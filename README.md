# MailBoy

A Chrome side-panel extension for clearing out and organizing a Gmail mailbox.
Bin what you never wanted, file what you keep, and set the rules that stop the
mess coming back — a few clicks each, in bulk.

Everything runs in your browser. There is no MailBoy server, and no mailbox data
ever leaves your machine.

**[Add MailBoy to Chrome](https://chromewebstore.google.com/detail/mailboy/mmdnbdmdmagefjpllaldgcklmikbjeem)**

## What it does

**Clear out in bulk.** Tick the senders filling a folder — or individual emails
— and send the lot to Trash in one go. Thousands at a time, not one thread at a
time.

**File what you keep.** Move a selection into a folder, creating the folder
right there if it doesn't exist yet. A move is definitive: the mail ends up in
the folder you chose and nowhere else, so "where is this?" has one answer.

**Block a sender for good.** One click writes a Gmail filter sending everything
from that address — or from their entire domain — straight to Trash from now on,
so you never deal with them again. Nothing you already have moves.

**Make it stick.** When you move or delete, you can ask for future mail like it
to go the same way automatically. The **Rules** tab keeps every rule MailBoy
made in one place, alongside the Gmail filters you already had, grouped by where
they send mail — and deletes any of them.

**Shape your folders.** Create and remove your own folders, nesting included.
Deleting one asks what should happen to the mail inside: back to your inbox, or
to Trash.

**Know what to clear before you clear it.** Every folder shows an exact email
count and a total size, which Gmail itself will not tell you. Open one and it
breaks down by sender: how many emails each has sent, how much space they take,
how often they write. Sort by any of those, or narrow to a period — then act on
what the list puts at the top.

**Check a sender before you bin them.** Their emails, ten to a page, and any one
of them opened. Messages are shown as plain text — MailBoy never loads a
sender's images or styling, so looking at one doesn't tell them you did.

### Two things worth knowing up front

**Nothing is ever deleted permanently.** Mail MailBoy removes goes to Trash,
where Gmail keeps it for 30 days. The extension deliberately does not ask for
the permission that would allow permanent deletion.

**Mail you wrote is left out throughout.** No Sent or Drafts row, and neither
counts towards a folder. Gmail labels whole threads, so labelling a conversation
you replied to puts that label on your own replies — and MailBoy is about
sorting what arrives. It also means deleting a folder can never touch anything
you sent. The cost is that a folder covering conversations you took part in
reads slightly lower here than in Gmail's own sidebar.

## Privacy

The extension talks to the Gmail API directly from your browser. There is no
backend of ours in the path, so there is nowhere for mailbox data to be
collected even in principle. The full policy is at
[general-software-solutions.github.io/MailBoy/privacy.html](https://general-software-solutions.github.io/MailBoy/privacy.html).

What is stored on your machine, in `chrome.storage.local`:

- Message IDs, byte sizes, dates and **sender addresses** — the data behind the
  counts, sizes and sender breakdowns. Sizes and senders never change, which is
  why they are safe to keep.
- Which folders currently hold which messages, and your Google account's ID and
  email.

What is **never** written to disk: subjects, previews, message bodies,
recipients, attachments, and your rules. Those are fetched only for what is on
screen and dropped when you leave it.

Access tokens live in `chrome.storage.session` — memory only.

Everything cached is namespaced by account and kept for 7 days after you log
out, so signing back in is instant and moving between two mailboxes stays
practical. **Log out and erase data now** in the logout dialog wipes it
immediately instead.

### Permissions

MailBoy asks for three Gmail permissions, and Google's consent screen lets you
untick any of them individually. A partial grant is supported: the extension
signs you in on whatever it was given, shows what that reaches, and asks Google
again for a specific permission at the moment you press something that needs it.

| Permission | What it buys |
|---|---|
| `gmail.readonly` | Folders, counts, sizes, sender breakdowns, reading mail |
| `gmail.modify` | Creating and deleting folders; Move, Delete, Restore |
| `gmail.settings.basic` | Rules and Block |

`https://mail.google.com/` — the scope that permits permanent deletion, and the
widest Google publishes — is deliberately never requested.

## Setup

To run MailBoy from source, load it unpacked and supply your own Google OAuth
client. Roughly ten minutes.

### 1. A Google Cloud OAuth client

Every OAuth flow needs a registered client ID; there is no path to the Gmail API
without one. In [Google Cloud Console](https://console.cloud.google.com/),
create a project and set it up so that:

- The **Gmail API** is enabled.
- The OAuth consent screen is configured as an **External** app, left in
  **Testing**, with your own Google account added as a test user, and these
  scopes registered: `gmail.readonly`, `gmail.modify`, `gmail.settings.basic`,
  `userinfo.profile`, `userinfo.email`. Google flags the three Gmail scopes as
  restricted — that warning is about publishing; in Testing they work right away
  for up to 100 test users.
- An **OAuth client ID** exists of application type **Web application** — not
  "Chrome Extension", which only works with a different sign-in API. Leave
  *Authorized JavaScript origins* empty; the redirect URI is added in step 3,
  once the extension has an ID.

No OAuth verification or app review is needed for development. Keep the client
ID; the secret Google shows beside it is not used and must not be added
anywhere.

### 2. Load the extension

`manifest.json` is gitignored, so a fresh clone has to make one from the tracked
template:

```powershell
copy manifest.template.json manifest.json
```

Then go to `chrome://extensions`, turn on **Developer mode**, choose **Load
unpacked**, and pick this folder. Copy the extension ID from the card.

> `manifest.template.json` is the tracked source of truth. If you change
> anything in the manifest later, edit the template and re-copy — editing only
> the gitignored copy means the change never reaches a commit.

**Pinning the ID (optional, for publishing).** Loaded like this, the ID is
derived from this folder's path, so moving the folder — or publishing later —
changes it, and the redirect URI below has to be re-registered. To get the final
ID up front, upload a zip of this folder to the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole) as an
unpublished draft (one-time $5 registration), open the item's *Package* tab →
**View public key**, and paste the base64 between the `BEGIN`/`END` markers into
`manifest.json`:

```json
"key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A..."
```

The unpacked extension then shares the ID the published one will have. That key
is why `manifest.json` is gitignored — a committed key means every clone shares
your extension ID, and therefore your redirect URI.

### 3. Register the redirect URI

Back in Cloud Console, on the OAuth client from step 1, under **Authorized
redirect URIs** add exactly:

```
https://<your-extension-id>.chromiumapp.org/
```

The trailing slash matters: the value must match
`chrome.identity.getRedirectURL()` exactly, or sign-in fails with
`redirect_uri_mismatch`.

### 4. Add your client ID

`src/config.js` is gitignored, because a client ID is bound to one specific
redirect URI and committing the pair invites reuse. Copy the template:

```powershell
copy src\config.example.js src\config.js
```

and fill in your own value:

```js
export const CLIENT_ID = '123456789-abcdef.apps.googleusercontent.com';
```

`SCOPES` in that file is what the authorization request actually carries — the
Cloud Console list builds the consent screen and is what gets reviewed at
publish, but it is this file that asks. Keep the two in step.

### 5. Connect

Reload the extension at `chrome://extensions`, click the toolbar icon to open
the side panel, and press **Connect to Mailbox**. A Google-hosted window opens,
you pick an account and choose which permissions to grant.

The first run reads every message's size and sender so it knows what you are
working with. That takes a few minutes on a large mailbox — roughly 7 minutes
for 20,000 emails. You can close the panel while it runs; the work continues in
the background. Every open after that is seconds.

## How it works

Client-only by design: the panel calls Google's APIs straight from the browser.
Besides the privacy story, this keeps the app out of Google's CASA Tier 2
security assessment, which is required only for apps that route restricted-scope
data through their own backend.

Sign-in runs through `chrome.identity.launchWebAuthFlow` against Google's
authorization endpoint, using the implicit flow. Two deliberate choices behind
that: the Google Identity Services JS library loads code from
`accounts.google.com` at runtime and MV3 forbids remotely-hosted code, so the
same endpoint is driven manually; and the authorization-code flow needs a client
secret, which has nowhere safe to live in a package anyone can unzip. The cost
is a ~1 hour token with no refresh token, renewed silently in the background.

Deciding what to clear out needs figures Gmail will not give you: it has no API
for a folder's size and none for grouping by sender. Both are computed here —
every message is read once for its size, sender and date, and cached
permanently. After that, sender breakdowns and size totals cost no network calls
at all. Reading is paced against Gmail's quota and runs in the service worker,
so it survives the panel being closed. Day to day the panel keeps up using
Gmail's change log rather than re-reading anything, and re-lists the mailbox in
full once a week.

The bulk actions run as background jobs for the same reason: Gmail moves mail to
Trash one message at a time, so clearing a large folder is minutes of work. It
is resumable, and dispatching it updates the counts immediately rather than
after the job finishes.

```
manifest.template.json  tracked manifest; copy to manifest.json
background.js           opens the side panel; owns the long background jobs
sidepanel.html/.css/.js the panel: screens, rendering, load orchestration
src/config.js           OAuth client ID and scopes (gitignored)
src/auth.js             OAuth, and what a grant actually covers
src/gmail.js            Gmail REST client: retry, backoff, quota pacing, batches
src/mailbox.js          counts and sizes; patching from the change log
src/messages.js         the per-message cache
src/folders.js          creating and removing folders
src/bulk.js             moving and trashing a selection
src/mail.js             reading messages
src/rules.js            Gmail filters
src/copy.js             every word the interface shows
```

## Development

Plain ES modules — no build step, no dependencies. Edit, then hit reload on
`chrome://extensions`. Run `node --check` on any file you touch; there is no
test suite yet.

Every user-facing string lives in `src/copy.js` and nowhere else, reached either
as `COPY.*` or through a `data-copy="…"` attribute in the HTML.

`src/trace.js` has a `TRACE` flag that turns on console tracing of the paths
that fail quietly — which sync path an open took, why one was refused, whether
an action settled locally. Filter the console by `open`, `sync`, `listing`,
`action`, `bookmark`, `measure`, `snapshot`, `job` or `rules`.

Tracing stays on in published builds, so a user reporting a problem can send
the console output. That is safe only because trace lines carry ids and counts,
never an address, a subject or a name — keep it that way. There are two
consoles to ask for: the side panel's (right-click inside the panel →
**Inspect** → **Console**) and the background worker's (`chrome://extensions` →
**Developer mode** → **service worker** under MailBoy).

