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
 * The ceiling is 250 units per second per user, so sizes top out near 50
 * messages a second however they are batched. Pacing just under the ceiling
 * beats provoking 429s and backing off from them.
 */
const UNIT_COST = { cheap: 1, list: 5, get: 5, write: 5, batchModify: 50, history: 2 };
const UNITS_PER_SECOND = 220;

/** A request Gmail answered and refused, carrying enough to describe why. */
export class GmailError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.reason = reason;
  }
}

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

/** End of the last reserved slice of the per-second budget. */
let nextSlot = 0;

/**
 * Hold the caller until its share of the quota budget comes free. Callers
 * reserve in order, so concurrent batches queue rather than collide.
 */
async function reserve(units) {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + (units / UNITS_PER_SECOND) * 1000;
  if (start > now) await sleep(start - now);
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

  if (res.status === 401 || res.status === 403) {
    const refusal = await res.json().catch(() => ({}));
    const reason =
      refusal?.error?.errors?.[0]?.reason ??
      refusal?.error?.details?.find((detail) => detail.reason)?.reason ??
      '';
    const message = refusal?.error?.message || `Gmail denied the request (${res.status}).`;

    // The UI only ever shows a summary, so keep the real reason reachable.
    console.error('[MailBoy] request rejected', endpoint, res.status, reason, message);

    // 403 is overloaded: rate limiting is retryable, the rest are not.
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return backoffRetry(endpoint, params, { units, attempt, method, body });
    }

    // Only a token problem is worth sending the user back to sign in. A
    // disabled API or a project misconfiguration returns 403 too, and telling
    // someone to reconnect for those loops forever.
    const tokenProblem =
      res.status === 401 ||
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';

    throw tokenProblem
      ? new AuthError(message)
      : new GmailError(message, { status: res.status, reason });
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    return backoffRetry(endpoint, params, { units, attempt, method, body });
  }

  // `detail`, not `body`: that name is the request's own payload now.
  const detail = await res.json().catch(() => ({}));
  throw new GmailError(detail?.error?.message || `Gmail request failed (${res.status}).`, {
    status: res.status,
    reason: detail?.error?.errors?.[0]?.reason,
  });
}

async function backoffRetry(endpoint, params, { units, attempt, method, body }) {
  if (attempt >= 4) throw new Error('Gmail is rate limiting these requests.');
  const delay = 2 ** attempt * 400 + Math.random() * 300;
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
 * @returns {Promise<number>} how many were moved before a stop, if any
 */
export async function modifyMessages(ids, { add = [], remove = [] } = {}, stopped) {
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
  }

  return moved;
}

// ── Message sizes ────────────────────────────────────────────────

/** Gmail's own ceiling on sub-requests in one batch. */
const BATCH_SIZE = 100;

/** Enough in flight to hide latency; the quota pacer sets the real rate. */
const BATCH_CONCURRENCY = 3;

const MAX_ATTEMPTS = 4;

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
async function postBatch(ids, line, units, retry) {
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
    if (res.status === 429 || res.status >= 500) {
      retry.push(...ids);
      return null;
    }
    const detail = await res.json().catch(() => ({}));
    const reason = detail?.error?.errors?.[0]?.reason ?? '';
    const message = detail?.error?.message || `Gmail refused the batch (${res.status}).`;
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
function eachPart(text, contentType, ids, retry, handle) {
  const declared = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!declared) {
    retry.push(...ids);
    return;
  }

  const parts = text.split(`--${declared[1] ?? declared[2]}`);
  const answered = new Set();
  let position = -1;

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
    if (code === 429 || code >= 500) {
      retry.push(id);
      continue;
    }

    // part = outer headers, blank line, inner status + headers, blank line, body.
    const [, , ...rest] = part.split(/\r?\n\r?\n/);
    handle(id, code, rest.join('\n\n').trim());
  }

  for (const id of ids) if (!answered.has(id)) retry.push(id);
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
 * it is one `messages.trash` per message at 5 quota units each. Against the
 * 250-unit ceiling that is roughly 50 a second, the same rate as the size pass,
 * which is why emptying a large folder is a background job rather than
 * something to wait on. The multipart endpoint cuts the round trips but not
 * the quota.
 *
 * `onBatch(count)` fires as each batch lands so a long run can report progress.
 *
 * @returns {Promise<{trashed: number, failed: string[]}>} `failed` are ids Gmail
 *   would not move and would not retry — reported rather than swallowed, since
 *   the folder is about to be deleted out from under them.
 */
export async function trashMessages(ids, onBatch, stopped) {
  const trashed = new Set();
  const failed = new Set();
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
          // Per batch, not per message: one already in flight has moved mail
          // whether or not we wait for the answer, so its results matter.
          if (stopped?.()) return;
          const chunk = chunks[cursor++];
          const moved = await runTrashBatch(chunk, retry, failed);
          for (const id of moved) trashed.add(id);
          if (moved.length) onBatch?.(moved.length);
        }
      })
    );

    pending = retry;
  }

  // Retries exhausted: never moved, and nothing further will move them, so they
  // belong with the refusals rather than being forgotten.
  //
  // Not after a stop, though — what is left there was simply never attempted,
  // and reporting it as refused would turn "you called this off" into "Gmail
  // would not do it".
  if (!stopped?.()) for (const id of pending) failed.add(id);

  return { trashed: trashed.size, failed: [...failed] };
}

/** @returns {Promise<string[]>} the ids this batch actually moved */
async function runTrashBatch(ids, retry, failed) {
  const reply = await postBatch(
    ids,
    (id) =>
      `POST /gmail/v1/users/me/messages/${encodeURIComponent(id)}/trash` +
      '?fields=id&prettyPrint=false\r\n' +
      // Explicit rather than absent: trash takes no body, and Google's batch
      // parser should not have to infer that from a bare blank line.
      'Content-Length: 0\r\n\r\n',
    ids.length * UNIT_COST.write,
    retry
  );

  const moved = [];
  if (!reply) return moved;

  eachPart(reply.text, reply.contentType, ids, retry, (id, code) => {
    // 404 is a message that has already gone — deleted from another client
    // mid-pass, or trashed by an earlier attempt of this same job. Either way
    // it is out of the folder, which is what was asked for.
    if (code === 200 || code === 204 || code === 404) moved.push(id);
    else failed.add(id);
  });

  return moved;
}

export { AuthError };
