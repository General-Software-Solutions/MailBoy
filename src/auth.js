// OAuth against Google's authorization endpoint, driven through
// chrome.identity.launchWebAuthFlow.
//
// Why not the Google Identity Services JS library: it loads from
// accounts.google.com at runtime, and MV3 forbids remotely-hosted code in
// extension pages. So we drive the same endpoint GIS drives, ourselves.
//
// Why the implicit flow (response_type=token): it hands back an access token
// with no code-for-token exchange, so there is no client secret to embed in a
// package anyone can unzip. This is what GIS's own token client does in the
// browser. The cost is a ~1 hour token and no refresh token; renewal happens
// silently via prompt=none while the user has a live Google session.

import { CAPABILITIES, CLIENT_ID, REQUIRED_SCOPES, SCOPES } from './config.js';
import { trace } from './trace.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const TOKEN_KEY = 'token';
const HINT_KEY = 'accountHint';

/**
 * What Google actually granted, kept on disk rather than in session storage
 * alongside the token.
 *
 * It has to outlive the token, for one reason that is easy to get wrong: a
 * `prompt=none` renewal asking for a scope the user declined is refused
 * outright, so an hour after a partial grant the panel would drop to an
 * interactive sign-in — every hour, forever. Renewal asks for exactly what is
 * recorded here instead. It is a list of permission names, not a credential.
 */
const GRANT_KEY = 'grantedScopes';

/**
 * Set by an explicit logout, cleared by an explicit connect.
 *
 * Revoking the token is meant to end the grant, so a later `prompt=none`
 * renewal should fail on its own — but revocation is a network call made on a
 * best-effort basis, and if it does not land, Google's session is still live
 * and a silent renewal signs the user straight back in on the next panel open.
 * This makes the logout hold locally, whatever happened on the wire.
 */
const OUT_KEY = 'signedOut';

/** Renew a little early so a request can't die mid-flight. */
const EXPIRY_SKEW_MS = 60_000;

export class AuthError extends Error {}

/** Thrown when the user closes the Google window without approving. */
export class AuthCancelled extends AuthError {}

function redirectUri() {
  return chrome.identity.getRedirectURL();
}

