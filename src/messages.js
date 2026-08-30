// The per-message cache: size and sender, keyed by message id.
//
// Reading these is the only expensive thing MailBoy does — 5 quota units a
// message against Gmail's 250-per-second ceiling, so about 50 messages a
// second. What makes it bearable is that neither figure ever changes: once
// known a message is known forever, and the cost becomes one-time per message
// rather than per panel open.
//
// Label membership is deliberately *not* cached. That does change, and
// re-reading it costs 5 units per 500 ids, so it is cheaper to ask than to
// keep correct.

import { fetchMessageMeta } from './gmail.js';
import { parseFrom } from './sender.js';

/** Sharded so a refresh rewrites only the buckets it touched — chrome.storage
 *  re-serialises a whole key on every write. */
const SHARDS = 16;
const shardKey = (n) => `msg:${n}`;
const SENDERS_KEY = 'msg:senders';

/**
 * The cache before senders existed held bare byte counts and cannot answer who
 * sent anything. Carrying a half-populated state would complicate every read,
 * so it is dropped instead. Safe to delete this once published — no released
 * version ever wrote those keys.
 */
const LEGACY_KEYS = Array.from({ length: 16 }, (_, n) => `sizes:${n}`);

/** Past this the cache is pruned down to whatever the last load actually saw. */
const MAX_ENTRIES = 400_000;

/**
 * Dates are kept as whole days since the epoch rather than milliseconds: a
 * frequency over a span of months needs nothing finer, and the shorter number
 * costs far less across hundreds of thousands of entries.
 */
const DAY_MS = 86_400_000;

/** @type {Map<string, [bytes: number, sender: number, day: number]> | null} */
let messages = null;

/**
 * An entry written before dates were captured has only two fields. It is not
 * wrong — its size and sender are still good — but it cannot answer how often
 * a sender writes, so it is queued for re-reading.
 */
const complete = (entry) => Array.isArray(entry) && entry.length >= 3;

/**
 * Senders interned to an index, because the same address recurs across
 * thousands of messages and storing it inline would dwarf the rest.
 * @type {{address: string, name: string}[]}
 */
let senders = [];

/** @type {Map<string, number>} grouping key → index into `senders` */
let senderIndex = new Map();

const dirty = new Set();
let sendersDirty = false;

function shardOf(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (hash >>> 0) % SHARDS;
}

/** Group on the address; the display name only decides what is rendered. */
const keyOf = (sender) => sender.address || sender.name || '';

function intern(from) {
  const parsed = parseFrom(from);
  const key = keyOf(parsed);

  const existing = senderIndex.get(key);
  if (existing !== undefined) {
    // First readable name wins: plenty of messages carry only a bare address.
    if (parsed.name && !senders[existing].name) {
      senders[existing].name = parsed.name;
      sendersDirty = true;
    }
    return existing;
  }

  const index = senders.length;
  senders.push(parsed);
  senderIndex.set(key, index);
  sendersDirty = true;
  return index;
}

/** In-flight read, so two callers starting at once do the work once. */
let loading = null;

/** Load the cache into memory. A cold cache is a normal path, not a failure. */
export function loadMessages() {
  if (messages) return Promise.resolve();
  loading ??= readAll().finally(() => {
    loading = null;
  });
  return loading;
}

async function readAll() {
  messages = new Map();
  senders = [];
  senderIndex = new Map();

  const keys = [...Array.from({ length: SHARDS }, (_, n) => shardKey(n)), SENDERS_KEY];

  try {
    const stored = await chrome.storage.local.get(keys);

    senders = Array.isArray(stored[SENDERS_KEY]) ? stored[SENDERS_KEY] : [];
    senders.forEach((sender, index) => senderIndex.set(keyOf(sender), index));

    for (let n = 0; n < SHARDS; n++) {
      for (const [id, entry] of Object.entries(stored[shardKey(n)] ?? {})) {
        if (Array.isArray(entry)) messages.set(id, entry);
      }
    }
  } catch (err) {
    console.warn('[MailBoy] message cache unreadable, starting empty:', err);
  }

  chrome.storage.local.remove(LEGACY_KEYS).catch(() => {});
}

