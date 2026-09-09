/**
 * Every word the user reads, in one place.
 *
 * Nothing here knows anything about the DOM or about Gmail — a leaf is either a
 * string or a function returning one. That is the whole contract, and it is what
 * makes this file readable end to end when the wording needs a pass.
 *
 * **House style**, since the product is for people who do not think about mail
 * in terms of labels, filters or scopes:
 *
 * - Short. One idea per sentence, and no sentence that only restates the
 *   button it sits under.
 * - Plain. "Folder", not "label"; "rule", not "filter"; "emails", not
 *   "messages".
 * - Nothing that explains how the internet already works. No account of what a
 *   Google sign-in window is, what Trash is for, or what a checkbox does.
 * - Say the consequence, not the mechanism. "You can close the panel" beats an
 *   account of which process the work runs in.
 *
 * Static markup pulls from here through `data-copy="path.to.key"`, filled by
 * `applyStaticCopy()` at start-up; `sidepanel.js` reaches the rest as `COPY.*`.
 */

/** `1 email` / `1,284 emails`, which half this file needs somewhere. */
export const emails = (n) => `${n.toLocaleString()} email${n === 1 ? '' : 's'}`;

/** The same for rules. */
export const ruleCount = (n) => `${n.toLocaleString()} rule${n === 1 ? '' : 's'}`;

