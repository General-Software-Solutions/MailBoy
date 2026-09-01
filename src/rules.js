// Rules: standing instructions about mail that has not arrived yet.
//
// A rule is a Gmail filter, and MailBoy makes three kinds — everything from one
// sender goes to one folder, everything from one *domain* does, or everything
// with one subject does. All three are the same shape underneath: match, add the
// destination, take away INBOX.
//
// The domain kind was added 2026-08-31, after the tab started listing the
// account's own filters and made it obvious that people write filters against a
// whole domain far more often than against one address. It is a strictly wider
// sender rule and nothing else — see `domainRule`.
//
// ── Filters MailBoy did not make ─────────────────────────────────
//
// The Rules tab lists those too, in a section of their own, because a filter
// somebody made in Gmail files mail into the same folders and a screen that
// pretended otherwise would be describing half a mailbox. Only the ones MailBoy
// can state in one honest sentence are shown: the criteria has to be a sender or
// a subject and *nothing else* (`matchers` is the check), and the action has to
// put mail in a place MailBoy shows (`isFolder`).
//
// Anything wider — a filter matching a phrase in the body, or one that only
// stars mail — is left to Gmail's own settings rather than drawn as a row whose
// sentence would be a lie about what it catches.
//
// **One filter can be several rows.** Gmail lets a filter add any number of
// labels, so "from foo → Receipts *and* Work" is one filter and two of the rows
// this screen is organised by. `readFilter` fans those out, which is also why a
// row's `id` is not Gmail's filter id — see the Rule typedef.
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
 * @property {string} id the row's own key, `<filterId>#<destination>` — *not*
 *   what a delete is addressed to. One filter can send mail to several folders
 *   and each is a row, so the filter id alone would not tell two of them apart.
 * @property {string} filterId Gmail's filter id — what a delete is addressed to
 * @property {'mailboy' | 'existing'} origin which section of the tab it belongs
 *   to: made here, or found on the account
 * @property {'sender' | 'domain' | 'subject'} kind
 * @property {string} match the address, the bare domain, or the subject. A
 *   domain is stored here *without* its `@` — `example.com`, not `@example.com`
 *   — so that a spec asking for one and a rule read back from Gmail compare
 *   equal in `sameRule`. `domainRule` puts the `@` on.
 * @property {string} destination the label id this row is about
 * @property {string[]} destinations every folder the parent filter files into.
 *   More than one means deleting this row takes the others with it — Gmail has
 *   no way to remove part of a filter.
 */

/**
 * Label ids that are not places mail can sit, so not destinations a "move to"
 * rule can be about.
 *
 * The same call *Folders, not labels* makes: `UNREAD`, `STARRED` and `IMPORTANT`
 * are states a message carries while sitting somewhere else, and the five
 * `CATEGORY_*` rows are Gmail's to assign. `INBOX` is excluded because adding it
 * is not a move — mail arrives there. `SPAM` and `TRASH` are kept: both are
 * folders MailBoy shows, and Gmail's own "Delete it" action is `TRASH`.
 */
