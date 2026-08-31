// Rules: standing instructions about mail that has not arrived yet.
//
// A rule is a Gmail filter, and MailBoy makes exactly two kinds — everything
// from one sender goes to one folder, or everything with one subject does. Both
// are the same shape underneath: match, add the destination, take away INBOX.
//
// Trash is a destination like any other here, which is what lets the delete
// confirmation offer the same two boxes the move dialog does. It is the one
// destination whose action differs — see `actionFor` — and the one whose
// consequence needs saying out loud, since Gmail empties Trash after 30 days.
//
// **A rule and a move are two halves of one idea, and neither does the other's
// job.** The move in the panel handles the mail that is already there; a filter
// can only ever act on a delivery as it happens. Gmail's own settings screen has
// an "also apply to matching conversations" box; the API does not, and there is
// no way to ask for one. So the checkbox in the move dialog is honest as worded:
// *future* mail.
//
// ── Why the mark is a negated query ──────────────────────────────
//
// The Filter resource has no description, no labels of its own and nowhere to
// put a note, so an identifying mark has to be smuggled into a field that
// actually affects matching. `negatedQuery` is the one that costs nothing:
// "doesn't have the phrase mailboy-managed-rule" excludes a set of messages that
// does not exist, so the rule behaves exactly as it would without it, and the
// mark comes back with every `filters.list` for free.
//
// The two alternatives were worse. A marker *label* would put MailBoy's
// bookkeeping on the user's actual mail and then have to be hidden from the
// folder list. A local registry of ids we created would die with an erase, drift
// from Gmail the moment anything was changed there, and know nothing about a
// rule made on another device.
//
// The cost is one line in Gmail's own filter UI reading "Doesn't have:
// mailboy-managed-rule", which is arguably the point, and a theoretical email
// containing that exact phrase slipping past its own rule.
//
// ── What this deliberately does not do ───────────────────────────
//
// **Gmail cannot update a filter.** There is no patch or update method: changing
// one means deleting it and creating another, which is why the Rules screen
// offers delete and nothing else. Nothing here should grow an `updateRule`.
//
// **Nothing here is cached.** A rule carries a real sender address and, for the
// subject kind, a real mail subject — and a subject is message content, which
// *What is on disk* says is never written down. It is also not worth caching:
// re-reading every rule on the account is one quota unit.

import { createFilter, deleteFilter, listFilters } from './gmail.js';
import { trace } from './trace.js';

/**
 * What makes a filter ours.
 *
 * A single hyphenated phrase rather than a token with punctuation in it: Gmail
 * tokenises a search query, and a phrase this specific cannot be produced by
 * accident while still reading as English in Gmail's settings.
 */
export const MARK = 'mailboy-managed-rule';

/** Gmail's ceiling on filters per account, across every client that made them. */
export const MAX_RULES = 1000;

/**
 * @typedef {object} Rule
 * @property {string} id Gmail's filter id — what a delete is addressed to
 * @property {'sender' | 'subject'} kind
 * @property {string} match the address, or the subject, as typed into the filter
 * @property {string} destination the label id mail is being sent to
 */

/**
 * What a rule does to a matched message.
 *
 * **Definitive, in the same sense the panel's Move is.** A folder in MailBoy is
 * a place a message *is*, so a rule that merely added a label — Gmail's own
 * additive model — would leave the mail in two places and undo the thing the
 * product exists for.
 *
 * Removing `INBOX` is the whole of what that takes, and it is worth being clear
 * about why so nobody adds to it later:
 *
 * - Newly delivered mail carries `INBOX`, one `CATEGORY_*`, and nothing else
 *   MailBoy shows. There are no user folders to shed yet.
 * - The five category rows are scoped `in:inbox` (see *Folders, not labels*), so
 *   a message that has left the inbox has already left every category row. The
 *   categories do not need removing, and asking Gmail to remove one at delivery
 *   fights its own classifier for no visible gain.
 * - `UNREAD`, `STARRED` and `IMPORTANT` are states rather than places, and a
 *   rule must no more mark mail read than a move does.
 *
 * **Trash is the exception, and it is a bare `addLabelIds: ['TRASH']`.** That is
 * precisely what Gmail's own "Delete it" filter action is, and matching it
 * exactly is the point: `INBOX` is not removed alongside, because trashing
 * strips it anyway and a filter carrying an instruction Gmail already implies is
 * one more thing for it to reject.
 *
 * Note this is *not* the constraint `batchModify` has. That call refuses TRASH
 * outright, which is why trashing mail already in the mailbox costs one
 * `messages.trash` per message — a filter is a different surface, and the
 * ceiling there does not apply.
 */
const actionFor = (labelId) =>
  labelId === 'TRASH'
    ? { addLabelIds: ['TRASH'] }
    : { addLabelIds: [labelId], removeLabelIds: ['INBOX'] };

/**
 * The filter body for "everything from this sender".
 *
 * `criteria.from` rather than a `query` of `from:…`: it is the field Gmail's own
 * UI writes, so a rule made here reads as an ordinary filter there.
 */
