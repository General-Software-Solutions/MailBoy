// Acting on a selection of senders from a folder's breakdown.
//
// Three actions over one call. Move, restore and trash are all `batchModify`
// and differ only in what the panel asks to be added and taken away — Trash is
// a label like any other, and `addLabelIds: ['TRASH']` moves a thousand
// messages for the same 50 units a move costs.
//
// **That was not always true here.** Until 2026-09-09 a trash ran one
// `messages.trash` per message at 20 units each, on the claim that `batchModify`
// refused the label. It does not, and the difference is about four hundredfold:
// a folder of 10,000 emails was over half an hour of solid quota — throttled
// most of the way, because 20 units a message is 5 a second at the ceiling — and
// is now a few seconds. The asymmetry this file used to be organised around is
// simply gone.
//
// It still runs in the service worker rather than the panel. Not for the length
// of the work any more, but because a selection of tens of thousands is still
// several calls, and nobody should have to keep a side panel open through them.
//
// **Unlike the size pass and the folder delete, this job cannot be rebuilt from
// the mailbox.** Those two re-derive their work from Gmail — an unmeasured
// message is one the cache does not hold, and a message still under a label is
// one the delete has not moved. A sender selection is a choice somebody made in
// the panel, and nothing in Gmail records it.
//
// So it carries its own outstanding work: `remaining` on the task record, cut
// down every few seconds by `onLanded` below. Re-running whatever is left is
// harmless in itself — trashing a trashed message, adding a label it already
// carries and removing one it does not are all no-ops — and now that both
// actions are `batchModify` the wasted quota is small too. What the checkpoint
// is still worth is the projection: `remaining` is what the panel puts back if
// somebody presses Stop, and a task that forgot how far it had got would hand
// back mail that has already moved.

import { modifyMessages, trashMessages } from './gmail.js';

/**
 * Do one task's worth of work.
 *
 * A stop returns what was achieved with `complete: false`, leaving the task in
 * the queue. Only `complete: true` should take it out.
 *
 * @param {import('./tasks.js').Task} task
 * @param {{onLanded?: (ids: string[], done: number) => void,
 *   stopped?: () => boolean}} hooks `onLanded` reports the ids that have
 *   actually moved, which is what a checkpoint is written from.
 * @returns {Promise<{done: number, moved: number, trashed: number,
 *   failed: string[], unfinished: number, complete: boolean}>} `failed` is Gmail
 *   refusing particular messages; `unfinished` is work it would not get to,
 *   which is nearly always a rate limit. Only the first is worth reporting to
 *   anyone — the second means come back and try again.
 */
export async function runBulkJob(task, { onLanded, stopped } = {}) {
  const outcome = { done: 0, moved: 0, trashed: 0, failed: [], unfinished: 0, complete: false };

  // What is left of it, which on a resumed task is less than it was dispatched
  // over. The full `ids` stay on the record for the panel to settle against.
  const ids = task.remaining ?? task.ids ?? [];

  if (task.action === 'trash') {
    // One `batchModify` per thousand, like the move below. It reports rather
    // than throwing, because a throttle and a refusal have to stay apart here:
    // one leaves the task queued, the other is the only thing worth telling
    // anyone about.
    const result = await trashMessages(
      ids,
      (landed) => {
        outcome.done += landed.length;
        onLanded?.(landed, outcome.done);
      },
      stopped
    );
    outcome.trashed = result.trashed;
    outcome.failed = result.failed;
    outcome.unfinished = result.pending.length;
  } else {
    const moved = await modifyMessages(
      ids,
      { add: task.add ?? [], remove: task.remove ?? [] },
      stopped,
      (chunk) => {
        outcome.done += chunk.length;
        onLanded?.(chunk, outcome.done);
      }
    );
    outcome.moved = moved;
    outcome.done = moved;
  }

  if (stopped?.()) return outcome;

  // Gmail was still throttling when the retry budget ran out. The task is not
  // finished, and saying so is the whole point: `remaining` still holds this
  // mail, the queue keeps the task, and the alarm brings it back. Calling it
  // complete here is what produced "346 moved. 399 could not be moved." for a
  // job that had simply been rate-limited.
  if (outcome.unfinished) return outcome;

  outcome.complete = true;
  return outcome;
}
