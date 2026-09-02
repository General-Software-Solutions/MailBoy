// Template for src/config.js, which is gitignored because CLIENT_ID is bound
// to one specific OAuth client + redirect URI (see README.md "One-time
// setup"). Copy this file to src/config.js and fill in your own value —
// never reuse another deployment's CLIENT_ID.
//
// cp src/config.example.js src/config.js   (or copy by hand on Windows)

// OAuth client ID for MailBoy, from Google Cloud Console.
// Type: "Web application", with this extension's chromiumapp.org redirect URI
// registered against it.
export const CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';

// gmail.modify is what creating and deleting folders costs. It covers every
// read/write operation *except* permanent deletion — mail it removes goes to
// Trash and can be recovered, which is the whole reason not to reach for
// `https://mail.google.com/` instead. That one grants irreversible deletion and
// is the widest scope Google publishes; nothing MailBoy does needs it.
//
// Deliberately not also requesting gmail.labels. It is the narrower scope for
// labels.create/delete, but gmail.modify already authorises both, so listing it
// would add a redundant line to the consent screen and one more scope to
// justify at verification.
//
// gmail.readonly stays even though modify subsumes it: it is the scope that
// describes what MailBoy does almost all of the time, and dropping it would
// make a revoked or downgraded grant fail everything rather than just the two
// write actions.
//
// Both are restricted scopes, so this pair does not change the review tier —
// and the client-only design still keeps CASA Tier 2 out of it.
//
// gmail.settings.basic is what rules cost. `users.settings.filters` is a
// settings surface and gmail.modify does not reach it, however much mail it can
// move, so there is no narrower option. Restricted too, so the same argument
// holds.
//
// userinfo.* carries the avatar and the signed-in address. Sourcing identity
// here rather than from Gmail keeps the top bar populated even when the Gmail
// API itself is refusing requests. Both are non-sensitive scopes, so unlike the
// Gmail pair they add nothing to the verification burden.
//
// **This list is what actually grants permission**, not the one under "Data
// access" in Cloud Console. The authorization request carries these, and while
// the project is in Testing, Google issues a grant for a scope the consent
// screen configuration does not list — verified 2026-08-31 by adding
// gmail.settings.basic here alone and finding it granted. `auth.js` reads every
// scope back out of the redirect, so what a sign-in actually granted is known
// rather than assumed.
//
// The Cloud Console list still matters, for two things: it is what the consent
// screen is built from, and it is what gets reviewed at publish. A restricted
// scope missing there will block verification even though it works today.
export const SCOPE = {
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  modify: 'https://www.googleapis.com/auth/gmail.modify',
  settings: 'https://www.googleapis.com/auth/gmail.settings.basic',
  profile: 'https://www.googleapis.com/auth/userinfo.profile',
  email: 'https://www.googleapis.com/auth/userinfo.email',
};

/** Everything a first connect asks for. The user may hand back less. */
export const SCOPES = Object.values(SCOPE);

/**
 * The one thing nothing works without.
 *
 * Each Gmail permission has its own checkbox on Google's consent screen and can
 * be unticked there, so a grant can come back short — a supported outcome, not
 * an error. Identity is the exception: every cache key is namespaced by the
 * `sub` these two carry.
 */
export const REQUIRED_SCOPES = [SCOPE.profile, SCOPE.email];

/**
 * What each part of the product needs, and what to go back and ask for when it
 * is missing. `needs` is satisfied by any one of the scopes listed — gmail.modify
 * subsumes gmail.readonly — while `ask` is the single scope an ad-hoc request
 * goes back for.
 */
export const CAPABILITIES = {
  read: { needs: [SCOPE.read, SCOPE.modify], ask: SCOPE.read },
  write: { needs: [SCOPE.modify], ask: SCOPE.modify },
  rules: { needs: [SCOPE.settings], ask: SCOPE.settings },
};
