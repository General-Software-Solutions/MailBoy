import { AuthError, getToken, invalidateToken } from './auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const PAGE_SIZE = 500;

/**
 * A runaway guard, not a product limit: half a million messages under a single
 * label means something has gone wrong upstream.
 */
const MAX_PAGES = 1000;

/**
 * Gmail meters by quota unit rather than request count, and the two calls that
 * matter are priced very differently: messages.list costs 5 units for 500 ids,
 * messages.get costs 5 units for one message. Enumeration is effectively free;
 * reading messages is not.
 *
 * The ceiling is 250 units per second per user, so sizes top out near 50
 * messages a second however they are batched. Pacing just under the ceiling
 * beats provoking 429s and backing off from them.
 */
const UNIT_COST = { cheap: 1, list: 5, get: 5 };
const UNITS_PER_SECOND = 220;

/** A request Gmail answered and refused, carrying enough to describe why. */
export class GmailError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.reason = reason;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `fields=` mask can select nothing at all: an empty label asked for
 * `nextPageToken,messages/id` comes back 200 with a zero-byte body, and
 * `Response.json()` rejects that outright. It stands for the empty object, so
 * read it as one — a label with no mail is ordinary, not a failure.
 */
async function readJson(res) {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ── Quota pacing ─────────────────────────────────────────────────

/** End of the last reserved slice of the per-second budget. */
let nextSlot = 0;

/**
 * Hold the caller until its share of the quota budget comes free. Callers
 * reserve in order, so concurrent batches queue rather than collide.
 */
async function reserve(units) {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + (units / UNITS_PER_SECOND) * 1000;
  if (start > now) await sleep(start - now);
}

// ── Requests ─────────────────────────────────────────────────────

function call(path, params = {}, units = UNIT_COST.cheap) {
  return request(BASE + path, params, { units });
}

async function request(endpoint, params = {}, { units = UNIT_COST.cheap, attempt = 0 } = {}) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  await reserve(units);

  const token = await getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.ok) return readJson(res);

  // A token Google no longer honours: drop it and renew silently, once.
  if (res.status === 401 && attempt === 0) {
    await invalidateToken();
    return request(endpoint, params, { units, attempt: attempt + 1 });
  }

  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const reason =
      body?.error?.errors?.[0]?.reason ??
      body?.error?.details?.find((detail) => detail.reason)?.reason ??
      '';
    const message = body?.error?.message || `Gmail denied the request (${res.status}).`;

    // The UI only ever shows a summary, so keep the real reason reachable.
    console.error('[MailBoy] request rejected', endpoint, res.status, reason, message);

    // 403 is overloaded: rate limiting is retryable, the rest are not.
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
      return backoffRetry(endpoint, params, { units, attempt });
    }

    // Only a token problem is worth sending the user back to sign in. A
    // disabled API or a project misconfiguration returns 403 too, and telling
    // someone to reconnect for those loops forever.
    const tokenProblem =
      res.status === 401 ||
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';

    throw tokenProblem
      ? new AuthError(message)
      : new GmailError(message, { status: res.status, reason });
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    return backoffRetry(endpoint, params, { units, attempt });
  }

  const body = await res.json().catch(() => ({}));
  throw new GmailError(body?.error?.message || `Gmail request failed (${res.status}).`, {
    status: res.status,
    reason: body?.error?.errors?.[0]?.reason,
  });
}

async function backoffRetry(endpoint, params, { units, attempt }) {
  if (attempt >= 4) throw new Error('Gmail is rate limiting these requests.');
  const delay = 2 ** attempt * 400 + Math.random() * 300;
  await sleep(delay);
  return request(endpoint, params, { units, attempt: attempt + 1 });
}

// ── Identity ─────────────────────────────────────────────────────

/**
 * OpenID userinfo: avatar and signed-in address. Deliberately independent of
 * the Gmail API, and it never throws — the panel stays usable with a fallback
 * glyph and a blank address.
 *
 * @returns {Promise<{email?: string, picture?: string, name?: string} | null>}
 */
export async function getUserInfo() {
  try {
    return await request(USERINFO);
  } catch (err) {
    console.warn('[MailBoy] userinfo unavailable:', err);
    return null;
  }
}

// ── Labels and membership ────────────────────────────────────────

/** Names and IDs only — labels.list does not include message counts. */
export async function listLabels() {
  const { labels = [] } = await call('/labels');
  return labels;
}

/**
 * Google's own precomputed `messagesTotal` for one label. One quota unit, and
 * by far the fastest real number available — enumeration reaches the same
 * figure, but only after paging through the label.
 */
export function getLabel(id) {
  return call(`/labels/${encodeURIComponent(id)}`);
}

/**
 * Every message id carrying `labelId`, optionally narrowed by a search `query`.
 *
 * There is no page cap here on purpose. Enumeration is the cheap half of the
 * API — 5 quota units buys 500 ids — so counts stay exact however large the
 * label grows, and every number the panel shows is a real count of ids rather
 * than `resultSizeEstimate`, which is only an estimate.
 *
 * Filtering by label ID and leaving the query to the negations avoids escaping
 * label names with spaces and slashes.
 *
 * @returns {Promise<string[]>}
 */
