// Everything the panel shows, derived from one cheap pass over label
// membership plus the per-message cache.
//
// Nothing about a label's contents is kept between loads except each message's
// size and sender, neither of which can change. Counts come from enumerating
// the labels every time, because that is both exact and nearly free.

import { activeAccount, keyFor } from './account.js';
import {
  AuthError,
  getLabel,
  getProfile,
  listHistory,
  listLabels,
  listMessageIds,
} from './gmail.js';
import { buildGroups } from './labels.js';
import { trace } from './trace.js';
import {
  bySender,
  idsForSenders,
  isMeasured,
  loadMessages,
  reloadMessages,
  sizeOf,
} from './messages.js';

/** Rows that count something narrower than their whole label. */
const SCOPES = {
  inbox: 'in:inbox',
  // Mail that arrived, not mail you wrote. See the note on `scope` in
  // labels.js — this is what keeps a folder delete from returning your own
  // sent replies to your inbox.
  incoming: '-in:sent -is:draft',
};

// ── Sizing a row without reading its mail ────────────────────────
//
// **A size normally costs 20 quota units a message and there is no bulk route** —
// `messages.list` hands back nothing but an id and a thread id, there is no
// `batchGet`, and the HTTP batch endpoint is billed as n requests rather than
// one. That is why the real pass takes hours on a large mailbox, and none of
// that changes here: `fetchMessageMeta` still reads every message, because the
// **sender** and the date it also brings back exist nowhere else, and the
// breakdown, the mail list, every action's id resolution and the frequency
// column are all built on them.
//
// What this adds is a figure to show *while* that runs. Gmail's search takes
// `larger:` and `smaller:`, so a row can be listed band by band and its mail
// sorted into size classes for the price of listing it again — **5 units per 500
// ids, against 20 units per message.** On a 46,000-message folder that is about
// 500 units rather than 920,000, and it answers in seconds rather than in hours.
//
// What it buys is an estimate and it is never presented as more than one: the
// panel marks it `~` until the row's own messages have actually been read. A
// band says a message is between 45 KB and 90 KB; it does not say which.
//
// **The bands do not replace enumeration.** They could — every message has
// exactly one size, so the bands are a partition of the row — but a count is the
// number this product is most careful about, and boundary semantics are the one
// thing here Google does not document precisely (see `bandQuery`). So the
// enumerated id set stays the authority on what a row holds, and a band that
// claims nothing simply leaves its messages unestimated.
//
// Boundaries in bytes. Band `i` is `[SIZE_BANDS[i], SIZE_BANDS[i + 1])`, and the
// last one runs to infinity. Roughly 2× apart, which is as coarse as the
// midpoint rule below can be without the estimate visibly missing — and each
// extra band costs one 5-unit call per row, so this is a price, not a free dial.
const SIZE_BANDS = [
  0, 3_000, 8_000, 20_000, 45_000, 90_000, 180_000, 350_000, 700_000, 1_400_000, 3_000_000,
  6_000_000, 12_000_000, 25_000_000,
];

/** Measured messages a band needs before its own average beats the midpoint. */
const MIN_SAMPLE = 12;

/**
 * The search that selects one band.
 *
 * `larger:`/`smaller:` are strict, so `[lo, hi)` is `larger:lo-1 smaller:hi`: a
 * message of exactly `lo` clears `lo - 1`, and one of exactly `hi` does not
 * clear `smaller:hi` and is picked up by the band above. Google documents the
 * operators but not their behaviour at the boundary, so **both ways of being
 * wrong are harmless here**: were they inclusive the bands would overlap by a
 * byte, and a message claimed twice keeps the first band it landed in; were
 * there a gap, the message is left unestimated and its row is short by one
 * message's worth rather than wrong about its count.
 */
function bandQuery(band) {
  const lo = SIZE_BANDS[band];
  const hi = SIZE_BANDS[band + 1];
  const terms = [];
  if (lo > 0) terms.push(`larger:${lo - 1}`);
  if (hi !== undefined) terms.push(`smaller:${hi}`);
  return terms.join(' ');
}

/**
 * What one message in a band is worth, before any measured mail has calibrated
 * it. The geometric mean is the midpoint of a band whose ends are a ratio apart
 * rather than a difference, which is what log-spaced bands are.
 *
 * The two ends are special because neither has a geometric mean: the bottom band
 * reaches 0, and sizes crowd its low end rather than spreading evenly, so it
 * takes a fraction of its ceiling. The top band has no ceiling at all.
 */
function midOf(band) {
  const lo = SIZE_BANDS[band];
  const hi = SIZE_BANDS[band + 1];
  if (!lo) return hi / 2.5;
  if (hi === undefined) return lo * 1.5;
  return Math.sqrt(lo * hi);
}

/**
 * The same question `SCOPES` asks, asked of a label set instead of a search.
 *
 * A row's membership is defined by what `messages.list` hands back, and the
 * change log speaks only in labels — so patching membership from the log means
 * deciding, from a message's labels alone, whether that row would have listed
 * it. Three rules, and **every one of them mirrors something above or in
 * `listMessageIds`.**
 *
 * Keep this beside `SCOPES` and change the two together. When the gate in
 * `collect` and the queue in `ensureMeta` disagreed about what still needed
 * reading, the backfill silently never ran; a divergence here would be the same
 * kind of fault, and would show up as counts that drift a little further from
 * Gmail's every time the panel is opened.
 */
