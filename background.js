// MailBoy service worker.
//
// Three jobs: open the side panel from the toolbar, own the slow half of the
// data pass — reading every message for its size and sender — and work through
// the task queue, which is every action that moves mail about.
//
// Both of the long ones live here rather than in the panel because they take
// minutes, and requiring someone to sit with the panel open for that is not a
// reasonable thing to ask.
//
// **Measuring keeps no state at all.** Its queue is rebuilt from scratch on
// every wake and the message cache filters out whatever is already known, so
// "start" and "resume" are one code path and a termination at any instant is
// harmless — Chrome ends a worker after roughly 30 seconds of inactivity, and
// while a batch every couple of seconds keeps it alive, that is a happy accident
// and never something to depend on.
//
// **The task queue is the opposite, and deliberately so.** A folder delete could
// re-derive its work by listing its labels; a sender selection cannot, because
// nothing in Gmail records which senders somebody ticked. So a task carries its
// own outstanding ids and checkpoints them as it goes — see src/tasks.js. The
// queue is worked through one task at a time, because they share one quota
// budget and running two only splits the same rate between them; what the queue
// buys is that nothing has to be *refused* while one runs.

import { activeAccount } from './src/account.js';
import { AuthError } from './src/auth.js';
import { runBulkJob } from './src/bulk.js';
import { runDeleteJob } from './src/folders.js';
import { buildQueue } from './src/mailbox.js';
import { ensureMeta, flushMessages } from './src/messages.js';
import { clearTasks, dropTask, readTasks, summarise, updateTask } from './src/tasks.js';
import { trace } from './src/trace.js';

const PORT_NAME = 'measure';
const ALARM = 'measure';

const TASK_PORT = 'folders';
const TASK_ALARM = 'tasks';

/** Safety net: if the worker is killed mid-pass, this starts it again. */
const RESUME_MINUTES = 1;

/** After a hard failure, stop hammering and try again much later. */
const RETRY_MINUTES = 15;

/**
 * After Gmail rate-limits a task to a standstill.
 *
 * Much sooner than a hard failure, because nothing is broken — the limit that
 * refuses is per *minute*, so it clears on its own.
 *
 * It eases off when a run achieves nothing at all, because that means something
 * else is holding the whole budget — nearly always a measuring pass, which can
 * run for eighteen minutes — and coming straight back to be refused again only
 * adds to the contention it is waiting on. A run that moved *some* mail is
 * making progress and comes back at the short end.
 */
const THROTTLED_MINUTES = 2;
const THROTTLED_MAX_MINUTES = 15;

/**
 * How often a running task writes down what is left of it.
 *
 * Effectively every chunk, and deliberately so — a trash and a move both land
 * 1,000 messages at a time, roughly twice a second, so this is a coalescing
 * window rather than a real throttle. It matters more than it did: a chunk is a
 * thousand ids now that trashing goes through `batchModify` too, where it used
 * to be a hundred.
 *
 * The interval is what a stop can be wrong by: whatever moved since the last
 * write is reported as still outstanding, so the panel puts it back onto a row
 * it has actually left. Re-acting on it is a no-op and the next full listing
 * corrects the number, but the shorter this is the smaller that window — which
 * is why it is a second and not the ten it could comfortably be.
 */
const CHECKPOINT_MS = 1000;

function openOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[MailBoy] side panel behavior:', err));
}

chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);

// A browser restart takes the alarms with it, so a queue interrupted by one
// would otherwise sit half-done until somebody opened the panel and noticed.
chrome.runtime.onStartup.addListener(() => void runQueue());

// ── Talking to the panel ─────────────────────────────────────────

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

/** @type {Set<chrome.runtime.Port>} */
const taskPorts = new Set();

/** Last progress seen, so a panel opening mid-pass is not left guessing. */
let progress = null;

/** The queue as the panel should see it: summaries, never ids. */
let queueView = [];

let running = false;

/** Set by a stop from the panel; cleared when a fresh pass begins. */
let stopping = false;

let workingTasks = false;
let stoppingTasks = false;

