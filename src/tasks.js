// The task queue: every long job MailBoy is working through, on disk.
//
// Gmail meters writes hard — 6,000 quota units a minute, and a trash costs 5 a
// message — so anything touching a folder's worth of mail runs for minutes.
// Before this there was one job at a time and one record per kind, which meant
// two things a user could feel:
//
//   - Pressing Move while a Delete ran was refused. The panel said "MailBoy is
//     still finishing the last job", which is an implementation detail wearing
//     the clothes of a rule.
//   - A record held the *original* work, never the outstanding part of it. A
//     killed worker resumed by re-deriving what was left from Gmail, which the
//     folder delete can do and a sender selection cannot.
//
// So: one queue, appended to freely, worked through one task at a time. Tasks
// are *the* state — the panel dispatches by enqueuing, the worker runs the head
// of the queue, and both read the same record.
//
// **A task carries its own outstanding work, checkpointed as it goes.** `ids`
// is what the action was dispatched over and never changes; `remaining` is what
// is left and is rewritten every few seconds. That is what makes a resume exact
// rather than approximate, and it is what lets a stop put back precisely the
// mail that never moved — including in a panel that was opened long after the
// action was taken, which the old memory-only projection could not do.
//
// The cost is storage: a 40,000-message selection is roughly half a megabyte of
// ids, and `vacated` holds them again grouped by the row they came out of. That
// is what `unlimitedStorage` is for, and it buys the only honest answer to "put
// those emails back".

import { activeAccount, keyFor } from './account.js';

const QUEUE_NAME = 'tasks';

/** The one key a mailbox's queue occupies, for erasing it. */
export const tasksKey = (id) => keyFor(id, QUEUE_NAME);

/**
 * The two records this queue replaced.
 *
 * Read once, folded into the queue and removed. They are listed here rather
 * than left to rot because either one could be a *destructive* job caught
 * half-done by the update — a folder being emptied into Trash is not something
 * to strand.
 */
export const LEGACY_NAMES = ['folder-delete', 'bulk-job'];

export const legacyKeys = (id) => LEGACY_NAMES.map((name) => keyFor(id, name));

/**
 * **A task is never abandoned.** Once it is queued it runs to completion, and
 * the only thing that ends it early is the user pressing Stop.
 *
 * Both records this replaced expired after 24 hours, on the reasoning that
 * resuming a destructive action out of that much context is worse than leaving a
 * folder visibly half-emptied. That is reversed deliberately (2026-09-05, at the
 * user's call): Gmail's rate limit means a large job legitimately spans hours
 * and any number of browser sessions, so an expiry does not retire *forgotten*
 * work — it retires *slow* work, halfway through, having already moved some of
 * the mail and while still hiding the rest.
 *
 * What replaces it is visibility rather than a timer. An outstanding task always
 * has the card up, naming what it is doing, with a Stop button on it. Nothing
 * expires quietly because nothing is quiet.
 */

/**
 * The panel and the worker both write this key, so every read-modify-write goes
 * under one lock. Web Locks and `storage.local` are both per-origin, and an
 * extension's pages and its worker share one origin — the same arrangement the
 * quota budget in gmail.js uses, for the same reason.
 */
const QUEUE_LOCK = 'mailboy-tasks';

/**
 * @typedef {object} Task
 * @property {string} id
 * @property {'bulk' | 'folder-delete'} kind which runner does the work
 * @property {'move' | 'trash' | 'restore' | 'restore-folder'} action
 * @property {number} startedAt
 * @property {number} total emails it set out to move, for the progress bar
 * @property {number} done how many it has actually moved
 * @property {string[]} [ids] every message the action was dispatched over.
 *   **Immutable** — `remaining` is what shrinks. A folder delete has none: it
 *   re-derives its work by listing its own labels.
 * @property {string[]} [remaining] what is still to do, rewritten as it goes
 * @property {string[]} [add] labels to add
 * @property {string[]} [remove] labels to take away
 * @property {string} [target] where it is going, for the status line
 * @property {string} [source] the folder it was selected in
 * @property {string | null} [destination] the row the mail lands in, or null
 *   where nothing here can know (a restore)
 * @property {Record<string, string[]>} [vacated] what the panel's projection
 *   took out of which row, so a stop can put back exactly that
 * @property {{id: string, name: string, fullName?: string}[]} [labels] folder
 *   delete only, deepest first
 * @property {boolean} [trash] folder delete only: Trash, or back to the inbox
 * @property {'labels' | null} [phase] folder delete only: `labels` once the mail
 *   is dealt with and only the folders are left to remove. Nothing in that
 *   stretch reports progress, so without it the card sits at its full count
 *   claiming to still be moving mail — which on a resumed job is the whole run.
 */

/** Distinct without a counter to keep, and short enough to trace. */
export function taskId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** What the queue holds, oldest first. Never throws. */
export async function readTasks() {
  try {
    const account = await activeAccount();
    if (!account) return [];
    return await withQueue(account, (queue) => queue);
  } catch (err) {
    console.warn('[MailBoy] task queue unreadable:', err);
    return [];
  }
}

/** Append one task and hand back the queue it joined. */
export async function enqueueTask(task) {
  const account = await activeAccount();
  if (!account) return [];
  return withQueue(account, (queue) => [...queue, task], { write: true });
}

/**
 * Merge fields into one task — how a checkpoint lands.
 *
 * Read-modify-write under the lock rather than a blind overwrite: the panel may
 * have queued another task since this one started, and a whole-queue write from
 * the worker would drop it.
 */
export async function updateTask(id, patch) {
  const account = await activeAccount();
  if (!account) return [];
  return withQueue(
    account,
    (queue) => queue.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    { write: true }
  );
}

