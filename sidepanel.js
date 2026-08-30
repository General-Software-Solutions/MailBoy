import {
  activeAccount,
  dropAccount,
  expiredAccounts,
  keyFor,
  releaseAccount,
  scopedKey,
  setActiveAccount,
} from './src/account.js';
import {
  AuthCancelled,
  AuthError,
  getToken,
  logout,
  rememberAccount,
} from './src/auth.js';
import { bulkJobKey, readBulkJob } from './src/bulk.js';
import {
  MAX_NAME,
  createFolder,
  deleteJobKey,
  readDeleteJob,
  validateFolderName,
} from './src/folders.js';
import { GmailError, getUserInfo, listLabels } from './src/gmail.js';
import { formatAgo, formatBytes, formatRate, formatTimeLeft } from './src/format.js';
import { buildGroups, buildTree, descendantsOf } from './src/labels.js';
import {
  breakdownOf,
  collect,
  forgetMembership,
  idsForSelection,
  patchMembership,
  resetMembership,
  restoreMembership,
} from './src/mailbox.js';
import { clearMessages, resetMessages } from './src/messages.js';

// Both live in the signed-in account's namespace — see src/account.js. Bare
// names, scoped at the point of use.
const CACHE_NAME = 'snapshot';
const IDENTITY_NAME = 'identity';

/**
 * How stale the numbers may get before an open re-reads them.
 *
 * Enumeration costs a few seconds of listing every time, and a mailbox does not
 * change enough between openings of a side panel to be worth paying that on
 * each one. "Refresh current data" is there for when it does.
 */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const el = {
  boot: document.getElementById('screen-boot'),
  welcome: document.getElementById('screen-welcome'),
  app: document.getElementById('app'),
  main: document.getElementById('screen-main'),
  connect: document.getElementById('btn-connect'),
  logout: document.getElementById('btn-logout'),
  logoutDialog: document.getElementById('logout-dialog'),
  logoutMailbox: document.getElementById('logout-mailbox'),
  deleteDialog: document.getElementById('delete-dialog'),
  deleteName: document.getElementById('delete-name'),
  deleteText: document.getElementById('delete-text'),
  deleteTrash: document.getElementById('delete-trash'),
  deleteTrashLabel: document.getElementById('delete-trash-label'),
  deleteHint: document.getElementById('delete-hint'),
  refresh: document.getElementById('btn-refresh'),
  refreshIcon: document.getElementById('refresh-icon'),
  stopIcon: document.getElementById('stop-icon'),
  refreshLabel: document.getElementById('refresh-label'),
  welcomeError: document.getElementById('welcome-error'),
  account: document.getElementById('account'),
  avatarPhoto: document.getElementById('avatar-photo'),
  avatarFallback: document.getElementById('avatar-fallback'),
  groups: document.getElementById('groups'),
  footer: document.getElementById('footer'),
  notice: document.getElementById('notice'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progress-bar'),
  progressDone: document.getElementById('progress-done'),
  progressLeft: document.getElementById('progress-left'),
  detail: document.getElementById('screen-detail'),
  back: document.getElementById('btn-back'),
  detailLabel: document.getElementById('detail-label'),
  detailTotal: document.getElementById('detail-total'),
  detailSpinner: document.getElementById('detail-spinner'),
  sortTrigger: document.getElementById('btn-sort'),
  sortLabel: document.getElementById('sort-label'),
  sortMenu: document.getElementById('sort-menu'),
  periodTrigger: document.getElementById('btn-period'),
  periodLabel: document.getElementById('period-label'),
  periodMenu: document.getElementById('period-menu'),
  senders: document.getElementById('senders'),
  senderHead: document.getElementById('sender-head'),
  senderRows: document.getElementById('sender-rows'),
  toolsFilters: document.getElementById('tools-filters'),
  toolsActions: document.getElementById('tools-actions'),
  selectionSummary: document.getElementById('selection-summary'),
  selectAll: document.getElementById('select-all'),
  move: document.getElementById('btn-move'),
  trash: document.getElementById('btn-trash'),
  restore: document.getElementById('btn-restore'),
  confirmDialog: document.getElementById('confirm-dialog'),
  confirmVerb: document.getElementById('confirm-verb'),
  confirmCount: document.getElementById('confirm-count'),
  confirmWhere: document.getElementById('confirm-where'),
  confirmText: document.getElementById('confirm-text'),
  confirmOk: document.getElementById('confirm-ok'),
  moveDialog: document.getElementById('move-dialog'),
  moveCount: document.getElementById('move-count'),
  moveText: document.getElementById('move-text'),
  moveList: document.getElementById('move-list'),
  moveCancel: document.getElementById('btn-move-cancel'),
};

let loading = false;

/** Raised by the stop button; cleared when the next load starts. */
let stopRequested = false;

/** Resolves the moment stop is pressed, so nothing has to wait out a reply. */
let stopSignal = null;

/** Survives the re-render a failed retry causes, so the panel doesn't collapse
 *  the details someone just opened to read. */
let detailsOpen = false;

// ── Screens ──────────────────────────────────────────────────────

function showWelcome(message) {
  el.boot.hidden = true;
  // Hiding the shell takes the identity bar with it, which is right: there is
  // nobody signed in to show.
  el.app.hidden = true;
  el.welcome.hidden = false;
  el.connect.disabled = false;
  setNotice(el.welcomeError, message);
}

function showMain() {
  el.boot.hidden = true;
  el.welcome.hidden = true;
  el.app.hidden = false;
  el.detail.hidden = true;
  el.main.hidden = false;
  setNotice(el.welcomeError, null);
}

function setNotice(node, message) {
  node.textContent = message ?? '';
  node.hidden = !message;
}

function setAccount(email) {
  el.account.textContent = email ?? '';
  // The address is truncated when the panel is narrow; keep it hoverable.
  el.account.title = email ?? '';
}

/** Swap in the Google profile photo, keeping the glyph if it cannot load. */
function setPhoto(url) {
  const useFallback = () => {
    el.avatarPhoto.hidden = true;
    el.avatarFallback.hidden = false;
  };

  if (!url) {
    el.avatarPhoto.removeAttribute('src');
    useFallback();
    return;
  }

  el.avatarPhoto.onload = () => {
    el.avatarPhoto.hidden = false;
    el.avatarFallback.hidden = true;
  };
  el.avatarPhoto.onerror = useFallback;
  el.avatarPhoto.src = url;
}

// ── Rendering ────────────────────────────────────────────────────

function skeleton() {
  return Object.assign(document.createElement('span'), { className: 'skeleton' });
}

// Material Symbols is bundled as a subset, so a new glyph would mean rebuilding
// it. One-offs are inline SVG instead — see README.
const ICON_ADD = '<path d="M8 3.5v9M3.5 8h9" />';
const ICON_BIN =
  '<path d="M3 4.4h10M6.4 4.4V2.9h3.2v1.5M4.4 4.4l.55 8.05a1 1 0 0 0 1 .95h4.1a1 1 0 0 0 1-.95L11.6 4.4" />';
const ICON_CLOSE = '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />';

/**
 * @param {string} action what the delegated handler on `#groups` should do
 * @param {string} path the glyph, as constant markup
 */
function actionButton(action, path, label, { danger = false } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? 'row-action row-action--danger' : 'row-action';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
  return button;
}

/**
 * @param {{editable?: boolean, counted?: boolean, removable?: boolean}}
 *   [options] `editable` is whether this row can be nested into and removed,
 *   true only for Your Folders: Gmail's user labels are a flat namespace that
 *   system labels are not part of, so there is nothing to create under Inbox
 *   and nothing to delete about Sent.
 *
 *   The other two are for the move picker, which shows the same folders as
 *   destinations: no figures, because a destination's own contents are beside
 *   the point, and no bin, because that dialog is for choosing somewhere to put
 *   mail rather than for managing folders.
 */
function renderRow(item, { editable = false, counted = true, removable = true } = {}) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.labelId = item.id;
  row.dataset.depth = String(item.depth ?? 0);
  // Not a <button>: the row is a grid of its own and the element would fight
  // that. Given the role, it has to answer the keyboard like one.
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  row.dataset.labelName = item.name;
  // Only the count can decide this, and it lands much later — so the intent
  // travels with the row and `paintRow` acts on it.
  if (item.hideWhenEmpty) row.dataset.hideEmpty = 'true';

  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = item.name;

  const num = document.createElement('span');
  num.className = 'row-num';
  num.append(skeleton());

  // Filled separately and much later: the count comes from listing ids, the
  // size from reading every one of those messages.
  const size = document.createElement('span');
  size.className = 'row-size';

  const count = document.createElement('span');
  count.className = 'row-count';
  count.append(num, size);

  row.append(name);
  if (counted) row.append(count);

  if (editable) {
    // The path, not the leaf: it is what a child's name has to be built from,
    // and what identifies the subtree a delete has to take with it.
    row.dataset.fullName = item.fullName ?? item.name;

    const actions = document.createElement('span');
    actions.className = 'row-actions';
    actions.append(actionButton('add', ICON_ADD, `New folder inside ${item.name}`));
    if (removable) {
      actions.append(actionButton('delete', ICON_BIN, `Delete ${item.name}`, { danger: true }));
    }
    row.append(actions);
  }

  return row;
}

function renderGroup(title, items, emptyText, options = {}) {
  const { editable = false } = options;
  const section = document.createElement('section');
  section.className = 'group';

  const heading = document.createElement('h2');
  heading.className = 'group-title';
  heading.textContent = title;

  const head = document.createElement('div');
  head.className = 'group-head';
  head.append(heading);

  // The heading's + is the only way to make a folder that sits at the top
  // level; every other one nests into the row it is on.
  if (editable) head.append(actionButton('add', ICON_ADD, 'New folder'));
  section.append(head);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  for (const item of items) section.append(renderRow(item, options));
  return section;
}

/** Rows a cached snapshot may still carry that the panel no longer shows. */
const RETIRED = new Set(['SENT', 'DRAFT']);

/**
 * A snapshot cached before the two groups were merged still carries the old
 * three, so read either shape rather than rendering a blank panel once.
 *
 * Retired rows are filtered here rather than left to the next load, because the
 * 24-hour freshness gate means most opens never run one — Sent and Drafts would
 * otherwise sit on screen for a day after they stopped being part of the
 * product, showing counts nothing will ever refresh.
 */
function defaultsOf(groups) {
  const rows = groups.defaults ?? [...(groups.mailboxes ?? []), ...(groups.categories ?? [])];
  return rows.filter((row) => !RETIRED.has(row.id));
}