/**
 * What the stop in progress means, if there is one.
 *
 * `'discard'` is the card's stop button: call the tasks off and give the mail
 * back. `'halt'` is a logout: the token every task is spending is about to be
 * revoked, so they have to stop — but the queue is namespaced to that account
 * and is exactly what should be waiting when somebody signs back in.
 *
 * @type {'discard' | 'halt' | null}
 */
let stopKind = null;

/**
 * Gags `publishQueue` between a discard and the moment the queue is actually
 * emptied, so a checkpoint from the task still winding down cannot redraw a card
 * the user has just dismissed. Lifted by `endTasks`, which has the real answer.
 */
let discardingTasks = false;

/** The discard in progress, so a pass can wait for it. @type {Promise<void>} */
let endingTasks = Promise.resolve();

function broadcast(message, to = ports) {
  for (const port of to) {
    try {
      port.postMessage(message);
    } catch {
      // The panel closed between the check and the send. Nothing to do.
      to.delete(port);
    }
  }
}

/** What the panel draws its task card from. Sent on every change. */
function publishQueue(queue) {
  queueView = discardingTasks ? [] : queue.map(summarise);
  broadcast({ type: 'tasks', queue: queueView }, taskPorts);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === TASK_PORT) {
    taskPorts.add(port);
    port.onDisconnect.addListener(() => taskPorts.delete(port));

    // Whatever is already under way, said immediately — a panel opened ten
    // minutes into a trash pass should not have to wait for the next batch.
    //
    // Only when there is something to say: a worker that has just been woken up
    // holds an empty view until it has read the queue, and announcing that as
    // "nothing is running" would blank the panel's card for a moment before
    // `runQueue` below fills it in.
    if (queueView.length) port.postMessage({ type: 'tasks', queue: queueView });

    // Opening the panel is a recovery path in its own right. A queue whose alarm
    // was lost — cleared by a logout, or gone with a browser restart — would
    // otherwise sit there with mail half moved and nothing to wake it.
    void runQueue();

    port.onMessage.addListener((message) => {
      // The panel has just added something. The record is already on disk; this
      // only says "there is work", so a queue standing idle starts at once
      // instead of waiting out the alarm.
      if (message?.type === 'run') void runQueue();
    });
    return;
  }

  if (port.name !== PORT_NAME) return;

  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));

  // Whatever is already in flight, said immediately — otherwise a panel opened
  // ten minutes in shows nothing until the next batch lands.
  //
  if (progress) port.postMessage({ type: 'progress', ...progress, sizes: {} });

  port.onMessage.addListener((message) => {
    // The panel just enumerated; reuse its queue rather than repeating it.
    if (message?.type === 'start') void measure(message.order);
    // A panel with no pass of its own, asking whether there is one to watch.
    if (message?.type === 'attach') void answerAttach(port);
  });
});

/**
 * Whether a pass is outstanding, and picking it back up if it is.
 *
 * **`running` is this worker instance, and a worker is not a pass.** One is
 * killed after ~30 seconds of inactivity and resumed by the alarm — and with a
 * read costing 20 quota units, the pacer leaves ~22 seconds between batches of
 * 100, so that happens routinely mid-pass rather than only between passes. A
 * connecting panel is very often *what woke the worker*: `running` is false,
 * `progress` is null, and answering "nothing is happening" is how the panel came
 * to report a three-hour pass as finished and mark every row it could not
 * account for as short for good.
 *
 * The alarm is the state that outlives the worker. It is created before the first
 * await of a pass and cleared only when one finishes or hits an `AuthError`, so
 * its existence is exactly the question being asked.
 *
 * **And opening the panel is a recovery path in its own right**, the same as it
 * is for the task queue on the other port: rather than leave the pass to the next
 * tick of a one-minute alarm, start it now. `measure` returns early if one is
 * already going, so a panel reconnecting mid-pass costs nothing.
 */
