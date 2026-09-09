// Rules: standing instructions about mail that has not arrived yet.
//
// A rule is one sentence — everything from one sender, one *domain*, or with one
// subject goes to one folder. All of them are the same shape underneath: match,
// add the destination, take away INBOX.
//
// **A rule is not a filter, and since 2026-09-05 it usually is not even one
// filter's worth.** Gmail allows an account 1,000 filters in total, shared with
// everything the user ever made in Gmail itself, and a filter per sender spends
// that allowance at the worst possible rate: one folder somebody files forty
// senders into used to be forty filters. `criteria.from` takes an OR expression,
// so those forty are now one filter reading `a@x.com OR b@y.com OR …`, and the
// forty rows the Rules tab draws are read back out of it.
//
// ── What can and cannot share a filter ───────────────────────────
//
// **Criteria fields are ANDed with each other; only within one field is there an
// OR.** So senders and domains consolidate together — both are `criteria.from` —
// and a subject cannot join them, because `{from, subject}` means "from A *and*
// about B", which is a different rule entirely.
//
// Subjects are deliberately left one-per-filter even among themselves. Gmail
// builds its query out of these fields and a `subject` of `"a" OR "b"` risks
// parsing as `subject:"a"` OR the free-text term `b` — which would quietly widen
// the rule to match "b" anywhere in the message, including the body. A rule that
// catches more than its own sentence says is the one failure this module exists
// to avoid, and subject rules are rare enough that nothing is lost by it.
//
// ── Editing means replacing ──────────────────────────────────────
//
// **Gmail cannot update a filter.** There is no patch method, so adding a sender
// to a folder's filter and removing one from it are the same operation: build
// the replacement, create it, delete the original. `saveRules` and `removeRules`
// are the two entry points, and both **create before they delete** — the overlap
// is two filters carrying the same instruction, which is harmless because adding
// a label twice is a no-op, where the other order would leave a window with no
// filter at all and mail arriving into it.
//
// That ordering is also what makes a failure safe: nothing is ever removed until
// what replaces it exists.
//
// **`saveRules` consolidates the whole destination, not just the addition.** So
// the first rule added to a folder that already has forty single-sender filters
// collapses all forty into one. That costs forty deletes once, and is the only
// migration the change needs.
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
// **They are never rewritten.** `readFilter` models `addLabelIds` and nothing
// else, so recreating somebody's own filter would silently drop a `forward`, a
// `markAsRead`, a `neverSpam` — fields this module does not carry. Consolidation
// is therefore for MailBoy's own filters only, and deleting a row of somebody
// else's still takes the whole filter, exactly as it always did.
// `partiallyEditable` is the one place that line is drawn.
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
// ── What this deliberately does not do ───────────────────────────
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
 * What separates one match from the next inside `criteria.from`.
 *
 * Uppercase `OR` is what Gmail's own search syntax takes and what its settings
 * screen shows back. Reading is more lenient than writing — see `matchesIn`.
 */
const FROM_JOIN = ' OR ';

/**
 * How long a `criteria.from` MailBoy is willing to build.
 *
 * **Chosen, not measured.** Google documents no limit on this field, so the only
 * honest position is to stay well under wherever it is: at roughly 30 characters
 * an address this holds about 35 senders per filter, which is already a 35-fold
 * saving against the allowance and leaves a great deal of room underneath a
 * search-query ceiling that is usually quoted in the low thousands.
 *
 * `tools/verify-rules.js` with `{ probe: true }` measures the real figure on a
 * real account. Raise this only against what that reports, and leave a margin:
 * a filter Gmail *truncates* rather than refuses would silently stop catching
 * the senders that fell off the end.
 */
const MAX_FROM_CHARS = 1000;

/**
 * @typedef {object} Part one thing a filter matches on
 * @property {'sender' | 'domain' | 'subject'} kind
 * @property {string} match the address, the bare domain (no `@`), or the subject
 */

