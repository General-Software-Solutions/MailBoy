import { AuthError, getToken, invalidateToken } from './auth.js';
import { trace } from './trace.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const PAGE_SIZE = 500;

/**
 * A runaway guard, not a product limit: half a million messages under a single
 * label means something has gone wrong upstream.
 */
const MAX_PAGES = 1000;

/**
 * Gmail meters by quota unit rather than request count, and the two calls that
 * matter are priced very differently: messages.list costs 5 units for 500 ids,
 * messages.get costs 5 units for one message. Enumeration is effectively free;
 * reading messages is not.
 *
 * **The ceiling is a minute, not a second, and it is far lower than it was.**
 * Google's usage limits now read `6,000 quota units per minute per user per
 * project` — cut from 15,000 on 2026-05-01, with projects that had used the API
 * before then keeping the old figure for a while. This one enabled Gmail on
 * 2026-08-29, so it is on 6,000: a hundred units a second, where the widely
 * quoted "250 units per user per second" was two and a half times that.
 *
 * That is the real cost of a size pass, and no amount of batching changes it:
 * 6,000 units a minute at 5 units a message is **20 messages a second at the
 * absolute ceiling**. Nothing here can be raised by asking — the per-user limit
 * is not the adjustable one, and a quota increase applies to the project's own
 * per-minute figure, which MailBoy is nowhere near.
 *
 * `SAFETY` is what keeps a burst inside the window rather than spending the last
 * of it and finding out. If a project turns out to still be on the old 15,000 —
 * Cloud console, *Quotas & System Limits*, filtered to `per minute per user` —
 * raising `UNITS_PER_MINUTE` to match is the one change that makes a first pass
 * faster.
 */
const UNIT_COST = { cheap: 1, list: 5, get: 5, write: 5, batchModify: 50, history: 2 };
const UNITS_PER_MINUTE = 6_000;
const SAFETY = 0.9;
const UNITS_PER_SECOND = (UNITS_PER_MINUTE / 60) * SAFETY;

/**
 * Retry budgets. `RETRY_ATTEMPTS` is the ordinary one — a 429 or a 5xx, gone
 * within a few seconds or not at all. `BUSY_ATTEMPTS` is for the two refusals
 * that clear on their own but not in seconds (see `attemptsFor`): eight attempts
 * capped at 20s each is a little over a minute, which is what it takes to outlast
 * a spent per-minute window. Capping the delay is what stops the doubling
 * turning into minutes of dead time between attempts.
 */
const RETRY_ATTEMPTS = 4;
const BUSY_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 20_000;
const BRIEF_COOLOFF_MS = 2_000;

/**
 * The refusals worth waiting out. Matched on the message because the status and
 * reason they arrive with are the same ones an ordinary rate limit uses — both
 * come back 429 or 403 `rateLimitExceeded`, and only the text says which.
 *
 * - *Too many concurrent requests for user* — something else is talking to this
 *   mailbox, and what clears it is that other thing finishing.
 * - *Quota exceeded … Units per minute per user* — the window has to roll over.
 *   A four-attempt backoff is about six seconds, so the old budget could not
 *   outlast this one however many times it tried.
 */
const PATIENT = /too many concurrent requests|quota exceeded/i;

/** A request Gmail answered and refused, carrying enough to describe why. */
export class GmailError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.reason = reason;
  }
}

/**
 * The token is fine; it simply does not carry the permission this call needs.
 *
 * An `AuthError` subclass so everything that already treats one as "reconnect
 * and this may work" keeps behaving — but the panel can tell the two apart and
 * offer the permission itself rather than sending someone back through a full
 * sign-in for a scope they turned down on the consent screen. This is the
 * backstop: the UI gates on `capabilities()` before it gets here.
 */
