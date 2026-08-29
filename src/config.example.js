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

// Least privilege for a read-only view. Adding write actions later means
// gmail.modify, which forces every existing user to re-consent.
//
// userinfo.* carries the avatar and the signed-in address. Sourcing identity
// here rather than from Gmail keeps the top bar populated even when the Gmail
// API itself is refusing requests. Both are non-sensitive scopes, so unlike
// gmail.readonly they add nothing to the verification burden.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];