/**
 * @typedef {object} Rule
 * @property {string} id the row's own key — *not* what a delete is addressed to.
 *   One filter can carry several matches and file into several folders, and each
 *   crossing of the two is a row, so the filter id alone would not tell two of
 *   them apart.
 * @property {string} filterId Gmail's filter id — what a delete is addressed to
 * @property {'mailboy' | 'existing'} origin which section of the tab it belongs
 *   to: made here, or found on the account
 * @property {'from' | 'subject'} field which criteria field the parent filter
 *   narrows on. What can be consolidated with what, in one word.
 * @property {'sender' | 'domain' | 'subject'} kind
 * @property {string} match the address, the bare domain, or the subject. A
 *   domain is stored here *without* its `@` — `example.com`, not `@example.com`
 *   — so that a spec asking for one and a rule read back from Gmail compare
 *   equal in `sameRule`. `fromText` puts the `@` back on.
 * @property {string} destination the label id this row is about
 * @property {string[]} destinations every folder the parent filter files into.
 *   More than one means it cannot be edited in part — see `partiallyEditable`.
 * @property {Part[]} matches every match the parent filter carries. This is what
 *   a rewrite is built from, which is why it rides on every row.
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
 * This module used to carry a note here saying `batchModify` refuses TRASH and
 * that a filter is the exception. **Both halves were wrong**: `batchModify` takes
 * the label like any other, and `trashMessages` has used it since 2026-09-09.
 * The asymmetry that remains is only in *when* the work happens — a filter acts
 * on mail as it arrives, for one 5-unit create and nothing after.
 */
const actionFor = (labelId) =>
  labelId === 'TRASH'
    ? { addLabelIds: ['TRASH'] }
    : { addLabelIds: [labelId], removeLabelIds: ['INBOX'] };

/**
 * The domain half of an address, lowercased. Handed a bare domain it returns it
 * unchanged, so it is safe to run over either.
 */
export const domainOf = (address) => String(address).split('@').pop().trim().toLowerCase();

/**
 * A `criteria.from` term read as a domain, or null where it names a sender.
 *
 * Two forms count. `@example.com` is what this module writes. `*@example.com` is
 * the other thing people type into Gmail's own From box, and it means the same
 * thing there — **Gmail has no wildcards**; it tokenises on punctuation, so the
 * `*` is dropped rather than honoured. Reading both keeps a filter somebody
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
 * One `criteria.from` read as the list of things it matches on.
 *
 * **Reading is deliberately more lenient than writing.** MailBoy writes ` OR `
 * and nothing else, but the *Existing filters* section meets whatever the
 * account's own filters were written with, and Gmail's settings screen has shown
 * several forms over the years: a braced group `{a b}`, a pipe, and the plain
 * `OR` this writes.
 *
 * **Uppercase `OR` only.** Gmail's syntax requires it, and matching a lowercase
 * "or" would split the display name "Bob or Alice" into two rows that stand for
 * nothing. Commas are left alone for the same reason and a stronger one: "Doe,
 * John" is an ordinary display name, and reading it as two senders would draw
 * two rows that quietly claim to catch mail nobody wrote.
 *
 * Whitespace splitting is safe *only* inside braces, which is what makes the
 * braced case a separate branch rather than one more separator in the pattern.
 *
 * @returns {Part[]}
 */
function matchesIn(from) {
  let text = String(from ?? '').trim();

  const braced = /^[({]([\s\S]*)[)}]$/.exec(text);
  if (braced) text = braced[1].trim();

  const terms = braced ? text.split(/\s+/) : text.split(/\s+OR\s+|\s*\|\s*/);

  const parts = [];
  const seen = new Set();
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;

    const domain = domainIn(term);
    const part = domain ? { kind: 'domain', match: domain } : { kind: 'sender', match: term };
    // A filter listing the same sender twice is one row, not two: the second
    // would be a row nobody could tell from the first, and ticking either has to
    // mean the same thing.
    const key = partKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  return parts;
}

/** How two matches are compared: by what they catch, which is case-blind. */
const partKey = (part) => `${part.kind}:${String(part.match).toLowerCase()}`;

/** One match as it is written into `criteria.from`. The `@` goes back on here. */
const partText = (part) => (part.kind === 'domain' ? `@${part.match}` : part.match);

/** Several, as one field. */
const fromText = (parts) => parts.map(partText).join(FROM_JOIN);

