// Everything the panel shows, derived from one cheap pass over label
// membership plus the per-message cache.
//
// Nothing about a label's contents is kept between loads except each message's
// size and sender, neither of which can change. Counts come from enumerating
// the labels every time, because that is both exact and nearly free.

import { activeAccount, keyFor } from './account.js';
import { AuthError, getLabel, listLabels, listMessageIds } from './gmail.js';
import { buildGroups } from './labels.js';
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

/** Listing is paced by the quota reserver, so concurrency only hides latency. */
const LIST_CONCURRENCY = 8;

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
async function saveMembership(counted) {
  try {
    const account = await activeAccount();
    if (!account) return;

    await chrome.storage.local.set({
      [membershipKey(account)]: { savedAt: Date.now(), ids: Object.fromEntries(counted) },
    });
  } catch (err) {
    // Costs a breakdown until the next enumeration, never the panel.
    console.warn('[MailBoy] membership not saved:', err);
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
  if (counts.size) return;
  try {
    const account = await activeAccount();
    if (!account) return;

    const key = membershipKey(account);
    const { [key]: stored } = await chrome.storage.local.get(key);
    if (stored?.ids) counts = new Map(Object.entries(stored.ids));
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
  patched = new Set();
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
 * Whoever calls it owes the user a real load when the job reports back,
 * whether it succeeded, was stopped or failed.
 *
 * Rows the last enumeration never reached are skipped rather than invented. An
 * absent row means "not known", and seeding one with just these ids would
 * claim the folder holds nothing else.
 *
 * @param {Iterable<string>} ids the messages that are moving
 * @param {{add?: string[], remove?: string[]}} where in MailBoy's rows, which
 *   is not the same list as the labels the job sends Gmail
 * @returns {string[]} the rows whose contents changed
 */
export function patchMessages(ids, { add = [], remove = [] } = {}) {
  const moving = new Set(ids);

  // An empty map means `restoreMembership` has not finished — the same trap
  // `patchMembership` guards against, and here it would also save a map of
  // almost nothing over the real one.
  if (!counts.size || !moving.size) return [];

  const touched = new Set();

  for (const rowId of remove) {
    const current = counts.get(rowId);
    if (!current) continue;

    const kept = current.filter((id) => !moving.has(id));
    if (kept.length === current.length) continue;

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
  return [...touched];
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
    if (ids) records[rowId] = figuresFor(ids);
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

  if (id === active) counts = new Map();
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
  if (!stopped()) {
    // Available to a drill-down from here on, before sizes are in: the ids are
    // final, only what is known about each message is still filling in.
    counts = counted;
    // This enumeration is Gmail's own answer, so it supersedes anything an
    // action projected before it ran.
    patched = new Set();
    void saveMembership(counted);
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
  hooks.onSizes?.(snapshot(records), 0, outstanding);

  if (outstanding && hooks.measure && !stopped()) {
    await hooks.measure(order, (found, done, total) => {
      for (const [id, bytes] of found) {
        for (const rowId of owners.get(id) ?? []) {
          records[rowId].bytes += bytes;
          records[rowId].pending--;
        }
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

/** One row's number and size, and how much of it is still unread. */
function figuresFor(ids) {
  let bytes = 0;
  let pending = 0;
  for (const id of ids) {
    const size = sizeOf(id);
    if (size === undefined) pending++;
    else bytes += size;
  }
  return { count: ids.length, bytes, pending };
}

/** Per-row size and how much of it is still unread, straight from the cache. */
function tally(counted, records) {
  for (const [rowId, ids] of counted) Object.assign(records[rowId], figuresFor(ids));
}

/** Records get rendered and cached, so hand out copies rather than live state. */
function snapshot(records, settled = false) {
  // A row an action has moved mail out of was enumerated before it moved, and
  // this load will keep emitting that enumeration for as long as measuring
  // takes. Re-derive those few rows rather than repaint mail where it is not.
  for (const rowId of patched) {
    const ids = counts.get(rowId);
    if (ids && records[rowId]) Object.assign(records[rowId], figuresFor(ids));
  }

  const out = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = record ? { ...record, settled } : null;
  }
  return out;
}