export function senderRule(address, labelId) {
  return { criteria: { from: address, negatedQuery: MARK }, action: actionFor(labelId) };
}

/**
 * The filter body for "everything with this subject".
 *
 * Quoted, so Gmail matches the line as a phrase rather than as a bag of words —
 * unquoted, a subject of "Your receipt" would also catch "Receipt for your
 * order". Any quotes already in the subject are dropped rather than escaped:
 * Gmail's query syntax has no escape for them, and a stray one would break the
 * phrase open and silently widen the rule.
 */
export function subjectRule(subject, labelId) {
  const phrase = subject.replace(/"/g, '').trim();
  return { criteria: { subject: `"${phrase}"`, negatedQuery: MARK }, action: actionFor(labelId) };
}

/** The subject as the user typed it, back out of the quoted form above. */
const unquote = (value) => value.replace(/^"|"$/g, '');

/**
 * Read one raw filter as a rule, or null if it is not one of ours.
 *
 * Deliberately strict about shape as well as about the mark. A filter carrying
 * the mark but no destination cannot be drawn on a screen organised by
 * destination, and guessing at what it was meant to do would be worse than
 * leaving it to Gmail's own settings.
 *
 * @returns {Rule | null}
 */
export function readRule(filter) {
  if (filter?.criteria?.negatedQuery !== MARK) return null;

  const destination = filter.action?.addLabelIds?.[0];
  if (!destination) {
    console.warn('[MailBoy] a marked filter has no destination; leaving it alone', filter.id);
    return null;
  }

  const { from, subject } = filter.criteria;
  if (from) return { id: filter.id, kind: 'sender', match: from, destination };
  if (subject) return { id: filter.id, kind: 'subject', match: unquote(subject), destination };

  console.warn('[MailBoy] a marked filter matches on neither sender nor subject', filter.id);
  return null;
}

/**
 * Every rule MailBoy manages, and how many filters the account holds in total.
 *
 * One quota unit for all of it — `filters.list` does not paginate. The total is
 * the account's, not ours: the 1,000-filter ceiling is shared with every filter
 * the user ever made in Gmail itself, so it is the only number worth checking a
 * bulk create against.
 *
 * @returns {Promise<{rules: Rule[], filters: number}>}
 */
export async function listRules() {
  const filters = await listFilters();
  const rules = filters.map(readRule).filter(Boolean);
  trace('rules', 'read every filter on the account', {
    filters: filters.length,
    ours: rules.length,
    units: 1,
  });
  return { rules, filters: filters.length };
}

/** Whether a rule already says what a new one would — the duplicate check. */
export const sameRule = (rule, { kind, match, destination }) =>
  rule.kind === kind &&
  rule.destination === destination &&
  rule.match.toLowerCase() === match.toLowerCase();

/**
 * Create rules, one call each.
 *
 * Sequential rather than concurrent: the quota pacer in gmail.js already
 * serialises them, and a straight loop is what makes `created` and `failed`
 * describe exactly which of the specs landed.
 *
 * A failure is collected rather than thrown. Ticking a box in the move dialog
 * asks for two things — move this mail, and file the next lot — and the move is
 * the half that has already happened by the time these run, so one refused
 * filter must not read as the whole action having failed.
 *
 * @param {{kind: 'sender' | 'subject', match: string, destination: string}[]} specs
 * @returns {Promise<{created: Rule[], failed: {match: string, message: string}[]}>}
 */
export async function createRules(specs) {
  const created = [];
  const failed = [];

  for (const spec of specs) {
    const body =
      spec.kind === 'sender'
        ? senderRule(spec.match, spec.destination)
        : subjectRule(spec.match, spec.destination);

    try {
      const filter = await createFilter(body);
      created.push({ id: filter.id, ...spec });
    } catch (err) {
      console.error('[MailBoy] could not create a rule for', spec.match, err);
      failed.push({ match: spec.match, message: err?.message ?? '' });
    }
  }

  trace('rules', 'created', { asked: specs.length, made: created.length, units: specs.length * 5 });
  return { created, failed };
}

/**
 * Remove rules, one call each.
 *
 * A 404 counts as removed: the filter is gone, which is what was asked for, and
 * the likeliest way to see one is a rule deleted in Gmail's settings since this
 * screen was drawn.
 *
 * @param {string[]} ids
 * @returns {Promise<{deleted: string[], failed: string[]}>}
 */
export async function deleteRules(ids) {
  const deleted = [];
  const failed = [];

  for (const id of ids) {
    try {
      await deleteFilter(id);
      deleted.push(id);
    } catch (err) {
      if (err?.status === 404) {
        deleted.push(id);
        continue;
      }
      console.error('[MailBoy] could not delete rule', id, err);
      failed.push(id);
    }
  }

  trace('rules', 'deleted', { asked: ids.length, gone: deleted.length, units: ids.length * 5 });
  return { deleted, failed };
}
