// Everything the panel shows, derived from one cheap pass over label
// membership plus the per-message cache.
//
// Nothing about a label's contents is kept between loads except each message's
// size and sender, neither of which can change. Counts come from enumerating
// the labels every time, because that is both exact and nearly free.

import { AuthError, getLabel, listLabels, listMessageIds } from './gmail.js';
import { buildGroups } from './labels.js';
import { bySender, hasMessage, loadMessages, reloadMessages, sizeOf } from './messages.js';

/**
 * A message matching none of these is filed away rather than still in the flow.
 *
 * This was briefly reimplemented as set subtraction over the flow labels'
 * message ids. That was exact, but it made every user label wait on Inbox —
 * the largest label in the mailbox — before it could show a number, because
 * the subtraction needs the whole flow enumerated first. Asking Gmail to do
 * the filtering costs the same 5 quota units a page and lets each label
 * resolve on its own, so the panel fills in as results arrive rather than all
 * at once at the end.
 *
 * The original reason for moving away from this query — a 10,000-message cap —
 * was our own page limit, not Gmail's, and is gone.
 */
const UNFILED_QUERY = '-in:inbox -in:sent -in:trash -in:spam -is:draft -in:chats';

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

const MEMBERSHIP_KEY = 'membership';

/** Every sender behind a label's number, heaviest first. No Gmail calls. */
export function sendersIn(labelId) {
  return bySender(counts.get(labelId) ?? []);
}

/**
 * Enumeration now runs at most once a day, so its result has to outlive the
 * panel — otherwise a breakdown would have no ids to aggregate on any open that
 * skipped it, which is most of them.
 */
async function saveMembership(counted) {
  try {
    await chrome.storage.local.set({
      [MEMBERSHIP_KEY]: { savedAt: Date.now(), ids: Object.fromEntries(counted) },
    });
  } catch (err) {
    // Costs a breakdown until the next enumeration, never the panel.
    console.warn('[MailBoy] membership not saved:', err);
  }
}

/** Put the last enumeration back in memory when this open skipped its own. */
export async function restoreMembership() {
  if (counts.size) return;
  try {
    const { [MEMBERSHIP_KEY]: stored } = await chrome.storage.local.get(MEMBERSHIP_KEY);
    if (stored?.ids) counts = new Map(Object.entries(stored.ids));
  } catch (err) {
    console.warn('[MailBoy] membership unreadable:', err);
  }
}

export function forgetMembership() {
  counts = new Map();
  return chrome.storage.local.remove(MEMBERSHIP_KEY);
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

const rowsOf = (groups) => [...groups.mailboxes, ...groups.categories, ...groups.user];

/**
 * One listing per row, each reported the moment it lands. No row waits on any
 * other, so small labels appear almost immediately and only Inbox-sized ones
 * take their time.
 *
 * @returns {Promise<Map<string, string[]>>} row id → exactly the ids its number counts
 */
async function enumerateRows(groups, onRow) {
  const rows = rowsOf(groups);
  const isUser = new Set(groups.user.map((row) => row.id));
  const counted = new Map();

  await pool(rows, LIST_CONCURRENCY, async (row) => {
    const filed = isUser.has(row.id);
    try {
      const ids = await listMessageIds(row.id, filed ? UNFILED_QUERY : undefined);
      counted.set(row.id, ids);
      onRow?.(row, ids, filed);
    } catch (err) {
      // Reconnecting fixes an auth problem and nothing else does, so that one
      // stops the load. A single label refusing to list should not.
      if (err instanceof AuthError) throw err;
      console.warn('[MailBoy] could not enumerate', row.id, err);
      onRow?.(row, null, filed);
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
 * @param {{mailboxes: object[], categories: object[], user: object[]}} groups
 * @param {{onCounts?: Function, onSizes?: Function, measure: Function}} hooks
 *   `measure(order, onBatch)` does the expensive half. The panel delegates it
 *   to the service worker so it outlives the panel being closed.
 * @returns {Promise<Record<string, object | null>>} keyed by label id; null
 *   where the label could not be read
 */
export async function collect(groups, hooks = {}) {
  const rows = rowsOf(groups);

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

  const isUser = new Set(groups.user.map((row) => row.id));

  /** @type {Map<string, number>} user label id → messages in the label overall */
  const totals = new Map();

  // ── Counts, the fast half ──────────────────────────────────────
  //
  // Enumerating every label takes seconds, and a panel of pulsing placeholders
  // for that long reads as broken. labels.get costs 1 quota unit and answers
  // immediately: for a system row that total is exactly the number displayed,
  // and for a user row it is the tooltip's "in the label" figure. Deliberately
  // not awaited here — it runs alongside the listing rather than delaying it.
  const provisional = pool(rows, LIST_CONCURRENCY, async (row) => {
    try {
      const total = (await getLabel(row.id)).messagesTotal ?? 0;

      if (isUser.has(row.id)) {
        // Not the number a user row shows — filed-away is a subset — so this
        // only ever fills in the tooltip.
        totals.set(row.id, total);
        if (records[row.id]) {
          records[row.id] = { ...records[row.id], total };
          emit();
        }
        return;
      }

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

  const counted = await enumerateRows(groups, (row, ids, filed) => {
    if (!ids) {
      // A label that would not enumerate may still have a provisional total,
      // and a real number beats a dash.
      records[row.id] = records[row.id] ?? null;
    } else {
      records[row.id] = filed
        ? { count: ids.length, total: totals.get(row.id) }
        : { count: ids.length };
    }
    hooks.onCounting?.(++listed, rows.length);
    emit();
  });

  // Available to a drill-down from here on, before sizes are in: the ids are
  // final, only what is known about each message is still filling in.
  counts = counted;
  void saveMembership(counted);

  await provisional;

  // Totals that arrived after their row was already painted.
  for (const [id, total] of totals) {
    if (records[id] && records[id].total === undefined) records[id].total = total;
  }

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

  const outstanding = order.filter((id) => !hasMessage(id)).length;
  hooks.onSizes?.(snapshot(records), 0, outstanding);

  if (outstanding && hooks.measure) {
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

/** Per-row size and how much of it is still unread, straight from the cache. */
function tally(counted, records) {
  for (const [rowId, ids] of counted) {
    let bytes = 0;
    let pending = 0;
    for (const id of ids) {
      const size = sizeOf(id);
      if (size === undefined) pending++;
      else bytes += size;
    }
    Object.assign(records[rowId], { bytes, pending });
  }
}

/** Records get rendered and cached, so hand out copies rather than live state. */
function snapshot(records, settled = false) {
  const out = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = record ? { ...record, settled } : null;
  }
  return out;
}