export class ScopeError extends AuthError {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `fields=` mask can select nothing at all: an empty label asked for
 * `nextPageToken,messages/id` comes back 200 with a zero-byte body, and
 * `Response.json()` rejects that outright. It stands for the empty object, so
 * read it as one — a label with no mail is ordinary, not a failure.
 */
async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Quota pacing ─────────────────────────────────────────────────
//
// **One budget for the whole extension, because Gmail meters the user and not
// the page.** This module is loaded twice — once in the side panel, once in the
// service worker — and a `nextSlot` private to each let them spend the same
// allowance twice over: a measuring pass and a panel opening asked for ~440
// units a second between them against a ceiling of 250. Neither pacer could see
// it, because neither could see the other.
//
// So the budget lives in `chrome.storage.session` (memory only, shared by every
// trusted context, exactly as the token already is) and `navigator.locks` makes
// the read-modify-write atomic. Both are per-origin, and an extension's pages
// and its worker share one origin.
//
// The stored value is a timestamp — the end of the last reserved slice — so a
// context that dies mid-reservation costs at most that slice, and a value left
// over from a previous session is simply in the past.

const BUDGET_KEY = 'quota:until';
const BUDGET_LOCK = 'mailboy-quota';

/** The same figure, for when the shared one cannot be reached. */
let nextSlot = 0;

/**
 * Whether the shared budget is reachable at all. Latched rather than re-tested:
 * whatever makes session storage or the lock fail once will fail every time, and
 * a warning on every request would bury the one that matters.
 */
let sharedBudget = Boolean(
  globalThis.navigator?.locks?.request && globalThis.chrome?.storage?.session
);

/**
 * Hold the caller until its share of the quota budget comes free. Callers
 * reserve in order, so concurrent batches queue rather than collide.
 */
async function reserve(units) {
  const wait = await claim((units / UNITS_PER_SECOND) * 1000);
  if (wait > 0) await sleep(wait);
}

/**
 * Push the budget forward so a refusal is felt by everything in flight, not
 * only by the request that got one.
 *
 * A rate limit is a statement about the mailbox rather than about one call, and
 * whatever provoked it — nearly always a measuring pass — is still running.
 * Backing off alone would leave that pass spending at full rate while the
 * request it starved retried into the same wall.
 */
function coolOff(ms) {
  return claim(ms);
}

/**
 * How long everything holds off after a refusal about rate. A `PATIENT` one has
 * to be waited out rather than merely eased off from, so it takes the ceiling;
 * an ordinary 429 takes a pause and lets the caller's own backoff do the rest.
 */
function coolOffFor(message) {
  return PATIENT.test(message) ? MAX_BACKOFF_MS : BRIEF_COOLOFF_MS;
}

/**
 * Reserve `ms` of the budget and answer how long that leaves the caller
 * waiting. **The wait happens outside the lock**: the slice is booked the
 * moment it is claimed, so holding the lock through the sleep would only stop
 * anyone else booking theirs.
 */
async function claim(ms) {
  if (!sharedBudget) return claimLocally(ms);

  try {
    return await navigator.locks.request(BUDGET_LOCK, async () => {
      const stored = (await chrome.storage.session.get(BUDGET_KEY))[BUDGET_KEY];
      const now = Date.now();
      const start = Math.max(now, typeof stored === 'number' ? stored : 0);
      await chrome.storage.session.set({ [BUDGET_KEY]: start + ms });
      return start - now;
    });
  } catch (err) {
    // A budget that cannot be read is worse than one that is only this
    // context's: a storage failure must not stop a pass, and pacing locally is
    // what this did before the budget was shared at all. **The other context is
    // then pacing separately again**, so this warning is the only sign that the
    // combined rate can go over — it is worth keeping loud.
    sharedBudget = false;
    console.warn('[MailBoy] shared quota budget unavailable, pacing locally:', err);
    return claimLocally(ms);
  }
}

function claimLocally(ms) {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + ms;
  return start - now;
}

// ── Requests ─────────────────────────────────────────────────────

function call(path, params = {}, units = UNIT_COST.cheap) {
  return request(BASE + path, params, { units });
}

/**
 * @param {{units?: number, attempt?: number, method?: string, body?: object}} options
 *   `body` is sent as JSON and implies a write; the caller still picks `units`,
 *   because Gmail prices writes very differently from each other.
 */
async function request(
  endpoint,
  params = {},
  { units = UNIT_COST.cheap, attempt = 0, method = 'GET', body } = {}
) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  await reserve(units);

  const token = await getToken();
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  // 204 on a DELETE and on batchModify, so this is the ordinary success path
  // for a write, not an edge case — readJson reads an empty body as {}.
  if (res.ok) return readJson(res);

  // A token Google no longer honours: drop it and renew silently, once.
  //
  // Safe to replay a write here: nothing has been applied, since the request
  // never got past authorisation.
  if (res.status === 401 && attempt === 0) {
    await invalidateToken();
    return request(endpoint, params, { units, attempt: attempt + 1, method, body });
  }

  // The refusal's own body, read before anything is decided: the status alone
  // does not say whether a retry has any chance, and "too many concurrent
  // requests" arrives as an ordinary 429 whose message is the only thing that
  // distinguishes it. `detail`, not `body` — that name is the payload we sent.
  const detail = await res.json().catch(() => ({}));
  const reason =
    detail?.error?.errors?.[0]?.reason ??
    detail?.error?.details?.find((entry) => entry.reason)?.reason ??
    '';
  const denied = res.status === 401 || res.status === 403;
  const message =
    detail?.error?.message ||
    (denied ? `Gmail denied the request (${res.status}).` : `Gmail request failed (${res.status}).`);
  const limit = attemptsFor(message);

