// MailBoy service worker.
//
// Four jobs: open the side panel from the toolbar, own the slow half of the
// data pass — reading every message for its size and sender — empty a folder
// that is being deleted, and carry out an action on a selection of senders.
//
// All three of the long ones live here rather than in the panel because they
// take minutes, and requiring someone to sit with the panel open for that is
// not a reasonable thing to ask.
//
// None keeps a cursor. The measuring queue is rebuilt from scratch on every
// wake and the message cache filters out whatever is already known; a delete
// re-lists its labels, and mail it has already moved no longer comes back in
// that listing. So "start" and "resume" are one code path, which is what makes
// a termination at any instant harmless — Chrome ends a worker after roughly 30
// seconds of inactivity, and while a batch every couple of seconds keeps it
// alive, that is a happy accident and never something to depend on.
//
// A delete carries one small record all the same — which folders, and what to
// do with their mail. That is intent, not progress: nothing in the mailbox can
// tell the worker whether the user asked for Trash or for the inbox. A
// selection job carries a much larger one, because the ids themselves cannot be
// re-derived from anything Gmail holds; see src/bulk.js.

import { activeAccount } from './src/account.js';
import { AuthError } from './src/auth.js';
import { clearBulkJob, readBulkJob, runBulkJob, saveBulkJob } from './src/bulk.js';
import { clearDeleteJob, readDeleteJob, runDeleteJob, saveDeleteJob } from './src/folders.js';
import { buildQueue } from './src/mailbox.js';
import { ensureMeta, flushMessages } from './src/messages.js';
import { trace } from './src/trace.js';

const PORT_NAME = 'measure';
const ALARM = 'measure';

const FOLDER_PORT = 'folders';
const DELETE_ALARM = 'folder-delete';
const BULK_ALARM = 'bulk-job';

/** Safety net: if the worker is killed mid-pass, this starts it again. */
const RESUME_MINUTES = 1;

/** After a hard failure, stop hammering and try again much later. */
const RETRY_MINUTES = 15;

function openOnClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[MailBoy] side panel behavior:', err));
}

chrome.runtime.onInstalled.addListener(openOnClick);
chrome.runtime.onStartup.addListener(openOnClick);

// A browser restart takes the alarms with it, so a job interrupted by one would
// otherwise sit half-done until somebody opened the panel and noticed.
chrome.runtime.onStartup.addListener(() => void resumeDelete());
chrome.runtime.onStartup.addListener(() => void resumeBulk());

// ── Talking to the panel ─────────────────────────────────────────

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

/** @type {Set<chrome.runtime.Port>} */
const folderPorts = new Set();

/** Last progress seen, so a panel opening mid-pass is not left guessing. */
let progress = null;

/** The same, for a delete: `{done, total, name}`. */
let deleteProgress = null;

/** And for a selection job: `{done, total, action, target}`. */
let bulkProgress = null;

let running = false;

/** Set by a stop from the panel; cleared when a fresh pass begins. */
let stopping = false;

let deleting = false;
let stoppingDelete = false;

let bulking = false;
let stoppingBulk = false;

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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === FOLDER_PORT) {
    folderPorts.add(port);
    port.onDisconnect.addListener(() => folderPorts.delete(port));

    if (deleteProgress) port.postMessage({ type: 'delete-progress', ...deleteProgress });
    if (bulkProgress) port.postMessage({ type: 'bulk-progress', ...bulkProgress });

    // Opening the panel is a recovery path in its own right. A job whose alarm
    // was lost — cleared by a logout, or gone with a browser restart — would
    // otherwise sit there with its folders half emptied and nothing to wake it.
    if (!deleting) void resumeDelete();
    if (!bulking) void resumeBulk();

    port.onMessage.addListener((message) => {
      if (message?.type === 'delete') void startDelete(message.job);
      if (message?.type === 'bulk') void startBulk(message.job);
    });
    return;
  }

  if (port.name !== PORT_NAME) return;

  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));

  // Whatever is already in flight, said immediately — otherwise a panel opened
  // ten minutes in shows nothing until the next batch lands.
  if (progress) port.postMessage({ type: 'progress', ...progress, sizes: {} });

  port.onMessage.addListener((message) => {
    // The panel just enumerated; reuse its queue rather than repeating it.
    if (message?.type === 'start') void measure(message.order);
  });
});