function belongsIn(row, labels) {
  if (!labels.has(row.id)) return false;

  // `messages.list` hides trashed and spam mail from every other label, so a
  // message keeps a folder's label on the way to Trash but leaves that folder's
  // number. `includeSpamTrash` is set for exactly these two — see gmail.js.
  if (row.id !== 'SPAM' && row.id !== 'TRASH' && (labels.has('SPAM') || labels.has('TRASH'))) {
    return false;
  }

  if (row.scope === 'inbox') return labels.has('INBOX'); // SCOPES.inbox
  if (row.scope === 'incoming') return !labels.has('SENT') && !labels.has('DRAFT'); // SCOPES.incoming
  return true;
}

/** Listing is paced by the quota reserver, so concurrency only hides latency. */
const LIST_CONCURRENCY = 8;

/**
 * How often a running pass re-reads the message cache into its row totals.
 *
 * The worker flushes every 15 seconds and a batch lands every ~22, so this is
 * about one re-read per couple of batches — enough to pick up a pass already in
 * progress within half a minute, and far short of the cost of re-reading every
 * shard per batch. See `refill`.
 */
const REFILL_MS = 30_000;

/**
 * The ids behind each row's number, from the most recent collect.
 *
 * Kept in memory only. A drill-down needs them to aggregate, and re-listing on
 * every click would be wasteful when the load just did it — but they are mail
 * data, so they live no longer than the open panel.
 *
 * @type {Map<string, string[]>}
 */
let counts = new Map();

/**
 * What one unread message is worth, per row, from the band pass — see
 * `readBands`.
 *
 * **A per-row average rather than a per-message band.** Both answer the row's
 * total equally well, because what is still unmeasured within a row is not
 * biased by size: the reading order is by row, smallest row first, and never by
 * how big a message is. The average is four numbers to store where the bands
 * would be one per message, and it stays right on its own as messages are read —
 * the row's estimate is simply whatever is left times this.
 *
 * @type {Map<string, number>}
 */
let estimates = new Map();

/**
 * Which mailbox `counts` and `estimates` were read for.
 *
 * The service worker is woken by an alarm and can easily outlive an account
 * switch the panel made, exactly as `messages.js` guards its own map with
 * `loadedFor`. Without this a queue rebuilt from memory would be built out of
 * somebody else's mailbox.
 *
 * @type {string | null}
 */
let membershipFor = null;

/**
 * Rows a projected action has changed since the running load enumerated them.
 *
 * A load's records were built by an enumeration that ran before the mail moved,
 * and it goes on emitting them for as long as measuring takes — which would
 * repaint the mail exactly where it no longer is, a second after the panel said
 * otherwise. `snapshot` re-derives these rows on the way out.
 *
 * @type {Set<string>}
 */
let patched = new Set();

/**
 * Where the change log stood when `counts` was last known to be right.
 *
 * Kept with membership rather than beside it, because the two are one fact: the
 * ids *are* the mailbox as of this number. Two keys could disagree, and a
 * bookmark running ahead of the ids is the one failure this whole path cannot
 * detect — every change before it would simply never be reported again.
 *
 * @type {string | null}
 */
let bookmark = null;

const MEMBERSHIP_NAME = 'membership';

/** The one key a mailbox's membership occupies, for erasing it. */
export const membershipKey = (id) => keyFor(id, MEMBERSHIP_NAME);

/**
 * Who is behind a label's number.
 *
 * Entirely local — the ids come from the last enumeration and every size and
 * sender is already cached, so this costs no Gmail calls at all.
 *
 * `cached` is below `total` when some of the label's messages have not been
 * read yet; the caller should say so rather than present a short total as
 * complete.
 *
 * @param {number} [sinceDay] whole days since the epoch, or 0 for everything
 * @returns {{senders: object[], total: number, cached: number, matched: number,
 *   undated: number, bytes: number}}
 */
export function breakdownOf(labelId, sinceDay = 0) {
  const ids = counts.get(labelId) ?? [];
  return { ...bySender(ids, sinceDay), total: ids.length };
}

/**
 * The messages behind a set of ticked senders in one row's breakdown.
 *
 * Also local, and deliberately the same two filters `breakdownOf` applies — the
 * figure a confirmation dialog quotes and the mail a job acts on have to be the
 * same set, or one of the two is lying.
 *
 * @param {string} labelId
 * @param {Iterable<string>} senderKeys
 * @param {number} [sinceDay]
 * @returns {string[]}
 */
export function idsForSelection(labelId, senderKeys, sinceDay = 0) {
  return idsForSenders(counts.get(labelId) ?? [], senderKeys, sinceDay);
}

/**
 * Enumeration now runs at most once a day, so its result has to outlive the
 * panel — otherwise a breakdown would have no ids to aggregate on any open that
 * skipped it, which is most of them.
 */
async function saveMembership(counted, historyId = bookmark) {
  try {
    bookmark = historyId ?? null;
    const account = await activeAccount();
    if (!account) return;

    membershipFor = account;
    await chrome.storage.local.set({
      [membershipKey(account)]: {
        savedAt: Date.now(),
        historyId: bookmark,
        ids: Object.fromEntries(counted),
        // Written with the ids because it is about them: an estimate is per
        // unread message of *this* row as this enumeration found it. Four bytes
        // a row against a megabyte of ids, and without it a panel reopened
        // mid-pass would go back to showing spinners over rows it had a figure
        // for a moment ago.
        estimates: Object.fromEntries(estimates),
      },
    });
  } catch (err) {
    // Costs a breakdown until the next enumeration, never the panel.
    console.warn('[MailBoy] membership not saved:', err);
  }
}