function buildAuthUrl({ state, prompt, loginHint, scopes }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', scopes.join(' '));
  // Incremental authorization: a later request for one more permission comes
  // back with a token covering everything granted so far, not just the new one.
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  if (prompt) url.searchParams.set('prompt', prompt);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

/** Roomy enough for Google's account picker without dominating the screen. */
const AUTH_WINDOW = { width: 520, height: 720 };

/**
 * launchWebAuthFlow exposes no sizing option and Chrome defaults the popup to a
 * cramped box, so catch the window as it opens and resize it once. Best effort
 * throughout: if the window never surfaces here, sign-in still works, just
 * small.
 *
 * @returns {() => void} teardown, safe to call more than once
 */
function sizeAuthWindow() {
  let listener = null;

  const stop = () => {
    if (!listener) return;
    chrome.windows.onCreated.removeListener(listener);
    listener = null;
  };

  try {
    const width = Math.min(AUTH_WINDOW.width, screen.availWidth);
    const height = Math.min(AUTH_WINDOW.height, screen.availHeight);
    const left = Math.round((screen.availLeft ?? 0) + (screen.availWidth - width) / 2);
    const top = Math.round((screen.availTop ?? 0) + (screen.availHeight - height) / 2);

    listener = (win) => {
      if (win.type !== 'popup') return;
      // Only ever touch the first popup, so an unrelated one opening later in
      // the flow is left alone.
      stop();
      chrome.windows.update(win.id, { width, height, left, top }).catch(() => {});
    };

    chrome.windows.onCreated.addListener(listener);
  } catch {
    stop();
  }

  return stop;
}

function launch(url, interactive) {
  // Only the interactive flow opens a window worth sizing.
  const stopSizing = interactive ? sizeAuthWindow() : () => {};

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      stopSizing();
      const message = chrome.runtime.lastError?.message;
      if (message || !redirectUrl) {
        // Chrome reports a dismissed window and a failed silent attempt the
        // same way; only the interactive case is a real cancellation.
        const Kind = interactive ? AuthCancelled : AuthError;
        reject(new Kind(message || 'Authorization did not complete.'));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

/**
 * @param {boolean} interactive
 * @param {{ want?: string[], prompt?: string }} [options]
 *   `want` is the scope list to request, defaulting to whatever is already
 *   granted — see GRANT_KEY. `prompt` overrides the default for the flow.
 */
async function authorize(interactive, { want, prompt } = {}) {
  if (!CLIENT_ID) {
    throw new AuthError(
      'No OAuth client ID is configured. Set CLIENT_ID in src/config.js — see README.md.'
    );
  }

  const state = crypto.randomUUID();
  const { [HINT_KEY]: loginHint } = await chrome.storage.local.get(HINT_KEY);
  const held = await grantedScopes();

  // Asking for the full list again on every renewal would re-request scopes the
  // user has already turned down — silently fatal for `prompt=none`, and a
  // nagging consent screen otherwise. A first connect has nothing recorded, so
  // it asks for everything and lets the user choose.
  const scopes = want ?? (held.length ? held : SCOPES);

  const url = buildAuthUrl({
    state,
    // Silent renewal must never draw UI. An explicit connect should let the
    // user choose which account to hand over.
    prompt: prompt ?? (interactive ? 'select_account' : 'none'),
    loginHint,
    scopes,
  });

  const redirectUrl = await launch(url, interactive);
  const params = new URLSearchParams(new URL(redirectUrl).hash.slice(1));

  const error = params.get('error');
  if (error) throw new AuthError(error);

  if (params.get('state') !== state) {
    throw new AuthError('Authorization response did not match the request.');
  }

  const accessToken = params.get('access_token');
  if (!accessToken) throw new AuthError('Google returned no access token.');

  const granted = (params.get('scope') ?? '').split(' ').filter(Boolean);
  const withheld = scopes.filter((scope) => !granted.includes(scope));

  // What Google actually handed over, which is the only authority on it — the
  // scope list configured in Cloud Console is about the consent screen and about
  // verification, not about what a token carries. Worth tracing because a token
  // cached in session storage from before a scope was added keeps working and
  // skips this entirely, so "it works" can mean either thing.
  trace('auth', 'token granted', {
    granted: granted.length,
    // Names, not the token: which permissions were given is exactly the
    // question, and none of this is mail data.
    scopes: granted.map(shortScope),
    withheld: withheld.map(shortScope),
  });

  // A withheld Gmail scope is a choice the user made on the consent screen, not
  // an error: the panel reads what it can and asks again for the rest at the
  // moment somebody reaches for it. Identity is the one thing that cannot be
  // worked around — without `sub` there is no account to key anything by.
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    console.error('[MailBoy] Google withheld required scopes:', missing);
    throw new AuthError('MailBoy needs to know which Google account it is reading.');
  }

  if (withheld.length) {
    console.warn('[MailBoy] Google withheld scopes:', withheld.map(shortScope).join(', '));
  }

  const expiresAt = Date.now() + Number(params.get('expires_in') || 3600) * 1000;
  // Session storage keeps the token in memory only — it never touches disk.
  await chrome.storage.session.set({ [TOKEN_KEY]: { accessToken, expiresAt } });
  // Recorded from the response rather than from the request: Google is the
  // authority on what was granted, and `include_granted_scopes` means this
  // already carries everything an earlier consent handed over.
  await chrome.storage.local.set({ [GRANT_KEY]: granted });
  await chrome.storage.local.remove(OUT_KEY);

  return accessToken;
}

function shortScope(scope) {
  return scope.replace(/^https:\/\/www\.googleapis\.com\/auth\//, '');
}

/** Every scope this account has handed over, as of the last authorization. */
export async function grantedScopes() {
  const { [GRANT_KEY]: granted } = await chrome.storage.local.get(GRANT_KEY);
  return Array.isArray(granted) ? granted : [];
}

/**
 * Which parts of the product the current grant reaches, as
 * `{ read, write, rules }`.
 *
 * Read from storage on every call rather than memoised: the same reasoning as
 * the active account in `account.js` — the panel and the service worker each
 * holding their own idea of what is permitted is a disagreement nothing can
 * detect, and this is one small local read.
 */
export async function capabilities() {
  const { [GRANT_KEY]: recorded } = await chrome.storage.local.get(GRANT_KEY);

  // No record at all means a token minted before grants were recorded — and
  // until then a partial grant was refused outright, so a token that exists with
  // nothing beside it was a full one. Reading this as "nothing is permitted"
  // would put a "MailBoy cannot see your mail" screen in front of somebody whose
  // permissions are perfectly fine, on the first open after an update. The next
  // renewal writes a real record over it.
  const granted = new Set(Array.isArray(recorded) ? recorded : SCOPES);

  const caps = {};
  for (const [name, { needs }] of Object.entries(CAPABILITIES)) {
    caps[name] = needs.some((scope) => granted.has(scope));
  }
  return caps;
}

/**
 * Ask for one more permission, from a user gesture, and report what the grant
 * looks like afterwards.
 *
 * `prompt=consent` rather than no prompt at all: Google may decide it has asked
 * about this scope already and return the same narrow grant without drawing
 * anything, which reads as the button having done nothing. Forcing the screen
 * costs a re-tick of what is already granted and guarantees the user sees the
 * question. `include_granted_scopes` is what keeps the resulting token wide
 * rather than narrowing it to the one scope asked about here.
 *
 * @param {string[]} scopes
 * @returns {Promise<Record<string, boolean>>}
 */
export async function requestScopes(scopes) {
  const held = await grantedScopes();
  const want = [...new Set([...REQUIRED_SCOPES, ...held, ...scopes])];

  trace('auth', 'requesting more', { asking: scopes.map(shortScope) });
  await authorize(true, { want, prompt: 'consent' });
  return capabilities();
}

/**
 * A usable access token, reusing the cached one and renewing silently when it
 * can. Pass `interactive: true` (from a user gesture) to allow the Google
 * sign-in window to open.
 */
export async function getToken({ interactive = false } = {}) {
  const { [TOKEN_KEY]: cached } = await chrome.storage.session.get(TOKEN_KEY);
  if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
    return cached.accessToken;
  }

  const { [OUT_KEY]: signedOut } = await chrome.storage.local.get(OUT_KEY);

  // Someone who signed out stays signed out until they ask to come back. Only
  // an interactive attempt — a press of Connect — gets past this.
  if (signedOut) {
    if (!interactive) throw new AuthError('Signed out of MailBoy.');
  } else {
    try {
      return await authorize(false);
    } catch (err) {
      if (!interactive) throw err;
    }
  }

  return authorize(true);
}

/** Drop a token Gmail has rejected so the next call fetches a fresh one. */
export function invalidateToken() {
  return chrome.storage.session.remove(TOKEN_KEY);
}

/** Remember which account to renew against, so silent renewal picks correctly. */
export function rememberAccount(email) {
  return chrome.storage.local.set({ [HINT_KEY]: email });
}

/** Forget the token locally and revoke it with Google, best effort. */
export async function logout() {
  const { [TOKEN_KEY]: cached } = await chrome.storage.session.get(TOKEN_KEY);

  if (cached?.accessToken) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(cached.accessToken)}`, {
        method: 'POST',
      });
    } catch {
      // Revocation is a courtesy; the local token is cleared regardless.
    }
  }

  await chrome.storage.session.remove(TOKEN_KEY);
  // The grant record goes with it, so the next connect asks for the full list
  // again rather than silently inheriting a partial grant somebody may have
  // signed out precisely to get away from.
  await chrome.storage.local.remove([HINT_KEY, GRANT_KEY]);
  await chrome.storage.local.set({ [OUT_KEY]: true });
}