export async function listMessageIds(labelId, query) {
  const ids = [];
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await call(
      '/messages',
      {
        labelIds: labelId,
        q: query,
        maxResults: PAGE_SIZE,
        fields: 'nextPageToken,messages/id',
        // messages.list hides spam and trash by default, even when those are
        // exactly the labels being asked about.
        includeSpamTrash: labelId === 'SPAM' || labelId === 'TRASH' ? 'true' : undefined,
        pageToken,
      },
      UNIT_COST.list
    );

    for (const message of data.messages ?? []) ids.push(message.id);

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return ids;
}

// ── Message sizes ────────────────────────────────────────────────

/** Gmail's own ceiling on sub-requests in one batch. */
const BATCH_SIZE = 100;

/** Enough in flight to hide latency; the quota pacer sets the real rate. */
const BATCH_CONCURRENCY = 3;

const MAX_ATTEMPTS = 4;

/**
 * `sizeEstimate` for each id, as a Map of id → bytes.
 *
 * This is the expensive thing MailBoy asks Gmail for, and there is no cheaper
 * route: size exists only per message, and labels.get does not carry it.
 * `format=minimal` keeps each response to a few dozen bytes — no headers, no
 * body, no attachment data — but the quota cost is 5 units either way, so the
 * caller is expected to ask only for ids it has not already cached.
 *
 * `onBatch(found)` fires with each batch's results as they land, so a long
 * first run can report progress instead of going quiet.
 */
export async function fetchSizes(ids, onBatch) {
  const sizes = new Map();
  let pending = [...ids];

  for (let attempt = 0; pending.length && attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt) await sleep(2 ** attempt * 500 + Math.random() * 400);

    const chunks = [];
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      chunks.push(pending.slice(i, i + BATCH_SIZE));
    }

    const retry = [];
    let cursor = 0;

    await Promise.all(
      Array.from({ length: Math.min(BATCH_CONCURRENCY, chunks.length) }, async () => {
        while (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          const found = await runBatch(chunk, retry);
          for (const [id, bytes] of found) sizes.set(id, bytes);
          if (found.size) onBatch?.(found);
        }
      })
    );

    pending = retry;
  }

  return sizes;
}

/**
 * One multipart batch request. Ids it could not resolve are pushed onto
 * `retry` rather than thrown, so one dead message cannot fail the whole pass.
 *
 * @returns {Promise<Map<string, number>>}
 */
async function runBatch(ids, retry) {
  const boundary = `mailboy_${crypto.randomUUID()}`;

  const body =
    ids
      .map(
        (id, index) =>
          `--${boundary}\r\n` +
          'Content-Type: application/http\r\n' +
          `Content-ID: <m${index}>\r\n\r\n` +
          `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}` +
          '?format=minimal&fields=sizeEstimate&prettyPrint=false\r\n\r\n'
      )
      .join('') + `--${boundary}--\r\n`;

  await reserve(ids.length * UNIT_COST.get);

  const token = await getToken();
  const res = await fetch(BATCH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });

  if (res.status === 401) {
    await invalidateToken();
    retry.push(...ids);
    return new Map();
  }

  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      retry.push(...ids);
      return new Map();
    }
    const detail = await res.json().catch(() => ({}));
    const reason = detail?.error?.errors?.[0]?.reason ?? '';
    const message = detail?.error?.message || `Gmail refused the batch (${res.status}).`;
    console.error('[MailBoy] batch rejected', res.status, reason, message);
    throw new GmailError(message, { status: res.status, reason });
  }

  return parseBatch(await res.text(), res.headers.get('Content-Type'), ids, retry);
}

/**
 * Batch replies are multipart/mixed, each part wrapping a complete HTTP
 * response with its own status. Sub-requests fail individually — a message
 * deleted between listing and reading 404s while its neighbours succeed — so
 * status is read per part, never per response.
 */
function parseBatch(text, contentType, ids, retry) {
  const found = new Map();

  const declared = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  if (!declared) {
    retry.push(...ids);
    return found;
  }

  const parts = text.split(`--${declared[1] ?? declared[2]}`);
  const answered = new Set();
  let position = -1;

  for (const part of parts) {
    const status = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(part);
    if (!status) continue; // the preamble and the closing delimiter

    position++;

    // Google echoes back the Content-ID we sent, prefixed. Order is not
    // promised, so trust the echo and fall back to position only without one.
    const echo = /^Content-ID:\s*<response-m(\d+)>/im.exec(part);
    const id = ids[echo ? Number(echo[1]) : position];
    if (id === undefined) continue;
    answered.add(id);

    const code = Number(status[1]);
    if (code === 429 || code >= 500) {
      retry.push(id);
      continue;
    }
    // 404 means the message is gone. Nothing to weigh, and asking again will
    // not bring it back.
    if (code !== 200) continue;

    // part = outer headers, blank line, inner status + headers, blank line, body.
    const [, , ...rest] = part.split(/\r?\n\r?\n/);
    const body = rest.join('\n\n').trim();
    // Same empty-mask case as readJson: no size to report, and asking again
    // would only produce the same nothing.
    if (!body) continue;

    try {
      const bytes = JSON.parse(body)?.sizeEstimate;
      if (Number.isFinite(bytes)) found.set(id, bytes);
    } catch {
      retry.push(id);
    }
  }

  for (const id of ids) if (!answered.has(id)) retry.push(id);

  return found;
}

export { AuthError };