/**
 * The folder list currently on screen.
 *
 * Held because creating and deleting a folder both patch this list and
 * re-render rather than re-reading the mailbox — a new folder is empty and a
 * deleted one is gone, so neither needs Gmail asked about it.
 *
 * @type {{defaults?: object[], user?: object[]} | null}
 */
let currentGroups = null;

function renderSkeleton(groups) {
  currentGroups = groups;
  el.groups.replaceChildren(
    renderGroup('Google Default Folders', defaultsOf(groups), 'None found.'),
    renderGroup('Your Folders', groups.user ?? [], 'No folders of your own yet.', {
      editable: true,
    })
  );

  // A re-render replaces the list wholesale, taking any open editor's DOM with
  // it. Letting the reference go is what stops a create from writing into — and
  // reporting errors against — a detached field nobody can see.
  if (editor && !editor.box.isConnected) editor = null;

  markWorkingRows();
}

/**
 * Everything currently on screen, kept so a re-render can restore it. Rebuilding
 * the rows for a refresh would otherwise drop numbers we already have back to
 * placeholders for as long as the refresh takes.
 */
let painted = {};

/**
 * Rows whose size has been worked out at least once.
 *
 * The spinner means "no figure has ever existed for this row", not "a pass is
 * running" — a refresh over known numbers should refine them in place rather
 * than blanking the panel back to placeholders.
 */
const sized = new Set();

function paintRecords(records) {
  for (const [labelId, incoming] of Object.entries(records)) {
    const previous = painted[labelId];

    // A fresh count arrives before its size has been recomputed. Where the
    // count is unchanged the old size still describes the same messages, so
    // keep showing it rather than flashing a spinner over a number we have.
    const record =
      incoming && incoming.bytes === undefined && previous?.bytes !== undefined
        ? { ...incoming, bytes: previous.bytes }
        : incoming;

    // Once a row has been fully worked out, it never goes back to a spinner: a
    // later pass has a real number to show while it refines it.
    if (record && record.bytes !== undefined && ((record.pending ?? 0) === 0 || record.settled)) {
      sized.add(labelId);
    }

    painted[labelId] = record;
    paintRow(labelId, record);
  }
}

/** Re-apply what was on screen after the rows have been rebuilt. */
function repaint() {
  for (const [labelId, record] of Object.entries(painted)) paintRow(labelId, record);
}

/** Shown beside a count while that row's messages are still being read. */
function spinner() {
  const el = document.createElement('span');
  el.className = 'row-spinner';
  el.setAttribute('aria-label', 'Measuring size');
  return el;
}

/**
 * @param {string} labelId
 * @param {{count: number, bytes?: number, pending?: number,
 *   settled?: boolean} | null} record
 */
function paintRow(labelId, record) {
  const row = el.groups.querySelector(`[data-label-id="${CSS.escape(labelId)}"]`);
  if (!row) return;

  const cell = row.querySelector('.row-count');
  const num = row.querySelector('.row-num');
  const size = row.querySelector('.row-size');

  // An empty inbox category is dropped rather than shown as 0 — Gmail returns
  // all five whether or not the mailbox uses tabs. Only a real count decides
  // it: an unknown or unavailable one leaves the row where it is, and a later
  // pass finding messages brings it back.
  if (row.dataset.hideEmpty === 'true') row.hidden = record?.count === 0;

  if (!record) {
    num.textContent = '—';
    size.replaceChildren();
    row.title = 'Count unavailable.';
    return;
  }

  const count = record.count.toLocaleString();
  num.textContent = count;
  cell.classList.toggle('row-count--zero', record.count === 0);

  // A running total that creeps upward is noise, not information, so a row
  // spins until its own messages have all been read and then shows one figure.
  // "Settled" is the load reporting it has stopped, which is what separates
  // still-waiting from could-not-be-measured.
  const short = (record.pending ?? 0) > 0;
  const measuring = short && !record.settled;
  const figure = record.bytes !== undefined;

  if (record.count === 0) {
    size.replaceChildren();
  } else if (figure && (sized.has(labelId) || !measuring)) {
    size.textContent = `(${formatBytes(record.bytes)})`;
  } else if (measuring || !record.settled) {
    // Only ever the first time: after this the row keeps its number.
    size.replaceChildren(spinner());
  } else {
    size.replaceChildren();
  }
  size.classList.toggle('row-size--partial', figure && short);

  const title = [];
  if (record.count > 0) {
    if (measuring) {
      title.push('measuring size…');
    } else if (record.bytes !== undefined) {
      // Gmail reports a per-message estimate, so the total is an estimate too.
      const bytes = formatBytes(record.bytes);
      title.push(
        record.pending
          ? `at least ${bytes} · ${record.pending.toLocaleString()} unmeasured`
          : `about ${bytes}`
      );
    }
  }
  row.title = title.join(' · ');
}

/** @type {number | null} when the numbers on screen were gathered */
let lastLoaded = null;

/** A load is running. Counts arrive in stages, and the footer must not claim
 *  the numbers are current while later stages are still filling in. */
let busy = false;

/**
 * @type {{phase: 'counting' | 'measuring', done: number, total: number,
 *   startedAt: number, startDone: number} | null}
 */
let progress = null;

/** Keeps the estimate honest between batches — a stall should show up as time
 *  remaining growing, not as a number frozen mid-run. */
let ticker = null;

function setBusy(running) {
  busy = running;

  // The one button does both jobs: it is how you start a refresh and the only
  // way to call one off, so it is never disabled.
  el.refreshIcon.hidden = running;
  el.stopIcon.hidden = !running;
  el.refreshLabel.textContent = running ? 'Stop refreshing' : 'Refresh current data';
  el.detailSpinner.hidden = !running;
  paintProgress();
  setFooter();
  // The breakdown grows a trailing spinner while a pass runs, and loses it
  // when one ends.
  if (openLabel) renderBreakdown();
}

/**
 * The card is up for the whole load. During enumeration it explains what is
 * coming — nothing is openable then either, since the id sets a breakdown
 * needs are still being rebuilt — and its bar paces until the size pass has a
 * ratio to report. Counting keeps its own line in the footer; the two phases
 * never overlap, because measuring works through a queue that is not built
 * until every label has been listed.
 */
function paintProgress() {
  const measuring = progress?.phase === 'measuring';

  el.notice.hidden = !busy;
  el.progress.classList.toggle('progress--indeterminate', !measuring);

  if (!measuring) {
    el.progressBar.style.width = '';
    el.progress.removeAttribute('aria-valuenow');
    el.progressDone.textContent = '';
    el.progressLeft.textContent = '';
    return;
  }

  const { done, total } = progress;
  const percent = Math.round((done / total) * 100);
  el.progressBar.style.width = `${percent}%`;
  el.progress.setAttribute('aria-valuenow', String(percent));

  el.progressDone.textContent = `${done.toLocaleString()} of ${total.toLocaleString()}`;
  const seconds = secondsRemaining(progress);
  el.progressLeft.textContent = seconds === null ? '' : formatTimeLeft(seconds);
}

/**
 * Seconds left at the rate this run has actually achieved, or null while that
 * is still guesswork. Measured rather than predicted: the quota ceiling puts a
 * floor near 50 messages a second, but latency, retries and how much was
 * already cached all move it.
 */
function secondsRemaining({ done, total, startedAt, startDone }) {
  const elapsed = (Date.now() - startedAt) / 1000;
  // Opening the panel ten minutes into a background pass hands us a large
  // `done` we did not watch accumulate. Rate has to come from the window this
  // panel has actually observed, or the estimate is wildly optimistic.
  const watched = done - startDone;
  if (watched < 200 || elapsed < 5) return null; // too early to be honest
  const rate = watched / elapsed;
  return rate > 0 ? (total - done) / rate : null;
}

/**
 * A folder being created or removed. It owns the status line for as long as it
 * runs — it is the thing the user just asked for, and the load status it covers
 * is still there afterwards.
 */
let actionStatus = null;

/** The outcome of one, shown briefly and then given back. */
let flashText = null;
let flashTimer = null;

const FLASH_MS = 7000;

function setAction(text) {
  actionStatus = text;
  // An outcome supersedes whatever was being reported on the way to it.
  if (text) clearFlash();
  setFooter();
}

function clearFlash() {
  flashText = null;
  clearTimeout(flashTimer);
  flashTimer = null;
}

function flash(text) {
  clearFlash();
  flashText = text;
  flashTimer = setTimeout(() => {
    flashText = null;
    setFooter();
  }, FLASH_MS);
  setFooter();
}

function setFooter(timestamp = lastLoaded) {
  lastLoaded = timestamp;

  // Both outrank the load: a refresh runs on its own schedule and says the same
  // thing a second later, where these are answers to something just asked for.
  if (actionStatus) {
    el.footer.textContent = actionStatus;
    return;
  }
  if (flashText) {
    el.footer.textContent = flashText;
    return;
  }

  // Counting, warm or cold. Once it is done the counts on screen are final,
  // so the timestamp is honest even while sizes are still being read.
  if (progress?.phase === 'counting') {
    el.footer.textContent = `Counting folders… ${progress.done} of ${progress.total}`;
    return;
  }

  if (!timestamp) {
    el.footer.textContent = busy ? 'Loading…' : '';
    return;
  }

  el.footer.textContent = `Updated ${formatAgo(Date.now() - timestamp)}`;
}

/**
 * Sizes cost one Gmail read per message, so a first run over a large mailbox
 * takes minutes. Saying how many and how long beats an unexplained wait.
 */
function tick() {
  paintProgress();
  setFooter();
}

function setProgress(phase, done, total) {
  if (phase && total > 0) {
    // `total` is fixed within a phase, so a matching one means the same run
    // continuing and the clock it is timed against must not restart.
    progress =
      progress?.phase === phase && progress?.total === total
        ? { ...progress, done }
        : { phase, done, total, startedAt: Date.now(), startDone: done };
    ticker ??= setInterval(tick, 1000);
  } else {
    progress = null;
    clearInterval(ticker);
    ticker = null;
  }
  paintProgress();
  setFooter();
}

// ── Breakdown ────────────────────────────────────────────────────

/** Messages a day, across the span this sender is actually known over. */
function perDay(sender) {
  if (sender.dated < 2) return 0;
  return (sender.dated - 1) / Math.max(sender.last - sender.first, 1);
}

/**
 * Each column knows how to read itself and which way round it is useful to
 * start: biggest-first for the figures, A-Z for the address.
 */