/**
 * Move the bookmark on without rewriting the ids.
 *
 * What an action resolves to is already in `counts` — it was patched there at
 * the click and completed when the job reported back — so all that is left is
 * to say the log has been accounted for up to here. Rewriting the id map to do
 * that would mean shipping megabytes to storage for a one-field change.
 *
 * **Refuses to write a bookmark where there are no ids to bookmark against.**
 * That pairing is the invariant the whole sync rests on.
 */
export async function stampHistoryId(historyId) {
  if (!historyId) return;

  try {
    const account = await activeAccount();
    if (!account) return;

    const key = membershipKey(account);
    const { [key]: stored } = await chrome.storage.local.get(key);
    if (!stored?.ids) return;

    bookmark = historyId;
    await chrome.storage.local.set({ [key]: { ...stored, historyId } });
    trace('bookmark', 'moved on past a settled action', { to: historyId });
  } catch (err) {
    // The next open replays from the old bookmark instead. Harmless.
    console.warn('[MailBoy] could not move the change-log bookmark:', err);
  }
}

/**
 * Put the last enumeration back in memory when this open skipped its own.
 *
 * Also loads the message cache, which is easy to forget: a skipped load never
 * reaches `collect`, and `collect` is the only other caller of
 * `loadMessages()`. Without it a breakdown reads an empty map and reports that
 * nothing has been measured, however much actually has.
 */
export async function restoreMembership() {
  await loadMessages();
  try {
    const account = await activeAccount();
    if (!account) return;

    // Held in memory once it has been read — but only for the mailbox it was
    // read for. The worker is woken by an alarm and can outlive a switch.
    if (counts.size && membershipFor === account) return;

    const key = membershipKey(account);
    const { [key]: stored } = await chrome.storage.local.get(key);
    if (stored?.ids) {
      counts = new Map(Object.entries(stored.ids));
      estimates = new Map(Object.entries(stored.estimates ?? {}));
      bookmark = stored.historyId ?? null;
      membershipFor = account;
    }
  } catch (err) {
    console.warn('[MailBoy] membership unreadable:', err);
  }
}

/**
 * Drop the ids held in memory without touching disk — what leaving a mailbox
 * needs, since a stored membership belongs to the account it was saved under
 * and outlives the panel on purpose.
 */
export function resetMembership() {
  counts = new Map();
  estimates = new Map();
  membershipFor = null;
  patched = new Set();
  // The bookmark describes the ids being dropped, and belongs to the mailbox
  // being left. Keeping it would point the next account's first sync at a
  // position in someone else's log.
  bookmark = null;
}

/**
 * Patch membership after a folder is created or deleted, instead of enumerating
 * again.
 *
 * A folder that has just been created holds nothing, and one that has just been
 * deleted holds nothing that can still be reached, so both answers are known
 * without asking Gmail. Worth having because enumeration is otherwise the only
 * thing that writes here, and it runs at most once a day — without this a new
 * folder's breakdown would read from whatever the last pass happened to know,
 * which is nothing at all.
 *
 * @param {string[]} added label ids that now exist and are empty
 * @param {string[]} removed label ids that are gone
 */
export function patchMembership({ added = [], removed = [] } = {}) {
  // An empty map means `restoreMembership` has not finished — a panel that
  // skipped enumeration restores in the background, and a click can beat it.
  // Saving a patch of nothing would write a one-entry map over the real one and
  // cost the next open every breakdown it has.
  const restored = counts.size > 0;

  for (const id of added) counts.set(id, []);
  for (const id of removed) counts.delete(id);

  if (restored) void saveMembership(counts);
}

/**
 * The ids behind one row's number, for an action that acts on a whole folder.
 *
 * A copy: the caller is about to hand these to a job, and the live array is
 * what every count on screen is derived from.
 */
export const idsIn = (labelId) => [...(counts.get(labelId) ?? [])];

/**
 * Patch membership for messages an action has just moved, rather than waiting
 * for the next enumeration to notice.
 *
 * Trashing and moving are minutes of background work, and until this existed
 * every number on screen went on describing where the mail *was* for the whole
 * of it. What an action does to each row is known at the moment it is
 * dispatched — it is the same knowledge the job itself is built from — so the
 * panel can say so at once and let the reconciling load correct it.
 *
 * This is a projection, not a fact: it says what Gmail was *asked* to do.
 * Whoever calls it owes the user a resolution when the job reports back — either
 * the completing half of the same patch, or a real load.
 *
 * Rows the last enumeration never reached are skipped rather than invented. An
 * absent row means "not known", and seeding one with just these ids would
 * claim the folder holds nothing else.
 *
 * @param {Iterable<string>} ids the messages that are moving
 * @param {{add?: string[], remove?: string[]}} where in MailBoy's rows, which
 *   is not the same list as the labels the job sends Gmail
 * @returns {{touched: string[], removed: Record<string, string[]>}} the rows
 *   whose contents changed, and exactly what came out of each — which is what a
 *   job that only half happened needs in order to put the rest back.
 */