/**
 * A subject, quoted so Gmail matches the line as a phrase rather than as a bag
 * of words — unquoted, a subject of "Your receipt" would also catch "Receipt for
 * your order". Any quotes already in it are dropped rather than escaped: Gmail's
 * query syntax has no escape for them, and a stray one would break the phrase
 * open and silently widen the rule.
 */
const quoted = (subject) => `"${String(subject).replace(/"/g, '').trim()}"`;

/** The subject as the user typed it, back out of the quoted form above. */
const unquote = (value) => value.replace(/^"|"$/g, '');

/**
 * The filter body for a set of matches into one folder.
 *
 * One destination, always. MailBoy has never made a filter that files into two
 * places, and now that a filter is rewritten rather than replaced it matters
 * more than it did: a single destination is what makes `partiallyEditable` true,
 * and therefore what lets one sender be dropped without disturbing anything
 * else the filter does.
 */
function buildFilter({ field, parts, destination }) {
  const criteria =
    field === 'subject' ? { subject: quoted(parts[0].match) } : { from: fromText(parts) };
  criteria.negatedQuery = MARK;
  return { criteria, action: actionFor(destination) };
}

/**
 * Split matches into as few filters as will hold them.
 *
 * Only ever more than one where a single folder has collected more senders than
 * `MAX_FROM_CHARS` allows in one field. Overflowing into a second filter keeps
 * the saving — thirty-five to one rather than one to one — where refusing would
 * put a ceiling on how many senders a folder may have.
 *
 * @returns {Part[][]} never empty for a non-empty input
 */
function chunk(parts) {
  const chunks = [];
  let current = [];

  for (const part of parts) {
    // A single match longer than the cap still gets its own filter: refusing it
    // would lose the rule, and Gmail is the one entitled to say no to it.
    if (current.length && fromText([...current, part]).length > MAX_FROM_CHARS) {
      chunks.push(current);
      current = [part];
    } else {
      current.push(part);
    }
  }
  if (current.length) chunks.push(current);

  return chunks;
}

/** The rows one filter stands for. Shared by `readFilter` and by a fresh create. */
function rowsOf({ filterId, origin, field, parts, destinations }) {
  return destinations.flatMap((destination) =>
    parts.map((part) => ({
      id: `${filterId}#${destination}#${partKey(part)}`,
      filterId,
      origin,
      field,
      kind: part.kind,
      match: part.match,
      destination,
      destinations,
      matches: parts,
    }))
  );
}

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
 * @returns {Rule[]} one per match per folder the filter files into
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

  const [field] = narrowing;
  if (field !== 'from' && field !== 'subject') {
    if (ours) console.warn('[MailBoy] a marked filter matches on neither sender nor subject', filter.id);
    return [];
  }

  const destinations = (filter.action?.addLabelIds ?? []).filter(isFolder);
  if (!destinations.length) {
    if (ours) console.warn('[MailBoy] a marked filter has no destination; leaving it alone', filter.id);
    return [];
  }

  const parts =
    field === 'subject'
      ? [{ kind: 'subject', match: unquote(criteria.subject) }]
      : matchesIn(criteria.from);
  if (!parts.length) {
    if (ours) console.warn('[MailBoy] a marked filter matches on nothing readable', filter.id);
    return [];
  }

  return rowsOf({
    filterId: filter.id,
    origin: ours ? 'mailboy' : 'existing',
    field,
    parts,
    destinations,
  });
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
    rows: rules.length,
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
 * Whether one row of this filter can be removed without disturbing the others.
 *
 * Three things have to hold, and each is a way it could go wrong:
 *
 * - **It has to be ours.** `readFilter` models `addLabelIds` and nothing else,
 *   so rebuilding somebody's own filter would drop whatever else it did —
 *   forwarding, marking read, never-spam. Deleting theirs whole is at least
 *   honest about what it costs, and the dialog says so.
 * - **It has to file into one folder.** Gmail cannot remove one destination from
 *   a filter, so a rewrite that kept the other folders would have to keep the
 *   match as well, and a rewrite that dropped the match would drop it for both.
 * - **It has to match on `from`.** A subject filter carries exactly one match,
 *   so there is never a part of it left to keep.
 */
export const partiallyEditable = (rule) =>
  Boolean(rule) && rule.origin === 'mailboy' && rule.field === 'from' && rule.destinations.length === 1;