  if (denied) {
    // 403 is overloaded: rate limiting is retryable, the rest are not.
    if (
      (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') &&
      attempt < limit
    ) {
      trace('quota', 'refused, waiting', { status: res.status, reason, attempt, limit });
      return backoffRetry(endpoint, params, { units, attempt, method, body });
    }

    // The UI only ever shows a summary, so keep the real reason reachable —
    // but only once it is final. A refusal about to be waited out is not a
    // fault, and eight identical error lines in front of a request that then
    // succeeded say something that is not true.
    console.error('[MailBoy] request rejected', endpoint, res.status, reason, message);

    // A permission that was never granted, as opposed to a token that has gone
    // stale: reconnecting fixes the second and does nothing for the first.
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      throw new ScopeError(message);
    }

    // Only a token problem is worth sending the user back to sign in. A
    // disabled API or a project misconfiguration returns 403 too, and telling
    // someone to reconnect for those loops forever.
    if (res.status === 401) throw new AuthError(message);
  } else if ((res.status === 429 || res.status >= 500) && attempt < limit) {
    trace('quota', 'refused, waiting', { status: res.status, reason, attempt, limit });
    return backoffRetry(endpoint, params, { units, attempt, method, body });
  }

  throw new GmailError(message, { status: res.status, reason });
}

/**
 * How many attempts a refusal is worth, read from what Gmail said rather than
 * from its status.
 *
 * **Neither `PATIENT` refusal is an ordinary rate limit**, and both outlast the
 * ordinary budget: a concurrent-request refusal clears when the other work
 * finishes, and a spent per-minute quota clears when the minute does. Four
 * attempts inside six seconds gives up while the cause is still running — which
 * is how a ticked rule box reported a failure for a filter that would have been
 * accepted moments later, and how a panel opening during a measuring pass
 * reported that it could not read the mailbox at all.
 *
 * Only the patience differs. The backoff still ends, so a genuinely stuck
 * mailbox still reports rather than retrying forever.
 */
function attemptsFor(message) {
  return PATIENT.test(message) ? BUSY_ATTEMPTS : RETRY_ATTEMPTS;
}

async function backoffRetry(endpoint, params, { units, attempt, method, body }) {
  const delay = Math.min(2 ** attempt * 400, MAX_BACKOFF_MS) + Math.random() * 300;

  // The whole extension waits, not just this request — see `coolOff`. Claimed
  // rather than awaited: the sleep below is this caller's share of it.
  void coolOff(delay);
  await sleep(delay);

  return request(endpoint, params, { units, attempt: attempt + 1, method, body });
}

// ── Identity ─────────────────────────────────────────────────────

/**
 * OpenID userinfo: avatar and signed-in address. Deliberately independent of
 * the Gmail API, and it never throws — the panel stays usable with a fallback
 * glyph and a blank address.
 *
 * @returns {Promise<{email?: string, picture?: string, name?: string} | null>}
 */
export async function getUserInfo() {
  try {
    return await request(USERINFO);
  } catch (err) {
    console.warn('[MailBoy] userinfo unavailable:', err);
    return null;
  }
}

// ── Labels and membership ────────────────────────────────────────

/** Names and IDs only — labels.list does not include message counts. */
export async function listLabels() {
  const { labels = [] } = await call('/labels');
  return labels;
}

/**
 * Google's own precomputed `messagesTotal` for one label. One quota unit, and
 * by far the fastest real number available — enumeration reaches the same
 * figure, but only after paging through the label.
 */
export function getLabel(id) {
  return call(`/labels/${encodeURIComponent(id)}`);
}

/**
 * Create a folder.
 *
 * Nesting is encoded in the name and nowhere else — "Work/Clients/Acme" is a
 * child of "Work/Clients" because of how it reads, not because of any link
 * between them. So a subfolder is created by handing over the full path, and
 * Gmail does not require the parent to exist.
 *
 * A duplicate name comes back 409, which is the one failure worth wording
 * differently for the user, so it reaches the caller as a GmailError carrying
 * that status rather than as a generic refusal.
 *
 * @param {string} name the full path, not the leaf
 * @returns {Promise<{id: string, name: string}>}
 */
export function createLabel(name) {
  return request(
    `${BASE}/labels`,
    {},
    {
      units: UNIT_COST.write,
      method: 'POST',
      // Both defaults already, stated so a Gmail-side change of default cannot
      // quietly produce folders that do not show up in either list.
      body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    }
  );
}

/**
 * Remove a folder.
 *
 * **This deletes no mail.** Gmail strips the label from every message carrying
 * it and leaves the messages alone, which is why anything done to that mail —
 * moving it to Trash, or putting it back in the inbox — is separate work the
 * caller does first, while it can still list what the label holds.
 *
 * It also removes only the label named: "Work/Clients" survives a delete of
 * "Work", and then reads as a top-level folder called "Work/Clients". Deleting
 * a subtree means one call per member of it.
 */
export async function deleteLabel(id) {
  await request(
    `${BASE}/labels/${encodeURIComponent(id)}`,
    {},
    { units: UNIT_COST.write, method: 'DELETE' }
  );
}

