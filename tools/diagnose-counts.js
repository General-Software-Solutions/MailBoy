// Why does a row read differently here than in Gmail?
//
// Every number MailBoy shows is a count of **message ids enumerated under one
// label, narrowed by that row's scope**. Gmail's own interface answers three
// *different* questions in three different places, and a mismatch is nearly
// always one of them rather than a fault:
//
//   1. **Gmail counts conversations; MailBoy counts messages.** "1–50 of 4,700"
//      is 4,700 threads. A row holding 5,900 messages in those threads is not
//      wrong. `threadsTotal` below is the figure Gmail would print.
//   2. **The bold number beside a label in Gmail's sidebar is *unread*, not
//      total.** `messagesUnread` / `threadsUnread` below are those.
//   3. **A row's scope narrows it, and Gmail's link usually does not.** This is
//      the one that actually surprises people — see the two gaps below.
//
// ── The two gaps this exists to measure ──────────────────────────
//
// **Categories are scoped `in:inbox`.** A CATEGORY_* label is applied at
// delivery and never removed, so it stays on mail long after it is archived —
// `category:promotions` in Gmail's search finds archived promos, and with the
// tabbed inbox switched off Gmail's own Categories links behave the same way.
// MailBoy narrows them to the inbox on purpose, so that the five partition
// Inbox exactly and can be nested under it (see *Folders, not labels*). The
// consequence is that `archivedOrElsewhere` below is mail Gmail will show you
// under Social and MailBoy will not — and when the inbox-scoped count is 0 the
// row is **hidden entirely**, which is what "I have no Social folder" is.
//
// **User folders and Inbox are scoped `-in:sent -is:draft`.** Gmail labels
// *threads*, so your own replies in a labelled conversation carry that label.
// `yourOwnMail` below is how many messages that scope removes from each row —
// and it is also the divergence from Gmail's sidebar that *Folders, not
// labels* accepted deliberately.
//
// Note `messagesTotal` includes spam and trash, where the enumerated figures
// here do not (except on the SPAM and TRASH rows themselves — `listMessageIds`
// sets `includeSpamTrash` for exactly those two). So a category with a lot of
// deleted promo mail will show a large `total` against a small `unscoped`, and
// that is expected rather than a paging fault.
//
// ── Running it ───────────────────────────────────────────────────
//
//     const { diagnoseCounts } = await import('/tools/diagnose-counts.js');
//     await diagnoseCounts();                 // the Google default rows
//     await diagnoseCounts({ user: true });   // your own folders too
//     await diagnoseCounts({ label: 'CATEGORY_SOCIAL' });
//
// **Cost: 1 unit per row for `labels.get`, plus 5 units per 500 ids for each of
// two enumerations.** On an ordinary mailbox that is a few hundred units and a
// few seconds. It writes nothing, reads no mail content, and touches neither
// the cache nor the snapshot.
//
// **Stop the size pass first** (the Refresh button reads "Stop" while one
// runs). These listings take the interactive lane, which is paid for by pushing
// the bulk lane's *future* reservations back and does nothing about the ones it
// has already issued — so a diagnostic run alongside a live pass spends on top
// of it and can draw a cool-off. Same caveat as tools/measure-threads.js.

import { getLabel, listLabels, listMessageIds } from '../src/gmail.js';
import { buildGroups } from '../src/labels.js';

/** Matches SCOPES in src/mailbox.js. Keep the three in step. */
const SCOPES = {
  inbox: 'in:inbox',
  incoming: '-in:sent -is:draft',
};

async function rowsOf({ user }) {
  const groups = buildGroups(await listLabels());
  return user ? [...groups.defaults, ...groups.user] : groups.defaults;
}

/** Enumerate, and report the failure rather than throwing the whole run. */
async function count(labelId, query) {
  try {
    const ids = await listMessageIds(labelId, query, undefined, { priority: true });
    // A duplicate id across pages would mean a paging fault rather than
    // anything about scoping, and the two look identical from a total alone.
    return { n: new Set(ids).size, listed: ids.length };
  } catch (err) {
    console.warn('[counts] could not list', labelId, query ?? '(unscoped)', err);
    return null;
  }
}

export async function diagnoseCounts({ user = false, label = null } = {}) {
  const rows = (await rowsOf({ user })).filter((row) => !label || row.id === label);
  if (!rows.length) {
    console.warn('[counts] no such row — pass a label id like CATEGORY_SOCIAL or INBOX');
    return null;
  }

  const report = [];

  for (const row of rows) {
    const scope = row.scope ? SCOPES[row.scope] : undefined;

    // What the panel itself would count, and the same listing with the scope
    // taken off. The difference between the two *is* the gap being explained.
    const scoped = await count(row.id, scope);
    const unscoped = scope ? await count(row.id, undefined) : scoped;

    let meta = {};
    try {
      const got = await getLabel(row.id);
      meta = {
        total: got.messagesTotal ?? null,
        threads: got.threadsTotal ?? null,
        unread: got.messagesUnread ?? null,
        threadsUnread: got.threadsUnread ?? null,
      };
    } catch (err) {
      console.warn('[counts] labels.get refused', row.id, err);
    }

    const gap = scoped && unscoped ? unscoped.n - scoped.n : null;

    report.push({
      row: row.fullName ?? row.name ?? row.id,
      id: row.id,
      scope: row.scope ?? '(none)',
      // The number on screen right now.
      mailboy: scoped?.n ?? null,
      // The same label with nothing narrowing it.
      unscoped: unscoped?.n ?? null,
      // Named for what the gap actually is, so the table reads as an answer.
      ...(row.scope === 'inbox'
        ? { archivedOrElsewhere: gap }
        : row.scope === 'incoming'
          ? { yourOwnMail: gap }
          : {}),
      // Gmail's own figures. `threads` is what Gmail's "1–50 of N" prints;
      // `unread` is the bold number in its sidebar. `total` counts spam and
      // trash, which the enumerations above do not.
      gmailThreads: meta.threads ?? null,
      gmailUnread: meta.unread ?? null,
      labelTotal: meta.total ?? null,
      // Non-zero here is a paging fault, not a scoping one.
      listedTwice: (scoped?.listed ?? 0) - (scoped?.n ?? 0),
      // What the panel does with a 0 on a category row.
      hidden: row.hideWhenEmpty === true && scoped?.n === 0,
    });
  }

  console.table(report);

  const hidden = report.filter((r) => r.hidden);
  if (hidden.length) {
    console.log(
      `%c[counts] ${hidden.length} row(s) are hidden because their inbox-scoped count is 0: ` +
        `${hidden.map((r) => r.row).join(', ')}. Gmail may still list mail under them — see ` +
        `archivedOrElsewhere.`,
      'color:#a60;font-weight:bold'
    );
  }

  const stranded = report.filter((r) => r.archivedOrElsewhere > 0);
  if (stranded.length) {
    console.log(
      '%c[counts] these categories hold mail that has left the inbox. MailBoy does not count it; ' +
        "Gmail's category links do:",
      'font-weight:bold'
    );
    console.table(
      stranded.map((r) => ({ row: r.row, inInbox: r.mailboy, elsewhere: r.archivedOrElsewhere }))
    );
  }

  const doubled = report.filter((r) => r.listedTwice > 0);
  if (doubled.length) {
    console.error('[counts] these rows listed the same message twice — that is a paging fault:');
    console.table(doubled);
  }

  return report;
}
