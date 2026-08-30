// Creating and removing folders.
//
// Gmail keeps nesting entirely in the name: "Work/Clients/Acme" is a child of
// "Work/Clients" because of how it reads, and there is no link between the two
// labels beyond that. So creating a subfolder is creating a label whose name
// carries its parent's path, and everything here is string work plus one call.
//
// Deleting is the asymmetric half. `labels.delete` removes one label and no
// mail — it unlabels every message and leaves them where they are — so what
// happens to that mail is separate work, done *before* the label goes while
// there is still something to list. The two choices cost wildly different
// amounts:
//
//   move the mail to the inbox   50 units per 1,000 messages
//   move the mail to Trash        5 units per message
//
// A 30,000-message folder is therefore under a second one way and roughly ten
// minutes the other, which is why this runs in the service worker.
//
// **The job is restartable without a cursor**, on the same principle as the
// size pass. Trashed mail drops out of `messages.list`, so a resumed trash job
// re-lists exactly what is left; the inbox job re-lists everything and re-adds
// a label most of them already carry, which Gmail treats as a no-op. Either
// way that only holds while the labels are still there, which is why they are
// deleted last.

import { activeAccount, keyFor } from './account.js';
import { createLabel, deleteLabel, listMessageIds, modifyMessages, trashMessages } from './gmail.js';

/** Gmail's ceiling on a label name, counted across the whole path. */
export const MAX_NAME = 225;

/**
 * Mail that arrived, as opposed to mail you wrote.
 *
 * **Everything a delete acts on is filtered through this, and it is the single
 * most important line in the file.** Gmail labels *threads*, so labelling a
 * conversation you took part in puts that label on your own replies as well.
 * Without this, deleting a folder would trash your sent mail, or return it to
 * your inbox — for a folder whose row never claimed to count it in the first
 * place. It is the same scope user-folder counts use (`SCOPES.incoming` in
 * mailbox.js), which is what keeps the number on a row and the mail a delete
 * touches the same set.
 */
const INCOMING = '-in:sent -is:draft';

// ── Naming ───────────────────────────────────────────────────────

/**
 * Check a name typed into the inline editor, in the position it was typed.
 *
 * Duplicates are caught here rather than left to Gmail's 409 because the panel
 * already knows every folder name, and answering as someone types beats a round
 * trip. Gmail still has the last word — a name this misses is refused there.
 *
 * @param {string} typed the leaf, as entered
 * @param {{parent?: string, existing?: string[]}} context `parent` is the full
 *   path this sits under, absent for a root folder
 * @returns {{name: string} | {error: string}}
 */
export function validateFolderName(typed, { parent = '', existing = [] } = {}) {
  const leaf = typed.trim();

  if (!leaf) return { error: 'Give the folder a name.' };

  // Nesting is what the + button is for, and a slash typed here would create a
  // depth nobody asked for — under a parent, silently two levels down.
  if (leaf.includes('/')) {
    return { error: 'Names cannot contain “/”. Use + on a folder to nest inside it.' };
  }

  const name = parent ? `${parent}/${leaf}` : leaf;

  if (name.length > MAX_NAME) {
    return { error: `That name is too long — ${MAX_NAME} characters including the folders above it.` };
  }

  // Gmail treats names case-insensitively for uniqueness, so "work" collides
  // with an existing "Work" and the 409 would otherwise look arbitrary.
  const taken = existing.some((other) => other.toLowerCase() === name.toLowerCase());
  if (taken) return { error: 'There is already a folder with that name here.' };

  return { name };
}

/**
 * Create one folder and hand back the label.
 *
 * Thin on purpose: the interesting work is the naming above, and the caller
 * needs the new id to put a row on screen without re-reading the mailbox.
 *
 * @returns {Promise<{id: string, name: string}>}
 */
export async function createFolder(name) {
  const label = await createLabel(name);
  return { id: label.id, name: label.name ?? name };
}

// ── The delete job ───────────────────────────────────────────────

const JOB_NAME = 'folder-delete';

/** The one key a mailbox's pending delete occupies, for erasing it. */
export const deleteJobKey = (id) => keyFor(id, JOB_NAME);

/**
 * How long a half-finished delete may sit before it is abandoned.
 *
 * The alarm brings an interrupted job back within a minute, so anything still
 * here a day later did not fail — the browser was closed, or nobody signed back
 * in. Resuming a destructive action out of that much context is worse than
 * leaving the folder visibly half-emptied for the user to decide about again.
 */
