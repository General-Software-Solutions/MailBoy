# MailBoy

A Chrome side-panel extension for clearing out and organizing a Gmail mailbox.
Bin what you never wanted, file what you keep, and set the rules that stop the
mess coming back — a few clicks each, in bulk.

Everything runs in your browser. There is no MailBoy server, and no mailbox data
ever leaves your machine.

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
collected even in principle.

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

MailBoy is not on the Chrome Web Store yet, so it is loaded unpacked and you
supply your own Google OAuth client. Roughly ten minutes.

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

### Icons

Inline glyphs come from Material Symbols, bundled at
`resources/fonts/material-symbols-outlined.woff2` rather than loaded from a CDN
— MV3 extensions should not depend on remote resources. The file is **subsetted
to the glyphs actually used** (2.6 KB against roughly 4 MB for the full family),
so a glyph outside the subset renders as its literal name. Currently bundled:

```
logout, refresh, inbox, label, star, delete,
send, draft, report, schedule, search, settings
```

To add one, re-download the subset with the new name appended to `icon_names`,
keeping the existing entries:

```powershell
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$url = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined' +
       ':opsz,wght,FILL,GRAD@24,400,0,0&icon_names=logout,refresh,inbox,label'
$css = (Invoke-WebRequest $url -UserAgent $ua -UseBasicParsing).Content
$font = [regex]::Match($css, 'url\((https://[^)]+)\)').Groups[1].Value
Invoke-WebRequest $font -UserAgent $ua -UseBasicParsing `
  -OutFile resources\fonts\material-symbols-outlined.woff2
```

Use them as `<span class="icon" aria-hidden="true">logout</span>`; the ligature
turns the name into the glyph.

The toolbar icon (`resources/icons/icon{16,32,48,128}.png`) is rasterized from
`resources/icon-candidates/icon1.svg`, the same mark used on the welcome screen.
The other files there are unused drafts kept for reference.

## Status

Pre-release, and honest about it. The half that works out what to clear —
counting, measuring, sender breakdowns — runs against a real mailbox. The half
that does the clearing does not yet: the bulk move and trash jobs, rules and
Block, and partial permission grants have all been built and reviewed without
being exercised end to end against a real account. Nothing MailBoy does is
unrecoverable — everything it removes goes to Trash — but the destructive paths
are not yet proven, so treat them with that in mind.

Chrome 114 or newer.