const SORTS = {
  count: { label: 'Email count', dir: 'desc', of: (s) => s.count },
  bytes: { label: 'Size', dir: 'desc', of: (s) => s.bytes },
  rate: { label: 'How often', dir: 'desc', of: (s) => perDay(s) },
  address: { label: 'Sender', dir: 'asc', of: (s) => s.address || '' },
};

function comparator(key, direction) {
  const { of } = SORTS[key];
  const sign = direction === 'asc' ? 1 : -1;

  return (a, b) => {
    const left = of(a);
    const right = of(b);
    const order =
      typeof left === 'string'
        ? left.localeCompare(right, undefined, { sensitivity: 'base' })
        : left - right;
    return sign * order;
  };
}

const DAY_MS = 86_400_000;

/**
 * How far back to look. Kept as a span rather than a fixed cutoff so a panel
 * left open overnight still means "the last month" tomorrow.
 */
const PERIODS = {
  all: { label: 'All time', days: 0 },
  y1: { label: 'Last 1 year', days: 365 },
  m6: { label: 'Last 6 months', days: 183 },
  m3: { label: 'Last 3 months', days: 91 },
  m1: { label: 'Last 1 month', days: 30 },
};

/** Which label is open, how its senders are ordered, and over what span. */
let openLabel = null;
let sortKey = 'count';
let sortDir = SORTS.count.dir;
let periodKey = 'all';

/** @returns {number} the first day in scope, or 0 for everything */
function sinceDay() {
  const { days } = PERIODS[periodKey];
  return days ? Math.round(Date.now() / DAY_MS) - days : 0;
}

/**
 * Resolves once the ids behind each row are in memory. An open that skipped
 * enumeration restores them from storage in the background, and a click can
 * easily beat that.
 */
let membershipReady = Promise.resolve();

// ── Picking senders ──────────────────────────────────────────────
//
// A tick is a promise about a set of messages, and the whole of it rests on one
// thing: `selected` holds the same grouping keys `bySender` bucketed on, so the
// number a row shows, the number the summary adds up, and the ids an action
// resolves to are all the same set. `keyOf` in messages.js is the other half of
// that — the two must not drift.

/** Matches `keyOf` in src/messages.js. */
const senderKey = (sender) => sender.address || sender.name || '';

/** Grouping keys ticked in the open breakdown. */
let selected = new Set();

/**
 * The senders the last render actually put on screen.
 *
 * Select-all covers exactly these, and so does the summary — a tick on a sender
 * the current period no longer lists cannot be acted on, so it must not be
 * counted either.
 *
 * @type {object[]}
 */
let listedSenders = [];

function clearSelection() {
  selected = new Set();
  paintSelection();
}

/**
 * What is ticked, as the list currently on screen sees it. Everything a dialog
 * quotes and everything a job acts on comes from here, so there is one answer
 * rather than three that can disagree.
 */
function selectionFacts() {
  const rows = listedSenders.filter((sender) => selected.has(senderKey(sender)));
  return {
    keys: rows.map(senderKey),
    senders: rows.length,
    messages: rows.reduce((sum, sender) => sum + sender.count, 0),
    bytes: rows.reduce((sum, sender) => sum + sender.bytes, 0),
  };
}

/**
 * Swap the tools row over, and say what the buttons beside it would act on.
 *
 * The period picker is off screen while a selection is live, so the summary
 * carries the period instead — the actions are scoped by it, and a figure that
 * did not say so would be quoting a number nobody can see the basis for.
 */
function paintSelection() {
  const { senders, messages } = selectionFacts();
  const picked = senders > 0;

  el.toolsFilters.hidden = picked;
  el.toolsActions.hidden = !picked;

  el.selectAll.checked = picked && senders === listedSenders.length;
  el.selectAll.indeterminate = picked && senders < listedSenders.length;

  if (!picked) return;

  // Trash offers one thing, and it is the way back. There is nowhere to move
  // mail that is already deleted, and a "delete" there could only mean
  // permanently — which needs `https://mail.google.com/`, the widest scope
  // Google publishes, and is not something MailBoy will ever ask for.
  const inTrash = openLabel?.id === 'TRASH';
  el.restore.hidden = !inTrash;
  el.move.hidden = inTrash;
  el.trash.hidden = inTrash;

  // A picker left open goes off screen with its trigger, and would come back
  // still open when the ticks are cleared.
  closeMenus();

  const scope = periodKey === 'all' ? '' : ` · ${PERIODS[periodKey].label}`;
  el.selectionSummary.textContent = `${emails(messages)}${scope}`;
  el.selectionSummary.title = `${senders.toLocaleString()} selected · ${emails(messages)}${scope}`;
}

/**
 * Paint the ticks from `selected` rather than trusting the boxes to have kept
 * their own state: a measuring pass rebuilds these rows every second or so.
 */
function syncSelection() {
  for (const row of el.senderRows.querySelectorAll('.sender')) {
    const on = selected.has(row.dataset.sender);
    row.classList.toggle('sender--picked', on);
    const box = row.querySelector('input[type="checkbox"]');
    if (box && box.checked !== on) box.checked = on;
  }
  paintSelection();
}

function toggleSender(key, on) {
  if (key === undefined) return;
  if (on) selected.add(key);
  else selected.delete(key);
  syncSelection();
}

function figure(text) {
  const cell = document.createElement('span');
  cell.className = 'sender-figure';
  cell.textContent = text;
  return cell;
}

function renderSender(sender) {
  const row = document.createElement('div');
  row.className = 'sender';

  const key = senderKey(sender);
  const picked = selected.has(key);
  row.dataset.sender = key;
  row.classList.toggle('sender--picked', picked);

  // The label is what makes the 15px box a slightly larger target; the row
  // itself is the real one, wired below.
  const tick = document.createElement('label');
  tick.className = 'sender-tick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = picked;
  box.setAttribute('aria-label', `Select ${sender.address || sender.name || 'unknown sender'}`);
  tick.append(box);

  const who = document.createElement('span');
  who.className = 'sender-who';

  // The address identifies a sender; the display name is whatever they chose
  // to call themselves that day, and the same sender varies it constantly.
  const address = document.createElement('span');
  address.className = 'sender-id';
  address.textContent = sender.address || 'Unknown sender';
  who.append(address);

  const rate = formatRate(sender.dated, sender.last - sender.first);

  if (sender.name) {
    const display = document.createElement('span');
    display.className = 'sender-display';
    display.textContent = sender.name;
    who.append(display);
  }

  row.append(
    tick,
    who,
    figure(sender.count.toLocaleString()),
    figure(formatBytes(sender.bytes)),
    // An em dash rather than a blank: the column has a value, it is just not
    // knowable from one message.
    figure(rate || '—')
  );
  const parts = [sender.name, sender.address].filter(Boolean);
  parts.push(`${sender.count.toLocaleString()} messages`, formatBytes(sender.bytes));
  if (rate) parts.push(rate);
  row.title = parts.join(' · ') || 'Unknown sender';
  return row;
}

function stillReading() {
  const row = document.createElement('div');
  row.className = 'sender-more';
  row.append(spinner(), Object.assign(document.createElement('span'), {
    textContent: 'Still reading — this list will grow.',
  }));
  return row;
}

function emptyNote(text) {
  const note = document.createElement('p');
  note.className = 'empty';
  note.textContent = text;
  return note;
}

function renderBreakdown() {
  if (!openLabel) return;

  const filtered = periodKey !== 'all';
  const { senders, total, cached, matched, undated, bytes } = breakdownOf(
    openLabel.id,
    sinceDay()
  );

  // Unfiltered, the label's own count is the truth and matches the row behind
  // this screen. Filtered, only the messages actually in scope can be counted.
  const shown = filtered ? matched : total;
  el.detailTotal.textContent = total ? `(${shown.toLocaleString()} · ${formatBytes(bytes)})` : '';

  if (!senders.length) {
    el.senderHead.hidden = true;
    listedSenders = [];
    paintSelection();
    const note = emptyNote(
      !total
        ? "Nothing here yet. If MailBoy is still going through your mailbox, this fills in once it's done."
        : !cached
          ? 'None of these messages have been read yet. They are measured in the background — check back shortly.'
          : 'Nothing in this period.'
    );
    el.senderRows.replaceChildren(...(busy ? [stillReading(), note] : [note]));
    return;
  }

  el.senderHead.hidden = false;

  const sorted = [...senders].sort(comparator(sortKey, sortDir));
  // Before the rows are built: `renderSender` reads the tick state, and
  // `paintSelection` needs to know what is on screen to add it up.
  listedSenders = sorted;
  const nodes = sorted.map(renderSender);
  paintSelection();

  // Sizes land every second or so while measuring, and rebuilding the list
  // resets its scroll — which would yank the page out from under anyone
  // reading it.
  const scroll = el.senders.scrollTop;

  // A short breakdown is not a wrong one, but it should say so.
  if (cached < total) {
    nodes.push(
      emptyNote(
        `${(total - cached).toLocaleString()} more not measured yet, so these totals will grow.`
      )
    );
  }

  // Every message has a date; these are the ones still carrying cache entries
  // written before dates were captured. Purely a migration artifact, and it
  // reaches zero once the backfill has been through — but until then, leaving
  // them out silently would make a period look emptier than it is.
  if (undated) {
    nodes.push(
      emptyNote(
        `${undated.toLocaleString()} not dated yet, so they are left out of this period. ` +
          'They join it once the current pass reaches them.'
      )
    );
  }

  // First, not last: the list is as long as the mailbox has senders, so a
  // trailing notice is below the fold and nobody scrolls to find out the list
  // is still growing. Under the sticky header it is the first thing read.
  if (busy) nodes.unshift(stillReading());

  el.senderRows.replaceChildren(...nodes);
  el.senders.scrollTop = scroll;
}

async function openBreakdown(labelId, labelName) {
  openLabel = { id: labelId, name: labelName };

  el.detailLabel.textContent = labelName;
  el.detailTotal.textContent = '';
  el.senderHead.hidden = true;
  // Ticks belong to the folder they were made in — they name senders, but what
  // they stand for is that folder's messages.
  listedSenders = [];
  clearSelection();
  el.senderRows.replaceChildren(emptyNote('Working it out…'));

  el.main.hidden = true;
  el.detail.hidden = false;
  el.back.focus();

  await membershipReady;
  // Guard against a fast Back followed by a different label.
  if (openLabel?.id === labelId) renderBreakdown();
}