export const COPY = {
  /** Words that stand alone and are the same wherever they appear. */
  common: {
    appName: 'MailBoy',
    cancel: 'Cancel',
    delete: 'Delete',
  },

  nav: {
    sections: 'Sections',
  },

  /** Table column headings, shared wherever the same column appears twice. */
  columns: {
    sender: 'Sender',
    count: 'Count',
    size: 'Size',
    frequency: 'Frequency',
    mail: 'Mail',
    date: 'Date',
    destination: 'Destination',
    rules: 'Rules',
    rule: 'Rule',
  },

  // ── Getting in ─────────────────────────────────────────────────
  boot: {
    loading: 'Loading…',
  },

  welcome: {
    tagline: 'Take control of you messy Inbox.',
    connect: 'Connect Gmail',
    connecting: 'Connecting…',
    // Three claims, and each is something a user could not guess: what it
    // reads, that it cannot destroy anything, and where the data goes. How a
    // Google sign-in works is not one of them.
    fineprint:
      'MailBoy reads your mailbox to show what is in it. Anything you delete ' +
      'goes to Trash, never deleted for good. Your mail never leaves this browser. We have no backend.',
    failed: 'Could not sign in. Try again.',
    expired: 'Signed out. Connect again.',
  },

  topbar: {
    refresh: 'Refresh',
    stop: 'Stop',
    refreshTitle: 'Refresh',
    stopTitle: 'Stop refreshing',
    logout: 'Log out',
  },

  logout: {
    title: 'Log out?',
    // The seven days are the only thing here worth a sentence: they are why
    // signing back in is instant, and they are what the second button removes.
    text: (mailbox) => `Data for ${mailbox} stays on this device for 7 days, so signing back in is quick.`,
    mailboxFallback: 'this mailbox',
    keep: 'Log out',
    erase: 'Log out and erase data',
  },

  // ── The mailbox screen ─────────────────────────────────────────
  main: {
    title: 'Mailbox',
    googleFolders: 'Google Default Folders',
    userFolders: 'Your Folders',
    noGoogleFolders: 'None found.',
    noUserFolders: 'No folders yet — use + to make one.',
    countUnavailable: 'Count unavailable.',
    measuring: 'Measuring size',
    loading: 'Loading…',
  },

  notice: {
    title: 'Getting your mailbox ready',
    body:
      'Numbers fill in as they arrive — you can keep using the panel. MailBoy ' +
      'reads only the size, sender and date of each email.',
    progressLabel: 'Reading messages',
    done: (done, total) => `${done.toLocaleString()} of ${total.toLocaleString()}`,
  },

  footer: {
    counting: (done, total) => `Counting folders… ${done} of ${total}`,
    updated: (ago) => `Updated ${ago}`,
  },

  /**
   * The task card: what is happening to mail right now.
   *
   * Its own card rather than a line in the footer, because it can be joined by a
   * refresh saying something else entirely, and because a queue that is being
   * throttled needs somewhere to say so. The body is the one place the product
   * explains a limit that is not its own.
   *
   * **The wording is deliberately about "a while" rather than about minutes.**
   * Since trashing became one `batchModify` per thousand (2026-09-09) most jobs
   * are seconds and the card is a flash; what is left slow is a busy mailbox
   * being rate-limited, which is the case this text has to cover.
   */
  tasks: {
    title: {
      move: (target) => `Moving emails to “${target}”`,
      trash: 'Moving emails to Trash',
      restore: 'Restoring emails to your inbox',
      emptying: (name) => `Emptying “${name}”`,
      deleting: 'Deleting a folder',
      // The last stretch of a folder delete: every email is where it was asked
      // to go and only the folder itself is left. Named rather than left to look
      // like the moving it is not, because nothing here reports progress and the
      // bar has been sitting at its end since the last email moved.
      removing: (name) => `Removing “${name}”`,
      removingFolder: 'Removing the folder',
      working: 'Moving your emails',
    },
    body:
      'Google limits how fast email can be moved, so this can take a while. It ' +
      'keeps going until it finishes or you stop it, and you can close the panel or keep doing other actions.',
    // Said in place of the body above once the emails are done with: the wait
    // that is left is not about how fast mail can be moved.
    removingBody: 'All the emails have been moved. Tidying up the folder now.',
    queued: (n) => `${n.toLocaleString()} more waiting`,
    done: (done, total) => `${done.toLocaleString()} of ${total.toLocaleString()} emails`,
    progressLabel: 'Moving emails',
    stop: 'Stop',
    stopTitle: 'Stop and put the rest back',
    stopped: (n) => (n ? `Stopped. ${emails(n)} stayed where they were.` : 'Stopped.'),
    // A task that hit a wall stays queued and is tried again, so this says what
    // is going to happen rather than asking for anything.
    retrying: 'Could not finish that. MailBoy will try again shortly.',
    // Deliberately not an error, and it does not say "could not": nothing
    // failed and no email was refused. Google caps how fast mail can be moved,
    // and saying so is the difference between a wait somebody understands and
    // one that looks like a bug.
    throttled: 'Google is limiting how fast this can go. MailBoy will keep trying.',
  },

  // ── Making and removing folders ────────────────────────────────
  folders: {
    newFolder: 'New folder',
    newFolderIn: (parent) => `New folder in ${parent}`,
    addInside: (name) => `New folder inside ${name}`,
    removeFolder: (name) => `Delete ${name}`,
    create: 'Create',
    creating: 'Creating…',
    creatingNamed: (name) => `Creating “${name}”…`,
    created: (name) => `Created “${name}”.`,
    createFailed: (reason) => `Could not create the folder. ${reason}`,
  },

  deleteFolder: {
    // Split so the folder's name keeps the emphasis the markup gives it.
    titleLead: 'Delete',
    titleTail: '?',
    name: (name) => `“${name}”`,
    alsoDeletes: (folders, held) => `Also deletes ${folders}. ${held}`,
    oneChild: 'the folder inside it',
    manyChildren: (n) => `the ${n} folders inside it`,
    childrenHold: (n) => `Together they hold ${emails(n)}.`,
    childrenEmpty: 'Neither holds any email.',
    holds: (n) => `It holds ${emails(n)}.`,
    empty: 'This folder is empty.',
    rulesGoToo: (n, many) =>
      `${ruleCount(n)} send${n === 1 ? 's' : ''} mail ${many ? 'to these folders' : 'here'}. ` +
      `${n === 1 ? 'It goes' : 'They go'} too.`,
    trashBox: (n) => `Also move ${emails(n)} to Trash`,
    trashHint: 'They go to Trash, where Gmail keeps them for 30 days. You can close the panel while this runs.',
    inboxHint: 'These emails move to your inbox.',
    confirm: 'Delete folder',
    // No progress line of its own any more: a delete is one task in the queue,
    // and the task card reports every one of them the same way.
    done: (name) => `Deleted “${name}”.`,
    trashed: (n) => `${emails(n)} moved to Trash.`,
    restored: (n) => `${emails(n)} moved to your inbox.`,
    someStuck: (n) => `${n.toLocaleString()} could not be moved.`,
    stopped: (name) => `Stopped deleting “${name}”. The folder is still there.`,
  },

  // ── The breakdown ──────────────────────────────────────────────
  breakdown: {
    back: 'Back to folders',
    period: 'Period:',
    sortBy: 'Sort by:',
    search: 'Search senders',
    searchLabel: 'Search senders by name or email address',
    selectAll: 'Select every sender listed',
    selectOne: (who) => `Select ${who}`,
    unknownSender: 'Unknown sender',
    loading: 'Loading…',
    stillReading: 'Still reading — this list will grow.',
    nothingYet: 'Nothing here yet. This fills in as MailBoy reads your mailbox.',
    noneRead: 'These emails have not been read yet. Check back shortly.',
    nothingInPeriod: 'Nothing in this period.',
    noMatches: 'No senders match your search.',
    moreComing: (n) => `${n.toLocaleString()} more still being read, so these totals will grow.`,
    undated: (n) => `${n.toLocaleString()} have no date yet, so they are left out of this period.`,
  },

  periods: {
    all: 'All time',
    y1: 'Last 1 year',
    m6: 'Last 6 months',
    m3: 'Last 3 months',
    m1: 'Last 1 month',
  },

  sorts: {
    count: 'Email count',
    bytes: 'Size',
    rate: 'How often',
    address: 'Sender',
    date: 'Date',
  },

  // ── A sender's mail, and one message ───────────────────────────
  mails: {
    back: 'Back to senders',
    selectAll: 'Select every email listed',
    selectOne: (subject) => `Select ${subject}`,
    inFolder: (folder) => `In ${folder}`,
    loading: 'Loading…',
    nothingHere: 'Nothing from this sender in this period.',
    stillReading: 'Still reading this folder. Mail appears as it is read.',
    gone: 'No longer in Gmail',
    goneWhy: 'Moved or deleted since this list was built.',
    noSubject: '(no subject)',
    readFailed: (reason) => `Could not read those emails. ${reason}`,
    pages: 'Pages of emails',
    page: (n) => `Page ${n}`,
    previousPage: 'Previous page',
    nextPage: 'Next page',
  },

  message: {
    back: 'Back to emails',
    opening: 'Opening…',
    plainText: 'Shown as plain text. Images and styling are not loaded.',
    noText: 'No text in this email — it may be attachments only.',
    attachments: (n) => (n === 1 ? '1 attachment' : `${n} attachments`),
    unnamed: '(unnamed)',
    openFailed: (reason) => `Could not open this email. ${reason}`,
  },

  // ── Acting on mail ─────────────────────────────────────────────
  actions: {
    move: 'Move',
    block: 'Block',
    delete: 'Delete',
    restore: 'Restore',
    thisFolder: 'this folder',
    thisSender: 'this sender',
    yourInbox: 'your inbox',
    gone: 'Those emails are no longer in this folder.',
    foldersNotReady: 'MailBoy is still reading your folders.',
    fromSenders: (n) => (n === 1 ? 'one sender' : `${n.toLocaleString()} senders`),
    fromLine: (who, folder, period) => `From ${who} in ${folder}${period}.`,
    thisEmail: (folder) => `This email, in ${folder}.`,
    thisSubject: (subject, folder) => `“${subject}” in ${folder}.`,
    periodClause: (period) => `, ${period.toLowerCase()}`,
    scopeClause: (period) => ` · ${period}`,
    selectedSummary: (n, scope) => `${emails(n)}${scope}`,
    sendersSelected: (senders, n, scope) =>
      `${senders.toLocaleString()} selected · ${emails(n)}${scope}`,
    mailsSelected: (n, scope) => `${emails(n)} selected${scope}`,
  },

  trash: {
    verb: 'Move',
    where: 'to Trash',
    text: (line) => `${line} Gmail keeps trashed mail for 30 days. You can close the panel while this runs.`,
    confirm: 'Move to Trash',
    done: (n) => `${emails(n)} moved to Trash.`,
    someStuck: (n) => `${n.toLocaleString()} could not be moved.`,
  },

  restore: {
    verb: 'Restore',
    where: 'to your inbox',
    text: (line) => `${line} They keep any folders they were in.`,
    confirm: 'Restore to inbox',
    done: (n) => `${emails(n)} restored to your inbox.`,
  },

  move: {
    titleLead: 'Move',
    titleTail: 'to…',
    countFallback: 'these emails',
    text: (line) => `${line} They leave every folder they are in now, including your inbox.`,
    confirm: 'Move here',
    done: (n, name) => `${emails(n)} moved to “${name}”.`,
    failed: 'Could not finish moving those emails.',
  },

  // ── Rules ──────────────────────────────────────────────────────
  //
  // The wording every rule box shares. A rule is only ever about mail that has
  // not arrived, which is the one thing a user has to understand here — so it is
  // said once, plainly, and nothing else is explained.
  ruleBoxes: {
    sender: (to) => `Move future mail from this sender to ${to}`,
    senders: (n, to) => `Move future mail from these ${n.toLocaleString()} senders to ${to}`,
    domain: (domain, to) => `Move future mail from anyone at ${domain} to ${to}`,
    domains: (n, to) => `Move future mail from these ${n.toLocaleString()} domains to ${to}`,
    subject: (to) => `Move future mail with this subject to ${to}`,
    thisFolder: 'this folder',
    moveHint: 'This only affects mail that arrives from now on.',
    trashHint:
      'This only affects mail that arrives from now on. It goes straight to ' +
      'Trash, and Gmail deletes trashed mail for good after 30 days.',
    domainWarning: 'This includes senders you have never had mail from.',
    ceiling: (n, max) => `Adds ${n.toLocaleString()} rules. Gmail allows ${max.toLocaleString()}.`,
  },

  block: {
    titleLead: 'Block',
    titleTail: '?',
    who: (address) => `“${address}”`,
    manyWho: (n) => `${n.toLocaleString()} senders`,
    text:
      'Future mail from them goes straight to Trash. Nothing you already have ' +
      'moves. You can undo this under Rules.',
    skipped: (skipped, total) =>
      ` ${skipped.toLocaleString()} of the ${total.toLocaleString()} selected have no address, so they are not blocked.`,
    domainBox: (domain) => `Block everyone at ${domain}`,
    domainsBox: (n) => `Block everyone at these ${n.toLocaleString()} domains`,
    domainWarning: 'This includes senders you have never had mail from.',
    confirm: 'Block',
    noAddress: 'That sender has no address to block.',
    noAddresses: 'None of those senders has an address to block.',
    ruleFailed: 'The rule could not be added.',
  },

  rules: {
    tab: 'Rules',
    back: 'Back to mailbox',
    backToRules: 'Back to rules',
    home: 'Home',
    scope: 'Filters that send mail to a folder',
    selectAllDestinations: 'Select every destination listed',
    selectAllRules: 'Select every rule listed',
    selectBlockRow: 'Select the rules that block senders',
    selectDestination: (name) => `Select rules moving to ${name}`,
    selectRule: (what) => `Select ${what}`,
    moveTo: 'Move to ',
    // The row says it as one string; the drill-down heading splits the same
    // phrase around the Block glyph, which is a node rather than text.
    blocked: ' (Blocked mails)',
    blockedBeforeIcon: ' (',
    blockedAfterIcon: ' Blocked mails)',
    trash: 'Trash',
    orphan: 'a deleted folder',
    orphanWhy: 'This folder was deleted. Remove the rule to tidy up.',
    readingFolders: 'Reading your folders…',
    readingRules: 'Reading your rules…',
    readFailed: 'Could not read your rules. Try again in a moment.',
    // What the screen says when the permission was declined. Press Rules again
    // to be asked once more — the tab is the way back in, so this points at it
    // rather than carrying a second button of its own.
    needsPermission: 'MailBoy needs permission to see your rules. Press Rules to allow it.',
    // Rules are named after the folder they send mail to, and the folder list
    // comes from the mailbox — so the one grant that covers rules and not mail
    // can read every rule and name none of them.
    needsFolders: 'Rules are named after your folders, which MailBoy cannot see yet.',
    // Both sections carry a heading whether or not they have anything under
    // them: a heading that comes and goes makes the list look like a different
    // screen each visit.
    mine: {
      title: 'MailBoy filters',
      scope: 'Rules MailBoy manages',
      empty: 'None yet. Rules you create appear here.',
    },
    existing: {
      title: 'Existing filters',
      scope: 'Filters already on your account',
      empty: 'None. Filters you made in Gmail that send mail to a folder appear here.',
    },
    noneAtAll: 'No rules yet. Block a sender, or tick a box when you move mail.',
    fromSender: 'Mail from ',
    fromDomain: 'Mail from anyone at ',
    withSubject: 'Mail with subject ',
    destinations: (n, total) => `${n.toLocaleString()} destinations · ${total}`,
    // Deleting a rule changes nothing about mail that is already filed, which
    // is the one thing people expect it to do.
    deleteText:
      'Mail already filed stays where it is. New mail that would have matched ' +
      'lands in your inbox instead. A deleted rule cannot be brought back.',
    // Only ever shown for a filter MailBoy cannot rewrite — one of the account's
    // own, or one sending mail to several folders. Its own it takes apart around
    // the rule being removed, so nothing else goes.
    alsoGoing: (n) =>
      ` Gmail cannot remove part of a filter, so ${ruleCount(n)} sharing one ` +
      `with these ${n === 1 ? 'goes' : 'go'} as well.`,
    deleteOne: 'Delete rule',
    deleteMany: 'Delete rules',
    deleting: (count) => `Deleting ${count}…`,
    deleted: (count) => `${count} deleted.`,
    deletedSome: (gone, kept) => `${gone} deleted. ${kept} could not be.`,
    deleteFailed: 'Could not delete those rules.',
    added: (where) => `Rule added — future mail goes to ${where}.`,
    addedMany: (n, where) => `${n.toLocaleString()} rules added, all sending mail to ${where}.`,
    alreadyHad: (n) => `Already had ${n === 1 ? 'that rule' : 'those rules'}.`,
    full: (max) => `Gmail is full at ${max.toLocaleString()} filters. No rule added.`,
    someFailed: (n) => `${n.toLocaleString()} could not be added.`,
    addFailedDuringMove: 'The emails are moving, but the rule could not be added.',
  },

  // ── When something goes wrong ──────────────────────────────────
  //
  // Short titles that name the problem, and one line that says whether trying
  // again is worth it. Google's own wording carries project ids and console
  // URLs; none of that belongs on screen.
  errors: {
    offline: {
      title: 'You are offline',
      body: 'MailBoy needs a connection to read your mail.',
    },
    notConfigured: {
      title: 'Gmail access is switched off',
      body: 'MailBoy is not finished being set up, so Gmail is refusing. Reconnecting will not help.',
    },
    busy: {
      title: 'Gmail is busy',
      body: 'Too many requests at once. Wait a moment and try again.',
    },
    google: {
      title: 'Gmail is having trouble',
      body: 'The problem is on Google’s side. Try again shortly.',
    },
    refused: {
      title: 'Gmail turned down the request',
      body: 'Gmail refused to hand over your folders.',
    },
    unreachable: {
      title: 'Could not reach Gmail',
      body: 'The connection failed.',
    },
    unknown: {
      title: 'Something went wrong',
      body: 'MailBoy could not load your folders.',
    },
    retry: 'Try again',
    retrying: 'Trying…',
    logout: 'Log out',
    details: 'Technical details',
  },

  /** One line for the footer or an inline field, with the detail left to the log. */
  writeErrors: {
    expired: 'Signed out. Connect again.',
    missing: 'MailBoy does not have permission for that yet.',
    duplicate: 'That folder already exists.',
    badName: 'That name is not allowed.',
    refused: 'Gmail refused that change.',
    unreachable: 'Could not reach Gmail.',
    unknown: 'Something went wrong.',
  },

  /**
   * Asking for a permission that was turned down at sign-in.
   *
   * Each one says what the permission buys and nothing about scopes, tokens or
   * consent screens. The title is the thing somebody just tried to do, so the
   * dialog answers the click rather than announcing itself.
   */
  permission: {
    allow: 'Continue',
    later: 'Not now',
    granted: 'Permission granted.',
    declined: 'Google did not grant that permission.',
    failed: 'Could not ask for that permission.',
    /** Marks a control that will ask before it does anything. */
    needed: 'Needs permission',

    read: {
      title: 'MailBoy cannot see your mail',
      text:
        'Reading your mailbox is how MailBoy shows what is in it — folders, ' +
        'who fills them, and how much space they take. Nothing leaves this browser.',
      // The one screen that has nothing at all to show without it, so it gets
      // its own button rather than a marked-up control somebody has to find.
      action: 'Give access to my mail',
    },

    write: {
      title: 'MailBoy cannot change your mail',
      text:
        'Making and deleting folders, and moving mail between them, needs ' +
        'permission to change your mailbox. Anything deleted goes to Trash.',
      action: 'Allow changes',
    },

    rules: {
      title: 'MailBoy cannot manage your rules',
      text:
        'Rules send future mail to a folder, or straight to Trash, on their ' +
        'own. Making and removing them needs permission to change your Gmail settings.',
      action: 'Allow rules',
    },
  },
};