/**
 * Re-read from storage. The service worker owns the writing now, so a panel
 * that has been open across a measuring pass is holding a stale copy.
 */
export async function reloadMessages() {
  messages = null;
  loading = null;
  dirty.clear();
  sendersDirty = false;
  await loadMessages();
}

/** @returns {number | undefined} */
export function sizeOf(id) {
  return messages?.get(id)?.[0];
}

/** @returns {number} whole days since the epoch, or 0 when not yet known */
export function dayOf(id) {
  return messages?.get(id)?.[2] ?? 0;
}

/** @returns {{address: string, name: string} | undefined} */
export function senderOf(id) {
  const entry = messages?.get(id);
  return entry ? senders[entry[1]] : undefined;
}

/**
 * Everything known about this message, dates included.
 *
 * Deliberately not "is it in the cache": an entry written before dates were
 * captured is present but incomplete, and the gate that decides whether a
 * measuring pass is worth starting has to agree with `ensureMeta` about what
 * still needs reading. Disagree, and a backfill silently never runs.
 */
export function isMeasured(id) {
  return complete(messages?.get(id));
}

/**
 * Count and total size per sender across `ids`, heaviest first.
 *
 * Entirely local — the ids come from a live label enumeration and everything
 * else is already cached, so a drill-down costs no Gmail calls at all.
 *
 * `sinceDay` narrows it to messages from that day onward.
 *
 * `undated` is not "mail without a date" — every message has one. It counts
 * entries written before dates were captured, which have a size and a sender
 * but an empty date slot until the backfill re-reads them. They cannot be
 * placed in time, so a filtered view excludes them and reports the number;
 * including them would be wrong, and dropping them silently would make the
 * period look emptier than it is. It reaches zero once the backfill finishes.
 *
 * @returns {{senders: object[], cached: number, matched: number,
 *   undated: number, bytes: number}} each sender carries `count`, `bytes` and
 *   `dated`/`first`/`last` in whole days since the epoch.
 */
export function bySender(ids, sinceDay = 0) {
  const totals = new Map();
  let cached = 0;
  let matched = 0;
  let undated = 0;
  let bytesTotal = 0;

  for (const id of ids) {
    const entry = messages?.get(id);
    if (!entry) continue; // not measured yet
    cached++;

    const [bytes, index, day] = entry;

    if (sinceDay) {
      if (!day) {
        undated++;
        continue;
      }
      if (day < sinceDay) continue;
    }

    matched++;
    bytesTotal += bytes;

    let row = totals.get(index);
    if (!row) {
      row = {
        ...(senders[index] ?? { address: '', name: '' }),
        count: 0,
        bytes: 0,
        dated: 0,
        first: 0,
        last: 0,
      };
      totals.set(index, row);
    }
    row.count++;
    row.bytes += bytes;

    // Span comes only from messages whose date is known, so a partly
    // backfilled cache reports a rate over what it can actually see.
    if (day) {
      row.dated++;
      if (!row.first || day < row.first) row.first = day;
      if (day > row.last) row.last = day;
    }
  }

  return {
    senders: [...totals.values()].sort((a, b) => b.bytes - a.bytes),
    cached,
    matched,
    undated,
    bytes: bytesTotal,
  };
}

/**
 * How much measured work to risk. A first run over a large mailbox takes
 * minutes, and the panel can be closed at any point in it, so the cache is
 * written out along the way rather than only at the end.
 */
const FLUSH_EVERY = 5000;
const FLUSH_AFTER_MS = 60_000;

/**
 * Fill in every message not already cached.
 *
 * `onBatch(found, done, total)` fires as each batch lands so a long first run
 * can show where it has got to; `found` maps id → bytes. Ids already known are
 * filtered out of it, so a caller keeping running totals cannot double-count.
 */
