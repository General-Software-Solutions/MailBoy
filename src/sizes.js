// The size cache.
//
// Reading sizes is the only expensive thing MailBoy does — 5 quota units a
// message against Gmail's 250-per-second ceiling, so about 50 messages a
// second. What makes that bearable is that a message's size never changes:
// once known it is worth keeping forever, and the cost becomes one-time per
// message rather than per panel open.
//
// Label membership is deliberately *not* cached. That does change, and
// re-reading it costs 5 units per 500 ids, so it is cheaper to ask than to
// keep correct.

import { fetchSizes } from './gmail.js';

/** Sharded so a refresh rewrites only the buckets it touched — chrome.storage
 *  re-serialises a whole key on every write. */
const SHARDS = 16;
const shardKey = (n) => `sizes:${n}`;

/** Past this the cache is pruned down to whatever the last load actually saw. */
const MAX_ENTRIES = 400_000;

/** @type {Map<string, number> | null} message id → sizeEstimate in bytes */
let sizes = null;

/** Shards changed since the last flush. */
const dirty = new Set();

function shardOf(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (hash >>> 0) % SHARDS;
}

/** Load the cache into memory. A cold cache is a normal path, not a failure. */
export async function loadSizes() {
  if (sizes) return;

  const keys = Array.from({ length: SHARDS }, (_, n) => shardKey(n));
  sizes = new Map();

  try {
    const stored = await chrome.storage.local.get(keys);
    for (const key of keys) {
      for (const [id, bytes] of Object.entries(stored[key] ?? {})) sizes.set(id, bytes);
    }
  } catch (err) {
    console.warn('[MailBoy] size cache unreadable, starting empty:', err);
  }
}

/** @returns {number | undefined} */
export function sizeOf(id) {
  return sizes?.get(id);
}

export function hasSize(id) {
  return sizes?.has(id) ?? false;
}

/**
 * How much measured work to risk. A first run over a large mailbox takes
 * minutes, and the panel can be closed at any point in it, so the cache is
 * written out along the way rather than only at the end.
 */
const FLUSH_EVERY = 5000;
const FLUSH_AFTER_MS = 60_000;

/**
 * Fill in every size not already cached.
 *
 * `onBatch(found, done, total)` fires as each batch lands so a long first run
 * can show where it has got to. Ids already known are filtered out of `found`,
 * so a caller keeping running totals can add without double-counting.
 */
export async function ensureSizes(ids, onBatch) {
  await loadSizes();

  const missing = ids.filter((id) => !sizes.has(id));
  if (!missing.length) return;

  let done = 0;
  let sinceFlush = 0;
  let lastFlush = Date.now();

  await fetchSizes(missing, (found) => {
    const fresh = new Map();
    for (const [id, bytes] of found) {
      if (sizes.has(id)) continue; // a retry that arrived twice
      sizes.set(id, bytes);
      dirty.add(shardOf(id));
      fresh.set(id, bytes);
    }
    if (!fresh.size) return;

    done += fresh.size;
    sinceFlush += fresh.size;
    onBatch?.(fresh, done, missing.length);

    if (sinceFlush >= FLUSH_EVERY || Date.now() - lastFlush > FLUSH_AFTER_MS) {
      sinceFlush = 0;
      lastFlush = Date.now();
      // Deliberately not awaited: measuring should not stall on a disk write.
      void flushSizes();
    }
  });
}

/** Writes are serialised: an interval flush must not overlap the final one. */
let writing = Promise.resolve();

/**
 * Persist whatever changed. `seen` is every id the load touched; when the
 * cache has outgrown its ceiling, that set is what survives — anything else is
 * mail that has since been deleted or filed somewhere the panel does not show.
 */
export function flushSizes(seen) {
  writing = writing.then(() => write(seen));
  return writing;
}

async function write(seen) {
  if (!sizes) return;

  if (seen && sizes.size > MAX_ENTRIES) {
    const kept = new Map();
    for (const id of seen) {
      const bytes = sizes.get(id);
      if (bytes !== undefined) kept.set(id, bytes);
    }
    sizes = kept;
    for (let n = 0; n < SHARDS; n++) dirty.add(n);
  }

  if (!dirty.size) return;

  const write = {};
  for (const shard of dirty) write[shardKey(shard)] = {};
  for (const [id, bytes] of sizes) {
    const key = shardKey(shardOf(id));
    if (key in write) write[key][id] = bytes;
  }
  dirty.clear();

  try {
    await chrome.storage.local.set(write);
  } catch (err) {
    // A blown quota should cost the cache, never the panel.
    console.warn('[MailBoy] size cache not saved:', err);
  }
}

export async function clearSizes() {
  sizes = null;
  dirty.clear();
  await chrome.storage.local.remove(Array.from({ length: SHARDS }, (_, n) => shardKey(n)));
}
