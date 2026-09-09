// Creating and removing folders.
//
// Gmail keeps nesting entirely in the name: "Work/Clients/Acme" is a child of
// "Work/Clients" because of how it reads, and there is no link between the two
// labels beyond that. So creating a subfolder is creating a label whose name
// carries its parent's path, and everything here is string work plus one call.
//
// Deleting is the larger half. `labels.delete` removes one label and no mail —
// it unlabels every message and leaves them where they are — so what happens to
// that mail is separate work, done *before* the label goes while there is still
// something to list.
//
// **Both choices now cost the same**, because both are `batchModify`: 50 units
// per 1,000 messages, whether the mail is being handed back to the inbox or sent
// to Trash. A 30,000-message folder is one listing and thirty writes either way.
//
// It was not always so. Until 2026-09-09 the Trash half ran one
// `messages.trash` per message — 20 units each, 5 a second at the ceiling — so a
// folder that size was hours rather than seconds, and this file was organised
// around an asymmetry that turned out to be an unchecked assumption about what
// `batchModify` accepts. It runs in the service worker still, because a folder
// of any size is a listing plus a run of writes and neither should need an open
// panel.
//
// **The job is restartable without a cursor**, on the same principle as the
// size pass. Trashed mail drops out of `messages.list`, so a resumed trash job
// re-lists exactly what is left; the inbox job re-lists everything and re-adds
// a label most of them already carry, which Gmail treats as a no-op. Either
// way that only holds while the labels are still there, which is why they are
// deleted last.

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
//
// It has no record of its own any more: it is one task in the queue, like a
// move or a trash — see src/tasks.js. What it carries there is *intent* rather
// than progress, which is the one thing the mailbox cannot say: nothing in Gmail
// records whether the user asked for Trash or for the inbox. Everything else it
// re-derives by listing its own labels, which is why it needs no `remaining`.

/**
 * Do the job: move the mail, then remove the labels.
 *
 * Ordering is the whole of the recovery story. Every label stays in place until
 * all of its mail has been dealt with, because the label is the only handle on
 * that mail — delete it first and a job interrupted halfway leaves messages
 * unlabelled, un-trashed and untraceable. Deleting last means an interrupted
 * job simply re-lists and carries on.
 *
 * A stop returns what was achieved with `complete: false`, leaving the task in
 * the queue. Only `complete: true` should take it out.
 *
 * @param {import('./tasks.js').Task} job carrying `labels` and `trash`
 * @param {{onProgress?: (done: number, total: number) => void,
 *   onPhase?: (phase: 'labels') => void, stopped?: () => boolean}} hooks
 *   `onPhase` fires once the mail is all dealt with and only the folders are
 *   left to remove — the card has nothing else to say for that stretch, and on a
 *   resumed job where the mail already moved it is the *whole* of the run.
 * @returns {Promise<{done: number, trashed: number, restored: number,
 *   failed: string[], unfinished: number, complete: boolean}>}
 */
export async function runDeleteJob(job, { onProgress, onPhase, stopped } = {}) {
  const outcome = { done: 0, trashed: 0, restored: 0, failed: [], unfinished: 0, complete: false };
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
          outcome.done += moved.length;
          onProgress?.(outcome.done, job.total);
        },
        stopped
      );
      outcome.trashed += result.trashed;
      outcome.failed.push(...result.failed);
      outcome.unfinished += result.pending.length;
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

  // **Mail that did not move keeps the labels alive**, whichever way it did not.
  // The label is the only handle on it, so deleting now would leave that mail
  // unlabelled, un-trashed and untraceable — the exact failure the delete-last
  // ordering above exists to prevent.
  //
  // `unfinished` is Gmail not getting to it: the task stays queued, re-lists,
  // and finds only what is left. `failed` is Gmail refusing the request, and
  // until 2026-09-09 it did *not* stop the delete — the guard read `unfinished`
  // alone. That was the hole: `batchModify` is whole-request, so one refusal
  // speaks for a thousand messages, and the folder went anyway. It is checked
  // here rather than merged into `unfinished` because the two ask for different
  // clocks — see `runTask`.
  if (outcome.unfinished || outcome.failed.length) return outcome;

  // Everything is moved; only the folders are left. Nothing below reports
  // progress — the bar has been at its end since the last batch — so this is
  // what stops the card claiming to still be moving mail.
  onPhase?.('labels');

  // Deepest first, so an interruption partway through can never orphan a child
  // under a parent that has already gone.
  for (const label of job.labels) await deleteLabel(label.id);

  outcome.complete = true;
  return outcome;
}