export async function ensureMeta(ids, onBatch, stopped) {
  await loadMessages();

  // Includes entries that predate dates: same 5 quota units, and re-reading is
  // the only way to fill them in.
  const missing = ids.filter((id) => !complete(messages.get(id)));
  if (!missing.length) return;

  let done = 0;
  let sinceFlush = 0;
  let lastFlush = Date.now();

  const onFound = (found) => {
    const fresh = new Map();
    let written = 0;

    for (const [id, { bytes, from, date }] of found) {
      const before = messages.get(id);
      if (complete(before)) continue; // a retry that arrived twice

      const day = date > 0 ? Math.round(date / DAY_MS) : 0;
      messages.set(id, [bytes, intern(from), day]);
      dirty.add(shardOf(id));
      written++;

      // Only a size the caller has never seen moves its running totals. A
      // backfill re-reads sizes that were already counted, and handing those
      // back would double them.
      if (!before) fresh.set(id, bytes);
    }
    if (!written) return;

    done += written;
    sinceFlush += written;
    onBatch?.(fresh, done, missing.length);

    if (sinceFlush >= FLUSH_EVERY || Date.now() - lastFlush > FLUSH_AFTER_MS) {
      sinceFlush = 0;
      lastFlush = Date.now();
      // Deliberately not awaited: measuring should not stall on a disk write.
      void flushMessages();
    }
  };

  await fetchMessageMeta(missing, onFound, stopped);
}

/** Writes are serialised: an interval flush must not overlap the final one. */
let writing = Promise.resolve();

/**
 * Persist whatever changed. `seen` is every id the load touched; when the
 * cache has outgrown its ceiling, that set is what survives — anything else is
 * mail that has since been deleted or filed somewhere the panel does not show.
 */
export function flushMessages(seen) {
  writing = writing.then(() => write(seen));
  return writing;
}

async function write(seen) {
  if (!messages) return;

  if (seen && messages.size > MAX_ENTRIES) prune(seen);
  if (!dirty.size && !sendersDirty) return;

  const payload = {};
  for (const shard of dirty) payload[shardKey(shard)] = {};
  for (const [id, entry] of messages) {
    const key = shardKey(shardOf(id));
    if (key in payload) payload[key][id] = entry;
  }
  if (sendersDirty) payload[SENDERS_KEY] = senders;

  dirty.clear();
  sendersDirty = false;

  try {
    await chrome.storage.local.set(payload);
  } catch (err) {
    // A blown quota should cost the cache, never the panel.
    console.warn('[MailBoy] message cache not saved:', err);
  }
}

function prune(seen) {
  const kept = new Map();
  for (const id of seen) {
    const entry = messages.get(id);
    if (entry) kept.set(id, entry);
  }
  messages = kept;

  // Senders left behind would accumulate forever, so the table is rebuilt
  // against what survived and every surviving entry is remapped onto it.
  const previous = senders;
  const remap = new Map();
  senders = [];
  senderIndex = new Map();

  for (const entry of messages.values()) {
    const old = entry[1];
    let next = remap.get(old);
    if (next === undefined) {
      const sender = previous[old] ?? { address: '', name: '' };
      next = senders.length;
      senders.push(sender);
      senderIndex.set(keyOf(sender), next);
      remap.set(old, next);
    }
    entry[1] = next;
  }

  for (let n = 0; n < SHARDS; n++) dirty.add(n);
  sendersDirty = true;
}

export async function clearMessages() {
  messages = null;
  senders = [];
  senderIndex = new Map();
  dirty.clear();
  sendersDirty = false;
  await chrome.storage.local.remove([
    ...Array.from({ length: SHARDS }, (_, n) => shardKey(n)),
    SENDERS_KEY,
    ...LEGACY_KEYS,
  ]);
}