function closeBreakdown() {
  const previous = openLabel?.id;
  openLabel = null;
  listedSenders = [];
  clearSelection();
  closeMenus();
  showMain();

  const row = previous && el.groups.querySelector(`[data-label-id="${CSS.escape(previous)}"]`);
  if (row) row.focus();
}

/**
 * @param {string} key which column to order by
 * @param {'asc' | 'desc'} [direction] defaults to whichever way round that
 *   column is useful to start
 */
function setSort(key, direction = SORTS[key].dir) {
  sortKey = key;
  sortDir = direction;
  el.sortLabel.textContent = SORTS[key].label;

  for (const option of el.sortMenu.querySelectorAll('.picker-option')) {
    option.setAttribute('aria-checked', String(option.dataset.sort === key));
  }

  // The column heads and the menu are two ways into the same setting, so both
  // have to show it. aria-sort doubles as the hook the arrow is drawn from.
  for (const head of el.senderHead.querySelectorAll('.col-head')) {
    if (head.dataset.sort === key) {
      head.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
    } else {
      head.removeAttribute('aria-sort');
    }
  }

  renderBreakdown();
}

function setPeriod(key) {
  periodKey = key;
  // Everything a selection stands for is scoped by the period, so a tick made
  // under one cannot silently carry into another — the same senders would mean
  // a different set of messages.
  clearSelection();
  el.periodLabel.textContent = PERIODS[key].label;
  for (const option of el.periodMenu.querySelectorAll('.picker-option')) {
    option.setAttribute('aria-checked', String(option.dataset.period === key));
  }
  renderBreakdown();
}

/** Both pickers behave identically, so they are wired the same way. */
function closeMenus(except) {
  for (const [trigger, menu] of [
    [el.sortTrigger, el.sortMenu],
    [el.periodTrigger, el.periodMenu],
  ]) {
    if (menu === except) continue;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
}

function wirePicker(trigger, menu, attribute, choose) {
  trigger.addEventListener('click', (event) => {
    event.stopPropagation(); // Otherwise the document handler shuts it again.
    const opening = menu.hidden;
    // Only one at a time, or they overlap each other.
    closeMenus();
    menu.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
  });

  menu.addEventListener('click', (event) => {
    const option = event.target.closest('.picker-option');
    if (!option) return;
    choose(option.dataset[attribute]);
    closeMenus();
    trigger.focus();
  });
}

function anyMenuOpen() {
  return !el.sortMenu.hidden || !el.periodMenu.hidden;
}

// ── Creating and removing folders ────────────────────────────────
//
// Both are confined to Your Folders. Gmail's user labels are a flat namespace
// that system labels are not part of, so there is nothing to create under Inbox
// and nothing to delete about Sent — and offering the controls there would
// promise something the API refuses.
//
// Creating is one call and lands instantly. Deleting is the asymmetric half:
// `labels.delete` removes no mail at all, so what happens to the mail is
// separate work that has to run *before* the label goes, and moving it to Trash
// costs 5 quota units a message. That is why the delete is handed to the
// service worker and only its outcome comes back here.

const leafOf = (path) => path.split('/').pop();

const emails = (n) => `${n.toLocaleString()} email${n === 1 ? '' : 's'}`;

/** The user's folders as the last render knew them. */
const folderRows = () => currentGroups?.user ?? [];

const rowFor = (labelId) => el.groups.querySelector(`[data-label-id="${CSS.escape(labelId)}"]`);

/**
 * Write the patched folder list back to the cache.
 *
 * `generatedAt` is carried over rather than restamped: adding or removing a
 * folder says nothing about how current the *counts* are, and restamping would
 * push the next real load up to a day away. Nothing is written when there is no
 * snapshot yet — the load that is coming will write a complete one.
 */
async function saveSnapshot() {
  try {
    const key = await scopedKey(CACHE_NAME);
    if (!key || !currentGroups) return;

    const { [key]: cached } = await chrome.storage.local.get(key);
    if (!cached) return;

    await chrome.storage.local.set({ [key]: { ...cached, groups: currentGroups, counts: painted } });
  } catch (err) {
    console.warn('[MailBoy] could not update the cached folder list:', err);
  }
}

/** Short enough for the status line or the editor, with the detail in the log. */
function describeWriteError(err) {
  if (err instanceof AuthError) return 'Gmail access expired — reconnect and try again.';

  if (err instanceof GmailError) {
    if (err.status === 409) return 'Gmail already has a folder with that name.';
    if (err.status === 400) return 'Gmail would not accept that name.';
    if (err.status === 403) return 'Gmail turned down the change.';
  }

  // fetch() rejects with a TypeError when it never reached the server.
  if (err instanceof TypeError) return "Couldn't reach Gmail.";

  return 'Something went wrong.';
}

// ── The inline editor ────────────────────────────────────────────

/** The open editor, if any — only ever one at a time. */
let editor = null;

function closeEditor() {
  editor?.box.remove();
  editor = null;
}

function showEditorError(message) {
  if (!editor) return;
  editor.error.textContent = message;
  editor.error.hidden = false;
}

function setEditorBusy(working) {
  if (!editor) return;
  editor.working = working;
  editor.input.disabled = working;
  editor.create.disabled = working;
  editor.create.textContent = working ? 'Creating…' : 'Create';
}

/**
 * Open the name field in the place the folder is going to appear — under its
 * parent, at the child indent. The position is the explanation, so nothing has
 * to say in words which folder this will end up inside.
 *
 * @param {{parent?: string, depth?: number, after?: Element, into?: Element}} where
 *   `after` puts it under a row; `into` puts it at the top of a section, which
 *   is what the heading's + wants.
 */
function openEditor({ parent = '', depth = 0, after = null, into = null }) {
  closeEditor();

  const box = document.createElement('div');
  box.className = 'folder-new';

  const line = document.createElement('div');
  line.className = 'folder-editor';
  line.dataset.depth = String(Math.min(depth, 3));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-input';
  // The ceiling is on the whole path, so a deeply nested folder has less of it
  // left to spend on its own name.
  input.maxLength = Math.max(1, MAX_NAME - (parent ? parent.length + 1 : 0));
  input.placeholder = parent ? `New folder in ${leafOf(parent)}` : 'New folder';
  input.setAttribute('aria-label', input.placeholder);
  input.autocomplete = 'off';
  input.spellcheck = false;

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'btn btn--primary btn--sm';
  create.textContent = 'Create';

  const cancel = actionButton('cancel', ICON_CLOSE, 'Cancel');

  const error = document.createElement('p');
  error.className = 'folder-error';
  error.hidden = true;

  line.append(input, create, cancel);
  box.append(line, error);

  if (after) after.after(box);
  else if (into) into.querySelector('.group-head').after(box);
  else return;

  editor = { box, input, create, error, parent, working: false };

  create.addEventListener('click', () => void submitCreate());
  cancel.addEventListener('click', closeEditor);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitCreate();
    } else if (event.key === 'Escape') {
      // Stopped here so the same press does not also close the breakdown or
      // whatever else the document handler would reach for.
      event.preventDefault();
      event.stopPropagation();
      closeEditor();
    }
  });

  // Typing is the fix for whatever the last attempt was told off for.
  input.addEventListener('input', () => {
    editor.error.hidden = true;
  });

  input.focus();
}

async function submitCreate() {
  if (!editor || editor.working) return;

  const existing = folderRows().map((row) => row.fullName ?? row.name);
  const check = validateFolderName(editor.input.value, { parent: editor.parent, existing });

  if (check.error) {
    showEditorError(check.error);
    editor.input.focus();
    return;
  }

  setEditorBusy(true);
  setAction(`Creating “${leafOf(check.name)}”…`);

  try {
    const label = await createFolder(check.name);
    closeEditor();
    setAction(null);
    addFolder(label);
    flash(`Created “${leafOf(label.name)}”.`);
  } catch (err) {
    console.error('[MailBoy] could not create folder:', err);
    setAction(null);

    // The editor is gone if a refresh re-rendered the list underneath it, in
    // which case the status line is the only place left to say so.
    const reason = describeWriteError(err);
    if (editor) {
      setEditorBusy(false);
      showEditorError(reason);
      editor.input.focus();
    }
    flash(`Couldn't create the folder. ${reason}`);
  }
}

/**
 * Put a new folder on screen without re-reading anything.
 *
 * It cannot hold any mail, so its count is known to be 0 rather than unknown —
 * which is why it gets a settled record instead of a spinner that would never
 * resolve. The tree is rebuilt rather than spliced because a new "Work/Clients"
 * turns an existing top-level "Work/Clients/Acme" into a child of it.
 */
function addFolder(label) {
  if (!currentGroups) {
    void load({ force: true });
    return;
  }

  const raw = folderRows().map((row) => ({ id: row.id, name: row.fullName ?? row.name }));
  raw.push({ id: label.id, name: label.name });

  painted[label.id] = { count: 0, bytes: 0, pending: 0, settled: true };
  sized.add(label.id);

  renderSkeleton({ ...currentGroups, user: buildTree(raw) });
  repaint();

  patchMembership({ added: [label.id] });
  void saveSnapshot();

  // The move dialog is a second view of the same list, and a folder made from
  // inside it is almost certainly where the mail is about to go — so it is
  // rebuilt too, and it is the copy that takes focus.
  if (el.moveDialog.open) {
    renderMoveList();
    moveRowFor(label.id)?.focus();
    return;
  }

  rowFor(label.id)?.focus();
}

// ── Deleting ─────────────────────────────────────────────────────

/** The delete in flight, if any. @type {{ids: string[], name: string} | null} */
let deleteState = null;

/**
 * Dim the folders a delete is working through.
 *
 * They keep their numbers and stay on screen until the job actually finishes —
 * removing a row at the click would claim a completion that a ten-minute Trash
 * pass has not reached. Re-applied after every render, since the rows are
 * rebuilt from scratch each time.
 */
function markWorkingRows() {
  for (const row of el.groups.querySelectorAll('.row--working')) {
    row.classList.remove('row--working');
  }
  for (const id of deleteState?.ids ?? []) rowFor(id)?.classList.add('row--working');
}

/** The hint tracks the box, because the two outcomes are genuinely different. */
function paintDeleteHint() {
  el.deleteHint.textContent = el.deleteTrash.checked
    ? 'They go to Trash, where Gmail keeps them for 30 days. On a large folder this takes a while — MailBoy carries on in the background, so you can close the panel.'
    : 'These emails will be appearing in your inbox (Primary, Social, Promotions, Updates, Forums).';
}

/**
 * @returns {Promise<{trash: boolean} | null>} null if it was called off
 */