// ── The job ──────────────────────────────────────────────────────

/**
 * Stop arrives as a one-off message rather than over the port, so it lands
 * even if the panel is between reconnects. It also clears the alarm — a pass
 * the user stopped must not quietly resume a minute later.
 *
 * `job` names which one to call off. The refresh button stops measuring only; a
 * logout names nothing and stops everything, because the token both of them are
 * using is about to be revoked.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'stop') return;

  if (!message.job || message.job === 'measure') {
    stopping = true;
    void chrome.alarms.clear(ALARM);
  }

  if (!message.job || message.job === 'delete') {
    stoppingDelete = true;
    void chrome.alarms.clear(DELETE_ALARM);
  }

  if (!message.job || message.job === 'bulk') {
    stoppingBulk = true;
    void chrome.alarms.clear(BULK_ALARM);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void measure();
  if (alarm.name === DELETE_ALARM) void resumeDelete();
  if (alarm.name === BULK_ALARM) void resumeBulk();
});

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

// ── Deleting folders ─────────────────────────────────────────────

/**
 * Take a delete from the panel.
 *
 * The record is written before any work starts, so a worker killed on its very
 * first await still leaves something for the alarm to find. Everything after
 * this point goes through `runDelete`, which is also what the alarm calls —
 * there is no separate resume path.
 */
async function startDelete(job) {
  if (deleting) return;
  const stamped = { ...job, startedAt: Date.now() };
  await saveDeleteJob(stamped);
  await runDelete(stamped);
}

/** What the alarm and a browser restart both come back to. */
async function resumeDelete() {
  if (deleting) return;
  const job = await readDeleteJob();
  if (job) await runDelete(job);
}

/**
 * Move a folder's mail, then remove the folder.
 *
 * The record is cleared only on a completed run. A stop or a crash leaves it in
 * place with the labels still there, which is exactly the state `runDeleteJob`
 * knows how to pick up from — it re-lists each label and finds only the mail it
 * has not dealt with yet.
 */
async function runDelete(job) {
  if (deleting) return;
  deleting = true;
  stoppingDelete = false;

  try {
    // Signed out there is no token to spend and no mailbox to act on. The job
    // record is namespaced to the account, so it waits rather than being lost.
    if (!(await activeAccount())) {
      await chrome.alarms.clear(DELETE_ALARM);
      return;
    }

    // Before the first await that can be interrupted, same as the size pass.
    chrome.alarms.create(DELETE_ALARM, { periodInMinutes: RESUME_MINUTES });

    const name = job.labels.at(-1)?.name ?? '';
    deleteProgress = { done: 0, total: job.total ?? 0, name };
    broadcast({ type: 'delete-progress', ...deleteProgress }, folderPorts);

    const outcome = await runDeleteJob(job, {
      onProgress: (done, total) => {
        deleteProgress = { done, total, name };
        broadcast({ type: 'delete-progress', done, total, name }, folderPorts);
      },
      stopped: () => stoppingDelete,
    });

    deleteProgress = null;
    await chrome.alarms.clear(DELETE_ALARM);

    if (!outcome.complete) {
      // Stopped, not finished. The record stays and the alarm above is gone, so
      // nothing resumes until the panel asks again — which is what a stop means.
      trace('job', 'folder delete stopped', outcome);
      broadcast({ type: 'delete-stopped', ...outcome, name }, folderPorts);
      return;
    }

    await clearDeleteJob();
    trace('job', `folder delete finished — ${job.trash ? 'to Trash' : 'to the inbox'}`, {
      trashed: outcome.trashed,
      restored: outcome.restored,
      refused: outcome.failed.length,
      folders: job.labels.length,
    });
    broadcast({ type: 'delete-done', ...outcome, name, labels: job.labels }, folderPorts);
  } catch (err) {
    console.error('[MailBoy] deleting folder failed:', err);
    deleteProgress = null;
    broadcast({ type: 'delete-failed', message: err?.message ?? String(err) }, folderPorts);

    // Same reasoning as the size pass: nothing here can re-grant a token, and
    // hammering a refused API every minute helps no one. The record survives
    // either way, so signing back in and reopening the panel picks it up.
    await chrome.alarms.clear(DELETE_ALARM);
    if (!(err instanceof AuthError)) {
      chrome.alarms.create(DELETE_ALARM, { delayInMinutes: RETRY_MINUTES });
    }
  } finally {
    deleting = false;
  }
}