async function answerAttach(port) {
  const outstanding = running || Boolean(await chrome.alarms.get(ALARM));

  try {
    port.postMessage({ type: outstanding ? 'measuring' : 'idle' });
  } catch {
    // The panel closed while we were asking. Nothing to tell it.
  }

  if (outstanding && !running) {
    trace('measure', 'a panel connected and a pass was outstanding — resuming');
    void measure();
  }
}

// ── Stopping ─────────────────────────────────────────────────────

/**
 * Stop arrives as a one-off message rather than over the port, so it lands
 * even if the panel is between reconnects. It also clears the alarm — a pass
 * the user stopped must not quietly resume a minute later.
 *
 * `job` names which one to call off. The refresh button stops measuring only;
 * the task card's stop names `tasks`; a logout names nothing and stops
 * everything, because the token they all share is about to be revoked.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'stop') return;

  if (!message.job || message.job === 'measure') {
    stopping = true;
    void chrome.alarms.clear(ALARM);
  }

  if (!message.job || message.job === 'tasks') {
    stoppingTasks = true;
    stopKind = message.job === 'tasks' ? 'discard' : 'halt';
    void chrome.alarms.clear(TASK_ALARM);
  }

  // **Only a named stop empties the queue.** The card's stop button means "call
  // this off and give me my emails back", so the record has to go. A logout
  // names no job at all and means something quite different: the token every
  // task is spending is about to be revoked, so they have to halt — but the
  // queue is namespaced to that account and is exactly what should be waiting
  // when somebody signs back in.
  //
  // Emptied here rather than after the running task notices, because a stop is
  // an answer to a button press and the panel should not sit through a batch
  // already in flight. Safe to run twice: the second call finds nothing.
  if (message.job === 'tasks') {
    discardingTasks = true;
    // Stamped now, spent later: `endTasks` only takes what was already queued
    // when the button was pressed. See `clearTasks`. The promise is held because
    // the pass winding down has to know when the queue has actually been emptied
    // before it can decide whether anything is left to run.
    endingTasks = endTasks('stopped', Date.now());
    void endingTasks;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void measure();
  if (alarm.name === TASK_ALARM) void runQueue();
});

// ── Measuring ────────────────────────────────────────────────────

/**
 * @param {string[]} [order] the panel's queue when it has one; otherwise the
 *   worker builds its own, which is only seconds of cheap listing.
 */
async function measure(order) {
  if (running) return;
  running = true;
  stopping = false;

  try {
    // Signed out, there is no mailbox to measure and nowhere to file the
    // results. The alarm outlives a logout, so this is checked on every wake.
    // Safe ahead of the alarm below: no work has been done yet, and a wake that
    // got here from the alarm still has that alarm set.
    if (!(await activeAccount())) {
      await chrome.alarms.clear(ALARM);
      return;
    }

    // Set before the pass starts: if it dies halfway, the alarm is what brings
    // it back.
    chrome.alarms.create(ALARM, { periodInMinutes: RESUME_MINUTES });

    // Told, rather than waiting to be asked. A panel only asks when it opens, so
    // a pass the alarm resumes under an already-open panel would otherwise run
    // for an hour with nothing on screen saying so — and the panel would have
    // marked its rows short for good a minute earlier, on being told the worker
    // was idle. A port is no good for this: the panel holds one only while it is
    // itself watching. Nobody listening is the ordinary case, hence the catch.
    chrome.runtime.sendMessage({ type: 'measuring' }).catch(() => {});

    const queue = order ?? (await buildQueue());
    trace('measure', order ? 'started on the panel’s queue' : 'started, building its own queue', {
      messages: queue.length,
    });

    await ensureMeta(
      queue,
      (found, done, total) => {
        progress = { done, total };
        broadcast({ type: 'progress', done, total, sizes: Object.fromEntries(found) });
      },
      () => stopping
    );

    // Whatever was read before the stop is still worth keeping.
    await flushMessages(new Set(queue));
    progress = null;
    trace('measure', stopping ? 'stopped' : 'finished');
    broadcast({ type: stopping ? 'stopped' : 'done' });
    await chrome.alarms.clear(ALARM);
  } catch (err) {
    console.error('[MailBoy] measuring failed:', err);
    progress = null;
    broadcast({ type: 'failed', message: err?.message ?? String(err) });

    // Nothing here can fix a token the user has to re-grant, and retrying a
    // refused API every minute helps no one.
    if (err instanceof AuthError) {
      await chrome.alarms.clear(ALARM);
    } else {
      await chrome.alarms.clear(ALARM);
      chrome.alarms.create(ALARM, { delayInMinutes: RETRY_MINUTES });
    }
  } finally {
    running = false;
  }
}