function askDelete(target, children, messages) {
  // showModal throws on an already-open dialog, which a second click would be.
  if (el.deleteDialog.open) return Promise.resolve(null);

  el.deleteName.textContent = `“${target.name}”`;

  const inside = children.length === 1 ? 'the folder inside it' : `the ${children.length} folders inside it`;
  const holds = messages ? `Together they hold ${emails(messages)}.` : 'Neither holds any email.';

  el.deleteText.textContent = children.length
    ? `This also deletes ${inside}. ${holds}`
    : messages
      ? `It holds ${emails(messages)}.`
      : 'It holds no email.';

  // Nothing to move means there is no choice to offer.
  const movable = messages > 0;
  el.deleteTrash.closest('.checkbox').hidden = !movable;
  el.deleteHint.hidden = !movable;
  el.deleteTrashLabel.textContent = `Also move ${emails(messages)} to Trash`;

  // Unticked every single time. Gmail's own folder delete never removes a
  // message, and a box that remembers a previous yes is how mail gets deleted
  // by accident.
  el.deleteTrash.checked = false;
  paintDeleteHint();

  // Escape leaves the previous choice in place, so a second open would read as
  // a confirmation of the first.
  el.deleteDialog.returnValue = '';

  return new Promise((resolve) => {
    el.deleteDialog.addEventListener(
      'close',
      () => {
        const confirmed = el.deleteDialog.returnValue === 'delete';
        resolve(confirmed ? { trash: el.deleteTrash.checked } : null);
      },
      { once: true }
    );
    el.deleteDialog.showModal();
  });
}

async function confirmDelete(labelId) {
  if (jobRunning()) {
    flash('MailBoy is still finishing the last job.');
    return;
  }

  const rows = folderRows();
  const target = rows.find((row) => row.id === labelId);
  if (!target) return;

  // Gmail removes only the label named, so a delete of "Work" would otherwise
  // leave "Work/Clients" behind as a top-level folder with its full path for a
  // name. Deepest first is also the order they have to go in.
  const children = descendantsOf(rows, target.fullName ?? target.name);
  const family = [...children, target];

  // What the rows on screen add up to. A message carrying both a parent's label
  // and a child's counts twice here — which is also what someone reading the
  // two rows would work out, so the figure matches the panel even where it
  // overstates the mailbox.
  const messages = family.reduce((sum, row) => sum + (painted[row.id]?.count ?? 0), 0);

  const choice = await askDelete(target, children, messages);
  if (!choice) return;

  deleteState = { ids: family.map((row) => row.id), name: target.name };
  markWorkingRows();
  setAction(`Deleting “${target.name}”…`);

  folderChannel().postMessage({
    type: 'delete',
    job: {
      trash: choice.trash,
      labels: family.map((row) => ({
        id: row.id,
        name: row.name,
        fullName: row.fullName ?? row.name,
      })),
      // No ratio worth reporting on the inbox path: it is one batchModify per
      // thousand messages and over in about a second.
      total: choice.trash ? messages : 0,
    },
  });
}

/** Take deleted folders off the screen and out of the cache. */
function removeFolders(ids) {
  if (!currentGroups || !ids.length) return;

  const gone = new Set(ids);
  const raw = folderRows()
    .filter((row) => !gone.has(row.id))
    .map((row) => ({ id: row.id, name: row.fullName ?? row.name }));

  for (const id of gone) {
    delete painted[id];
    sized.delete(id);
  }

  renderSkeleton({ ...currentGroups, user: buildTree(raw) });
  repaint();

  patchMembership({ removed: ids });
  void saveSnapshot();
}

function summariseDelete(message, name) {
  const parts = [`Deleted “${name}”.`];

  if (message.trashed) parts.push(`${emails(message.trashed)} moved to Trash.`);
  else if (message.restored) parts.push(`${emails(message.restored)} moved to your inbox.`);

  if (message.failed?.length) {
    parts.push(`${message.failed.length.toLocaleString()} could not be moved.`);
  }

  return parts.join(' ');
}

// ── Acting on a sender selection ─────────────────────────────────
//
// Two actions on the messages behind the ticked senders, and both are handed to
// the service worker for the same reason the folder delete is: trashing costs 5
// quota units a message, so a large selection is minutes, and nobody should
// have to hold a side panel open through it.
//
// Everything either one touches comes from `idsForSelection`, which applies the
// same two filters the breakdown rows do. That is what keeps the figure in the
// dialog and the mail that moves the same set.

/** The selection job in flight, if any. @type {{action: string, total: number,
 *  target: string} | null} */
let bulkState = null;

/** One long job at a time: they share a status line and a quota budget. */
const jobRunning = () => Boolean(deleteState || bulkState);

/**
 * What a move takes the mail out of: **everywhere except where it is going.**
 *
 * A move here is definitive. Gmail's own model is additive — a message wears as
 * many labels as you care to put on it, and "moving" it usually means adding
 * one more — but that is the model this whole product exists to get away from.
 * A folder in MailBoy is a place a message *is*, so after a move the answer to
 * "where is this" has to be one folder and not a list.
 *
 * The set is every row MailBoy shows, minus the destination, because that is
 * exactly the universe of places it claims a message can sit. Removing a label
 * a message does not carry is a no-op, so one list serves every message in the
 * batch.
 *
 * Two things are deliberately *not* in it, and both matter:
 *
 * - **`SENT` and `DRAFT`.** `defaultsOf` drops them, which is what we want
 *   twice over: Gmail refuses to remove either through `modify` and would fail
 *   the whole batch, and mail you wrote is not something this product files.
 * - **`UNREAD`, `STARRED` and `IMPORTANT`.** They never reach `buildGroups` at
 *   all (see labels.js), and that is the right answer here for the same reason
 *   it was there: they are states a message carries, not places it sits. A move
 *   must not silently mark things read or drop your stars.
 */
function shedding(targetId) {
  const rows = [...defaultsOf(currentGroups ?? {}), ...folderRows()];
  return rows.map((row) => row.id).filter((id) => id !== targetId);
}

/** How the dialogs name where the mail is coming from. */
function departing() {
  if (!openLabel) return 'this folder';
  return openLabel.id.startsWith('CATEGORY_') ? 'your inbox' : `“${openLabel.name}”`;
}

/** The scope both dialogs have to state: the period picker is off screen. */
function scopeLine({ senders }) {
  const who = senders === 1 ? 'one sender' : `${senders.toLocaleString()} senders`;
  const when = periodKey === 'all' ? '' : `, ${PERIODS[periodKey].label.toLowerCase()}`;
  return `From ${who} in ${departing()}${when}.`;
}

/**
 * Resolve the ticks to messages and hand the job over.
 *
 * The selection is cleared at the hand-over rather than at the end: the action
 * is under way, the ticks no longer describe anything outstanding, and leaving
 * them up invites a second press of the same button.
 */
function dispatchBulk(job, { total, action, target, status }) {
  bulkState = { action, total, target };
  setAction(status);
  clearSelection();
  renderBreakdown();
  folderChannel().postMessage({ type: 'bulk', job });
}

/**
 * The one dialog both target-less actions use. Each is a single sentence with
 * the count in the middle, so only the parts around it change.
 *
 * @returns {Promise<boolean>} whether it was confirmed
 */
function askConfirm({ verb, count, where, text, button, destructive = false }) {
  // showModal throws on an already-open dialog, which a second click would be.
  if (el.confirmDialog.open) return Promise.resolve(false);

  el.confirmVerb.textContent = verb;
  el.confirmCount.textContent = emails(count);
  el.confirmWhere.textContent = where;
  el.confirmText.textContent = text;
  el.confirmOk.textContent = button;
  el.confirmOk.classList.toggle('dialog-destructive', destructive);

  // Escape leaves the previous choice in place, so a second open would read as
  // a confirmation of the first.
  el.confirmDialog.returnValue = '';

  return new Promise((resolve) => {
    el.confirmDialog.addEventListener(
      'close',
      () => resolve(el.confirmDialog.returnValue === 'go'),
      { once: true }
    );
    el.confirmDialog.showModal();
  });
}

/**
 * Resolve the ticks to ids and check nothing has moved out from under them.
 *
 * Always called *before* a dialog opens, and it is the returned array that
 * travels with the job: the number someone is shown has to be the mail that
 * actually moves, not a figure taken from the rows and then re-derived at the
 * click from a cache a measuring pass has moved on since.
 *
 * @returns {{facts: object, ids: string[]} | null}
 */
function resolveSelection() {
  if (!openLabel) return null;
  if (jobRunning()) {
    flash('MailBoy is still finishing the last job.');
    return null;
  }

  const facts = selectionFacts();
  if (!facts.messages) return null;

  const ids = idsForSelection(openLabel.id, facts.keys, sinceDay());
  if (!ids.length) {
    flash('Those emails are no longer in this folder.');
    clearSelection();
    return null;
  }

  return { facts, ids };
}

async function startTrash() {
  const picked = resolveSelection();
  if (!picked) return;
  const { facts, ids } = picked;

  const confirmed = await askConfirm({
    verb: 'Move',
    count: ids.length,
    where: 'to Trash',
    text:
      `${scopeLine(facts)} Gmail keeps trashed mail for 30 days, so you can still get it ` +
      'back from Trash. On a large selection this takes a while — MailBoy carries on in ' +
      'the background, so you can close the panel.',
    button: 'Move to Trash',
    destructive: true,
  });
  if (!confirmed) return;

  dispatchBulk(
    { action: 'trash', ids, target: 'Trash', source: openLabel.name },
    {
      total: ids.length,
      action: 'trash',
      target: 'Trash',
      status: `Moving ${emails(ids.length)} to Trash…`,
    }
  );
}

/**
 * Out of Trash and back to the inbox.
 *
 * Deliberately *not* a definitive move: this is the undo of a delete, so
 * whatever folders the mail was in stay on it. `messages.trash` strips `INBOX`
 * on the way in, which is why `INBOX` has to be put back — without it a
 * restored message with no folders of its own would come back into All Mail and
 * nowhere MailBoy shows, which reads as the restore having done nothing.
 */
async function startRestore() {
  const picked = resolveSelection();
  if (!picked) return;
  const { facts, ids } = picked;

  const confirmed = await askConfirm({
    verb: 'Restore',
    count: ids.length,
    where: 'to your inbox',
    text: `${scopeLine(facts)} They keep any folders they were in when they were deleted.`,
    button: 'Restore to inbox',
  });
  if (!confirmed) return;

  dispatchBulk(
    { action: 'restore', ids, add: ['INBOX'], remove: ['TRASH'], target: 'Inbox' },
    {
      total: ids.length,
      action: 'restore',
      target: 'Inbox',
      status: `Restoring ${emails(ids.length)} to your inbox…`,
    }
  );
}