// ── Acting on a sender selection ─────────────────────────────────
//
// Same shape as the delete above, and for the same two reasons: trashing is 5
// quota units a message, so a large selection is minutes, and a worker can be
// ended at any moment. The difference is that this job's record carries the
// message ids themselves — a sender selection is a choice made in the panel and
// nothing in the mailbox records it, so there is nothing to re-derive it from.
// See src/bulk.js.

async function startBulk(job) {
  if (bulking) return;
  const stamped = { ...job, startedAt: Date.now() };
  await saveBulkJob(stamped);
  await runBulk(stamped);
}

/** What the alarm and a browser restart both come back to. */
async function resumeBulk() {
  if (bulking) return;
  const job = await readBulkJob();
  if (job) await runBulk(job);
}

async function runBulk(job) {
  if (bulking) return;
  bulking = true;
  stoppingBulk = false;

  try {
    // Signed out there is no token to spend and no mailbox to act on. The
    // record is namespaced to the account, so it waits rather than being lost.
    if (!(await activeAccount())) {
      await chrome.alarms.clear(BULK_ALARM);
      return;
    }

    // Before the first await that can be interrupted, same as the other two.
    chrome.alarms.create(BULK_ALARM, { periodInMinutes: RESUME_MINUTES });

    const shape = { action: job.action, target: job.target ?? '', total: job.ids.length };
    bulkProgress = { done: 0, ...shape };
    broadcast({ type: 'bulk-progress', ...bulkProgress }, folderPorts);

    const outcome = await runBulkJob(job, {
      onProgress: (done) => {
        bulkProgress = { done, ...shape };
        broadcast({ type: 'bulk-progress', ...bulkProgress }, folderPorts);
      },
      stopped: () => stoppingBulk,
    });

    bulkProgress = null;
    await chrome.alarms.clear(BULK_ALARM);

    if (!outcome.complete) {
      // Stopped, not finished. The record stays and the alarm is gone, so
      // nothing resumes until the panel asks again — which is what a stop means.
      trace('job', `${job.action} stopped`, outcome);
      broadcast({ type: 'bulk-stopped', ...outcome, ...shape }, folderPorts);
      return;
    }

    await clearBulkJob();
    trace('job', `${job.action} finished`, {
      moved: outcome.moved,
      trashed: outcome.trashed,
      refused: outcome.failed.length,
      of: job.ids.length,
    });
    broadcast({ type: 'bulk-done', ...outcome, ...shape }, folderPorts);
  } catch (err) {
    console.error('[MailBoy] selection job failed:', err);
    bulkProgress = null;
    broadcast(
      { type: 'bulk-failed', action: job.action, message: err?.message ?? String(err) },
      folderPorts
    );

    await chrome.alarms.clear(BULK_ALARM);
    if (!(err instanceof AuthError)) {
      chrome.alarms.create(BULK_ALARM, { delayInMinutes: RETRY_MINUTES });
    }
  } finally {
    bulking = false;
  }
}