### Releasing

The Web Store package is built by `tools/package.ps1`. It packs an explicit list
of files — never the whole folder — uses `manifest.template.json` (the store
refuses a manifest with a `"key"`), and writes two files into `dist/`:
`mailboy-<version>.zip`, and `mailboy-<version>.crx`, which is that same zip
signed. `dist/` is gitignored; it only ever holds build output and can be
deleted.

```powershell
powershell -File tools\package.ps1
```

Locally it uses your `src/config.js`. Given `-ClientId` or a
`MAILBOY_CLIENT_ID` environment variable, it generates `src/config.js` from
`src/config.example.js` instead, which is how CI builds it.

**GitHub Action.** `.github/workflows/package.yml` runs the same script,
after syntax-checking every `.js` and `.mjs` file. One-time setup: in the
repository's **Settings → Secrets and variables → Actions**, add a secret named
`MAILBOY_CLIENT_ID` holding the client ID from your `src/config.js`.

To release a new version:

1. Raise `"version"` in `manifest.template.json` and in your local
   `manifest.json`. The store rejects an upload that is not higher than the live
   version.
2. Commit and push.
3. Tag that commit with the same version and push the tag:

   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The workflow fails if the tag and the manifest version disagree. It can also
   be started by hand from the **Actions** tab, without a tag.