/**
 * Every message id carrying `labelId`, optionally narrowed by a search `query`.
 *
 * There is no page cap here on purpose. Enumeration is the cheap half of the
 * API — 5 quota units buys 500 ids — so counts stay exact however large the
 * label grows, and every number the panel shows is a real count of ids rather
 * than `resultSizeEstimate`, which is only an estimate.
 *
 * Filtering by label ID and leaving the query to the negations avoids escaping
 * label names with spaces and slashes.
 *
 * @returns {Promise<string[]>}
 */
export async function listMessageIds(labelId, query, stopped) {
  const ids = [];
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (stopped?.()) break;

    const data = await call(
      '/messages',
      {
        labelIds: labelId,
        q: query,
        maxResults: PAGE_SIZE,
        fields: 'nextPageToken,messages/id',
        // messages.list hides spam and trash by default, even when those are
        // exactly the labels being asked about.
        includeSpamTrash: labelId === 'SPAM' || labelId === 'TRASH' ? 'true' : undefined,
        pageToken,
      },
      UNIT_COST.list
    );

    for (const message of data.messages ?? []) ids.push(message.id);

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return ids;
}

// ── The change log ───────────────────────────────────────────────
//
// Gmail keeps an ordered log of everything that happens to a mailbox, each entry
// stamped with a sequence number. Hand it the number last seen and it hands back
// what has changed since — 2 quota units, against the thousands a full listing
// of every folder costs. That is what lets opening the panel be current instead
// of either stale or expensive.
//
// The log is kept for roughly a week. Past that the sequence number is refused
// and there is nothing for it but to list the mailbox again.

/**
 * Where the mailbox is *now*, as a sequence number for `listHistory`.
 *
 * Taken before a full listing starts rather than after it finishes: a listing
 * takes seconds, and stamping the end would silently swallow everything that
 * changed while it ran.
 */
export function getProfile() {
  return call('/profile');
}

/**
 * Everything that has happened since `startHistoryId`.
 *
 * **A 404 is not a failure here.** It is Gmail saying the sequence number has
 * aged out of the log, which is ordinary after a long enough absence and means
 * only that the caller has to fall back to listing the mailbox. Every other
 * refusal keeps the usual `GmailError` / `AuthError` behaviour.
 *
 * @returns {Promise<{records: object[], historyId?: string, expired: boolean}>}
 *   `historyId` is the new bookmark, and it is **only present when the walk
 *   reached the end of the log.** Gmail's id is the mailbox's position *now*,
 *   not the position after the records on this page, so storing one taken from
 *   an abandoned walk would skip every record never fetched. A caller left
 *   without one keeps the bookmark it had and replays next time, which costs a
 *   repeat and no correctness: every change applies as a set operation.
 */
export async function listHistory(startHistoryId, stopped) {
  const records = [];
  let pageToken;
  let historyId;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (stopped?.()) {
        trace('sync', 'change-log walk stopped partway — no bookmark taken', { pages: page });
        return { records, expired: false };
      }

      const data = await call(
        '/history',
        { startHistoryId, maxResults: PAGE_SIZE, pageToken },
        UNIT_COST.history
      );

      // Deliberately unfiltered by historyType: membership can change through
      // any of the four, and asking for a subset would drop the rest silently.
      for (const record of data.history ?? []) records.push(record);

      historyId = data.historyId ?? historyId;

      pageToken = data.nextPageToken;
      if (!pageToken) {
        trace('sync', 'change-log walk finished', { pages: page + 1, units: (page + 1) * 2 });
        return { records, historyId, expired: false };
      }
    }
  } catch (err) {
    if (err instanceof GmailError && err.status === 404) {
      trace('sync', '404 — the bookmark has aged out of Gmail’s log');
      return { records: [], expired: true };
    }
    throw err;
  }

  // Ran out of pages rather than out of log — the same runaway guard
  // `listMessageIds` carries. Not a complete walk, so no bookmark.
  console.warn('[MailBoy] change log longer than expected; falling back');
  return { records, expired: true };
}

// ── Moving messages ──────────────────────────────────────────────

/** Gmail's ceiling on ids in one batchModify. */
const MODIFY_CHUNK = 1000;

/**
 * Add and remove labels across many messages at once.
 *
 * The cheap half of the write API by a wide margin: 50 quota units moves up to
 * a thousand messages, where trashing the same thousand costs 5,000. That is
 * why putting a folder's mail back in the inbox is seconds and emptying it
 * into Trash is minutes.
 *
 * **It cannot trash anything.** Gmail rejects TRASH, SPAM and DRAFT here, so
 * moving mail to Trash goes through `trashMessages` and its per-message cost.
 *
 * @param {string[]} ids
 * @param {{add?: string[], remove?: string[]}} change
 * @param {() => boolean} [stopped]
 * @param {(chunk: string[]) => void} [onChunk] the ids a chunk moved, as it
 *   lands. A chunk either succeeds whole or throws, so this is also exactly what
 *   a long job needs in order to checkpoint what is left of it.
 * @returns {Promise<number>} how many were moved before a stop, if any
 */
