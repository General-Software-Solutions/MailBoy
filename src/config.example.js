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
// userinfo.* carries the avatar and the signed-in address. Sourcing identity
// here rather than from Gmail keeps the top bar populated even when the Gmail
// API itself is refusing requests. Both are non-sensitive scopes, so unlike the
// Gmail pair they add nothing to the verification burden.
//
// These must match the scopes added under "Data access" in Google Cloud
// Console. Asking here for one that is not registered there fails the sign-in.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];