/** Follow a dotted key, e.g. `rules.mine.title`. */
export function copyAt(path) {
  const text = path.split('.').reduce((at, key) => at?.[key], COPY);
  // A missing key is a typo worth hearing about rather than a blank panel.
  if (typeof text !== 'string') console.warn(`[MailBoy] no copy for “${path}”`);
  return typeof text === 'string' ? text : '';
}

/**
 * Fill every node in the markup that carries a copy key.
 *
 * Static markup carries the key rather than the words, so the HTML stays
 * structure and this file stays the only place wording lives:
 *
 * - `data-copy` sets the text
 * - `data-copy-label` sets `aria-label`
 * - `data-copy-title` sets `title`
 * - `data-copy-placeholder` sets `placeholder`
 *
 * An element may carry more than one, which is what a button whose glyph needs
 * naming twice actually needs.
 */
export function applyStaticCopy(root = document) {
  for (const node of root.querySelectorAll('[data-copy]')) {
    node.textContent = copyAt(node.dataset.copy);
  }
  for (const node of root.querySelectorAll('[data-copy-label]')) {
    node.setAttribute('aria-label', copyAt(node.dataset.copyLabel));
  }
  for (const node of root.querySelectorAll('[data-copy-title]')) {
    node.title = copyAt(node.dataset.copyTitle);
  }
  for (const node of root.querySelectorAll('[data-copy-placeholder]')) {
    node.placeholder = copyAt(node.dataset.copyPlaceholder);
  }
}