// ── Choosing where a move goes ───────────────────────────────────

/**
 * The folders worth offering as destinations.
 *
 * Your Folders, minus the one being looked at, plus Inbox — the one Google
 * folder that is a place to put mail rather than a state, and the same one the
 * folder delete already offers as the way back. Spam and Trash have their own
 * actions, and a category is Gmail's to assign. Inbox drops off the list when
 * the mail is already there, which is what a category row means too.
 */
function moveTargets() {
  const source = openLabel?.id ?? '';
  const inInbox = source === 'INBOX' || source.startsWith('CATEGORY_');

  return {
    defaults: inInbox ? [] : [{ id: 'INBOX', name: 'Inbox', depth: 0 }],
    user: folderRows().filter((row) => row.id !== source),
  };
}

const moveRowFor = (labelId) =>
  el.moveList.querySelector(`[data-label-id="${CSS.escape(labelId)}"]`);

/**
 * The same `.group` / `.row` markup the mailbox screen uses, so the + buttons
 * and the inline editor drop in unchanged — just without the counts, which a
 * destination does not need, and without the bins.
 */
function renderMoveList() {
  const { defaults, user } = moveTargets();
  const sections = [];

  if (defaults.length) {
    sections.push(renderGroup('Google Default Folders', defaults, '', { counted: false }));
  }
  sections.push(
    renderGroup('Your Folders', user, 'No folders of your own yet — use + to make one.', {
      editable: true,
      counted: false,
      removable: false,
    })
  );

  el.moveList.replaceChildren(...sections);
}

/**
 * The messages the open move dialog is about, resolved when it opened.
 *
 * Held rather than re-derived on the click for the same reason the trash dialog
 * resolves early: the dialog's heading names a number, and picking a folder has
 * to move that mail and no other. The dialog can be open for a while — long
 * enough to create a folder to put the mail in — and a measuring pass runs the
 * whole time.
 *
 * @type {string[] | null}
 */
let moveIds = null;

function closeMoveDialog() {
  moveIds = null;
  // The editor lives inside the dialog; leaving it open would strand a field
  // nobody can see, still holding a half-typed name.
  closeEditor();
  if (el.moveDialog.open) el.moveDialog.close();
}

function startMove() {
  if (el.moveDialog.open) return;

  // The removal set is built from the folder list, so a move cannot be started
  // before that list exists — a half-built one would shed only some folders and
  // leave the mail in two places, which is the one outcome this must not have.
  if (!currentGroups) {
    flash('MailBoy is still reading your folders.');
    return;
  }

  const picked = resolveSelection();
  if (!picked) return;
  const { facts, ids } = picked;

  moveIds = ids;
  el.moveCount.textContent = emails(ids.length);
  el.moveText.textContent =
    `${scopeLine(facts)} They move out of every folder they are in now — your inbox ` +
    'included — and into the one you pick.';

  renderMoveList();
  el.moveDialog.showModal();
}

/** Picking a folder is the confirmation — there is no second step. */
function chooseMoveTarget(labelId, name) {
  const ids = moveIds;
  if (!openLabel || !labelId || !ids?.length) return;

  closeMoveDialog();

  dispatchBulk(
    {
      action: 'move',
      ids,
      add: [labelId],
      remove: shedding(labelId),
      target: name,
      source: openLabel.name,
    },
    {
      total: ids.length,
      action: 'move',
      target: name,
      status: `Moving ${emails(ids.length)} to “${name}”…`,
    }
  );
}

// ── Reporting a selection job ────────────────────────────────────

function bulkStatus(done, total) {
  const action = bulkState?.action;
  const lead =
    action === 'trash'
      ? 'Moving to Trash'
      : action === 'restore'
        ? 'Restoring to your inbox'
        : `Moving to “${bulkState?.target ?? ''}”`;

  // `done` is capped: a move reports its whole chunk at once and the totals are
  // built from different sums, so overshooting by a few is possible.
  const ratio = total
    ? ` ${Math.min(done, total).toLocaleString()} of ${total.toLocaleString()}`
    : '';
  return `${lead}…${ratio}`;
}

function summariseBulk(message, action, target) {
  if (action === 'trash') {
    const parts = [`${emails(message.trashed ?? 0)} moved to Trash.`];
    if (message.failed?.length) {
      parts.push(`${message.failed.length.toLocaleString()} could not be moved.`);
    }
    return parts.join(' ');
  }
  if (action === 'restore') return `${emails(message.moved ?? 0)} restored to your inbox.`;
  return `${emails(message.moved ?? 0)} moved to “${target}”.`;
}

/**
 * Adopt a selection job still running from a previous open, or one the worker
 * was killed partway through — the same reasoning as `adoptPendingDelete`.
 */
async function adoptPendingBulk() {
  const job = await readBulkJob();
  if (!job || bulkState) return;

  bulkState = { action: job.action, total: job.ids.length, target: job.target ?? '' };
  setAction(bulkStatus(0, job.ids.length));
  folderChannel();
}

// ── Talking to the worker about deletes ──────────────────────────

/** @type {chrome.runtime.Port | null} */
let folderPort = null;

function folderChannel() {
  if (folderPort) return folderPort;

  const port = chrome.runtime.connect({ name: 'folders' });
  folderPort = port;

  port.onMessage.addListener(onFolderMessage);
  port.onDisconnect.addListener(() => {
    folderPort = null;
    // The worker was killed mid-job. It comes back from its own alarm, and
    // reconnecting is also what prompts it to pick a stranded record back up.
    if (jobRunning()) {
      setTimeout(() => {
        if (jobRunning()) folderChannel();
      }, 1000);
    }
  });

  return port;
}

/** Nothing here re-sends the job: the worker owns it, and the record it wrote
 *  before starting is what makes reconnecting safe. */
function onFolderMessage(message) {
  const name = deleteState?.name ?? message?.name ?? 'Folder';

  if (message?.type === 'delete-progress') {
    // `done` can fall short of `total`: a message under both a parent and a
    // child is counted once per row that holds it, but Gmail only moves it
    // once. Completion is the worker saying so, never the two meeting.
    setAction(
      message.total
        ? `Deleting “${name}”… ${Math.min(message.done, message.total).toLocaleString()} of ${message.total.toLocaleString()}`
        : `Deleting “${name}”…`
    );
    return;
  }

  if (message?.type === 'delete-done') {
    const ids = deleteState?.ids ?? (message.labels ?? []).map((label) => label.id);
    deleteState = null;
    setAction(null);

    removeFolders(ids);
    flash(summariseDelete(message, name));

    // Trashing mail and restoring it both change what other folders hold, so
    // the numbers still on screen for those are now wrong. An empty folder
    // changes nothing and is not worth a re-read.
    if (message.trashed || message.restored) void load({ force: true });
    return;
  }

  if (message?.type === 'delete-stopped') {
    deleteState = null;
    markWorkingRows();
    setAction(null);
    flash(`Stopped deleting “${name}”. The folder is still there.`);
    return;
  }

  if (message?.type === 'delete-failed') {
    console.error('[MailBoy] deleting folder failed:', message.message);
    deleteState = null;
    markWorkingRows();
    setAction(null);
    flash(`Couldn't finish deleting “${name}”.`);
    return;
  }

  // A panel opened mid-job is told what is running before it knows itself, so
  // the worker's word stands in where there is no local state.
  if (message?.type === 'bulk-progress') {
    bulkState ??= { action: message.action, total: message.total, target: message.target ?? '' };
    setAction(bulkStatus(message.done, message.total));
    return;
  }

  if (message?.type === 'bulk-done' || message?.type === 'bulk-stopped') {
    const action = bulkState?.action ?? message.action;
    const target = bulkState?.target ?? message.target ?? '';
    const stopped = message.type === 'bulk-stopped';
    bulkState = null;
    setAction(null);

    flash(
      stopped
        ? `Stopped. ${summariseBulk(message, action, target)}`
        : summariseBulk(message, action, target)
    );

    // Mail that has moved changes what every other folder holds, so the numbers
    // still on screen for those are now wrong.
    if (message.trashed || message.moved) void load({ force: true });
    return;
  }

  if (message?.type === 'bulk-failed') {
    console.error('[MailBoy] selection job failed:', message.message);
    bulkState = null;
    setAction(null);
    flash("Couldn't finish moving those emails.");
  }
}

/**
 * Adopt a delete that is still running from a previous open, or one the worker
 * was killed partway through.
 *
 * Without this the panel would look idle while folders quietly disappeared out
 * from under it, and the rows involved would invite a second delete.
 */
/** Housekeeping at boot, so a failure here costs the dimming, never the panel. */
function watchPendingJobs() {
  adoptPendingDelete().catch((err) => {
    console.warn('[MailBoy] could not pick up the pending delete:', err);
  });
  adoptPendingBulk().catch((err) => {
    console.warn('[MailBoy] could not pick up the pending selection job:', err);
  });
}

async function adoptPendingDelete() {
  const job = await readDeleteJob();
  if (!job || deleteState) return;

  deleteState = {
    ids: job.labels.map((label) => label.id),
    name: job.labels.at(-1)?.name ?? '',
  };
  markWorkingRows();
  setAction(`Deleting “${deleteState.name}”…`);
  folderChannel();
}

// ── Error state ──────────────────────────────────────────────────

