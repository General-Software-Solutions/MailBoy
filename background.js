// MailBoy service worker.
//
// Two jobs: open the side panel from the toolbar, and own the slow half of the
// data pass — reading every message for its size and sender.
//
// That work lives here rather than in the panel because it takes minutes on a
// first run, and requiring someone to sit with the panel open for that is not
// a reasonable thing to ask.
//
// The job is deliberately stateless. Nothing about progress is persisted: no
// cursor, no remaining-id list. Every wake rebuilds the queue from scratch and
// the message cache filters out whatever is already known, so "start" and
// "resume" are the same code path. That matters because a service worker can
// be terminated at any instant — Chrome ends one after roughly 30 seconds of
// inactivity, and while a batch every couple of seconds keeps it alive, that
// is a happy accident and never something to depend on.

import { AuthError } from './src/auth.js';
import { buildQueue } from './src/mailbox.js';
import { ensureMeta, flushMessages } from './src/messages.js';

const PORT_NAME = 'measure';
const ALARM = 'measure';

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

// ── Talking to the panel ─────────────────────────────────────────

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

/** Last progress seen, so a panel opening mid-pass is not left guessing. */
let progress = null;

let running = false;

function broadcast(message) {
  for (const port of ports) {
    try {
      port.postMessage(message);
    } catch {
      // The panel closed between the check and the send. Nothing to do.
      ports.delete(port);
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void measure();
});

/**
 * @param {string[]} [order] the panel's queue when it has one; otherwise the
 *   worker builds its own, which is only seconds of cheap listing.
 */
async function measure(order) {
  if (running) return;
  running = true;

  // Set before any await: if this pass dies halfway, the alarm is what brings
  // it back.
  chrome.alarms.create(ALARM, { periodInMinutes: RESUME_MINUTES });

  try {
    const queue = order ?? (await buildQueue());

    await ensureMeta(queue, (found, done, total) => {
      progress = { done, total };
      broadcast({ type: 'progress', done, total, sizes: Object.fromEntries(found) });
    });

    await flushMessages(new Set(queue));
    progress = null;
    broadcast({ type: 'done' });
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