// ── The task queue ───────────────────────────────────────────────

/** Something asked for the queue while a pass was already going. See below. */
let queueWanted = false;

/**
 * Work through the queue until it is empty, one task at a time.
 *
 * Everything reaches this: a panel dispatching, the alarm after a killed worker,
 * a browser restart, and a panel merely connecting. They are all the same code
 * path, because the queue on disk is the whole of the state.
 *
 * **The trampoline is not decoration.** A pass winds down for two reasons that
 * both leave work behind: a stop calls off the tasks that were queued *when the
 * button was pressed* and not one added a moment later, and a `run` from the
 * panel arrives while a task is mid-batch. Either would leave a task sitting
 * there — a stop clears the alarm, so nothing else would ever wake it. So a call
 * that finds a pass already going notes it, and the pass rounds again.
 */
async function runQueue() {
  if (workingTasks) {
    queueWanted = true;
    return;
  }

  workingTasks = true;
  try {
    let round;
    do {
      queueWanted = false;
      // A fresh pass is a fresh decision: whatever was called off has been
      // called off, and the tasks in hand now have not.
      stoppingTasks = false;
      discardingTasks = false;
      stopKind = null;
      round = await drainQueue();
    } while (round === 'again' || (round === 'drained' && queueWanted));
  } finally {
    workingTasks = false;
  }
}

/**
 * One pass over the queue.
 *
 * @returns {Promise<'drained' | 'again' | 'stop'>} `again` means a discard took
 *   the tasks it was aimed at and left something behind it, which nothing else
 *   would wake — the alarm is gone. `stop` ends the trampoline: a hard failure,
 *   with the task still at the head of the queue and its retry alarm set, or a
 *   logout, which halts deliberately and keeps everything.
 */
async function drainQueue() {
  try {
    // Signed out there is no token to spend and no mailbox to act on. The queue
    // is namespaced to the account, so it waits rather than being lost.
    if (!(await activeAccount())) {
      await chrome.alarms.clear(TASK_ALARM);
      return 'stop';
    }

    let queue = await readTasks();
    publishQueue(queue);
    if (!queue.length) {
      await chrome.alarms.clear(TASK_ALARM);
      return 'drained';
    }

    // Before the first await that can be interrupted: if the worker dies
    // mid-task, this is what brings it back.
    chrome.alarms.create(TASK_ALARM, { periodInMinutes: RESUME_MINUTES });

    while (queue.length && !stoppingTasks) {
      const ending = await runTask(queue[0]);
      if (ending === 'failed') return 'stop';
      if (ending === 'stopped') break;
      queue = await readTasks();
      publishQueue(queue);
    }

    if (stoppingTasks) {
      // A logout: halt where we are, keep everything, and do not touch the
      // alarm again — the handler already cleared it.
      if (stopKind !== 'discard') return 'stop';

      // A discard: wait for the queue to have actually been emptied before
      // deciding whether anything is left. A task queued in the moment after the
      // button was pressed survives it (see `clearTasks`), and with the alarm
      // gone the round after this is the only thing that would ever run it.
      await endingTasks;
      return 'again';
    }

    await chrome.alarms.clear(TASK_ALARM);
    return 'drained';
  } catch (err) {
    console.error('[MailBoy] task queue failed:', err);
    await chrome.alarms.clear(TASK_ALARM);
    if (!(err instanceof AuthError)) {
      chrome.alarms.create(TASK_ALARM, { delayInMinutes: RETRY_MINUTES });
    }
    return 'stop';
  }
}