export function patchMessages(ids, { add = [], remove = [] } = {}) {
  const moving = new Set(ids);

  // An empty map means `restoreMembership` has not finished — the same trap
  // `patchMembership` guards against, and here it would also save a map of
  // almost nothing over the real one.
  if (!counts.size || !moving.size) return { touched: [], removed: {} };

  const touched = new Set();
  /** @type {Record<string, string[]>} */
  const removed = {};

  for (const rowId of remove) {
    const current = counts.get(rowId);
    if (!current) continue;

    const kept = current.filter((id) => !moving.has(id));
    if (kept.length === current.length) continue;

    removed[rowId] = current.filter((id) => moving.has(id));
    counts.set(rowId, kept);
    touched.add(rowId);
  }

  for (const rowId of add) {
    const current = counts.get(rowId);
    if (!current) continue;

    const held = new Set(current);
    const gained = [...moving].filter((id) => !held.has(id));
    if (!gained.length) continue;

    counts.set(rowId, [...current, ...gained]);
    touched.add(rowId);
  }

  if (touched.size) {
    for (const rowId of touched) patched.add(rowId);
    void saveMembership(counts);
  }
  return { touched: [...touched], removed };
}

/**
 * Put back what a projection took out, for the part of a job that never
 * happened.
 *
 * A projection removes mail from where it was the moment the action is
 * dispatched. When the job then only half runs — stopped partway, or refused for
 * some of its messages — the rows are showing all of it as gone. This is the
 * other half of `patchMessages`, and it is why that one reports what it removed
 * rather than only which rows it touched.
 *
 * @param {Record<string, string[]>} removed as `patchMessages` returned it
 * @returns {string[]} the rows whose contents changed
 */
export function unpatchMessages(removed) {
  if (!counts.size) return [];

  const touched = new Set();

  for (const [rowId, ids] of Object.entries(removed)) {
    const current = counts.get(rowId);
    if (!current || !ids?.length) continue;

    const held = new Set(current);
    const back = ids.filter((id) => !held.has(id));
    if (!back.length) continue;

    counts.set(rowId, [...current, ...back]);
    touched.add(rowId);
  }

  if (touched.size) {
    for (const rowId of touched) patched.add(rowId);
    void saveMembership(counts);
  }
  return [...touched];
}

/**
 * Bring membership up to date from Gmail's change log instead of re-listing.
 *
 * Two quota units against the thousands a full pass over every row costs, which
 * is what makes it affordable to do on every open rather than once a week. It
 * answers only about messages that actually changed, so a quiet mailbox costs
 * one request and touches nothing.
 *
 * **`{ synced: false }` is an ordinary answer, not an error.** No bookmark, a
 * bookmark Gmail has forgotten, or a log this cannot read means only that the
 * caller has to list the mailbox instead.
 *
 * @param {{defaults: object[], user: object[]}} groups the rows to place mail in
 * @returns {Promise<{synced: boolean, changed?: string[], added?: string[]}>}
 *   `added` are messages now sitting in a row with nothing cached about them —
 *   what a size pass still owes.
 */
export async function syncHistory(groups, stopped) {
  await restoreMembership();

  if (!counts.size || !bookmark) {
    trace('sync', 'refused — nothing to patch from', {
      rows: counts.size,
      bookmark,
    });
    return { synced: false };
  }

  trace('sync', 'asking the change log what has changed', { since: bookmark });

  const { records, historyId, expired } = await listHistory(bookmark, stopped);
  if (expired) {
    trace('sync', 'refused — Gmail has forgotten this bookmark, or the log is too long');
    return { synced: false };
  }

  trace('sync', `${records.length} record(s)`, { since: bookmark, now: historyId });

  // ── What each touched message now carries ──────────────────────
  //
  // Re-derived from whole label sets rather than accumulated from the deltas.
  // The log reports a change and the set it left behind, and trusting the set is
  // self-correcting: a record misread earlier is overwritten by the next one to
  // mention that message, where a running delta would carry the mistake to the
  // end.

  /** @type {Map<string, Set<string>>} */
  const labelsById = new Map();
  const gone = new Set();
  let unreadable = 0;

  const track = (message) => {
    if (!message?.id) return null;
    if (message.labelIds) {
      const labels = new Set(message.labelIds);
      labelsById.set(message.id, labels);
      gone.delete(message.id);
      return labels;
    }
    return labelsById.get(message.id) ?? null;
  };

  for (const record of records) {
    for (const { message } of record.messagesAdded ?? []) track(message);

    for (const { message } of record.messagesDeleted ?? []) {
      if (!message?.id) continue;
      labelsById.delete(message.id);
      gone.add(message.id);
    }

    for (const entry of record.labelsAdded ?? []) {
      const labels = track(entry.message);
      if (!labels) unreadable++;
      else for (const label of entry.labelIds ?? []) labels.add(label);
    }

    for (const entry of record.labelsRemoved ?? []) {
      const labels = track(entry.message);
      if (!labels) unreadable++;
      else for (const label of entry.labelIds ?? []) labels.delete(label);
    }
  }

  // A record that named a message without saying what it carries leaves that
  // message unplaceable, and guessing would put a wrong number on a row and
  // then bookmark past the evidence. Listing is the honest answer, and saying
  // so loudly is what turns this from a silent drift into something findable.
  if (unreadable) {
    console.warn(`[MailBoy] ${unreadable} change-log records carried no label set; listing instead`);
    trace('sync', 'refused — records without a label set', { unreadable });
    return { synced: false };
  }

  // ── Where that puts them ───────────────────────────────────────

  const rows = rowsOf(groups);
  const changed = new Set();

  // Sets rather than the stored arrays: every changed message is tested against
  // every row, and `includes` over a mailbox-sized row would turn an instant
  // open into a visible stall.
  const sets = new Map();
  for (const [rowId, ids] of counts) sets.set(rowId, new Set(ids));

  for (const [id, labels] of labelsById) {
    for (const row of rows) {
      const set = sets.get(row.id);
      // A row the last enumeration never reached is not known, and seeding one
      // here would claim it holds nothing but this.
      if (!set) continue;

      const should = belongsIn(row, labels);
      if (should === set.has(id)) continue;

      if (should) set.add(id);
      else set.delete(id);
      changed.add(row.id);
    }
  }

  for (const id of gone) {
    for (const [rowId, set] of sets) if (set.delete(id)) changed.add(rowId);
  }

  for (const rowId of changed) counts.set(rowId, [...sets.get(rowId)]);

  // Mail that landed somewhere on screen with nothing cached about it. Without
  // this the row's count would go up and its size would sit short for a week.
  const added = [];
  for (const id of labelsById.keys()) {
    if (isMeasured(id)) continue;
    for (const rowId of changed) {
      if (sets.get(rowId)?.has(id)) {
        added.push(id);
        break;
      }
    }
  }

  // Gmail's own answer, so it supersedes whatever an action projected — the same
  // rule `collect` applies after enumerating.
  patched = new Set();

  // No `historyId` means the walk was abandoned rather than finished, so the old
  // bookmark stands and the next open replays. The work above is not wasted:
  // every change applies as a set operation, so seeing it twice changes nothing.
  await saveMembership(counts, historyId);

  trace('sync', changed.size ? 'patched' : 'nothing moved', {
    messages: labelsById.size,
    deleted: gone.size,
    rows: [...changed],
    unmeasured: added.length,
    bookmark: historyId ?? `${bookmark} (kept — walk did not finish)`,
  });

  return { synced: true, changed: [...changed], added };
}

