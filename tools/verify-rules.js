// Does Gmail accept several senders in one filter?
//
// Everything in `src/rules.js` now rests on one unverified claim: that
// `criteria.from` may hold an OR expression, that Gmail stores it in that field
// rather than rewriting it into `query`, and that a bare `@domain` inside the
// expression still matches a domain. If any of that is false, consolidation is
// not merely suboptimal — the Rules tab goes blank for MailBoy's own filters,
// because `matchers` disqualifies a filter that narrows on `query`.
//
// This cannot be checked from a repository. It needs a real account, a real
// token and a real `filters.create`, so it is a thing you run rather than a
// test that runs itself.
//
// ── Running it ───────────────────────────────────────────────────
//
// Open the side panel, open DevTools on it (right-click → Inspect), and:
//
//     const { verifyRules } = await import('/tools/verify-rules.js');
//     await verifyRules();
//
// It prints a table and returns the report. Add `{ probe: true }` to also
// measure how long a `from` Gmail will actually accept — that one creates and
// deletes about a dozen filters, so it is opt-in.
//
// ── Why it is safe to run on a real account ──────────────────────
//
// Every address it matches on is at `.invalid`, a TLD reserved by RFC 2606 that
// can never resolve — so no mail can ever come from one and the filters it makes
// are inert whatever happens to them. They are deleted in a `finally`, and the
// report says how many were left behind if a delete failed.
//
// It only ever deletes filters it created in this run, by id. Nothing it does
// touches a filter that was already on the account.
//
// **Not part of the extension.** Nothing imports it, and it should be left out
// of the published package along with `TRACE`.

import { createFilter, deleteFilter, listFilters } from '../src/gmail.js';
import { MARK, readFilter } from '../src/rules.js';

/** Reserved by RFC 2606: no mail can ever arrive from one of these. */
const SENDER = 'mailboy-verify@probe.invalid';
const DOMAIN = 'probe-domain.invalid';

/**
 * Where the probe filters file mail.
 *
 * Trash, because it is the one destination guaranteed to exist on every account
 * — a user label id would have to be found first, and a wrong one fails the
 * create for a reason that has nothing to do with what is being tested. It also
 * settles a second open question for free: whether `filters.create` accepts a
 * bare `addLabelIds: ['TRASH']`, which is what every Block rule is.
 */
const DESTINATION = 'TRASH';

const check = (name, pass, detail) => ({ name, pass, detail });

/**
 * Create one filter and hand back both what Gmail returned and what a later
 * `filters.list` says about it.
 *
 * The second read is the whole point: `filters.create` echoes a resource that
 * may not be what was stored, and the question here is what survives a
 * round trip.
 */
async function roundTrip(criteria, made) {
  const filter = await createFilter({ criteria, action: { addLabelIds: [DESTINATION] } });
  made.push(filter.id);
  const all = await listFilters();
  return { created: filter, stored: all.find((one) => one.id === filter.id) ?? null };
}

/**
 * The longest `from` Gmail will take, to the nearest step.
 *
 * `MAX_FROM_CHARS` in `src/rules.js` is a guess deliberately set well under
 * whatever this finds — Google documents no limit, so the constant is chosen to
 * be safe rather than measured. This is how you find out what it is actually
 * being safe against.
 *
 * Doubling until a refusal, then bisecting: about a dozen creates rather than
 * the hundreds a linear walk would cost.
 */
async function probeCeiling(made) {
  const address = (n) => `probe-${String(n).padStart(6, '0')}@probe.invalid`;
  const accepts = async (count) => {
    const from = Array.from({ length: count }, (_, n) => address(n)).join(' OR ');
    try {
      const { stored } = await roundTrip({ from, negatedQuery: MARK }, made);
      // Accepted is not enough: a filter Gmail truncates or moves into `query`
      // is worse than one it refuses, because nothing would notice.
      return stored?.criteria?.from === from;
    } catch {
      return false;
    }
  };

  let good = 0;
  let bad = 0;
  for (let count = 8; count <= 4096; count *= 2) {
    if (await accepts(count)) good = count;
    else {
      bad = count;
      break;
    }
  }
  if (!bad) return { addresses: good, chars: null, bounded: false };

  while (bad - good > Math.max(4, good / 16)) {
    const middle = Math.floor((good + bad) / 2);
    if (await accepts(middle)) good = middle;
    else bad = middle;
  }

  return {
    addresses: good,
    chars: Array.from({ length: good }, (_, n) => address(n)).join(' OR ').length,
    bounded: true,
  };
}