const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} DeleteJob
 * @property {number} startedAt
 * @property {boolean} trash whether the mail goes to Trash, or to the inbox
 * @property {{id: string, name: string, fullName?: string}[]} labels the whole
 *   subtree, deepest first
 * @property {number} total messages to move, as counted when the job was built;
 *   0 where there is no ratio worth reporting
 */

/** Persist the job so a killed worker can pick it up from the alarm. */
export async function saveDeleteJob(job) {
  const account = await activeAccount();
  if (!account) return;
  await chrome.storage.local.set({ [deleteJobKey(account)]: job });
}

/**
 * The pending job, or null. An expired one is cleared as it is read, so this is
 * also what retires a job nobody came back for.
 *
 * @returns {Promise<DeleteJob | null>}
 */
export async function readDeleteJob() {
  try {
    const account = await activeAccount();
    if (!account) return null;

    const key = deleteJobKey(account);
    const { [key]: job } = await chrome.storage.local.get(key);
    if (!job?.labels?.length) return null;

    if (Date.now() - (job.startedAt ?? 0) > MAX_JOB_AGE_MS) {
      await chrome.storage.local.remove(key);
      return null;
    }

    return job;
  } catch (err) {
    console.warn('[MailBoy] pending delete unreadable:', err);
    return null;
  }
}

/** Defaults to the signed-in mailbox; an explicit id is how a sweep erases one. */
export async function clearDeleteJob(account) {
  const id = account ?? (await activeAccount());
  if (!id) return;
  await chrome.storage.local.remove(deleteJobKey(id));
}

/**
 * Do the job: move the mail, then remove the labels.
 *
 * Ordering is the whole of the recovery story. Every label stays in place until
 * all of its mail has been dealt with, because the label is the only handle on
 * that mail — delete it first and a job interrupted halfway leaves messages
 * unlabelled, un-trashed and untraceable. Deleting last means an interrupted
 * job simply re-lists and carries on.
 *
 * A stop returns what was achieved with `complete: false`, leaving the job
 * record for the alarm to resume. Only `complete: true` should clear it.
 *
 * @param {DeleteJob} job
 * @param {{onProgress?: (done: number, total: number) => void,
 *   stopped?: () => boolean}} hooks
 * @returns {Promise<{done: number, trashed: number, restored: number,
 *   failed: string[], complete: boolean}>}
 */
export async function runDeleteJob(job, { onProgress, stopped } = {}) {
  const outcome = { done: 0, trashed: 0, restored: 0, failed: [], complete: false };
  const halted = () => stopped?.() ?? false;

  for (const label of job.labels) {
    if (halted()) return outcome;

    if (job.trash) {
      // Scoped, not bare: a bare listing would sweep up the sent replies Gmail
      // put this label on and trash them, which is both destructive and a
      // larger number than the row ever showed.
      //
      // Trashed mail drops out of messages.list for a user label, so on a
      // resumed job this returns exactly what is left to move.
      const ids = await listMessageIds(label.id, INCOMING, stopped);
      if (halted()) return outcome;

      const result = await trashMessages(
        ids,
        (moved) => {
          outcome.done += moved;
          onProgress?.(outcome.done, job.total);
        },
        stopped
      );
      outcome.trashed += result.trashed;
      outcome.failed.push(...result.failed);
    } else {
      // Everything the folder holds, not just the archived part of it. The
      // promise is one line — the emails turn up in your inbox — and it can
      // only be that if it covers every message the row counted, whatever else
      // those messages are labelled with. Mail already in the inbox re-lists
      // and gets INBOX added again, which costs one cheap call per 1,000 and
      // changes nothing.
      //
      // INCOMING is the one narrowing, and it is not about location: Gmail
      // labels threads, so a folder covering a conversation you replied to
      // carries the label on your own replies, and dragging those into the
      // inbox would be a bug rather than a rescue. It is also exactly the set
      // the row counted.
      const ids = await listMessageIds(label.id, INCOMING, stopped);
      if (halted()) return outcome;

      const moved = await modifyMessages(ids, { add: ['INBOX'] }, stopped);
      outcome.restored += moved;
      outcome.done += moved;
      onProgress?.(outcome.done, job.total);
    }
  }

  if (halted()) return outcome;

  // Deepest first, so an interruption partway through can never orphan a child
  // under a parent that has already gone.
  for (const label of job.labels) await deleteLabel(label.id);

  outcome.complete = true;
  return outcome;
}
