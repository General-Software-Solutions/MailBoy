# Security

MailBoy holds a Gmail grant that can move and trash mail, and read every message
in a mailbox. Reports about it are welcome, and this file says where to send
them.

## Reporting a vulnerability

Email **generalsoftwaresolutionspvt@gmail.com** with `MailBoy security` in the
subject line.

Please include what you need to make the problem understandable: the version
(`manifest.json` → `version`), what you did, what happened, and what you expected
instead. A proof of concept helps, but a clear description is enough — do not sit
on a report because you have not written an exploit for it.

**Please do not open a public GitHub issue for a security problem.** Report it
privately first and give a fix a chance to ship.

You should expect an acknowledgement within **7 days**, and an assessment within
**30**. MailBoy is maintained by one person, so those are honest limits rather
than a service level. You are free to disclose publicly after 90 days, sooner if
a fix has already shipped, and immediately if the report is acknowledged as
invalid.

Nothing here is a bug bounty. There is no money, and good-faith research will not
be met with legal action.

## Scope

**In scope** — this repository and the published extension:

- Anything that could expose mailbox data outside the user's own browser.
- Anything that could cause mail to be moved, trashed or relabelled other than
  as the user asked, or in greater quantity than the confirmation stated.
- Anything that could create, alter or delete a Gmail filter unasked.
- Token handling: leakage of the access token out of `chrome.storage.session`,
  or into disk, logs or a network request.
- Cache poisoning across accounts — one mailbox's data being read into or
  written under another account's namespace.
- Injection through mail content. Message bodies are rendered as text through a
  detached `DOMParser` document and never as HTML; a way to get sender-controlled
  markup or script to execute in the panel is a real finding.
- OAuth flow problems: redirect URI handling, scope escalation, a silent renewal
  that widens a grant the user narrowed.

**Out of scope:**

- Google's own infrastructure, the Gmail API, and the consent screen. Report
  those to Google.
- Anything requiring a compromised browser, a malicious extension already
  installed with equal permissions, or physical access to an unlocked machine.
- The fact that cached data survives a logout for 7 days. That is documented and
  deliberate, and the logout dialog offers an immediate erase.
- The fact that sender addresses, message IDs, sizes and dates are stored on
  disk. Documented in the privacy policy and in the README.
- Reports from automated scanners with no demonstrated impact.

## What MailBoy deliberately does not do

These are design decisions, not oversights. A report that one of them is a
weakness will not be treated as a vulnerability, but a report that one of them is
**not actually true** very much will be:

- **There is no server.** The extension talks to Google's APIs directly from the
  browser. No mailbox data reaches the developer or any third party.
- **No permanent deletion.** MailBoy never requests `https://mail.google.com/`,
  so it is not capable of `messages.batchDelete`. Everything it removes goes to
  Trash.
- **No remote code.** Every script, style and font ships inside the package.
  There is no CDN, no analytics, no telemetry, and no third-party dependency.
- **Message content is never written to disk**, and never rendered as HTML.
- **Access tokens live in `chrome.storage.session` only** — memory, never disk —
  and there is no refresh token.

If you can show that any of the above is false, that is the highest-value report
you can send.