/**
 * Run one task to its end.
 *
 * @returns {Promise<'done' | 'stopped' | 'failed'>} `failed` leaves the task at
 *   the head of the queue with the retry alarm on it.
 */
async function runTask(task) {
  const base = task.done ?? 0;

  /** Landed ids, held back until the checkpoint clock comes round. */
  let banked = [];
  let done = base;
  let dirty = false;
  let wroteAt = Date.now();

  /**
   * What a folder delete is up to, for the card. Starts null on **every** run,
   * which is what clears a stale `labels` left by a run that got as far as
   * removing the folders and then failed: the next one begins by listing and
   * moving mail again, and a card still saying "removing the folders" would be
   * describing the run before it.
   *
   * @type {'labels' | null}
   */
  let phase = null;

  /** Writes go one at a time. Two in flight could land out of order, and the
   *  older one would put back pruning the newer had already done. */
  let writes = Promise.resolve();

  /**
   * Write down what is left.
   *
   * `remaining` is the whole point: a killed worker resumes on exactly the mail
   * that has not moved, and the panel — which may be a *different* panel, opened
   * long after the action was taken — settles against it. `vacated` is pruned in
   * step so that a stop puts back only what never went.
   */
  const checkpoint = (force = false) => {
    if (!dirty && !force) return writes;
    if (!force && Date.now() - wroteAt < CHECKPOINT_MS) return writes;

    // Everything up to the first await is synchronous, so concurrent batches
    // cannot bank the same ids twice or race the clock.
    const landed = new Set(banked);
    banked = [];
    dirty = false;
    wroteAt = Date.now();

    const patch = { done };
    if (task.kind === 'folder-delete') patch.phase = phase;
    if (task.kind === 'bulk' && landed.size) {
      task.remaining = (task.remaining ?? task.ids ?? []).filter((id) => !landed.has(id));
      patch.remaining = task.remaining;
    }

    writes = writes
      .then(() => updateTask(task.id, patch))
      .then(publishQueue)
      // A checkpoint that cannot be written costs a resume some repeated work,
      // never the job. It must not take the job down with it.
      .catch((err) => console.warn('[MailBoy] could not check the task in:', err));

    return writes;
  };

  try {
    trace('job', `${task.action} started`, { id: task.id, kind: task.kind, done: base });

    // A run that reached the folders and then failed left `labels` on the
    // record. This one starts over at the listing, so the card must stop saying
    // otherwise before that listing — which on a large folder is seconds.
    if (task.phase) await checkpoint(true);

    const outcome =
      task.kind === 'folder-delete'
        ? await runDeleteJob(task, {
            onProgress: (moved) => {
              // A folder delete re-derives its own work by listing, so there is
              // nothing to bank — only how far along to say it is.
              done = base + moved;
              dirty = true;
              void checkpoint();
            },
            onPhase: (next) => {
              phase = next;
              dirty = true;
              void checkpoint(true);
            },
            stopped: () => stoppingTasks,
          })
        : await runBulkJob(task, {
            onLanded: (ids, moved) => {
              banked.push(...ids);
              done = base + moved;
              dirty = true;
              void checkpoint();
            },
            stopped: () => stoppingTasks,
          });

    await checkpoint(true);

    // Gmail would not get to all of it. Nothing has failed — this mail has not
    // been *tried* to a conclusion — so the task stays queued with the rest of
    // its work in `remaining`, keeps holding that mail out of the rows, and
    // comes back. Reporting it as refused is what produced "346 moved. 399 could
    // not be moved."
    if (!outcome.complete && outcome.unfinished && !stoppingTasks) {
      // `outcome.done` counts this run only — a resumed task starts it at zero —
      // so anything above zero means the run got somewhere.
      return retryLater(task, {
        moved: outcome.done > 0,
        outstanding: outcome.unfinished,
      });
    }

    // A folder delete that could not move all of its mail keeps its labels —
    // see `runDeleteJob` — so it is unfinished rather than done, and it is not a
    // stop either: falling through to the branch below would take it out of the
    // queue with mail still sitting under a folder somebody asked to have
    // removed, and nothing left holding that mail out of the rows.
    //
    // It takes the long clock rather than `retryLater`'s, because `failed` here
    // is Gmail refusing the request outright — a malformed id, a withdrawn
    // permission — which coming back in two minutes would meet again. Nothing
    // drops it: it stays queued with the card up and its Stop button, which is
    // the whole shape of the completion guarantee.
    if (!outcome.complete && outcome.failed.length && !stoppingTasks) {
      return refusedLater(task, outcome.failed.length);
    }

    if (!outcome.complete) {
      // Stopped, one of two ways. The card's stop button has already emptied the
      // queue and told the panel what to put back, so there is nothing left to
      // report; a logout halted this without discarding anything, and the record
      // is meant to be waiting when somebody signs back in. Either way the
      // checkpoint above is what makes the resume exact.
      trace('job', `${task.action} stopped`, { id: task.id, done: outcome.done });
      return 'stopped';
    }

    const queue = await dropTask(task.id);
    publishQueue(queue);

    // Only what this kind of task actually reports. A folder delete has no
    // `moved` and a bulk move has no `trashed`, and the undefineds made a trace
    // read as a job that had done nothing.
    trace('job', `${task.action} finished`, {
      id: task.id,
      ...(outcome.moved === undefined ? {} : { moved: outcome.moved }),
      ...(outcome.trashed === undefined ? {} : { trashed: outcome.trashed }),
      ...(outcome.restored === undefined ? {} : { restored: outcome.restored }),
      refused: outcome.failed.length,
    });

    broadcast(
      {
        type: 'task-ended',
        ending: 'done',
        id: task.id,
        kind: task.kind,
        action: task.action,
        target: task.target ?? '',
        name: task.labels?.at(-1)?.name ?? '',
        labels: task.labels ?? [],
        // What never moved: refusals on a completed run. The panel puts exactly
        // these back and treats everything else as landed.
        remaining: task.kind === 'bulk' ? (task.remaining ?? []) : [],
        moved: outcome.moved,
        trashed: outcome.trashed,
        restored: outcome.restored,
        failed: outcome.failed,
      },
      taskPorts
    );

    return 'done';
  } catch (err) {
    // A move gives up by throwing rather than by reporting — `batchModify` has
    // no per-message outcome to report — so a rate limit reaches here as an
    // exception. It is the same thing as the branch above and takes the same
    // path: nothing failed, and the task is owed another go soon rather than in
    // a quarter of an hour.
    if (rateLimit(err) && !stoppingTasks) {
      return retryLater(task, { moved: done > base, outstanding: 0 });
    }

    console.error('[MailBoy] task failed:', err);

    // The task stays in the queue with whatever it checkpointed, so the mail it
    // is holding out of the rows stays held — the panel must not put it back
    // over a failure that is about to be retried. **Nothing here drops it**: a
    // queued task is only ever ended by finishing or by the user, so even a
    // failure nobody understands comes back round.
    broadcast(
      {
        type: 'task-ended',
        ending: 'failed',
        id: task.id,
        kind: task.kind,
        action: task.action,
        target: task.target ?? '',
        name: task.labels?.at(-1)?.name ?? '',
        message: err?.message ?? String(err),
      },
      taskPorts
    );

    await chrome.alarms.clear(TASK_ALARM);
    // Nothing here can re-grant a token, and hammering a refused API every
    // minute helps no one. The queue survives either way, so signing back in or
    // reopening the panel picks it up — both of which run the queue.
    if (!(err instanceof AuthError)) {
      chrome.alarms.create(TASK_ALARM, { delayInMinutes: RETRY_MINUTES });
    }
    return 'failed';
  }
}