4. Open the finished run under **Actions**. Its summary page lists what was
   built and which file to upload, and says so again as a notice when an
   optional secret is missing. Download from **Artifacts** (kept 30 days):
   upload the `.crx` if verified CRX uploads are on for the item, the `.zip`
   otherwise; neither needs extracting. The third artifact,
   `-dev-unpacked-only`, is for testing the build and must not be uploaded —
   see below.
5. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open MailBoy → **Package** → **Upload new package**, update the listing if
   the release needs it, and **Submit for review**. Existing users receive the
   update automatically once it is approved.

If a release adds a permission or an OAuth scope, review takes longer and
existing users are asked to accept it before the update enables.

### Testing a build before uploading it

**A packaged build cannot sign in, and that is not a fault.** The extension ID
comes from the `key` in the manifest, and the redirect URI registered with
Google is `https://<that id>.chromiumapp.org/`. `manifest.template.json` carries
no key, because the store refuses an upload that has one — so a package loaded
straight from CI gets an ID derived from wherever it happens to sit, Google sees
a redirect URI it has never heard of, and the sign-in fails with **"Access
blocked: This app's request is invalid"**. Publishing is unaffected: the store
re-signs under your registered key and users get the right ID.

For everyday work, load the repository folder itself — that is what its
gitignored `manifest.json` with the key is for. To test a *packaged* build,
`-Dev` writes a second zip beside the store one with the key put back:

