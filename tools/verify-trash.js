// Will Gmail let `batchModify` move mail to Trash?
//
// Everything about how long a delete takes now rests on one claim: that `TRASH`
// is an ordinary manually-applicable label, so `messages.batchModify` with
// `addLabelIds: ['TRASH']` moves a thousand messages for 50 quota units. Google's
// label guide says exactly that — `SENT` and `DRAFT` are the only two it marks as
// applied automatically — and this module used to claim the opposite, on nothing.
// That wrong claim cost a factor of about four hundred: `messages.trash` is 20
// units for one message, so a folder of 10,000 emails was 200,000 units and over
// half an hour of solid throttling.
//
// The docs are not the account, and a claim about a *write* deserves better than
// a reading. So this runs the round trip for real.
//
// ── Running it ───────────────────────────────────────────────────
//
// Open the side panel, open DevTools on it (right-click → Inspect), and:
//
//     const { verifyTrash } = await import('/tools/verify-trash.js');
//     await verifyTrash();
//
// It prints a table and returns the report.
//
// ── Why it is safe to run on a real account ──────────────────────
//
// **It only ever touches one message that is already in Trash**, and it puts it
// back exactly as it found it. That choice is the whole safety argument: mail in
// Trash is mail the user has already thrown away, so the worst case is one
// already-deleted email sitting in the inbox until they delete it again — visible,
// recoverable, and reported here in as many words.
//
// The order matters and is deliberate. Taking `TRASH` *off* first tests the
// Restore path, which was itself unverified; putting it back tests the trash path
// this file exists for. Ending on the restore means a failure at either step
// leaves the message somewhere the user can see, never somewhere they cannot.
//
// Original labels are captured before anything is written and reinstated in a
// `finally`, so a message that carried folders keeps them.
//
// It needs `gmail.modify`. It creates nothing, deletes nothing, and reads no mail
// content — labelIds only.
//
// **Not part of the extension.** Nothing imports it, and it should be left out of
// the published package along with `TRACE`.

import { getMessage, listMessageIds, modifyMessages } from '../src/gmail.js';

const check = (name, pass, detail) => ({ name, pass, detail });

/** The label set Gmail currently holds for one message. */
async function labelsOf(id) {
  const message = await getMessage(id);
  return new Set(message?.labelIds ?? []);
}

const show = (labels) => [...labels].sort().join(', ') || '(none)';

/**
 * Cut a listing off after its first page.
 *
 * `listMessageIds` checks `stopped` at the top of each page and returns what it
 * has, so this is the only way to ask for "one page" — and one page is all the
 * probe needs from Trash, where any id will do. **Not used for the folder
 * listing below**: a partial list that happens not to contain the id would read
 * as a pass when it means nothing.
 */
function firstPageOnly() {
  let seen = false;
  return () => {
    const stop = seen;
    seen = true;
    return stop;
  };
}

/**
 * A user folder the message sits in, if any.
 *
 * Worth finding, because it settles a second unverified claim for free: the
 * projection asserts that a trashed message drops out of its own folder's count,
 * on the grounds that `messages.list` hides trashed mail from every label but
 * Trash. That is a claim about Gmail, and this is the one chance to check it.
 */
function userLabelIn(labels) {
  for (const id of labels) {
    if (/^Label_/.test(id)) return id;
  }
  return null;
}

/** How many trashed messages to read before giving up on finding a safe one. */
const CANDIDATES = 5;

/**
 * The first trashed message that is safe to relabel.
 *
 * Safe means incoming: `SENT` and `DRAFT` are the two labels Gmail applies
 * automatically and will not accept in a modify, so a message carrying either
 * would fail the reinstatement in the `finally` and be stranded in the inbox.
 */
async function usable(ids) {
  for (const id of ids.slice(0, CANDIDATES)) {
    const labels = await labelsOf(id);
    if (!labels.has('TRASH')) continue;
    if (labels.has('SENT') || labels.has('DRAFT')) continue;
    return { id, labels };
  }
  return null;
}

/**
 * @returns {Promise<{ok: boolean, checks: object[], message: string | null,
 *   restored: boolean}>}
 */