/** Whether a thrown error is Gmail saying "not now" rather than "no". */
function rateLimit(err) {
  if (err?.status === 429) return true;
  const reason = err?.reason ?? '';
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') return true;
  return /rate ?limit|quota exceeded|too many concurrent/i.test(err?.message ?? '');
}

/**
 * Gmail refused some of the work outright, so the task is owed another go on the
 * slow clock — the same ending a thrown failure takes, reported without an
 * exception to carry it.
 *
 * The panel treats `failed` as "still queued, still holding its mail", which is
 * exactly right here: the folders are still standing and the mail under them
 * still has to come out of the rows.
 */
async function refusedLater(task, refused) {
  console.error('[MailBoy] task refused, keeping it queued:', task.id, refused);
  trace('job', `${task.action} refused — leaving it queued`, {
    id: task.id,
    refused,
    retryIn: `${RETRY_MINUTES}m`,
  });

  broadcast(
    {
      type: 'task-ended',
      ending: 'failed',
      id: task.id,
      kind: task.kind,
      action: task.action,
      target: task.target ?? '',
      name: task.labels?.at(-1)?.name ?? '',
      message: `Gmail refused ${refused} of them.`,
    },
    taskPorts
  );

  await chrome.alarms.clear(TASK_ALARM);
  chrome.alarms.create(TASK_ALARM, { delayInMinutes: RETRY_MINUTES });
  return 'failed';
}