/**
 * Count and size for particular rows, from the membership now in memory and
 * the message cache — no Gmail calls, exactly as a breakdown costs none.
 *
 * Same shape `collect` hands the renderer, minus `settled`: whether a row is
 * still owed sizes is the load's business, not this one's.
 *
 * @param {Iterable<string>} rowIds
 * @returns {Record<string, {count: number, bytes: number, pending: number}>}
 */
export function recountRows(rowIds) {
  const records = {};
  for (const rowId of rowIds) {
    const ids = counts.get(rowId);
    if (ids) records[rowId] = figuresFor(ids, rowId);
  }
  return records;
}

/**
 * Erase one mailbox's membership. Defaults to the signed-in one; an explicit id
 * sweeps expired data, which must leave the live in-memory set alone.
 */
export async function forgetMembership(account) {
  const active = await activeAccount();
  const id = account ?? active;

  if (id === active) {
    counts = new Map();
    estimates = new Map();
    membershipFor = null;
  }
  if (!id) return;

  await chrome.storage.local.remove(membershipKey(id));
}

async function pool(items, limit, worker) {
  let cursor = 0;
  let failed = false;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length && !failed) {
        try {
          await worker(items[cursor++]);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    })
  );
}

const rowsOf = (groups) => [...groups.defaults, ...groups.user];

/**
 * One listing per row, each reported the moment it lands. No row waits on any
 * other, so small labels appear almost immediately and only Inbox-sized ones
 * take their time.
 *
 * A user folder counts every message carrying its label, full stop. An earlier
 * rule excluded anything still in the flow — inbox, sent, drafts, spam, trash —
 * so a row read as "filed away under this label" rather than "in this label".
 * That is a distinction Gmail's own UI never makes, and it left a folder
 * showing a smaller number than the same folder in Gmail with nothing on screen
 * explaining the gap.
 *
 * @returns {Promise<Map<string, string[]>>} row id → exactly the ids its number counts
 */
async function enumerateRows(groups, onRow, stopped) {
  const rows = rowsOf(groups);
  const counted = new Map();

  await pool(rows, LIST_CONCURRENCY, async (row) => {
    if (stopped?.()) return;
    try {
      // A row can carry its own scope — the categories are narrowed to the
      // inbox so they partition it rather than counting archived mail twice.
      const ids = await listMessageIds(row.id, row.scope ? SCOPES[row.scope] : undefined, stopped);
      counted.set(row.id, ids);
      onRow?.(row, ids);
    } catch (err) {
      // Reconnecting fixes an auth problem and nothing else does, so that one
      // stops the load. A single label refusing to list should not.
      if (err instanceof AuthError) throw err;
      console.warn('[MailBoy] could not enumerate', row.id, err);
      onRow?.(row, null);
    }
  });

  return counted;
}

/**
 * Put a size on every row's unread mail without reading any of it — see the note
 * on `SIZE_BANDS`.
 *
 * One listing per band per row, 5 units per 500 ids, against the 20 units a
 * message the real pass costs. It fills `estimates`, which is all the rest of
 * the module reads.
 *
 * Three things keep it cheap, and the first two are what make it affordable at
 * all on a mailbox with many folders:
 *
 * - **Only rows with unread mail are banded.** A second open, where everything
 *   is already cached, spends nothing here.
 * - **A message is banded once.** The rows overlap heavily — the five categories
 *   are subsets of Inbox, and a user folder is mostly inbox mail — so the rows
 *   are walked biggest-first and a row whose unread mail is already banded is
 *   skipped outright. That is what makes the categories free.
 * - **Sequentially, deliberately.** Listings are paced against one shared quota
 *   budget, so running eight at once would not make the pass finish any sooner;
 *   what it would do is race the skip above and band the same mail twice.
 *
 * Nothing here is ever fatal. A band that will not list leaves its mail
 * unestimated, which costs a row its early figure and nothing else.
 *
 * @returns {Promise<number>} how many messages were sorted into a band
 */
