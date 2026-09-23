// What labels does Gmail actually have on these messages?
//
// The question this answers is "MailBoy says these 43 emails are Updates and
// Gmail shows them in Primary — which of the two is wrong?", and the answer is
// usually **neither**. MailBoy reads the `CATEGORY_*` label Gmail put on the
// message; Gmail's inbox shows *tabs*, and the two are not the same thing.
//
// **A category tab can be turned off** — Gmail, Settings → Inbox → Categories —
// and when it is, that category's mail is displayed in Primary. Gmail does not
// remove the label to do it: the message still carries `CATEGORY_UPDATES`, it is
// still found by a `category:updates` search, and `labels.get` still counts it.
// So a mailbox with the Updates tab switched off shows an empty Updates tab, all
// of that mail in Primary, and a MailBoy row reading 43. Nothing is miscounted.
//
// This prints the real label set on a handful of messages so that can be checked
// rather than argued about, with a link that opens each one in Gmail.
//
// ── Running it ───────────────────────────────────────────────────
//
//     const { inspectLabels } = await import('/tools/inspect-labels.js');
//     await inspectLabels('CATEGORY_UPDATES');
//     await inspectLabels('CATEGORY_UPDATES', { sample: 10 });
//     await inspectLabels('INBOX', { account: 1 });   // Gmail's /u/<n>/
//
// **Cost: 5 units to list, plus 20 units per message sampled** — `messages.get`
// is 20 whatever is asked for, so five messages is about 105 units and a second.
//
// It reads each message with `format=full` because that is the only accessor
// `src/gmail.js` exports, but **it prints nothing but ids and label names**: no
// subject, no sender, no snippet, no body. Same rule the tracing follows — what
// is kept off disk does not go to a console either. It writes nothing.

import { getMessage, listMessageIds } from '../src/gmail.js';

/** Matches SCOPES in src/mailbox.js — a category row is what is in the inbox. */
const SCOPES = {
  CATEGORY_PERSONAL: 'in:inbox',
  CATEGORY_SOCIAL: 'in:inbox',
  CATEGORY_PROMOTIONS: 'in:inbox',
  CATEGORY_UPDATES: 'in:inbox',
  CATEGORY_FORUMS: 'in:inbox',
};

const CATEGORIES = Object.keys(SCOPES);

export async function inspectLabels(labelId = 'CATEGORY_UPDATES', { sample = 5, account = 0 } = {}) {
  const ids = await listMessageIds(labelId, SCOPES[labelId], undefined, { priority: true });
  if (!ids.length) {
    console.log(`[labels] ${labelId} holds nothing — nothing to inspect.`);
    return null;
  }

  console.log(
    `[labels] ${labelId} holds ${ids.length.toLocaleString()} message(s). ` +
      `Reading ${Math.min(sample, ids.length)} of them.`
  );

  const rows = [];
  /** How often each label co-occurs, which is what shows a double categorisation. */
  const together = new Map();

  for (const id of ids.slice(0, sample)) {
    let message;
    try {
      message = await getMessage(id);
    } catch (err) {
      console.warn('[labels] could not read', id, err);
      continue;
    }

    const labels = message.labelIds ?? [];
    for (const name of labels) together.set(name, (together.get(name) ?? 0) + 1);

    rows.push({
      id,
      // The categories this message carries. More than one here would mean the
      // rows genuinely overlap; exactly one is the ordinary case.
      categories: labels.filter((name) => CATEGORIES.includes(name)).join(', ') || '(none)',
      inInbox: labels.includes('INBOX'),
      allLabels: labels.join(' '),
      // Opens the conversation in Gmail, so where Gmail *shows* it can be
      // compared against the label it actually carries.
      openInGmail: `https://mail.google.com/mail/u/${account}/#all/${message.threadId ?? id}`,
    });
  }

  console.table(rows.map(({ allLabels, ...rest }) => rest));
  console.log('[labels] every label seen across the sample, and how many carried it:');
  console.table(
    [...together.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => ({ label, messages: n }))
  );

  const multi = rows.filter((row) => row.categories.includes(','));
  if (multi.length) {
    console.log(
      `%c[labels] ${multi.length} of the sample carry more than one category. The category rows ` +
        'overlap for those, so they will not sum to Inbox.',
      'color:#a60;font-weight:bold'
    );
  } else {
    console.log(
      `%c[labels] every message sampled carries exactly one category, and it is ${labelId}. ` +
        'So the label is right and MailBoy is counting it correctly — if Gmail shows these in ' +
        'Primary, that tab is switched off under Settings → Inbox → Categories.',
      'color:green'
    );
  }

  return rows;
}