/** MailBoy's own rewritable `from` filters for one destination, as parts per filter. */
function ownFilters(rules, destination) {
  const found = new Map();
  for (const rule of rules) {
    if (rule.destination !== destination || !partiallyEditable(rule)) continue;
    if (!found.has(rule.filterId)) found.set(rule.filterId, rule.matches);
  }
  return [...found.entries()].map(([filterId, parts]) => ({ filterId, parts }));
}

/**
 * Everything one call has to create and then delete, worked out before anything
 * is written.
 *
 * Separated from the writing so the caller can see how many filters the plan
 * needs before it starts spending them against the 1,000 ceiling — and so the
 * arithmetic can be reasoned about without a mailbox.
 *
 * `adding` is the part of `chunks` that somebody actually asked for, as opposed
 * to what is being carried across from the filters being replaced. Only that is
 * ever reported as having failed: a create that is refused while consolidating
 * forty existing senders has not lost forty rules — those are still on the
 * account, in the filters this plan did not get around to deleting.
 *
 * @returns {{field: string, destination: string, chunks: Part[][], adding: Part[], replacing: string[]}[]}
 */
export function planSave(specs, rules = []) {
  const plans = [];

  // One filter each, and never merged — see the header.
  for (const spec of specs) {
    if (spec.kind !== 'subject') continue;
    const part = { kind: 'subject', match: spec.match };
    plans.push({
      field: 'subject',
      destination: spec.destination,
      chunks: [[part]],
      adding: [part],
      replacing: [],
    });
  }

  const byDestination = new Map();
  for (const spec of specs) {
    if (spec.kind === 'subject') continue;
    const list = byDestination.get(spec.destination) ?? [];
    list.push({ kind: spec.kind, match: spec.match });
    byDestination.set(spec.destination, list);
  }

  for (const [destination, additions] of byDestination) {
    const family = ownFilters(rules, destination);
    const held = family.flatMap((one) => one.parts);
    const seen = new Set(held.map(partKey));

    const added = [];
    for (const part of additions) {
      if (seen.has(partKey(part))) continue;
      seen.add(partKey(part));
      added.push(part);
    }

    const chunks = chunk([...held, ...added]);

    // Nothing new, and the filters holding it are already as few as they can be.
    // The second half is what makes this self-migrating: a folder left with
    // forty single-sender filters by an older build is not "already consolidated"
    // even when the rule being added is one it has.
    if (!added.length && family.length === chunks.length) continue;

    plans.push({
      field: 'from',
      destination,
      chunks,
      adding: added,
      replacing: family.map((one) => one.filterId),
    });
  }

  return plans;
}

/** How many filters a plan needs to exist at once, which is what the ceiling meters. */
export const filtersNeeded = (plans) => plans.reduce((total, plan) => total + plan.chunks.length, 0);

/**
 * Write rules, consolidating each destination into as few filters as will hold
 * it.
 *
 * **Create, then delete.** The replacement is in place before the original goes,
 * so an interruption anywhere leaves two filters carrying the same instruction
 * rather than none carrying it. Adding a label twice is a no-op, so the overlap
 * costs nothing but a row in Gmail's settings until the next call tidies it.
 *
 * A failure is collected rather than thrown, and it stops that destination's
 * plan before any delete: ticking a box in the move dialog asks for two things —
 * move this mail, and file the next lot — and the move is the half that has
 * already happened by the time these run, so one refused filter must not read as
 * the whole action having failed.
 *
 * @param {{kind: 'sender' | 'domain' | 'subject', match: string, destination: string}[]} specs
 * @param {Rule[]} rules every rule on the account, as `listRules` last read them
 * @returns {Promise<{created: Rule[], failed: {match: string, message: string}[], replaced: number}>}
 */