const NOT_A_FOLDER = new Set(['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'CHAT']);

const isFolder = (id) =>
  typeof id === 'string' && id !== '' && !id.startsWith('CATEGORY_') && !NOT_A_FOLDER.has(id);

/**
 * Which of a filter's criteria fields actually narrow what it catches.
 *
 * A row reads "All mails from foo@bar.com", and that sentence is only true if
 * the sender is the *whole* of what the filter matches on. A filter carrying
 * `from` and `hasTheWord` as well would be drawn as something wider than it is,
 * which is worse than not drawing it — so this is what the strictness in
 * `readFilter` is checked against rather than a bare `criteria.from` test.
 *
 * `size` and `hasAttachment` are compared against their unset values rather than
 * merely being present: Gmail returns `size: 0` and `sizeComparison:
 * 'unspecified'` on filters that say nothing about size.
 */
function matchers(criteria) {
  const narrowing = [];
  for (const key of ['from', 'to', 'subject', 'query', 'negatedQuery', 'hasAttachment', 'excludeChats', 'size']) {
    const value = criteria[key];
    if (value !== undefined && value !== null && value !== '' && value !== false && value !== 0) {
      narrowing.push(key);
    }
  }
  return narrowing;
}

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
 * The filter body for "everything from anyone at this domain".
 *
 * `@example.com` in `criteria.from`, which is how Gmail's own From box is
 * written for a domain and what its `from:` operator matches a domain with. The
 * leading `@` is what makes it a domain rather than a sender: without it Gmail
 * would also match a display name or an address merely containing the string.
 *
 * A strictly wider `senderRule` and nothing else — same action, same mark, same
 * everything. That is why ticking the domain box in a dialog makes the sender
 * box redundant rather than making it mean something different.
 */
export function domainRule(domain, labelId) {
  return { criteria: { from: `@${domainOf(domain)}`, negatedQuery: MARK }, action: actionFor(labelId) };
}

/**
 * The domain half of an address, lowercased. Handed a bare domain it returns it
 * unchanged, so it is safe to run over either.
 */
export const domainOf = (address) => String(address).split('@').pop().trim().toLowerCase();

/**
 * A `criteria.from` read as a domain, or null where it names a sender.
 *
 * Two forms count. `@example.com` is what `domainRule` writes. `*@example.com`
 * is the other thing people type into Gmail's own From box, and it means the
 * same thing there — **Gmail has no wildcards**; it tokenises on punctuation, so
 * the `*` is dropped rather than honoured. Reading both keeps a filter somebody
 * wrote by hand from rendering as *All mails from `*@example.com`*, an address
 * that has apparently lost its front half.
 *
 * MailBoy writes the bare form deliberately. The starred one cannot match
 * anything the bare one does not, and it implies a wildcard facility that does
 * not exist — which is an invitation to write `invoice*@example.com` next and
 * get a filter that quietly matches nothing like what was meant.
 *
 * Which is also why anything with a real local part is a sender, star or no
 * star: `invoice*@example.com` is somebody expecting a prefix match Gmail does
 * not do, and guessing at what they meant is not this function's job.
 */
function domainIn(from) {
  const found = /^\s*\*?@(.+)$/.exec(String(from));
  return found ? found[1].trim().toLowerCase() : null;
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
 * Read one raw filter as the rows it stands for — none, if it is not something
 * the Rules tab can state in one sentence.
 *
 * Deliberately strict about shape, and strict in the same way for both origins.
 * A filter carrying the mark but no destination cannot be drawn on a screen
 * organised by destination, and guessing at what it was meant to do would be
 * worse than leaving it to Gmail's own settings; an unmarked filter that matches
 * on more than a sender or a subject would be drawn as something wider than it
 * is, which is the same fault from the other side.
 *
 * The mark decides only *which section* a filter lands in — see `MARK`. Nothing
 * else about the reading differs, so a rule made here and the identical one made
 * in Gmail render as the same row.
 *
 * @returns {Rule[]} one per folder the filter files into
 */
export function readFilter(filter) {
  const criteria = filter?.criteria;
  if (!criteria) return [];

  const ours = criteria.negatedQuery === MARK;
  // The mark is bookkeeping rather than a condition anybody wrote, so it does
  // not count against the "sender or subject and nothing else" test.
  const narrowing = matchers(criteria).filter((key) => !(ours && key === 'negatedQuery'));
  if (narrowing.length !== 1) {
    if (ours) console.warn('[MailBoy] a marked filter matches on more than one thing', filter.id);
    return [];
  }

  const [on] = narrowing;
  if (on !== 'from' && on !== 'subject') {
    if (ours) console.warn('[MailBoy] a marked filter matches on neither sender nor subject', filter.id);
    return [];
  }

  const destinations = (filter.action?.addLabelIds ?? []).filter(isFolder);
  if (!destinations.length) {
    if (ours) console.warn('[MailBoy] a marked filter has no destination; leaving it alone', filter.id);
    return [];
  }

  const domain = on === 'from' ? domainIn(criteria.from) : null;

  const shared = {
    filterId: filter.id,
    origin: ours ? 'mailboy' : 'existing',
    kind: on === 'subject' ? 'subject' : domain ? 'domain' : 'sender',
    match: on === 'subject' ? unquote(criteria.subject) : (domain ?? criteria.from),
    destinations,
  };

  return destinations.map((destination) => ({
    ...shared,
    id: `${filter.id}#${destination}`,
    destination,
  }));
}

/**
 * Every rule the Rules tab can draw — MailBoy's and the account's own — and how
 * many filters the account holds in total.
 *
 * One quota unit for all of it — `filters.list` does not paginate. The total is
 * the account's, not ours: the 1,000-filter ceiling is shared with every filter
 * the user ever made in Gmail itself, so it is the only number worth checking a
 * bulk create against. It also counts filters no row here stands for, which is
 * right — they take up the same allowance.
 *
 * @returns {Promise<{rules: Rule[], filters: number}>}
 */
export async function listRules() {
  const filters = await listFilters();
  const rules = filters.flatMap(readFilter);
  trace('rules', 'read every filter on the account', {
    filters: filters.length,
    ours: rules.filter((rule) => rule.origin === 'mailboy').length,
    existing: rules.filter((rule) => rule.origin === 'existing').length,
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
 * @param {{kind: 'sender' | 'domain' | 'subject', match: string, destination: string}[]} specs
 * @returns {Promise<{created: Rule[], failed: {match: string, message: string}[]}>}
 */
export async function createRules(specs) {
  const created = [];
  const failed = [];

  for (const spec of specs) {
    const body =
      spec.kind === 'sender'
        ? senderRule(spec.match, spec.destination)
        : spec.kind === 'domain'
          ? domainRule(spec.match, spec.destination)
          : subjectRule(spec.match, spec.destination);

    try {
      const filter = await createFilter(body);
      created.push({
        ...spec,
        id: `${filter.id}#${spec.destination}`,
        filterId: filter.id,
        origin: 'mailboy',
        destinations: [spec.destination],
      });
    } catch (err) {
      console.error('[MailBoy] could not create a rule for', spec.match, err);
      failed.push({ match: spec.match, message: err?.message ?? '' });
    }
  }

  trace('rules', 'created', { asked: specs.length, made: created.length, units: specs.length * 5 });
  return { created, failed };
}

/**
 * Remove filters, one call each.
 *
 * These are **filter ids, not row ids** — `Rule.filterId`, deduplicated by the
 * caller. A filter filing into two folders is two rows here and one filter to
 * Gmail, and there is no way to remove half of it.
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