/** Take one finished task out. */
export async function dropTask(id) {
  const account = await activeAccount();
  if (!account) return [];
  return withQueue(account, (queue) => queue.filter((task) => task.id !== id), { write: true });
}

/**
 * Empty the queue and hand back what was in it.
 *
 * What a stop does. The caller needs the tasks it removed, because each one is
 * holding mail out of the rows it came from and only the record says which.
 *
 * `before` is what keeps a stop from swallowing a task queued in the moment
 * after it. A stop is asynchronous — the message lands, the queue is read, the
 * queue is written — and somebody pressing Stop and then immediately moving
 * something else would otherwise have that second action wiped: no record, no
 * ending, and mail left hidden with nothing to bring it back. Ties are left
 * *running*, which is the recoverable direction: another press stops it.
 *
 * @param {string} [account] an explicit id is how an account sweep erases one
 * @param {number} [before] only take tasks queued strictly earlier than this
 */
export async function clearTasks(account, before = Infinity) {
  const id = account ?? (await activeAccount());
  if (!id) return [];

  let removed = [];
  await withQueue(
    id,
    (queue) => {
      removed = queue.filter((task) => (task.startedAt ?? 0) < before);
      const kept = new Set(removed.map((task) => task.id));
      return queue.filter((task) => !kept.has(task.id));
    },
    { write: true }
  );
  return removed;
}

/**
 * Everything that touches the queue, under the lock.
 *
 * `mutate` is handed the queue as stored — already aged out and already carrying
 * anything an older build left behind — and returns the queue to keep. Reads
 * pass it through; only `write` puts the result back.
 */
async function withQueue(account, mutate, { write = false } = {}) {
  const run = async () => {
    const key = tasksKey(account);
    const { [key]: stored } = await chrome.storage.local.get(key);

    const queue = live(Array.isArray(stored) ? stored : []);
    const adopted = queue.length ? queue : await adoptLegacy(account, key);

    const next = mutate(adopted);
    if (write) await chrome.storage.local.set({ [key]: next });
    return next;
  };

  try {
    return await navigator.locks.request(QUEUE_LOCK, run);
  } catch (err) {
    // A lock that cannot be taken must not stop a job. The window it leaves is
    // two contexts writing the queue at the same instant, which costs at worst
    // one just-queued task — against a job that would otherwise never run.
    console.warn('[MailBoy] task queue lock unavailable:', err);
    return run();
  }
}

/**
 * Only a malformed entry is dropped on the way in. Age is deliberately not a
 * reason — see the note above `tasksKey`.
 */
function live(queue) {
  return queue.filter((task) => task?.id && task.kind);
}

/**
 * Fold a job left by the build before this queue existed into it.
 *
 * Only reached when the queue itself is empty, so it cannot resurrect anything
 * twice: the legacy keys are removed once the queue holds what they said, and
 * after that there is nothing to find.
 *
 * **It writes, even on a read.** An adoption that only returned the tasks would
 * hand them to a caller that may not be writing anything back — and the very
 * next read, with the legacy keys already gone, would find nothing. That is a
 * pending *destructive* job quietly disappearing.
 *
 * The queue is written before the legacy keys are removed. A death between the
 * two leaves them behind with the queue already holding them, which the guard
 * above then ignores — clutter rather than a duplicate delete, and
 * `eraseAccountData` sweeps them up.
 */
async function adoptLegacy(account, key) {
  const [deleteKey, bulkKey] = legacyKeys(account);
  const stored = await chrome.storage.local.get([deleteKey, bulkKey]);

  const adopted = [];
  const old = stored[deleteKey];
  if (old?.labels?.length) {
    adopted.push({
      id: taskId(),
      kind: 'folder-delete',
      action: old.trash ? 'trash' : 'restore-folder',
      startedAt: old.startedAt ?? Date.now(),
      total: old.total ?? 0,
      done: 0,
      labels: old.labels,
      trash: Boolean(old.trash),
      destination: old.trash ? 'TRASH' : 'INBOX',
      // Nothing was recorded about what the old panel hid, so a settlement here
      // has to fall back to listing the mailbox. That is the same answer the
      // old build gave, which is what makes this migration free.
      vacated: {},
    });
  }

  const bulk = stored[bulkKey];
  if (bulk?.ids?.length) {
    adopted.push({
      id: taskId(),
      kind: 'bulk',
      action: bulk.action,
      startedAt: bulk.startedAt ?? Date.now(),
      total: bulk.ids.length,
      done: 0,
      ids: bulk.ids,
      remaining: bulk.ids,
      add: bulk.add,
      remove: bulk.remove,
      target: bulk.target,
      source: bulk.source,
      destination: bulk.action === 'trash' ? 'TRASH' : (bulk.add?.[0] ?? null),
      vacated: {},
    });
  }

  if (!adopted.length) return [];

  const kept = live(adopted);
  await chrome.storage.local.set({ [key]: kept });
  await chrome.storage.local.remove([deleteKey, bulkKey]);
  console.info('[MailBoy] adopted', kept.length, 'job(s) from the previous build');
  return kept;
}

/**
 * What the panel is shown: everything except the ids.
 *
 * The queue is broadcast on every batch, and a 40,000-id array crossing the port
 * a few times a second would be the most expensive thing in the extension. The
 * ids only ever travel once, at the ending, where they are what a settlement is
 * worked out from.
 */
export function summarise(task) {
  return {
    id: task.id,
    kind: task.kind,
    action: task.action,
    target: task.target ?? '',
    total: task.total ?? 0,
    done: task.done ?? 0,
    labels: task.labels?.map((label) => label.id) ?? [],
    name: task.labels?.at(-1)?.name ?? '',
    phase: task.phase ?? null,
  };
}