export async function saveRules(specs, rules = []) {
  const plans = planSave(specs, rules);
  const created = [];
  const failed = [];
  let replaced = 0;

  for (const plan of plans) {
    const made = [];
    let complete = true;

    for (let index = 0; index < plan.chunks.length; index++) {
      const parts = plan.chunks[index];
      try {
        const filter = await createFilter(
          buildFilter({ field: plan.field, parts, destination: plan.destination })
        );
        made.push(
          ...rowsOf({
            filterId: filter.id,
            origin: 'mailboy',
            field: plan.field,
            parts,
            destinations: [plan.destination],
          })
        );
      } catch (err) {
        console.error('[MailBoy] could not create a rule for', plan.destination, err);
        // Only the rules somebody asked for, and only the ones in a chunk that
        // never got written. Everything carried across is still on the account,
        // in the originals this plan will now leave alone.
        const missing = new Set(plan.chunks.slice(index).flat().map(partKey));
        for (const part of plan.adding) {
          if (missing.has(partKey(part))) failed.push({ match: part.match, message: err?.message ?? '' });
        }
        complete = false;
        break;
      }
    }

    created.push(...made);

    // Only once every replacement is safely in place. A half-written plan leaves
    // the originals alone, which is the whole reason the order is this way round.
    if (complete && plan.replacing.length) {
      const { deleted } = await deleteRules(plan.replacing);
      replaced += deleted.length;
    }
  }

  trace('rules', 'saved', {
    asked: specs.length,
    filtersMade: created.length ? new Set(created.map((rule) => rule.filterId)).size : 0,
    filtersRemoved: replaced,
    units: (filtersNeeded(plans) + replaced) * 5,
  });
  return { created, failed, replaced };
}

/**
 * Take rules away, rewriting the filter that held them where that is possible
 * and deleting it outright where it is not.
 *
 * The two cases are `partiallyEditable`, and the caller has to know which is
 * which *before* it asks — deleting one row of somebody else's filter still
 * takes its siblings, and the confirmation names them. That is why this takes
 * the whole rule list alongside the doomed rows: the siblings are what a rewrite
 * is built from.
 *
 * Create-before-delete again, for the same reason as `saveRules`.
 *
 * @param {Rule[]} doomed the ticked rows
 * @param {Rule[]} rules every rule on the account
 * @returns {Promise<{removed: Rule[], failed: Rule[]}>} rows, not filters
 */
export async function removeRules(doomed, rules = []) {
  const byFilter = new Map();
  for (const rule of doomed) {
    const list = byFilter.get(rule.filterId) ?? [];
    list.push(rule);
    byFilter.set(rule.filterId, list);
  }

  const removed = [];
  const failed = [];

  for (const [filterId, ticked] of byFilter) {
    const family = rules.filter((rule) => rule.filterId === filterId);
    const base = family[0] ?? ticked[0];
    const tickedIds = new Set(ticked.map((rule) => rule.id));
    const surviving = family.filter((rule) => !tickedIds.has(rule.id));

    // Nothing of it is being kept, or nothing of it *can* be: the filter goes.
    if (!surviving.length || !partiallyEditable(base)) {
      try {
        await deleteFilter(filterId);
        removed.push(...(family.length ? family : ticked));
      } catch (err) {
        // A 404 counts as removed: the filter is gone, which is what was asked
        // for, and the likeliest way to see one is a rule deleted in Gmail's
        // settings since this screen was drawn.
        if (err?.status === 404) {
          removed.push(...(family.length ? family : ticked));
          continue;
        }
        console.error('[MailBoy] could not delete rule', filterId, err);
        failed.push(...ticked);
      }
      continue;
    }

    const gone = new Set(ticked.map(partKey));
    const kept = base.matches.filter((part) => !gone.has(partKey(part)));

    try {
      for (const parts of chunk(kept)) {
        await createFilter(buildFilter({ field: base.field, parts, destination: base.destination }));
      }
      await deleteFilter(filterId);
      removed.push(...ticked);
    } catch (err) {
      // The original is untouched unless its replacement exists, so the rules on
      // the account still say what the screen said before the press.
      console.error('[MailBoy] could not rewrite rule', filterId, err);
      failed.push(...ticked);
    }
  }

  trace('rules', 'removed', { asked: doomed.length, gone: removed.length, stuck: failed.length });
  return { removed, failed };
}

/**
 * Remove filters outright, one call each.
 *
 * These are **filter ids, not row ids** — `Rule.filterId`, deduplicated by the
 * caller. Used where the whole filter is genuinely going: a folder delete taking
 * its rules with it, and the originals a rewrite has just replaced.
 *
 * A 404 counts as removed, for the reason given in `removeRules`.
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