```powershell
powershell -File tools\package.ps1 -Dev
```

That produces `dist/mailboy-<version>-dev-unpacked-only.zip`. Extract it, load
it with **Load unpacked**, and sign-in works because the ID matches. The name is
the whole warning: **never upload it.** The store rejects a manifest with a key,
so a slip fails loudly rather than shipping something odd.

**Where that key comes from.** It is the `"key"` line in your local
`manifest.json`, the one taken from the Web Store draft when the item was first
created — a *public* key, and the same one that fixes the extension ID. It is
not the crx signing key further down, and there is no way to derive one from the
other. `manifest.json` is gitignored, so a CI runner has never seen it.

The build takes the first of these it finds:

| | |
|---|---|
| `-ManifestKey <base64>` | a one-off |
| `MAILBOY_MANIFEST_KEY` environment variable | what CI sets, from the secret |
| the `"key"` in `manifest.json` | your machine, needing no setup |

**For CI**, add a repository secret named `MAILBOY_MANIFEST_KEY`. Print the
value with:

```powershell
(Get-Content -Raw manifest.json | ConvertFrom-Json).key | Set-Clipboard
```

Paste it as it is: one long base64 line, no quotes, no `"key":` prefix. Being a
public key, a repository *variable* would serve as well; a secret just keeps it
out of the logs.

**With no key the dev zip is simply not built**, and the log says so. The two
artifacts that get uploaded do not depend on it, so nothing is treated as a
failure.

### Verified CRX uploads

This is a store setting that decides **who may publish an update**, and it is
worth switching on. Without it, anything that can reach the developer account
can ship a new version to every user — and MailBoy holds `gmail.modify`, so a
hijacked update could read, move or trash their mail. With it on, the store
accepts only a `.crx` signed with a key that lives on your machine, and an
account on its own is not enough.

It changes nothing for users. The store re-signs the package with its own key on
the way out, so the extension ID and the manifest `key` stay exactly as they are.

**Generate the key once**, outside the repository so it cannot be committed. Git
for Windows ships OpenSSL, which is why the path below is spelled out:

```powershell
New-Item -ItemType Directory -Force "$HOME\keys" | Out-Null
& "C:\Program Files\Git\usr\bin\openssl.exe" genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$HOME\keys\mailboy-upload.pem"
& "C:\Program Files\Git\usr\bin\openssl.exe" pkey -in "$HOME\keys\mailboy-upload.pem" -pubout
```

`genpkey` rather than `genrsa` because it always writes PKCS#8, the form
everything here reads. The second command prints the public half: paste all of
it, `BEGIN` and `END` lines included, into the dashboard's **Package** page.

**Back the private key up somewhere off this machine.** Losing it means no
further updates until store support resets the registered key.

Then tell the build where it is, in `src/config.js` — the file that is already
local to one machine and already gitignored:

```js
export const CRX_KEY_PATH = 'C:\\Users\\you\\keys\\mailboy-upload.pem';
```

`src/config.js` *ships inside the package*, so `package.ps1` reads that export
and then cuts it back out of the copy it packs — a build path names whoever
built it, and users have no use for it. Keep it to one `export const`
statement: the build stops rather than shipping a path it could not remove.

There are three ways to name the key and the build takes the first that exists:
`-KeyPath` on the command line, then the `MAILBOY_CRX_KEY_PATH` environment
variable, then that export. All three hold a *path*; the repository secret
further down is the one place that holds the key itself.