async function readBands(groups, counted, records, stopped) {
  /** @type {Map<string, number>} id → which band it fell into */
  const bands = new Map();

  const wanted = [...counted]
    .filter(([rowId]) => (records[rowId]?.pending ?? 0) > 0)
    .sort((a, b) => b[1].length - a[1].length);

  if (!wanted.length) return 0;

  const scopes = new Map(rowsOf(groups).map((row) => [row.id, row.scope ? SCOPES[row.scope] : '']));
  let listings = 0;

  for (const [rowId, ids] of wanted) {
    if (stopped?.()) break;

    const unread = ids.filter((id) => sizeOf(id) === undefined);
    if (unread.every((id) => bands.has(id))) continue;

    const scope = scopes.get(rowId) ?? '';

    for (let band = 0; band < SIZE_BANDS.length; band++) {
      if (stopped?.()) break;
      try {
        const query = [scope, bandQuery(band)].filter(Boolean).join(' ');
        listings++;
        for (const id of await listMessageIds(rowId, query, stopped)) {
          // First band wins. Were the operators inclusive rather than strict the
          // bands would overlap by a byte at each boundary, and the two
          // candidates differ by one byte — so which one is kept does not matter,
          // only that it is decided once.
          if (!bands.has(id)) bands.set(id, band);
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        console.warn('[MailBoy] could not size', rowId, 'band', band, err);
      }
    }
  }

  const weights = calibrate(bands);

  for (const [rowId, ids] of counted) {
    let total = 0;
    let unread = 0;
    for (const id of ids) {
      if (sizeOf(id) !== undefined) continue;
      unread++;
      const band = bands.get(id);
      if (band !== undefined) total += weights[band];
    }
    // Divided by every unread message rather than by the banded ones: mail no
    // band claimed is mail this pass could not size, and spreading the rest over
    // it would quietly inflate the row instead of leaving it a little short.
    if (unread) estimates.set(rowId, total / unread);
    else estimates.delete(rowId);
  }

  // `atLeast`, because a band wide enough to page reports one listing here and
  // spends 5 units a page. It is the floor, and the floor is the part worth
  // watching: it is what every extra band costs on every row.
  trace('listing', 'sized the rows from size bands — no mail read', {
    rows: wanted.length,
    banded: bands.size,
    atLeast: `${listings * 5} units`,
  });

  return bands.size;
}

/**
 * What one message in each band is worth.
 *
 * The midpoints are a starting guess about mail in general; the message cache is
 * this mailbox's own answer, so a band with enough already-measured mail in it
 * uses that instead. It sharpens as the real pass runs, which is the right way
 * round — the estimate is most wrong at the moment it matters least, when there
 * is nothing else on screen either.
 */
function calibrate(bands) {
  const sum = new Array(SIZE_BANDS.length).fill(0);
  const seen = new Array(SIZE_BANDS.length).fill(0);

  for (const [id, band] of bands) {
    const size = sizeOf(id);
    if (size === undefined) continue;
    sum[band] += size;
    seen[band]++;
  }

  return sum.map((total, band) => (seen[band] >= MIN_SAMPLE ? total / seen[band] : midOf(band)));
}

/**
 * The order messages get read in, which decides how the panel fills in: each
 * row's messages queued together, smallest label first, so rows settle one
 * after another rather than all at once at the very end.
 *
 * Deduplicated as it goes — a message sitting in Inbox, Promotions and a user
 * label is read once. Only its queue position is decided here; it still counts
 * towards every row that holds it.
 */
function queueFrom(counted) {
  const universe = new Set();
  const order = [];

  for (const [, ids] of [...counted].sort((a, b) => a[1].length - b[1].length)) {
    for (const id of ids) {
      if (universe.has(id)) continue;
      universe.add(id);
      order.push(id);
    }
  }

  return { order, universe };
}

/**
 * Everything the measuring job needs, rebuilt from nothing.
 *
 * The background worker calls this on every wake rather than persisting a
 * cursor: enumeration is cheap, the message cache already knows what has been
 * read, so "resume" and "start" are the same code path and a termination at
 * any instant is harmless.
 */
export async function buildQueue() {
  // **Stored membership first, and it is nearly always there.** Enumeration is
  // cheap against a size pass but it is not free — a mailbox with 47,000
  // messages in Trash is about 600 quota units and several seconds of listing —
  // and this runs on *every* wake. Chrome ends an idle worker after ~30 seconds
  // and the pacer leaves ~11 between batches, so a long pass is resumed by its
  // alarm many times over, each resume paying for a full re-listing of a mailbox
  // the panel enumerated minutes ago and wrote to disk.
  //
  // Nothing is lost by reading it back. Membership *is* the last enumeration's
  // output, `syncHistory` keeps it patched on every open, and mail that arrived
  // since is handed to the worker directly by `measureNewMail` rather than
  // waiting to be discovered here.
  await restoreMembership();
  if (counts.size) {
    trace('measure', 'queue rebuilt from stored membership — nothing listed', {
      rows: counts.size,
    });
    return queueFrom(counts).order;
  }

  const groups = buildGroups(await listLabels());
  return queueFrom(await enumerateRows(groups)).order;
}

/**
 * @param {{defaults: object[], user: object[]}} groups
 * @param {{onCounts?: Function, onSizes?: Function, measure: Function}} hooks
 *   `measure(order, onBatch)` does the expensive half. The panel delegates it
 *   to the service worker so it outlives the panel being closed.
 * @returns {Promise<Record<string, object | null>>} keyed by label id; null
 *   where the label could not be read
 */
export async function collect(groups, hooks = {}) {
  const rows = rowsOf(groups);
  const stopped = hooks.stopped ?? (() => false);

  /**
   * Sparse on purpose: a missing key means "not known yet" and leaves the
   * row's placeholder alone, where an explicit null means the label could not
   * be read at all.
   */
  const records = {};
  const emit = () => hooks.onCounts?.(snapshot(records));

  // Started now, awaited much later: reading the cache is storage I/O and CPU
  // with no bearing on listing labels, so it runs alongside rather than adding
  // its own wait once the listing is done.
  const cacheReady = loadMessages();

  // Where the change log stands *before* a single label is listed. Enumeration
  // takes seconds, and a bookmark stamped at the end would quietly swallow
  // everything that changed while it ran — the one way this can be wrong that
  // nothing downstream could ever detect. Never fatal: without it the next open
  // lists again, which is only what happens today.
  const bookmarkAt = getProfile()
    .then((profile) => profile.historyId)
    .catch((err) => {
      // `undefined`, not `null`: that leaves `saveMembership` on its default and
      // keeps whatever bookmark is already stored. It is older than the ids this
      // pass is about to write, so the next sync replays a little — which costs
      // nothing, where clearing it would cost a whole listing.
      console.warn('[MailBoy] no change-log position for this pass:', err);
      return undefined;
    });

  // ── Counts, the fast half ──────────────────────────────────────
  //
  // Enumerating every label takes seconds, and a panel of pulsing placeholders
  // for that long reads as broken. labels.get costs 1 quota unit and answers
  // immediately, and now that every unscoped row counts its whole label, it is
  // exactly the number that row will settle on. Deliberately not awaited here —
  // it runs alongside the listing rather than delaying it.
  const provisional = pool(rows, LIST_CONCURRENCY, async (row) => {
    if (stopped()) return;
    try {
      // Google's precomputed total counts the whole label. For a scoped row
      // that is a different number entirely, so it is no head start at all.
      if (row.scope) return;

      const total = (await getLabel(row.id)).messagesTotal ?? 0;

      if (records[row.id]) return; // enumeration got there first
      records[row.id] = { count: total };
      emit();
    } catch (err) {
      // Never fatal: this is a head start, not the source of truth.
      console.warn('[MailBoy] no quick total for', row.id, err);
    }
  });

  // ── Counts, the exact half ─────────────────────────────────────

  // Every row shows a number within a second thanks to the fast half above,
  // while listing carries on behind it for several more. Without a count of
  // its own that reads as the panel having hung.
  let listed = 0;
  hooks.onCounting?.(0, rows.length);

  const counted = await enumerateRows(
    groups,
    (row, ids) => {
      if (!ids) {
        // A label that would not enumerate may still have a provisional total,
        // and a real number beats a dash.
        records[row.id] = records[row.id] ?? null;
      } else {
        records[row.id] = { count: ids.length };
      }

      hooks.onCounting?.(++listed, rows.length);
      emit();
    },
    stopped
  );

  // A stopped enumeration is partial, and partial membership is worse than
  // none: it would drop ids for every row it did not reach.
  //
  // Held as a promise because the band pass below re-saves the same ids with the
  // estimates it works out, and two unordered writes of one key can land in
  // either order — the wrong one dropping the estimates a moment after they were
  // written.
  let membershipSaved = Promise.resolve();

  if (!stopped()) {
    // Available to a drill-down from here on, before sizes are in: the ids are
    // final, only what is known about each message is still filling in.
    counts = counted;
    // This enumeration is Gmail's own answer, so it supersedes anything an
    // action projected before it ran.
    patched = new Set();
    membershipSaved = bookmarkAt.then((historyId) => {
      trace('listing', 'enumerated every row', {
        rows: counted.size,
        messages: [...counted.values()].reduce((sum, ids) => sum + ids.length, 0),
        bookmark: historyId ?? '(unchanged — no profile for this pass)',
      });
      return saveMembership(counted, historyId);
    });
  } else {
    trace('listing', 'stopped partway — membership and bookmark left alone');
  }

  await provisional;
  emit();

  // ── Sizes ──────────────────────────────────────────────────────

  await cacheReady;

  const { order } = queueFrom(counted);

  // Which rows a message counts towards, so each batch can update running
  // totals in place instead of re-summing every label.
  /** @type {Map<string, string[]>} */
  const owners = new Map();
  for (const [rowId, ids] of counted) {
    for (const id of ids) {
      const list = owners.get(id);
      if (list) list.push(rowId);
      else owners.set(id, [rowId]);
    }
  }

  tally(counted, records);

  const outstanding = order.filter((id) => !isMeasured(id)).length;

  // **This one is load-bearing where it stands.** The first `onSizes` is the
  // moment enumeration is finished, and the panel takes it as the signal that
  // its counts are final — it stamps the timestamp and writes the snapshot on
  // it. The band pass below is another twenty seconds of listing, and delaying
  // this by that long would hold back numbers that are already right.
  hooks.onSizes?.(snapshot(records), 0, outstanding);

  // ── Sizes, the cheap half ──────────────────────────────────────
  //
  // A figure on every row in seconds, from listings rather than from reading
  // mail — see `readBands`. It runs *after* the tally so it can skip whatever
  // the cache already answers for, and before the real pass so there is
  // something on screen for the hours that one can take. It changes nothing
  // about that pass: every message is still read, because the sender and the
  // date come back with the size and exist nowhere else.
  if (outstanding && !stopped()) {
    try {
      await readBands(groups, counted, records, stopped);
      tally(counted, records);
      hooks.onSizes?.(snapshot(records), 0, outstanding);

      // Re-saved because the estimates ride with the ids, and the ids were
      // written before this ran. Chained onto that write rather than racing it.
      // Without it a panel reopened before the pass ends goes back to spinners
      // over rows it had a figure for.
      if (!stopped()) {
        membershipSaved = membershipSaved.then(() => saveMembership(counted));
        void membershipSaved;
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      // The rows simply spin until the real pass reaches them, which is what
      // they did before any of this existed.
      console.warn('[MailBoy] could not size the rows from bands:', err);
    }
  }

  if (outstanding && hooks.measure && !stopped()) {
    let refilledAt = Date.now();

    await hooks.measure(order, (found, done, total) => {
      for (const [id, bytes] of found) {
        for (const rowId of owners.get(id) ?? []) {
          records[rowId].bytes += bytes;
          records[rowId].pending--;
          // A real size has replaced an estimated one, so the row is owed one
          // message less of estimate. Recomputed from what is left rather than
          // subtracted, which keeps it exactly what `figuresFor` would say and
          // lands on zero at the same moment `pending` does.
          records[rowId].estimated = estimateFor(rowId, records[rowId].pending);
        }
      }

      // **A pass this panel did not start never reports what it read before the
      // panel connected**, and the worker's queue is shared — so those rows would
      // sit short until the pass ended, which on a large mailbox is hours. The
      // cache is where that work actually is, so it is re-read as the pass runs
      // rather than only on the way out. `refill` rather than `tally`, because a
      // cache behind the port must not un-measure a row. Not awaited: this is the
      // hot path, and the next batch reports whatever it lands.
      if (Date.now() - refilledAt > REFILL_MS) {
        refilledAt = Date.now();
        void reloadMessages().then(() => {
          refill(counted, records);
          hooks.onSizes?.(snapshot(records), done, total);
        });
      }

      hooks.onSizes?.(snapshot(records), done, total);
    });

    // The worker did the writing, so this copy is behind. A drill-down reads
    // senders straight from it.
    await reloadMessages();

    // Recompute rather than trust the running totals. The worker flushes on
    // its own schedule, so a panel that opened mid-pass started from a cache
    // that was already behind — and those messages, being measured before this
    // panel connected, are never sent to it. Without this the affected rows
    // would sit permanently short.
    tally(counted, records);
  }

  // Settled: any row still short of a full measurement is short for good, not
  // waiting. The renderer needs that to know when to stop spinning.
  return snapshot(records, true);
}

/**
 * One row's number and size, and how much of it is still unread.
 *
 * `bytes` is only ever mail that has actually been read, and `estimated` is what
 * the band pass says the rest is worth. Kept apart rather than summed because
 * the caller has to be able to say which it is showing — and because the running
 * pass adds real sizes into `bytes` as they land, which would double-count
 * anything already folded into the same figure.
 */
function figuresFor(ids, rowId) {
  let bytes = 0;
  let pending = 0;
  for (const id of ids) {
    const size = sizeOf(id);
    if (size === undefined) pending++;
    else bytes += size;
  }
  return { count: ids.length, bytes, pending, estimated: estimateFor(rowId, pending) };
}

/** What the band pass says a row's unread mail is worth. Zero where it has none. */
function estimateFor(rowId, pending) {
  if (!pending) return 0;
  return Math.round(pending * (estimates.get(rowId) ?? 0));
}

/** Per-row size and how much of it is still unread, straight from the cache. */
function tally(counted, records) {
  for (const [rowId, ids] of counted) Object.assign(records[rowId], figuresFor(ids, rowId));
}

/**
 * Fold the cache back into the running totals, keeping whichever knows more.
 *
 * `tally` replaces a row outright, which is right before a pass starts and right
 * once one has ended — and wrong in the middle of one, because the worker flushes
 * to disk on its own schedule and the cache can therefore be *behind* sizes it
 * has already reported over the port. Replacing a row from a cache that is behind
 * puts a spinner back over a figure, which is the one thing a re-read must never
 * do.
 *
 * Fewer pending is the test for which knows more: it only ever falls, so this is
 * monotone whichever order the two sources arrive in.
 */
function refill(counted, records) {
  for (const [rowId, ids] of counted) {
    const record = records[rowId];
    if (!record) continue;

    const fresh = figuresFor(ids, rowId);
    if (fresh.pending < (record.pending ?? Infinity)) Object.assign(record, fresh);
  }
}

/** Records get rendered and cached, so hand out copies rather than live state. */
function snapshot(records, settled = false) {
  // A row an action has moved mail out of was enumerated before it moved, and
  // this load will keep emitting that enumeration for as long as measuring
  // takes. Re-derive those few rows rather than repaint mail where it is not.
  for (const rowId of patched) {
    const ids = counts.get(rowId);
    if (ids && records[rowId]) Object.assign(records[rowId], figuresFor(ids, rowId));
  }

  const out = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = record ? { ...record, settled } : null;
  }
  return out;
}