/**
 * @param {{probe?: boolean}} options
 * @returns {Promise<{ok: boolean, checks: object[], ceiling: object | null, stranded: string[]}>}
 */
export async function verifyRules({ probe = false } = {}) {
  const made = [];
  const checks = [];
  let ceiling = null;

  try {
    // ── 1. Does an OR expression survive a round trip in `from`? ──
    const from = `${SENDER} OR @${DOMAIN}`;
    const { stored } = await roundTrip({ from, negatedQuery: MARK }, made);

    checks.push(check('filter was stored and read back', Boolean(stored), stored?.id ?? 'not in filters.list'));
    if (!stored) return finish(checks, ceiling, made);

    const criteria = stored.criteria ?? {};

    checks.push(
      check(
        'criteria.from holds the OR expression verbatim',
        criteria.from === from,
        `sent ${JSON.stringify(from)}, stored ${JSON.stringify(criteria.from ?? null)}`
      )
    );

    // The failure that would empty the Rules tab rather than merely look odd:
    // `matchers` disqualifies any filter narrowing on `query`.
    checks.push(
      check(
        'Gmail did not rewrite it into criteria.query',
        !criteria.query,
        criteria.query ? `query = ${JSON.stringify(criteria.query)}` : 'query is unset'
      )
    );

    // Folded in from next step 10: the mark is what sorts the Rules tab into its
    // two sections, and it fails silently if Gmail normalises it away.
    checks.push(
      check(
        'the mark survived (criteria.negatedQuery)',
        criteria.negatedQuery === MARK,
        JSON.stringify(criteria.negatedQuery ?? null)
      )
    );

    // Also free: a bare addLabelIds: ['TRASH'] is what every Block rule is.
    checks.push(
      check(
        'addLabelIds: ["TRASH"] was accepted',
        (stored.action?.addLabelIds ?? []).includes('TRASH'),
        JSON.stringify(stored.action ?? null)
      )
    );

    // ── 2. Does MailBoy's own reader make the right rows of it? ──
    const rows = readFilter(stored);
    const sender = rows.find((row) => row.kind === 'sender');
    const domain = rows.find((row) => row.kind === 'domain');

    checks.push(check('readFilter fans it out into two rows', rows.length === 2, `${rows.length} rows`));
    checks.push(
      check('the address reads as a sender', sender?.match === SENDER, sender?.match ?? 'no sender row')
    );
    checks.push(
      check('the @domain reads as a domain', domain?.match === DOMAIN, domain?.match ?? 'no domain row')
    );
    checks.push(
      check(
        'both rows are marked as MailBoy’s',
        rows.length > 0 && rows.every((row) => row.origin === 'mailboy'),
        rows.map((row) => row.origin).join(', ') || 'no rows'
      )
    );

    // ── 3. How long a `from` will it take? ──
    if (probe) ceiling = await probeCeiling(made);
  } catch (err) {
    checks.push(check('no request was refused', false, `${err?.status ?? ''} ${err?.message ?? err}`.trim()));
  }

  return finish(checks, ceiling, made);
}

/** Take back everything this run created, then report. */
async function finish(checks, ceiling, made) {
  const stranded = [];
  for (const id of made) {
    try {
      await deleteFilter(id);
    } catch (err) {
      // A 404 is the filter being gone, which is what was wanted.
      if (err?.status !== 404) stranded.push(id);
    }
  }

  if (stranded.length) {
    checks.push(
      check(
        'every probe filter was cleaned up',
        false,
        `${stranded.length} left behind — delete by hand in Gmail settings: ${stranded.join(', ')}`
      )
    );
  }

  const ok = checks.every((one) => one.pass);
  console.table(checks.map(({ name, pass, detail }) => ({ check: name, pass: pass ? 'yes' : 'NO', detail })));
  if (ceiling) {
    console.log(
      ceiling.bounded
        ? `[verify] Gmail took ${ceiling.addresses} addresses (${ceiling.chars} chars) in one criteria.from.`
        : `[verify] Gmail took every length tried (up to ${ceiling.addresses} addresses); no ceiling found.`
    );
  }
  console.log(ok ? '[verify] consolidation is safe on this account.' : '[verify] something above is NOT safe — see the table.');

  return { ok, checks, ceiling, stranded };
}