**Without a key the build still produces a `.crx`**, signed with a throwaway key
and named `mailboy-<version>_unsigned.crx`. It installs in Chrome for testing
and the store will refuse it once verification is on — the name is the warning,
and the build says so as well.

**Signing in CI is the weaker arrangement**, and the workflow supports it
anyway. Add a repository secret named `MAILBOY_CRX_KEY` holding the whole
contents of the `.pem` — every line from `-----BEGIN PRIVATE KEY-----` to
`-----END PRIVATE KEY-----`, and no quotes around it. The run writes that to a
file outside the workspace, hands the build its path, and deletes it. The
tradeoff is plain: a key GitHub can read is a key a compromised GitHub account
can sign with, which gives back some of what the setting bought. Signing locally
keeps the key on one machine. Leave the secret unset and CI builds the unsigned
crx beside the zip, which is still the file to upload when verification is off.

**How the signing works**, since it is unusual: `tools/crx.mjs` wraps the zip
that was just built in a CRX3 container using nothing but Node's own crypto.
Chrome's `--pack-extension` is the documented route and is not used here, for
two reasons — it packs a *directory*, so the zip and the crx would be two
separate acts of packing that could disagree, and it wants a display, which a
Linux CI runner has not got. Signing the finished zip keeps the two byte for
byte identical. The output was checked against a crx Chrome packed from the same
key: same header, field for field, differing only in the 256 signature bytes.

### Icons

**There is no icon font.** Every glyph is inline SVG drawn in a 16-unit
`viewBox` and stroked with `currentColor`, so a button's intent colour reaches
its icon without a rule of its own. In markup:

```html
<svg class="btn-glyph" viewBox="0 0 16 16" aria-hidden="true">
  <path d="M8 3.5v9M3.5 8h9" />
</svg>
```

In JavaScript, the path lives in an `ICON_*` constant in `sidepanel.js` and is
mounted by `actionButton()` or `iconButton()`. Stroke weight comes from the
class — `.btn-glyph`, `.icon-btn svg`, `.row-action svg` — never from the path,
so weight stays consistent across sizes. Optical weight is
`stroke-width ÷ viewBox units`, not `÷ rendered size`: a 9px and an 18px glyph
from the same 16-unit box at the same stroke are the same weight.

Material Symbols was bundled and subsetted here until it came down to three
glyphs, two of them the same arrow. Drawing them removed a 2.6 KB binary, the
re-subsetting step that every new icon needed, and the only third-party asset in
the package — along with the Apache-2.0 attribution it carried. Adding a glyph
now means drawing one, not rebuilding a font.

The toolbar icon (`resources/icons/icon{16,32,48,128}.png`) is rasterized from
`resources/icon-candidates/icon1.svg`, the same mark used on the welcome screen.
The other files there are unused drafts kept for reference.

## Status

Published on the
[Chrome Web Store](https://chromewebstore.google.com/detail/mailboy/mmdnbdmdmagefjpllaldgcklmikbjeem)
and in active development. Nothing MailBoy does is unrecoverable: everything it
removes goes to Trash, where Gmail keeps it for 30 days. If something does not
behave as described, please open an issue.

Chrome 114 or newer.

## Security

Found something? See [SECURITY.md](SECURITY.md). Please report privately rather
than opening a public issue.

## License

Copyright © 2026 Jerry Raju. All rights reserved.

**Source-available, not open source.** The code is published so that anyone
using MailBoy can read exactly what it does with their mailbox and check the
privacy claims above for themselves — an extension holding a Gmail grant should
not have to be taken on trust.

You may read it, build it, and run your own copy for personal use. You may not
redistribute it, fork it into a separate product, or publish it to the Chrome
Web Store. See [LICENSE](LICENSE) for the exact terms, which is also where to
look before opening a pull request.

MailBoy bundles no third-party code, fonts or assets — every glyph is drawn in
this repository — so there is nothing else here under anyone else's terms.

MailBoy is an independent project. It is not affiliated with, endorsed by, or
sponsored by Google LLC. Gmail is a trademark of Google LLC.
