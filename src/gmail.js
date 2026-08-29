import { AuthError, getToken, invalidateToken } from './auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/**
 * Messages carrying one of these are still "in the flow" rather than filed
 * away, so they are excluded from a user label's count.
 */
const UNFILED_QUERY = '-in:inbox -in:sent -in:trash -in:spam -is:draft -in:chats';

const PAGE_SIZE = 500;
const MAX_PAGES = 20; // 10,000 messages, then we report "10,000+".

/** A request Gmail answered and refused, carrying enough to describe why. */
export class GmailError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'GmailError';
    this.status = status;
    this.reason = reason;
  }
}

function call(path, params = {}) {
  return request(BASE + path, params);
}

async function request(endpoint, params = {}, attempt = 0) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const token = await getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.ok) return res.json();

  // A token Google no longer honours: drop it and renew silently, once.
  if (res.status === 401 && attempt === 0) {
    await invalidateToken();
    return request(endpoint, params, attempt + 1);
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
      return backoffRetry(endpoint, params, attempt);
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
    return backoffRetry(endpoint, params, attempt);
  }

  const body = await res.json().catch(() => ({}));
  throw new GmailError(body?.error?.message || `Gmail request failed (${res.status}).`, {
    status: res.status,
    reason: body?.error?.errors?.[0]?.reason,
  });
}

async function backoffRetry(endpoint, params, attempt) {
  if (attempt >= 4) throw new Error('Gmail is rate limiting these requests.');
  const delay = 2 ** attempt * 400 + Math.random() * 300;
  await new Promise((resolve) => setTimeout(resolve, delay));
  return request(endpoint, params, attempt + 1);
}

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

/** Names and IDs only — labels.list does not include message counts. */
export async function listLabels() {
  const { labels = [] } = await call('/labels');
  return labels;
}

/** labels.get is where messagesTotal / messagesUnread actually live. */
export function getLabel(id) {
  return call(`/labels/${encodeURIComponent(id)}`);
}

/**
 * Exact count of messages carrying `labelId` but sitting outside the main
 * system labels. Paginates IDs because resultSizeEstimate is only an estimate.
 *
 * @returns {Promise<{count: number, exact: boolean}>}
 */
export async function countUnfiled(labelId) {
  let count = 0;
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await call('/messages', {
      labelIds: labelId,
      q: UNFILED_QUERY,
      maxResults: PAGE_SIZE,
      fields: 'nextPageToken,messages/id',
      pageToken,
    });

    count += data.messages?.length ?? 0;
    pageToken = data.nextPageToken;
    if (!pageToken) return { count, exact: true };
  }

  return { count, exact: false };
}

export { AuthError };