export async function modifyMessages(ids, { add = [], remove = [] } = {}, stopped, onChunk) {
  let moved = 0;

  for (let at = 0; at < ids.length; at += MODIFY_CHUNK) {
    if (stopped?.()) break;
    const chunk = ids.slice(at, at + MODIFY_CHUNK);

    await request(
      `${BASE}/messages/batchModify`,
      {},
      {
        units: UNIT_COST.batchModify,
        method: 'POST',
        body: { ids: chunk, addLabelIds: add, removeLabelIds: remove },
      }
    );

    moved += chunk.length;
    onChunk?.(chunk);
  }

  return moved;
}

// ── Filters ──────────────────────────────────────────────────────
//
// The cheapest corner of the whole API, and cheap in the way that matters:
// `filters.list` hands back **every** filter on the account in one response, for
// one quota unit, with no paging and no cursor. There is nothing for an
// incremental update flow to be incremental about — refetching the lot costs
// less than half a `history.list` — which is why rules stay out of the snapshot,
// the membership record and the change-log bookmark entirely.
//
//   filters.list      1 unit   all of them
//   filters.create    5 units  one rule
//   filters.delete    5 units  one rule
//
// Two things Gmail does not offer, both load-bearing upstream: there is **no
// update method** (changing a filter is delete-then-create), and a filter can
// only ever act on mail as it arrives — the API has no equivalent of the "also
// apply to matching conversations" box in Gmail's own settings.

/**
 * Every filter on the account.
 *
 * @returns {Promise<object[]>} raw Filter resources, MailBoy's and Gmail's alike
 */
export async function listFilters() {
  const { filter = [] } = await call('/settings/filters');
  return filter;
}

/**
 * Create one filter.
 *
 * @param {{criteria: object, action: object}} filter
 * @returns {Promise<object>} the created resource, carrying its new `id`
 */
export function createFilter(filter) {
  return request(`${BASE}/settings/filters`, {}, {
    units: UNIT_COST.write,
    method: 'POST',
    body: filter,
  });
}

/**
 * Remove one filter. Deletes no mail and moves none: a filter is a standing
 * instruction about future deliveries, so removing it only stops the next one
 * being acted on.
 */
export async function deleteFilter(id) {
  await request(
    `${BASE}/settings/filters/${encodeURIComponent(id)}`,
    {},
    { units: UNIT_COST.write, method: 'DELETE' }
  );
}

// ── Message sizes ────────────────────────────────────────────────

/** Gmail's own ceiling on sub-requests in one batch. */
const BATCH_SIZE = 100;

/** Enough in flight to hide latency; the quota pacer sets the real rate. */
const BATCH_CONCURRENCY = 3;

/**
 * Rounds a batch job gets before it hands back what is left.
 *
 * **A round refused about rate does not spend one.** A queued task is guaranteed
 * to finish (see CLAUDE.md, *The task queue*), so being told "not now" can never
 * be the thing that ends it — and four rounds of 0.5–4s cannot outlast a
 * `Quota exceeded … per minute` anyway, which clears when the minute does rather
 * than when the backoff does.
 *
 * Everything else retryable — a 5xx, a sub-request that came back with no answer
 * at all — does spend one, and what is left after that is handed back as
 * **unfinished**, never as refused. That is not giving up either: the queue
 * retries it on its own clock, which survives the worker being killed where a
 * loop in here would not.
 */
const MAX_ATTEMPTS = 4;

/**
 * Total rounds in one run, throttled or not — roughly two minutes of patience.
 *
 * **Not a give-up point.** Looping in here until the throttle lifts would hold
 * the worker in a tight-ish retry against Gmail for as long as something else
 * holds the budget — nearly always a measuring pass, which runs for eighteen
 * minutes — and would add to the contention it is waiting on. Handing back
 * instead lets the queue wait on its own clock, which backs off when a run
 * achieves nothing, survives the worker being killed, and never ends the task.
 */
const MAX_ROUNDS = 12;

/** Where the round-level backoff stops doubling. */
const MAX_BACKOFF_ROUNDS = 6;

/**
 * Size, sender and date for each id, as a Map of id → `{bytes, from, date}`.
 *
 * This is the expensive thing MailBoy asks Gmail for, and there is no cheaper
 * route: neither figure exists anywhere but on the individual message, and
 * labels.get carries neither.
 *
 * `messages.get` costs 5 quota units whatever the format, so asking for the
 * From header and the date alongside the size is free — `format=metadata` with
 * one `metadataHeaders` costs exactly what `format=minimal` did. Only the response
 * grows, from roughly 40 bytes to 150, which is nothing against a pass that is
 * quota-bound rather than bandwidth-bound. No body and no attachment data is
 * transferred either way.
 *
 * The caller is expected to ask only for ids it has not already cached.
 *
 * `onBatch(found)` fires with each batch's results as they land, so a long
 * first run can report progress instead of going quiet.
 */
