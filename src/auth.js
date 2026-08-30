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

import { CLIENT_ID, SCOPES } from './config.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

const TOKEN_KEY = 'token';
const HINT_KEY = 'accountHint';

/** Renew a little early so a request can't die mid-flight. */
const EXPIRY_SKEW_MS = 60_000;

export class AuthError extends Error {}

/** Thrown when the user closes the Google window without approving. */
export class AuthCancelled extends AuthError {}

function redirectUri() {
  return chrome.identity.getRedirectURL();
}

function buildAuthUrl({ state, prompt, loginHint }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', prompt);
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

async function authorize(interactive) {
  if (!CLIENT_ID) {
    throw new AuthError(
      'No OAuth client ID is configured. Set CLIENT_ID in src/config.js — see README.md.'
    );
  }

  const state = crypto.randomUUID();
  const { [HINT_KEY]: loginHint } = await chrome.storage.local.get(HINT_KEY);

  const url = buildAuthUrl({
    state,
    // Silent renewal must never draw UI. An explicit connect should let the
    // user choose which account to hand over.
    prompt: interactive ? 'select_account' : 'none',
    loginHint,
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

  const granted = (params.get('scope') ?? '').split(' ');
  const missing = SCOPES.filter((scope) => !granted.includes(scope));
  if (missing.length) {
    throw new AuthError('MailBoy needs permission to read your mail to show folder counts.');
  }

  const expiresAt = Date.now() + Number(params.get('expires_in') || 3600) * 1000;
  // Session storage keeps the token in memory only — it never touches disk.
  await chrome.storage.session.set({ [TOKEN_KEY]: { accessToken, expiresAt } });

  return accessToken;
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

  try {
    return await authorize(false);
  } catch (err) {
    if (!interactive) throw err;
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
  await chrome.storage.local.remove(HINT_KEY);
}
