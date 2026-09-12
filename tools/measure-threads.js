// How many messages does a thread hold in *this* mailbox?
//
// It decides whether the size pass can be made several times faster, and it is
// the one number the published quota table cannot answer.
//
// Reading a message is `messages.get`, 20 units. Reading a whole thread is
// `threads.get`, **40** — and it returns every message in that thread, each with
// its own `sizeEstimate` and headers. So the cost per message is 40 ÷ (messages
// in the thread), and the comparison is arithmetic:
//
//     1 message  per thread → 40 units/message   — twice as expensive
//     2 messages per thread → 20 units/message   — exactly break-even
//     3 messages per thread → 13 units/message   — 1.5× faster
//    10 messages per thread →  4 units/message   — 5× faster
//
// A mailbox of newsletters is all one-message threads and `threads.get` would be
// the worst thing to do to it. A mailbox of long conversations is the opposite.
// Nobody can tell from the outside, hence this.
//
// ── Why the numbers look wrong in the first place ────────────────
//
// **Gmail's interface counts conversations; every number in MailBoy counts
// messages.** "1–50 of 4,700" in Trash is 4,700 *conversations*. If MailBoy
// enumerates 47,000 messages in the same folder, nothing is broken — the folder
// holds 47,000 messages in 4,700 threads, and that ratio is exactly the figure
// this measures.
//
// ── Running it ───────────────────────────────────────────────────
//
//     const { measureThreads } = await import('/tools/measure-threads.js');
//     await measureThreads();                  // every row, biggest first
//     await measureThreads({ label: 'TRASH' }); // just one
//
// **Cost: 5 quota units per 500 messages**, which is the same listing the panel
// already does on every full refresh — about 475 units for a 47,000-message
// folder, against the 940,000 it takes to read it. It writes nothing and reads no
// mail content: ids and thread ids only.
//
// **Stop the size pass first** (the Refresh button reads "Stop" while one runs).
// Its listings take the interactive lane, and that lane's slice is paid for by
// pushing the *bulk* lane's future reservations back — which does nothing about
// the reservations it has already issued. So a hundred listings alongside a
// running pass spend on top of it in real time rather than instead of it, and
// that is enough to cross the ceiling: run against a live pass on 2026-09-12, it
// drew a `403 rateLimitExceeded` and a cool-off. Harmless — `request` waited it
// out and the run finished — but it slows the pass it is measuring, which is a
// rude thing for a diagnostic to do.

import { listLabels, listMessageRefs } from '../src/gmail.js';
import { buildGroups } from '../src/labels.js';

/** Matches SCOPES in src/mailbox.js — a user folder counts only what arrived. */
const INCOMING = '-in:sent -is:draft';
const IN_INBOX = 'in:inbox';

const UNITS_MESSAGE_GET = 20;
const UNITS_THREAD_GET = 40;

/** Rows as the panel builds them, so this measures what the pass actually reads. */
async function rowsOf() {
  const groups = buildGroups(await listLabels());
  return [...groups.defaults, ...groups.user];
}

export async function measureThreads({ label = null } = {}) {
  const rows = (await rowsOf()).filter((row) => !label || row.id === label);
  if (!rows.length) {
    console.warn('[threads] no such row — pass a label id like TRASH or INBOX');
    return null;
  }

  const report = [];
  const everyThread = new Map();
  /** Message ids counted into `everyThread`, so a row overlap cannot inflate it. */
  const counted = new Set();

  for (const row of rows) {
    const query = row.scope === 'inbox' ? IN_INBOX : row.scope === 'incoming' ? INCOMING : undefined;

    let refs;
    try {
      refs = await listMessageRefs(row.id, query, undefined, { priority: true });
    } catch (err) {
      console.warn('[threads] could not list', row.id, err);
      continue;
    }
    if (!refs.length) continue;

    const threads = new Map();
    const seen = new Set();
    for (const { id, threadId } of refs) {
      // **Duplicates would mean something quite different.** A row holding ten
      // times more ids than Gmail shows conversations is ordinary — Gmail counts
      // conversations. A row holding ten times more ids than it has *distinct*
      // messages is a paging bug, and the pass would be re-reading the same mail
      // over and over. The two look identical from the outside, so both are
      // counted here and the caller is told which it is.
      if (seen.has(id)) continue;
      seen.add(id);

      // A message with no threadId cannot be grouped; count it as its own.
      const key = threadId || id;
      threads.set(key, (threads.get(key) ?? 0) + 1);

      // **Across rows, only once.** Rows overlap by design — a category is a
      // subset of Inbox, and a labelled message still in the inbox is in both —
      // and the pass reads each message once however many rows hold it. Counting
      // it per row inflated the mailbox-wide roll-up (the per-row figures were
      // always right); it read 47,757 messages for a mailbox of about 47,200.
      if (counted.has(id)) continue;
      counted.add(id);
      everyThread.set(key, (everyThread.get(key) ?? 0) + 1);
    }

    const density = seen.size / threads.size;

    report.push({
      row: row.fullName ?? row.name ?? row.id,
      messages: seen.size,
      listedTwice: refs.length - seen.size,
      threads: threads.size,
      perThread: Number(density.toFixed(2)),
      // What the two routes cost for this row, in quota units.
      readingMessages: seen.size * UNITS_MESSAGE_GET,
      readingThreads: threads.size * UNITS_THREAD_GET,
      // Threads with 3+ messages are the ones worth fetching as threads at all.
      worthAsThread: [...threads.values()].filter((n) => n >= 3).length,
    });
  }

  report.sort((a, b) => b.messages - a.messages);

  // The pass reads each message once however many rows hold it, so the verdict
  // has to be computed over the deduplicated whole rather than summed per row.
  const messages = [...everyThread.values()].reduce((sum, n) => sum + n, 0);
  const threads = everyThread.size;

  // The adaptive route: a thread is read as a thread only where doing so is
  // cheaper than reading its messages one at a time. That is the version that
  // cannot lose, so it is the one worth quoting.
  let adaptive = 0;
  for (const n of everyThread.values()) {
    adaptive += Math.min(n * UNITS_MESSAGE_GET, UNITS_THREAD_GET);
  }

  const now = messages * UNITS_MESSAGE_GET;
  const minutes = (units) => Math.round(units / 5400); // 90 units/sec, the pacer

  const verdict = {
    messages,
    threads,
    perThread: Number((messages / Math.max(threads, 1)).toFixed(2)),
    unitsNow: now,
    unitsAdaptive: adaptive,
    speedup: Number((now / Math.max(adaptive, 1)).toFixed(2)),
    minutesNow: minutes(now),
    minutesAdaptive: minutes(adaptive),
  };

  console.table(report);
  console.log('%c[threads] the whole mailbox, deduplicated', 'font-weight:bold', verdict);

  const doubled = report.filter((row) => row.listedTwice > 0);
  if (doubled.length) {
    console.error(
      '[threads] these rows listed the same message more than once — that is a paging fault, ' +
        'not thread density, and the pass is reading the same mail repeatedly:'
    );
    console.table(doubled);
  }

  if (verdict.speedup >= 1.5) {
    console.log(
      `%c[threads] worth doing: reading by thread would take about ${verdict.minutesAdaptive} ` +
        `minutes instead of ${verdict.minutesNow} (${verdict.speedup}× faster).`,
      'color:green;font-weight:bold'
    );
  } else {
    console.log(
      `%c[threads] not worth doing: ${verdict.speedup}× is inside the noise. This mailbox is ` +
        'mostly one-message threads, which is the case threads.get is bad at.',
      'color:#a60'
    );
  }

  return { rows: report, verdict };
}