const ICON_ALERT = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.6v5.6" />
    <circle cx="12" cy="16.8" r="1.15" class="dot" />
  </svg>`;

/**
 * Plain-language account of what went wrong. Deliberately free of project IDs
 * and console URLs — Google's own wording carries both.
 */
function describeError(err) {
  if (!navigator.onLine) {
    return {
      title: "You're offline",
      body: 'MailBoy needs a connection to read your folders from Gmail.',
    };
  }

  if (err instanceof GmailError) {
    if (err.reason === 'accessNotConfigured' || err.reason === 'SERVICE_DISABLED') {
      return {
        title: 'Gmail access is switched off',
        body: "MailBoy's connection to Gmail isn't finished being set up, so Gmail is refusing the request. Reconnecting won't change this.",
      };
    }
    if (err.reason === 'rateLimitExceeded' || err.reason === 'userRateLimitExceeded') {
      return {
        title: 'Gmail is busy',
        body: 'Too many requests went out at once. Waiting a moment usually clears it.',
      };
    }
    if (err.status >= 500) {
      return {
        title: 'Gmail is having trouble',
        body: "The problem is on Google's side. Trying again shortly usually works.",
      };
    }
    return {
      title: 'Gmail turned down the request',
      body: 'MailBoy asked Gmail for your folders and was refused.',
    };
  }

  // fetch() rejects with a TypeError when it never reached the server.
  if (err instanceof TypeError) {
    return {
      title: "Couldn't reach Gmail",
      body: 'The connection failed before Gmail could answer.',
    };
  }

  return {
    title: 'Something went wrong',
    body: "MailBoy couldn't load your folders.",
  };
}

function technicalDetail(err) {
  const parts = [];
  if (err instanceof GmailError) {
    if (err.status) parts.push(`HTTP ${err.status}`);
    if (err.reason) parts.push(err.reason);
  }
  parts.push(err?.message ?? String(err));
  return parts.join(' · ');
}

/**
 * Button with a Material Symbols glyph and a label, returned as parts so the
 * label can change without wiping the icon.
 */
function iconButton(className, glyph, label) {
  const el = document.createElement('button');
  el.className = className;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = glyph;

  const text = document.createElement('span');
  text.textContent = label;

  el.append(icon, text);
  return { el, icon, label: text };
}

function renderErrorState(err) {
  const { title, body } = describeError(err);

  const icon = document.createElement('div');
  icon.className = 'state-icon';
  icon.innerHTML = ICON_ALERT;

  const heading = document.createElement('h2');
  heading.className = 'state-title';
  heading.textContent = title;

  const text = document.createElement('p');
  text.className = 'state-body';
  text.textContent = body;

  const retry = iconButton('btn btn--primary btn--sm', 'refresh', 'Try again');
  const signOut = iconButton('btn btn--ghost btn--sm', 'logout', 'Log out');

  signOut.el.addEventListener('click', () => handleLogout());

  retry.el.addEventListener('click', async () => {
    retry.el.disabled = true;
    signOut.el.disabled = true;
    retry.label.textContent = 'Trying…';
    retry.icon.classList.add('icon--spin');

    // A repeat failure re-renders an identical state, so without a floor on
    // the pending state the click looks like it did nothing at all.
    await Promise.all([load({ force: true }), new Promise((done) => setTimeout(done, 450))]);

    // On success this state is gone; on failure a fresh one replaced it.
    if (retry.el.isConnected) {
      retry.el.disabled = false;
      signOut.el.disabled = false;
      retry.label.textContent = 'Try again';
      retry.icon.classList.remove('icon--spin');
    }
  });

  const actions = document.createElement('div');
  actions.className = 'state-actions';
  actions.append(retry.el, signOut.el);

  // Collapsed by default: useful when reporting a problem, noise otherwise.
  const details = document.createElement('details');
  details.className = 'state-details';
  details.open = detailsOpen;
  details.addEventListener('toggle', () => {
    detailsOpen = details.open;
  });
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  const detailText = document.createElement('p');
  detailText.textContent = technicalDetail(err);
  details.append(summary, detailText);

  const state = document.createElement('div');
  state.className = 'state';
  state.append(icon, heading, text, actions, details);

  el.groups.replaceChildren(state);
  // The numbers this timestamp described are gone from the screen with them.
  setFooter(null);
}

// ── Measuring, in the service worker ─────────────────────────────

/**
 * Hand the queue to the worker and relay its progress.
 *
 * The work runs there so it survives the panel being closed — a first pass
 * takes minutes and nobody should have to sit and watch it. The panel is only
 * a viewer here: it can come and go, and the pass carries on.
 */
/**
 * Call off whatever is running.
 *
 * The panel's half stops on the next check; the worker's half is told over a
 * one-off message rather than the port, so it lands even between reconnects —
 * and the worker clears its alarm, or the pass would resume a minute later.
 */
function stopLoad() {
  if (!busy) return;
  stopRequested = true;

  // Tell the worker, but do not wait to hear back. It stops on its own; the
  // panel has no reason to sit through a batch that is already in flight.
  //
  // Named, because this button is about refreshing. A delete has its own
  // lifetime and pressing stop on a refresh must not abandon one half-done.
  chrome.runtime.sendMessage({ type: 'stop', job: 'measure' }).catch(() => {});
  stopSignal?.();
  setFooter();
}

async function measureInWorker(order, onBatch) {
  // A killed worker drops the port. It resumes on its own from the alarm, so
  // reconnecting and asking again is all that is needed — and because the
  // cache filters what it has already read, nothing is measured twice.
  for (let attempt = 0; attempt < 60 && !stopRequested; attempt++) {
    const outcome = await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'measure' });

      // Pressing stop ends the wait here and now, whatever the worker is
      // mid-way through.
      stopSignal = () => {
        port.disconnect();
        resolve('done');
      };

      port.onMessage.addListener((message) => {
        if (message?.type === 'progress') {
          onBatch(new Map(Object.entries(message.sizes ?? {})), message.done, message.total);
        } else if (message?.type === 'done' || message?.type === 'stopped') {
          port.disconnect();
          resolve('done');
        } else if (message?.type === 'failed') {
          port.disconnect();
          reject(new Error(message.message || 'Measuring failed.'));
        }
      });

      // Only fires when the other end goes away, never for our own disconnect.
      port.onDisconnect.addListener(() => resolve('dropped'));

      port.postMessage({ type: 'start', order });
    });

    stopSignal = null;
    if (outcome === 'done') return;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

// ── Loading ──────────────────────────────────────────────────────

/** Whether the snapshot on screen is recent enough to stand on its own. */
async function isFresh() {
  try {
    const key = await scopedKey(CACHE_NAME);
    if (!key) return false;

    const { [key]: cached } = await chrome.storage.local.get(key);
    return Boolean(cached?.counts) && Date.now() - cached.generatedAt < REFRESH_AFTER_MS;
  } catch {
    return false;
  }
}

/**
 * @param {{force?: boolean}} [options] `force` skips the freshness check —
 *   what the refresh button and the error-state retry both want.
 */
async function load({ force = false } = {}) {
  if (loading) return;

  if (!force && (await isFresh())) {
    // Nothing to re-read. Put the last enumeration's ids back in memory,
    // though, so a breakdown works without having listed anything.
    membershipReady = restoreMembership();
    return;
  }

  // The previous enumeration's ids, so a breakdown opened during this pass has
  // something to aggregate rather than an empty list. `collect` replaces them
  // when its own enumeration lands.
  membershipReady = restoreMembership();

  loading = true;
  stopRequested = false;
  stopSignal = null;
  setBusy(true);

  try {
    const labels = await listLabels();
    const groups = buildGroups(labels);
    renderSkeleton(groups);
    // Rows were just rebuilt; put back whatever was already known so a refresh
    // shows stale numbers rather than placeholders.
    repaint();

    const generatedAt = Date.now();

    const counts = await collect(groups, {
      // Deliberately not stamping the timestamp here: counts land in stages,
      // and "Updated just now" while later rows are still filling in is a lie.
      onCounts: paintRecords,
      onCounting: (done, total) => setProgress('counting', done, total),
      onSizes: (records, done, total) => {
        paintRecords(records);
        // Sizes arriving behind an open breakdown should show up in it.
        if (openLabel) renderBreakdown();
        // Enumeration is finished by the time this first fires, so the counts
        // are final and worth stamping — sizes carry on in the card.
        setFooter(generatedAt);
        setProgress('measuring', done, total);
      },
      measure: measureInWorker,
      stopped: () => stopRequested,
    });

    paintRecords(counts);
    setProgress(null);
    setBusy(false);
    setFooter(generatedAt);

    const key = await scopedKey(CACHE_NAME);
    if (key && !stopRequested) {
      await chrome.storage.local.set({
        [key]: { generatedAt, groups, counts },
      });
    }
  } catch (err) {
    setProgress(null);
    console.error('[MailBoy] load failed:', err);
    if (err instanceof AuthError) {
      const key = await scopedKey(CACHE_NAME);
      if (key) await chrome.storage.local.remove(key);
      showWelcome('Gmail access expired. Please connect again.');
    } else {
      renderErrorState(err);
    }
  } finally {
    loading = false;
    setBusy(false);
  }
}

/**
 * Who is signed in, resolved independently of the mailbox load. Gmail can be
 * refusing every request and the top bar should still show who you are.
 */
async function loadIdentity() {
  try {
    const info = await getUserInfo();
    if (!info) return false;

    const email = info.email ?? null;
    const photo = info.picture ?? null;

    setAccount(email);
    setPhoto(photo);

    if (email) await rememberAccount(email);

    // `sub` is what every cache key hangs off. Without it there is no namespace
    // to write into, so the panel runs for this session and stores nothing —
    // better than filing one mailbox's data under another's name.
    if (!info.sub) return false;

    const switched = await setActiveAccount(info.sub, email);
    if (switched) forgetMailbox();

    await chrome.storage.local.set({ [keyFor(info.sub, IDENTITY_NAME)]: { email, photo } });
    return switched;
  } catch (err) {
    // Identity is decoration; never let it break the panel.
    console.warn('[MailBoy] identity unavailable:', err);
    return false;
  }
}

/**
 * Drop everything held about a mailbox, on disk or not. What is in memory
 * describes the account being left, and the screen is still showing it.
 */
function forgetMailbox() {
  resetMessages();
  resetMembership();
  sized.clear();
  painted = {};
  openLabel = null;
  listedSenders = [];
  selected = new Set();
  currentGroups = null;
  closeEditor();
  closeMoveDialog();
  // Whatever was being deleted or moved belonged to the mailbox being left. The
  // job records survive under that account's namespace; this is only the panel
  // letting go of them.
  deleteState = null;
  bulkState = null;
  setAction(null);
  el.senderRows.replaceChildren();
  el.groups.replaceChildren();
  setProgress(null);
  setFooter(null);
}

async function paintIdentityCache() {
  const key = await scopedKey(IDENTITY_NAME);
  if (!key) return;

  const { [key]: cached } = await chrome.storage.local.get(key);
  if (!cached) return;
  setAccount(cached.email);
  setPhoto(cached.photo);
}

/** Paint the last known good view instantly, then refresh behind it. */
async function paintCache() {
  const key = await scopedKey(CACHE_NAME);
  if (!key) return;

  const { [key]: cached } = await chrome.storage.local.get(key);
  if (!cached?.groups) return;

  renderSkeleton(cached.groups);
  paintRecords(cached.counts ?? {});
  setFooter(cached.generatedAt);
}

// ── Events ───────────────────────────────────────────────────────

el.connect.addEventListener('click', async () => {
  el.connect.disabled = true;
  el.connect.textContent = 'Waiting for Google…';
  setNotice(el.welcomeError, null);

  try {
    await getToken({ interactive: true });
    showMain();
    // Header first, so it is populated even if the mailbox load fails — and
    // because identity is what names the account whose cache the next two
    // lines read.
    await loadIdentity();
    // Signing back into a mailbox whose data is still here means `load` finds
    // it fresh and returns without rendering, so the panel would sit empty.
    // An unreadable cache is an emptier first frame, never a failed connect.
    await paintCache().catch((err) => console.warn('[MailBoy] cache unreadable:', err));
    await load();
    // Signing back in within the retention window can find a job that was
    // interrupted by the sign-out still outstanding.
    watchPendingJobs();
  } catch (err) {
    // Closing the Google window is a choice, not a failure worth shouting about.
    if (err instanceof AuthCancelled) {
      showWelcome(null);
    } else {
      console.error('[MailBoy] connect failed:', err);
      showWelcome("Couldn't connect to Google. Please try again.");
    }
  } finally {
    el.connect.disabled = false;
    el.connect.textContent = 'Connect to Mailbox';
  }
});

/** Every key one mailbox occupies. They are only ever erased together. */
async function eraseAccountData(id) {
  await clearMessages(id);
  await forgetMembership(id);
  await chrome.storage.local.remove([
    keyFor(id, CACHE_NAME),
    keyFor(id, IDENTITY_NAME),
    // A half-finished delete is intent, not data, but it is keyed the same way
    // and there is nothing left for it to act on once the rest of this is gone.
    deleteJobKey(id),
    // This one *is* mail data — a selection job carries the message ids it is
    // working through, since nothing in the mailbox can re-derive them.
    bulkJobKey(id),
  ]);
}

/**
 * Erase whatever was left by accounts signed out longer than the retention
 * window. Housekeeping, so a failure is logged and the panel carries on.
 */
async function purgeExpired() {
  try {
    for (const id of await expiredAccounts()) {
      await eraseAccountData(id);
      await dropAccount(id);
    }
  } catch (err) {
    console.warn('[MailBoy] could not purge expired data:', err);
  }
}

/**
 * Logging out is worth confirming because of what it costs, not because it is
 * hard to undo: a mailbox whose data has gone has to be read message by
 * message again, which is minutes rather than seconds.
 *
 * @returns {Promise<'keep' | 'erase' | null>} null if it was called off
 */
function confirmLogout() {
  // showModal throws on an already-open dialog, which a second click would be.
  if (el.logoutDialog.open) return Promise.resolve(null);

  return new Promise((resolve) => {
    el.logoutMailbox.textContent = el.account.textContent || 'this mailbox';
    // Escape leaves the previous choice in place, so a second open would read
    // as a confirmation of the first.
    el.logoutDialog.returnValue = '';
    el.logoutDialog.addEventListener(
      'close',
      () => {
        const choice = el.logoutDialog.returnValue;
        // Escape closes with no value at all, and Cancel closes with one that
        // is neither. Anything but an explicit choice means no.
        resolve(choice === 'keep' || choice === 'erase' ? choice : null);
      },
      { once: true }
    );
    el.logoutDialog.showModal();
  });
}

async function handleLogout() {
  const choice = await confirmLogout();
  if (!choice) return;

  // A pass still reading messages has no account to file them under once the
  // sign-out lands, and its token is about to be revoked. The worker is told
  // directly as well: it may be measuring from an earlier open, with this
  // panel idle and unaware of it.
  stopLoad();
  chrome.runtime.sendMessage({ type: 'stop' }).catch(() => {});

  await logout();

  // Order matters: the data is keyed by the account, so it has to be erased
  // while that account is still the active one.
  const id = await activeAccount();
  if (choice === 'erase' && id) await eraseAccountData(id);
  await releaseAccount();

  // Kept or erased, nothing about the mailbox stays on screen or in memory.
  forgetMailbox();
  setBusy(false);
  setAccount(null);
  setPhoto(null);
  showWelcome(null);
}

el.logout.addEventListener('click', () => handleLogout());

el.refresh.addEventListener('click', () => (busy ? stopLoad() : load({ force: true })));

/**
 * The + on a row nests inside it; the + on the heading makes a top-level
 * folder. Either way the editor opens where the folder will appear.
 */
function handleAdd(button) {
  const row = button.closest('.row');

  if (row) {
    openEditor({
      parent: row.dataset.fullName,
      depth: Number(row.dataset.depth ?? 0) + 1,
      after: row,
    });
    return;
  }

  openEditor({ into: button.closest('.group') });
}

// Delegated, because the rows are rebuilt on every render.
el.groups.addEventListener('click', (event) => {
  // Checked first: these sit inside a row that would otherwise take the click
  // as "open the breakdown".
  const action = event.target.closest('.row-action');
  if (action) {
    event.stopPropagation();
    if (action.dataset.action === 'add') handleAdd(action);
    else if (action.dataset.action === 'delete') {
      void confirmDelete(action.closest('.row')?.dataset.labelId);
    }
    // 'cancel' belongs to the editor and is wired where it is built.
    return;
  }

  const row = event.target.closest('.row');
  if (row) void openBreakdown(row.dataset.labelId, row.dataset.labelName);
});

el.groups.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  // The action buttons are real buttons and answer the keyboard themselves; the
  // row must not also open a breakdown behind them.
  if (event.target.closest('.row-action, .folder-editor')) return;

  const row = event.target.closest('.row');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.
  void openBreakdown(row.dataset.labelId, row.dataset.labelName);
});

el.deleteTrash.addEventListener('change', paintDeleteHint);

el.back.addEventListener('click', closeBreakdown);

// ── Picking senders ──────────────────────────────────────────────

// The box inside the label toggles itself, so this covers that half.
el.senderRows.addEventListener('change', (event) => {
  const box = event.target.closest('input[type="checkbox"]');
  const row = box?.closest('.sender');
  if (row) toggleSender(row.dataset.sender, box.checked);
});

el.senderRows.addEventListener('click', (event) => {
  // The label already toggled its own box and fired `change` above.
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.sender');
  if (!row) return;

  // A drag that ended up selecting text is somebody copying an address, not a
  // tick — an addressee is the one thing on this screen worth copying.
  if (!window.getSelection()?.isCollapsed) return;

  toggleSender(row.dataset.sender, !selected.has(row.dataset.sender));
});

el.selectAll.addEventListener('change', () => {
  // Exactly what is listed, which is the period's doing — a sender out of scope
  // cannot be acted on, so "all" cannot mean it.
  selected = el.selectAll.checked ? new Set(listedSenders.map(senderKey)) : new Set();
  syncSelection();
});

el.trash.addEventListener('click', () => void startTrash());
el.restore.addEventListener('click', () => void startRestore());
el.move.addEventListener('click', () => startMove());
el.moveCancel.addEventListener('click', closeMoveDialog);
// Escape closes a dialog on its own, leaving the editor inside it and the ids
// it was holding behind. Re-entrant by design: `close()` is guarded on `.open`,
// which is already false by the time this fires.
el.moveDialog.addEventListener('close', closeMoveDialog);

// Delegated for the same reason the mailbox list is: these rows are rebuilt
// whenever a folder is created from inside the dialog.
el.moveList.addEventListener('click', (event) => {
  const action = event.target.closest('.row-action');
  if (action) {
    event.stopPropagation();
    if (action.dataset.action === 'add') handleAdd(action);
    // 'cancel' belongs to the editor and is wired where it is built.
    return;
  }

  const row = event.target.closest('.row');
  if (row) chooseMoveTarget(row.dataset.labelId, row.dataset.labelName);
});

el.moveList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('.row-action, .folder-editor')) return;

  const row = event.target.closest('.row');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.
  chooseMoveTarget(row.dataset.labelId, row.dataset.labelName);
});

el.senderHead.addEventListener('click', (event) => {
  const head = event.target.closest('.col-head');
  if (!head) return;

  // Clicking the column already in use turns it round; clicking another moves
  // to it the way round that column starts.
  const key = head.dataset.sort;
  setSort(key, key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : undefined);
});

wirePicker(el.sortTrigger, el.sortMenu, 'sort', setSort);
wirePicker(el.periodTrigger, el.periodMenu, 'period', setPeriod);

document.addEventListener('click', (event) => {
  if (anyMenuOpen() && !event.target.closest('.picker')) closeMenus();
});

// Puts the defaults on the triggers and the ticks beside them.
setSort(sortKey);
setPeriod(periodKey);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // A dialog closes itself on Escape; without this the same press would also
  // close the breakdown standing behind it.
  if (
    el.logoutDialog.open ||
    el.deleteDialog.open ||
    el.confirmDialog.open ||
    el.moveDialog.open
  ) {
    return;
  }
  if (anyMenuOpen()) {
    closeMenus();
  } else if (editor) {
    // Nearest thing first: an editor is open over the list, so the press is
    // about that rather than about the screen it is on.
    closeEditor();
  } else if (!el.detail.hidden) {
    closeBreakdown();
  }
});

// ── Boot ─────────────────────────────────────────────────────────

(async function init() {
  // Neither of these needs a token, so they run alongside the token check
  // rather than after it. The boot screen is covering both screens meanwhile,
  // so whichever one it lifts to is already drawn — no second stage where the
  // mailbox is up but still blank.
  const painting = Promise.all([paintIdentityCache(), paintCache()]).catch((err) => {
    // Decoration, like loadIdentity: an emptier first frame, never a failure.
    console.warn('[MailBoy] could not paint from cache:', err);
  });

  // Data left by accounts nobody has signed back into. Not awaited: it touches
  // nothing this open reads, and a slow sweep should not hold up the panel.
  void purgeExpired();

  try {
    // Silent only: opening a sign-in window unprompted would be hostile.
    await getToken({ interactive: false });
  } catch {
    await painting;
    showWelcome(null);
    return;
  }

  await painting;
  showMain();
  // Both already have a token, and the mailbox load should not queue behind a
  // userinfo round trip just to fill in the header.
  const [switched] = await Promise.all([loadIdentity(), load()]);

  // The silent renewal came back as a different mailbox from the one this open
  // painted and loaded — everything on screen belongs to the account left
  // behind, and `forgetMailbox` has already cleared it. Read the new one.
  if (switched) await load({ force: true });

  // Last, because it dims rows the load has to have drawn first — and after
  // any account switch, so it never adopts the outgoing mailbox's job.
  watchPendingJobs();
})();