/**
 * Put a task back on the clock without ending it.
 *
 * The task keeps its place, its checkpoint and the mail it is holding; only the
 * card's line changes. **This is the shape of the completion guarantee** — there
 * is no path out of here that drops work.
 *
 * @param {{moved: boolean, outstanding: number}} how `moved` says the run
 *   achieved something, which is what decides how soon it is worth coming back.
 */
async function retryLater(task, { moved, outstanding }) {
  // A run that moved nothing at all means something else holds the whole budget
  // — nearly always a measuring pass, which can run for eighteen minutes — and
  // coming straight back to be refused again only adds to the contention it is
  // waiting on. One that moved some mail is getting through and comes back at
  // the short end.
  const held = moved ? 0 : (task.throttledRuns ?? 0) + 1;
  const minutes = Math.min(THROTTLED_MINUTES * 2 ** held, THROTTLED_MAX_MINUTES);

  trace('job', `${task.action} throttled — leaving it queued`, {
    id: task.id,
    outstanding,
    moved,
    retryIn: `${minutes}m`,
  });

  const queue = await updateTask(task.id, { throttledRuns: held });
  publishQueue(queue);

  broadcast(
    {
      type: 'task-ended',
      ending: 'throttled',
      id: task.id,
      kind: task.kind,
      action: task.action,
      target: task.target ?? '',
      name: task.labels?.at(-1)?.name ?? '',
    },
    taskPorts
  );

  await chrome.alarms.clear(TASK_ALARM);
  chrome.alarms.create(TASK_ALARM, { delayInMinutes: minutes });
  return 'failed';
}

/**
 * Empty the queue and tell the panel what each task was still holding.
 *
 * This is the whole of a stop. The running task notices `stoppingTasks` and
 * returns what it achieved, but the mail it is holding out of the rows can only
 * be put back from the record — which is why the record is what is broadcast.
 */
async function endTasks(ending, before) {
  const removed = await clearTasks(undefined, before);

  // Whatever was queued in the moment after the stop — see `clearTasks` — is
  // still work, so it is what the card goes back to showing. The gag comes off
  // first, or this would publish the empty view it was put there to hold.
  // Unconditional: leaving the gag on would silence every later checkpoint.
  discardingTasks = false;
  publishQueue(await readTasks());

  for (const task of removed) {
    broadcast(
      {
        type: 'task-ended',
        ending,
        id: task.id,
        kind: task.kind,
        action: task.action,
        target: task.target ?? '',
        name: task.labels?.at(-1)?.name ?? '',
        remaining: task.kind === 'bulk' ? (task.remaining ?? task.ids ?? []) : [],
        // A stop leaves the extent genuinely unknown for a folder delete, which
        // never tracked ids; the panel takes the listing for those.
        exact: task.kind === 'bulk',
      },
      taskPorts
    );
  }
}