export async function fetchMessageMeta(ids, onBatch, stopped) {
  const meta = new Map();
  let pending = [...ids];

  for (let attempt = 0; pending.length && attempt < MAX_ATTEMPTS && !stopped?.(); attempt++) {
    if (attempt) await sleep(2 ** attempt * 500 + Math.random() * 400);

    const chunks = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      chunks.push(pending.slice(i, i + BATCH_SIZE));
    }

    const retry = [];
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          // Checked per batch rather than per message: a batch is already in
          // flight and its results are worth keeping.
          if (stopped?.()) return;
          const chunk = chunks[cursor++];
          const found = await runBatch(chunk, retry);
          for (const [id, entry] of found) meta.set(id, entry);
          if (found.size) onBatch?.(found);
        }
      })
    );

    pending = retry;
  }

  return meta;
}

/**
 * One multipart batch request. Ids it could not resolve are pushed onto
 * `retry` rather than thrown, so one dead message cannot fail the whole pass.
 *
 * @returns {Promise<Map<string, number>>}
 */
async function runBatch(ids, retry) {
  const reply = await postBatch(
    ids,
    (id) =>
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
      '?format=metadata&metadataHeaders=From' +
      '&fields=sizeEstimate,internalDate,payload/headers&prettyPrint=false\r\n\r\n',
    ids.length * UNIT_COST.get,
    retry
  );

  const found = new Map();
  if (!reply) return found;

  eachPart(reply.text, reply.contentType, ids, retry, (id, code, body) => {
    // 404 means the message is gone. Nothing to weigh, and asking again will
    // not bring it back.
    if (code !== 200) return;
    // Same empty-mask case as readJson: no size to report, and asking again
    // would only produce the same nothing.
    if (!body) return;

    try {
      const data = JSON.parse(body);
      const bytes = data?.sizeEstimate;
      // Header names are case-insensitive and Gmail's casing is not promised.
      const from =
        data?.payload?.headers?.find((header) => header.name?.toLowerCase() === 'from')?.value ??
        '';
      // internalDate is epoch milliseconds, delivered as a string.
      const date = Number(data?.internalDate ?? 0);
      if (Number.isFinite(bytes)) found.set(id, { bytes, from, date });
    } catch {
      retry.push(id);
    }
  });

  return found;
}

// ── Reading actual messages ──────────────────────────────────────
//
// The only place MailBoy asks Gmail for content rather than for figures. It is
// deliberately *not* part of the measuring pass and nothing it returns is
// cached: subjects, snippets and bodies are the mail itself, and "what is on
// disk" is a promise the panel keeps by never writing them down.
//
// Cost is the same 5 units a message the size pass pays, but only ever for the
// handful on screen — one page of a list, or one open message.

/**
 * Subject, snippet, size and date for one page of messages, in a single batch.
 *
 * `snippet` is Gmail's own first-line extract, which is exactly the second line
 * a mail row wants and is free here — `format=metadata` carries it.
 *
 * Ids Gmail would not answer for are simply absent from the result. The caller
 * has a row on screen for each one and has to say so itself; throwing would
 * cost the whole page for one deleted message.
 *
 * @param {string[]} ids
 * @returns {Promise<Map<string, object>>} id → the raw message resource
 */
