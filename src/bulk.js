// Acting on a selection of senders from a folder's breakdown.
//
// Three actions over two calls — move and restore are both `batchModify`, and
// differ only in what the panel asks to be added and taken away. They cost
// wildly different amounts from trashing, the same asymmetry the folder delete
// runs into and for the same reason:
//
//   move / restore   50 units per 1,000 messages  (batchModify)
//   move to Trash     5 units per message         (messages.trash)
//
// So a move over a big selection is seconds and a trash is minutes, and both
// live in the service worker rather than the panel. Nobody should have to keep
// a side panel open to watch mail being filed.
//
// **Unlike the size pass and the folder delete, this job cannot be rebuilt from
// the mailbox.** Those two re-derive their work from Gmail — an unmeasured
// message is one the cache does not hold, and a message still under a label is
// one the delete has not moved. A sender selection is a choice somebody made in
// the panel, and nothing in Gmail records it. So the ids travel with the job
// record, which is the one place here that keeps real state.
//
// That record is large — a 40,000-message selection is roughly half a megabyte
// of ids — which is what `unlimitedStorage` is already there for. Re-running it
// is harmless: trashing a trashed message, adding a label it already carries
// and removing one it does not are all no-ops, so a resume after a killed
// worker simply repeats whatever it had already done.

import { activeAccount, keyFor } from './account.js';
import { modifyMessages, trashMessages } from './gmail.js';

const JOB_NAME = 'bulk-job';

/** The one key a mailbox's pending selection job occupies, for erasing it. */
export const bulkJobKey = (id) => keyFor(id, JOB_NAME);

/**
 * How long a half-finished job may sit before it is abandoned. Same reasoning
 * as the folder delete: the alarm brings an interrupted job back within a
 * minute, so anything still here a day later means the browser was closed or
 * nobody signed back in — and resuming mail movement out of that much context
 * is worse than leaving it half done and visible.
 */
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} BulkJob
 * @property {number} startedAt
 * @property {'trash' | 'move' | 'restore'} action `move` and `restore` are the
 *   same call and differ only in what the panel puts in `add`/`remove` and in
 *   how it words the outcome — a move sheds every other folder, a restore is
 *   the undo of a delete and keeps them.
 * @property {string[]} ids exactly the messages the selection resolved to
 * @property {string[]} [add] labels to add
 * @property {string[]} [remove] labels to take away
 * @property {string} [target] where it is going, for the status line
 * @property {string} [source] the folder it was selected in
 */

/** Persist the job so a killed worker can pick it up from the alarm. */
export async function saveBulkJob(job) {
  const account = await activeAccount();
  if (!account) return;
  await chrome.storage.local.set({ [bulkJobKey(account)]: job });
}

/**
 * The pending job, or null. An expired one is cleared as it is read, so this is
 * also what retires a job nobody came back for.
 *
 * @returns {Promise<BulkJob | null>}
 */
export async function readBulkJob() {
  try {
    const account = await activeAccount();
    if (!account) return null;

    const key = bulkJobKey(account);
    const { [key]: job } = await chrome.storage.local.get(key);
    if (!job?.ids?.length) return null;

    if (Date.now() - (job.startedAt ?? 0) > MAX_JOB_AGE_MS) {
      await chrome.storage.local.remove(key);
      return null;
    }

    return job;
  } catch (err) {
    console.warn('[MailBoy] pending selection job unreadable:', err);
    return null;
  }
}

/** Defaults to the signed-in mailbox; an explicit id is how a sweep erases one. */
export async function clearBulkJob(account) {
  const id = account ?? (await activeAccount());
  if (!id) return;
  await chrome.storage.local.remove(bulkJobKey(id));
}

/**
 * Do the job.
 *
 * A stop returns what was achieved with `complete: false`, leaving the record
 * for the alarm to resume. Only `complete: true` should clear it.
 *
 * @param {BulkJob} job
 * @param {{onProgress?: (done: number, total: number) => void,
 *   stopped?: () => boolean}} hooks
 * @returns {Promise<{done: number, moved: number, trashed: number,
 *   failed: string[], complete: boolean}>}
 */
export async function runBulkJob(job, { onProgress, stopped } = {}) {
  const outcome = { done: 0, moved: 0, trashed: 0, failed: [], complete: false };
  const total = job.ids.length;

  if (job.action === 'trash') {
    // No batched form of this — batchModify refuses the TRASH label — so it is
    // one messages.trash per message at 5 units each, roughly 50 a second.
    const result = await trashMessages(
      job.ids,
      (moved) => {
        outcome.done += moved;
        onProgress?.(outcome.done, total);
      },
      stopped
    );
    outcome.trashed = result.trashed;
    outcome.failed = result.failed;
  } else {
    const moved = await modifyMessages(
      job.ids,
      { add: job.add ?? [], remove: job.remove ?? [] },
      stopped
    );
    outcome.moved = moved;
    outcome.done = moved;
    onProgress?.(outcome.done, total);
  }

  if (stopped?.()) return outcome;

  outcome.complete = true;
  return outcome;
}