export async function verifyTrash() {
  const checks = [];
  let id = null;
  let original = null;
  let restored = true;

  try {
    // ── 0. Something already thrown away ──────────────────────────
    const trash = await listMessageIds('TRASH', '', firstPageOnly());
    if (!trash.length) {
      console.log(
        '[verify] Trash is empty, so there is nothing safe to test with. Delete ' +
          'one email you do not want in Gmail, then run this again.'
      );
      return { ok: false, checks, message: null, restored: true };
    }

    // **Not simply the first one.** `batchModify` genuinely does refuse `SENT`
    // and `DRAFT`, so a trashed message you wrote yourself would fail the
    // reinstatement at the end and be left in the inbox — the one outcome this
    // probe must not have. Reading a few candidates costs 20 units each.
    const candidate = await usable(trash);
    if (!candidate) {
      console.log(
        '[verify] every message checked in Trash was one you sent or a draft, ' +
          'which batchModify will not relabel. Delete an incoming email you do ' +
          'not want, then run this again.'
      );
      return { ok: false, checks, message: null, restored: true };
    }

    ({ id, labels: original } = candidate);
    checks.push(check('found a message in Trash to test with', true, `${id} — ${show(original)}`));

    const folder = userLabelIn(original);

    // ── 1. Can batchModify take TRASH off? (the Restore path) ─────
    await modifyMessages([id], { add: ['INBOX'], remove: ['TRASH'] });
    const afterRestore = await labelsOf(id);
    restored = false;

    checks.push(
      check(
        'batchModify removed TRASH',
        !afterRestore.has('TRASH'),
        `now ${show(afterRestore)}`
      )
    );
    checks.push(
      check('batchModify added INBOX alongside', afterRestore.has('INBOX'), `now ${show(afterRestore)}`)
    );

    // ── 2. Can batchModify put TRASH back? (the trash path) ───────
    //
    // The one this file is for. A refusal here comes back as a thrown
    // GmailError rather than a silently skipped id, which is why it is caught
    // below rather than inferred from the labels.
    await modifyMessages([id], { add: ['TRASH'], remove: ['INBOX'] });
    const afterTrash = await labelsOf(id);
    restored = afterTrash.has('TRASH');

    checks.push(
      check('batchModify added TRASH', afterTrash.has('TRASH'), `now ${show(afterTrash)}`)
    );
    checks.push(
      check('INBOX came off with it', !afterTrash.has('INBOX'), `now ${show(afterTrash)}`)
    );

    // A folder MailBoy shows must survive being trashed, or restoring within
    // Gmail's 30 days would come back to nowhere — and the count arithmetic
    // assumes the label is still on the message.
    if (folder) {
      checks.push(
        check('the user folder stayed on the message', afterTrash.has(folder), `${folder} in ${show(afterTrash)}`)
      );

      // ── 3. Does it drop out of that folder's listing? ───────────
      const listed = await listMessageIds(folder, '');
      checks.push(
        check(
          'messages.list hides it from its own folder',
          !listed.includes(id),
          listed.includes(id)
            ? 'still listed — a trashed message would keep counting under its folder'
            : `${listed.length.toLocaleString()} ids listed, not this one`
        )
      );
    }
  } catch (err) {
    checks.push(check('no call was refused', false, `${err.name}: ${err.message}`));
  } finally {
    // Exactly as it was found, whatever happened in between. Adding a label a
    // message already carries is a no-op, so this is safe to run on a success.
    if (id && original) {
      try {
        await modifyMessages([id], {
          add: [...original],
          remove: original.has('INBOX') ? [] : ['INBOX'],
        });
        restored = (await labelsOf(id)).has('TRASH');
      } catch (err) {
        restored = false;
        console.error('[verify] could not put the message back', id, err.message);
      }
    }
  }

  return finish(checks, id, restored);
}

function finish(checks, id, restored) {
  const ok = checks.length > 0 && checks.every((one) => one.pass);

  console.table(checks.map(({ name, pass, detail }) => ({ check: name, pass: pass ? 'yes' : 'NO', detail })));

  if (!restored && id) {
    console.error(
      `[verify] message ${id} was NOT put back in Trash. It is one email you had ` +
        'already deleted; delete it again in Gmail.'
    );
  }

  console.log(
    ok
      ? '[verify] batchModify moves mail to Trash on this account — the fast trash path is sound.'
      : '[verify] something above is NOT sound — see the table. Do not trust the batchModify trash path until it is.'
  );

  return { ok, checks, message: id, restored };
}