export async function fetchMessageHeaders(ids) {
  const found = new Map();
  let pending = [...ids];

  for (let attempt = 0; pending.length && attempt < 3; attempt++) {
    if (attempt) await sleep(2 ** attempt * 400 + Math.random() * 200);

    const retry = [];
    const reply = await postBatch(
      pending,
      (id) =>
        `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
        '?format=metadata&metadataHeaders=Subject&metadataHeaders=From' +
        '&fields=snippet,internalDate,sizeEstimate,payload/headers&prettyPrint=false\r\n\r\n',
      pending.length * UNIT_COST.get,
      retry
    );

    // Null means the batch itself was refused; postBatch has already queued
    // every id for another go.
    if (reply) {
      eachPart(reply.text, reply.contentType, pending, retry, (id, code, body) => {
        // 404 is a message that has gone since it was listed. Asking again
        // produces the same nothing.
        if (code !== 200 || !body) return;
        try {
          found.set(id, JSON.parse(body));
        } catch {
          retry.push(id);
        }
      });
    }

    pending = retry;
  }

  return found;
}

/**
 * One whole message, payload and all.
 *
 * No `fields` mask: the payload is a tree whose shape is not known in advance,
 * and the parts that carry real weight — attachments — come back as an
 * `attachmentId` and a size rather than as data, so `format=full` is not the
 * large transfer it sounds like.
 *
 * Reading a message through the API does not mark it read, so opening one here
 * changes nothing in the mailbox.
 */
export function getMessage(id) {
  return call(`/messages/${encodeURIComponent(id)}`, { format: 'full' }, UNIT_COST.get);
}

/**
 * Send one multipart batch and hand back its raw reply.
 *
 * `line(id)` writes the sub-request — everything after the part's own headers,
 * ending in the blank line that closes it. Whatever could not be sent at all
 * goes onto `retry`, and the caller gets null rather than an exception, so one
 * refused batch never fails a pass.
 *
 * @returns {Promise<{text: string, contentType: string | null} | null>}
 */
/**
 * @param {{throttled: boolean}} [signal] set when a refusal turns out to be
 *   about rate. The caller's round loop reads it to decide whether an attempt
 *   was really spent — see `trashMessages`.
 */
async function postBatch(ids, line, units, retry, signal) {
  const boundary = `mailboy_${crypto.randomUUID()}`;

  const body =
    ids
      .map(
        (id, index) =>
          `--${boundary}\r\n` +
          'Content-Type: application/http\r\n' +
          `Content-ID: <m${index}>\r\n\r\n` +
          line(id)
      )
      .join('') + `--${boundary}--\r\n`;

  await reserve(units);

  const token = await getToken();
  const res = await fetch(BATCH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });

  if (res.status === 401) {
    await invalidateToken();
    retry.push(...ids);
    return null;
  }

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const reason = detail?.error?.errors?.[0]?.reason ?? '';
    const message = detail?.error?.message || `Gmail refused the batch (${res.status}).`;

    // **A rate limit arrives here as a 403 as often as a 429**, and treating one
    // of those as fatal ended a pass that would have gone through a minute
    // later. Either way the batch goes back on `retry` rather than being thrown:
    // the caller's round-level backoff is what waits, and a refusal about rate
    // is never about these particular hundred messages.
    const rate =
      res.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';

    if (rate || res.status >= 500) {
      // A pass is the biggest thing spending this mailbox's quota, so it is the
      // thing that has to give way — and the panel shares the budget with it.
      if (rate) {
        if (signal) signal.throttled = true;
        trace('quota', 'batch refused, cooling off', { status: res.status, reason, of: ids.length });
        void coolOff(coolOffFor(message));
      }
      retry.push(...ids);
      return null;
    }

    console.error('[MailBoy] batch rejected', res.status, reason, message);
    throw new GmailError(message, { status: res.status, reason });
  }

  return { text: await res.text(), contentType: res.headers.get('Content-Type') };
}

/**
 * Walk a batch reply, handing `handle` each sub-response's status code and body
 * alongside the id it answers for.
 *
 * Batch replies are multipart/mixed, each part wrapping a complete HTTP
 * response with its own status. Sub-requests fail individually — a message
 * deleted between listing and acting on it 404s while its neighbours succeed —
 * so status is read per part, never per response. Parts that are retryable, and
 * ids that came back with no part at all, go onto `retry` before `handle` ever
 * sees them.
 */
function eachPart(text, contentType, ids, retry, handle, signal) {
  const declared = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!declared) {
    retry.push(...ids);
    return;
  }

  const parts = text.split(`--${declared[1] ?? declared[2]}`);
  const answered = new Set();
  let position = -1;
  let throttled = false;

  for (const part of parts) {
    const status = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(part);
    if (!status) continue; // the preamble and the closing delimiter

    position++;

    // Google echoes back the Content-ID we sent, prefixed. Order is not
    // promised, so trust the echo and fall back to position only without one.
    const echo = /^Content-ID:\s*<response-m(\d+)>/im.exec(part);
    const id = ids[echo ? Number(echo[1]) : position];
    if (id === undefined) continue;
    answered.add(id);

    const code = Number(status[1]);

    // part = outer headers, blank line, inner status + headers, blank line, body.
    const [, , ...rest] = part.split(/\r?\n\r?\n/);
    const body = rest.join('\n\n').trim();

    // **A rate limit is not a refusal about this message**, and it arrives here
    // as a 403 as often as a 429 — the same overloading `postBatch` handles one
    // level up. Reading only the status counted every throttled sub-request as
    // permanently unmovable, which is how a trash job reported hundreds of
    // messages it had never actually tried: `handle` marks them failed, and the
    // round loop never sees them again.
    if (code === 429 || code >= 500 || (code === 403 && rateLimited(body))) {
      // Once per batch rather than once per part: a hundred of these describe
      // one refusal, and the whole extension should feel it once.
      if (code !== 429 && code < 500 && !throttled) {
        throttled = true;
        trace('quota', 'batch parts throttled, cooling off', { of: ids.length });
        void coolOff(coolOffFor(body));
      }
      // A 5xx is Gmail having a moment rather than a statement about rate, so it
      // spends an attempt the way it always did. The other two do not.
      if (signal && code < 500) signal.throttled = true;
      retry.push(id);
      continue;
    }

    handle(id, code, body);
  }

  for (const id of ids) if (!answered.has(id)) retry.push(id);
}

/**
 * Whether a refusal is about rate rather than about the message it names. A
 * batch part's body is a string this far down, so the reason is read out of the
 * JSON where there is any and matched in the text where there is not.
 */
function rateLimited(body) {
  if (!body) return false;
  try {
    const reason = JSON.parse(body)?.error?.errors?.[0]?.reason ?? '';
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  } catch {
    return /rate ?limit|quota exceeded/i.test(body);
  }
}

// ── Trashing ─────────────────────────────────────────────────────

/**
 * Move messages to Trash, where Gmail keeps them for 30 days.
 *
 * Recoverable on purpose. The permanent equivalent, `messages.batchDelete`,
 * needs the `https://mail.google.com/` scope — the widest Google publishes —
 * and offers the user no way back from a mistake. Neither trade is worth it.
 *
 * There is no batched form of this: `batchModify` refuses the TRASH label, so
 * it is one `messages.trash` per message at 5 quota units each. Against a
 * ceiling of 6,000 units a minute that is 18 a second, the same rate as the size
 * pass, which is why emptying a large folder is a background job rather than
 * something to wait on — a thousand messages is a minute of quota on its own.
 * The multipart endpoint cuts the round trips but not the quota.
 *
 * `onBatch(ids)` fires as each batch lands, with the ids that batch actually
 * moved. Deliberately the ids and not a count: a long job checkpoints what is
 * left of it to disk as it goes, and "how many" cannot say which.
 *
 * @returns {Promise<{trashed: number, failed: string[], pending: string[]}>}
 *   **`failed` and `pending` are different answers and must not be merged.**
 *   `failed` is Gmail refusing *these messages* — a permission, a malformed id,
 *   something no amount of retrying changes. `pending` is work that ran out of
 *   patience, which is nearly always a rate limit and says nothing about the
 *   messages at all.
 *
 *   Merging them is exactly the bug this had: everything still on the retry list
 *   after four rounds was declared refused, so a throttled trash reported
 *   hundreds of messages it had never been allowed to try. The caller leaves
 *   `pending` outstanding and comes back to it.
 */
export async function trashMessages(ids, onBatch, stopped) {
  const trashed = new Set();
  const failed = new Set();
  let pending = [...ids];

  /** Rounds that were about something other than rate. Only these run out. */
  let spent = 0;
  /** Every round, for the backoff — a throttled one still has to wait. */
  let round = 0;

  while (pending.length && spent < MAX_ATTEMPTS && round < MAX_ROUNDS && !stopped?.()) {
    // Capped, and capped twice: the exponent stops doubling at
    // MAX_BACKOFF_ROUNDS because a throttled job can go round indefinitely, and
    // the result is held under MAX_BACKOFF_MS because the shared cool-off is
    // already pacing the whole extension.
    if (round) {
      const step = 2 ** Math.min(round, MAX_BACKOFF_ROUNDS) * 500;
      await sleep(Math.min(step, MAX_BACKOFF_MS) + Math.random() * 400);
    }
    round++;

    const chunks = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      chunks.push(pending.slice(i, i + BATCH_SIZE));
    }

    const retry = [];
    const signal = { throttled: false };
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          // Per batch, not per message: one already in flight has moved mail
          // whether or not we wait for the answer, so its results matter.
          if (stopped?.()) return;
          const chunk = chunks[cursor++];
          const moved = await runTrashBatch(chunk, retry, failed, signal);
          for (const id of moved) trashed.add(id);
          if (moved.length) onBatch?.(moved);
        }
      })
    );

    pending = retry;

    // A round refused about rate has not spent an attempt on these messages — it
    // never got to them. Not counting it is what makes the difference between
    // waiting out a busy minute and reporting a folder's worth of mail as
    // unmovable, and it is what makes a queued task's completion a guarantee
    // rather than a hope.
    if (signal.throttled) {
      if (round % 5 === 0) {
        trace('quota', 'still throttled — waiting it out rather than giving up', {
          outstanding: pending.length,
          moved: trashed.size,
          round,
        });
      }
    } else {
      spent++;
    }
  }

  return { trashed: trashed.size, failed: [...failed], pending };
}

/** @returns {Promise<string[]>} the ids this batch actually moved */
async function runTrashBatch(ids, retry, failed, signal) {
  const reply = await postBatch(
    ids,
    (id) =>
      `POST /gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash` +
      '?fields=id&prettyPrint=false\r\n' +
      // Explicit rather than absent: trash takes no body, and Google's batch
      // parser should not have to infer that from a bare blank line.
      'Content-Length: 0\r\n\r\n',
    ids.length * UNIT_COST.write,
    retry,
    signal
  );

  const moved = [];
  if (!reply) return moved;

  eachPart(
    reply.text,
    reply.contentType,
    ids,
    retry,
    (id, code) => {
      // 404 is a message that has already gone — deleted from another client
      // mid-pass, or trashed by an earlier attempt of this same job. Either way
      // it is out of the folder, which is what was asked for.
      if (code === 200 || code === 204 || code === 404) moved.push(id);
      else failed.add(id);
    },
    signal
  );

  return moved;
}

export { AuthError };
