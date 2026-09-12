// Where has the size pass actually got to?
//
// Three separate things decide what a row shows, and when they disagree the
// panel looks broken in ways that do not distinguish between them:
//
//   1. the message cache on disk — what has genuinely been read and kept
//   2. the membership record    — which ids each row is counting
//   3. the snapshot             — the figures the panel paints before it has
//                                 re-derived anything, stamped the moment
//                                 enumeration ended and so *before any size*
//
// A row spinning for ever can be any of: nothing measured yet, work measured and
// lost to a killed worker before it flushed, or a perfectly full cache that the
// panel never re-read. This prints all three side by side so the next question is
// about evidence.
//
// ── Running it ───────────────────────────────────────────────────
//
// Open the side panel, open DevTools on it (right-click → Inspect), and:
//
//     const { diagnoseSizes } = await import('/tools/diagnose-sizes.js');
//     await diagnoseSizes();
//
// It prints three tables and returns the report.
//
// **It spends no quota and writes nothing.** Every figure comes from
// `chrome.storage.local` and `chrome.alarms`; Gmail is not called at all, so it
// is safe to run repeatedly, mid-pass, on a real account.

import { activeAccount, keyFor } from '../src/account.js';

const SHARDS = 16;

/** Matches `complete()` in src/messages.js: a two-field entry predates dates. */
const complete = (entry) => Array.isArray(entry) && entry.length >= 3 && entry[2] > 0;

export async function diagnoseSizes() {
  const account = await activeAccount();
  if (!account) {
    console.warn('[diagnose] nobody is signed in');
    return null;
  }

  // ── 1. What is on disk ─────────────────────────────────────────
  const shardKeys = Array.from({ length: SHARDS }, (_, n) => keyFor(account, `msg:${n}`));
  const stored = await chrome.storage.local.get([
    ...shardKeys,
    keyFor(account, 'msg:senders'),
    keyFor(account, 'membership'),
    keyFor(account, 'snapshot'),
    keyFor(account, 'tasks'),
  ]);

  /** @type {Map<string, unknown[]>} id → cache entry */
  const cache = new Map();
  const perShard = [];
  for (const [n, key] of shardKeys.entries()) {
    const shard = stored[key] ?? {};
    const ids = Object.keys(shard);
    perShard.push({ shard: n, entries: ids.length });
    for (const id of ids) cache.set(id, shard[id]);
  }

  const sized = [...cache.values()].filter((entry) => Array.isArray(entry)).length;
  const dated = [...cache.values()].filter(complete).length;

  // ── 2. What each row is counting, in the order the pass reads it ──
  const membership = stored[keyFor(account, 'membership')];
  const ids = membership?.ids ?? {};

  // The same sort `queueFrom` applies: smallest row first, so small folders
  // settle while a large one is still being read. Printing it is what settles
  // whether a row that has no size yet is early in the queue or late in it.
  const rows = Object.entries(ids)
    .map(([id, list]) => {
      const measured = list.filter((messageId) => cache.has(messageId)).length;
      const withDates = list.filter((messageId) => complete(cache.get(messageId))).length;
      return {
        row: id,
        messages: list.length,
        measured,
        missing: list.length - measured,
        needsReading: list.length - withDates,
      };
    })
    .sort((a, b) => a.messages - b.messages);

  // Dedup in queue order, so `position` is roughly where the pass reaches a row.
  const seen = new Set();
  let position = 0;
  for (const row of rows) {
    row.queuedFrom = position;
    for (const id of ids[row.row]) {
      if (seen.has(id)) continue;
      seen.add(id);
      position++;
    }
  }
  const queueLength = seen.size;
  const outstanding = [...seen].filter((id) => !complete(cache.get(id))).length;

  // ── 3. What the panel is painting before it re-derives anything ──
  const snapshot = stored[keyFor(account, 'snapshot')];
  const painted = snapshot?.counts ?? {};
  const disagree = rows
    .filter((row) => {
      const record = painted[row.row];
      if (!record) return false;
      // The snapshot claiming more unread than the cache does is the shape of
      // the bug this was written for: the sizes are there and the row is not
      // showing them.
      return (record.pending ?? 0) > row.missing;
    })
    .map((row) => ({
      row: row.row,
      snapshotPending: painted[row.row].pending,
      reallyMissing: row.missing,
    }));

  // ── 4. What the task queue is holding ──────────────────────────
  //
  // The card is painted from this record, so an action that is not on the card
  // is either not in here — it finished, and there is nothing to show — or it is
  // in here and the panel failed to pick it up. Those are very different faults
  // and the record is the only thing that tells them apart.
  const queued = stored[keyFor(account, 'tasks')] ?? [];
  const tasks = queued.map((task) => ({
    id: task.id,
    kind: task.kind,
    action: task.action ?? null,
    phase: task.phase ?? null,
    ids: task.ids?.length ?? null,
    remaining: task.remaining?.length ?? null,
    done: task.done ?? null,
    total: task.total ?? null,
    hiddenFromRows: Object.keys(task.vacated ?? {}).length,
    ageMinutes: task.startedAt ? Math.round((Date.now() - task.startedAt) / 60000) : null,
  }));

  const alarms = (await chrome.alarms.getAll()).map((alarm) => ({
    name: alarm.name,
    inSeconds: Math.round((alarm.scheduledTime - Date.now()) / 1000),
    everyMinutes: alarm.periodInMinutes ?? null,
  }));

  const report = {
    account,
    cache: { entries: cache.size, sized, dated, undated: sized - dated },
    queue: { messages: queueLength, outstanding, done: queueLength - outstanding },
    snapshot: snapshot
      ? {
          minutesOld: Math.round((Date.now() - snapshot.generatedAt) / 60000),
          projected: Boolean(snapshot.projected),
          rows: Object.keys(painted).length,
        }
      : null,
    // Stored as a bare array — see `withQueue` in src/tasks.js.
    tasksQueued: queued.length,
    alarms,
    rowsDisagreeingWithTheCache: disagree,
  };

  console.log('%c[diagnose] the pass', 'font-weight:bold', report.queue);
  console.log('%c[diagnose] the cache on disk', 'font-weight:bold', report.cache);
  console.log('%c[diagnose] alarms', 'font-weight:bold', alarms);
  if (tasks.length) {
    console.log('%c[diagnose] the task queue', 'font-weight:bold');
    console.table(tasks);
  } else {
    console.log('[diagnose] the task queue is empty — nothing is outstanding to show a card for');
  }
  console.table(rows);
  if (disagree.length) {
    console.warn(
      '[diagnose] the snapshot describes these rows as less measured than the cache ' +
        'knows them to be. An open paints the snapshot first, so this is what a reopen ' +
        'shows as a spinner until something re-reads the cache:'
    );
    console.table(disagree);
  }
  if (!alarms.some((alarm) => alarm.name === 'measure') && outstanding) {
    console.warn(
      `[diagnose] ${outstanding} messages still need reading and there is no measure ` +
        'alarm, so nothing is going to read them. Press Refresh to start a pass.'
    );
  }

  return report;
}
