// Everything the panel shows, derived from one cheap pass over label
// membership plus the size cache.
//
// Nothing about a label's contents is kept between loads except message sizes,
// which cannot change. Counts come from enumerating the labels every time,
// because that is both exact and nearly free.

import { AuthError, getLabel, listMessageIds } from './gmail.js';
import { ensureSizes, flushSizes, hasSize, loadSizes, sizeOf } from './sizes.js';

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

/**
 * @param {{mailboxes: object[], categories: object[], user: object[]}} groups
 * @param {{onCounts?: Function, onSizes?: Function}} hooks
 * @returns {Promise<Record<string, {count: number, total?: number, bytes: number,
 *   pending: number} | null>>} keyed by label id; null where the label could
 *   not be read
 */
export async function collect(groups, hooks = {}) {
  const system = [...groups.mailboxes, ...groups.categories];
  const rows = [...system, ...groups.user];

  /**
   * Sparse on purpose: a missing key means "not known yet" and leaves the
   * row's placeholder alone, where an explicit null means the label could not
   * be read at all.
   */
  const records = {};
  const emit = () => hooks.onCounts?.(snapshot(records));

  const isUser = new Set(groups.user.map((row) => row.id));

  /** @type {Map<string, string[]>} row id → exactly the ids its number counts */
  const counted = new Map();

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
  //
  // One listing per row, each painted the moment it lands. No row waits on any
  // other, so small labels appear almost immediately and only Inbox-sized ones
  // take their time.
  await pool(rows, LIST_CONCURRENCY, async (row) => {
    try {
      const ids = await listMessageIds(row.id, isUser.has(row.id) ? UNFILED_QUERY : undefined);
      counted.set(row.id, ids);
      records[row.id] = isUser.has(row.id)
        ? { count: ids.length, total: totals.get(row.id) }
        : { count: ids.length };
    } catch (err) {
      // Reconnecting fixes an auth problem and nothing else does, so that one
      // stops the load. A single label refusing to list should not — and if it
      // has a provisional total, a real number beats a dash.
      if (err instanceof AuthError) throw err;
      console.warn('[MailBoy] could not enumerate', row.id, err);
      records[row.id] = records[row.id] ?? null;
    }
    emit();
  });

  await provisional;

  // Totals that arrived after their row was already painted.
  for (const [id, total] of totals) {
    if (records[id] && records[id].total === undefined) records[id].total = total;
  }

  emit();

  // ── Sizes ──────────────────────────────────────────────────────

  await loadSizes();

  // Fetch order decides how the panel fills in, so it is chosen rather than
  // incidental: each row's messages are queued together, smallest label first.
  // Rows then settle one after another, small labels within the first batch,
  // rather than every row landing at once at the very end.
  //
  // Deduplicated as we go, so a message sitting in Inbox, Promotions and a
  // user label is read once. Only its queue position is decided here — it is
  // still counted towards every row that holds it, via `owners` below.
  const universe = new Set();
  const order = [];
  const bySize = [...counted].sort((a, b) => a[1].length - b[1].length);
  for (const [, ids] of bySize) {
    for (const id of ids) {
      if (universe.has(id)) continue;
      universe.add(id);
      order.push(id);
    }
  }

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

  const outstanding = order.filter((id) => !hasSize(id)).length;
  hooks.onSizes?.(snapshot(records), 0, outstanding);

  try {
    await ensureSizes(order, (found, done, total) => {
      for (const [id, bytes] of found) {
        for (const rowId of owners.get(id) ?? []) {
          records[rowId].bytes += bytes;
          records[rowId].pending--;
        }
      }
      hooks.onSizes?.(snapshot(records), done, total);
    });
  } finally {
    // Whatever was measured before a failure is still worth keeping.
    await flushSizes(universe);
  }

  // Settled: any row still short of a full measurement is short for good, not
  // waiting. The renderer needs that to know when to stop spinning.
  return snapshot(records, true);
}

/** Records get rendered and cached, so hand out copies rather than live state. */
function snapshot(records, settled = false) {
  const out = {};
  for (const [id, record] of Object.entries(records)) {
    out[id] = record ? { ...record, settled } : null;
  }
  return out;
}
