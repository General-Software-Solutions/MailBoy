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
  capabilities,
  getToken,
  logout,
  rememberAccount,
  requestScopes,
} from './src/auth.js';
import { CAPABILITIES } from './src/config.js';
import { MAX_NAME, createFolder, validateFolderName } from './src/folders.js';
import { enqueueTask, legacyKeys, readTasks, taskId, tasksKey } from './src/tasks.js';
import {
  GmailError,
  ScopeError,
  fetchMessageHeaders,
  getMessage,
  getProfile,
  getUserInfo,
  listLabels,
} from './src/gmail.js';
import {
  formatAgo,
  formatBytes,
  formatDate,
  formatDateFull,
  formatRate,
  formatTimeLeft,
} from './src/format.js';
import { shapeHeader, shapeMessage } from './src/mail.js';
import { buildGroups, buildTree, descendantsOf } from './src/labels.js';
import {
  breakdownOf,
  collect,
  forgetMembership,
  idsForSelection,
  idsIn,
  patchMembership,
  patchMessages,
  recountRows,
  resetMembership,
  restoreMembership,
  stampHistoryId,
  syncHistory,
  unpatchMessages,
} from './src/mailbox.js';
import { clearMessages, dayOf, reloadMessages, resetMessages, sizeOf } from './src/messages.js';
import {
  MAX_RULES,
  createRules,
  deleteRules,
  domainOf,
  listRules,
  sameRule,
} from './src/rules.js';
import { COPY, applyStaticCopy, emails, ruleCount } from './src/copy.js';
import { trace } from './src/trace.js';

// Both live in the signed-in account's namespace — see src/account.js. Bare
// names, scoped at the point of use.
const CACHE_NAME = 'snapshot';
const IDENTITY_NAME = 'identity';

/**
 * How long a snapshot may stand before an open re-lists the whole mailbox.
 *
 * A week, not a day, because an open no longer chooses between "stale" and
 * "seconds of listing": it patches membership from Gmail's change log for two
 * quota units, so the numbers are current either way. What the full listing is
 * still for is the drift a change log cannot fix — the log only says what
 * changed, so anything already wrong stays wrong — and Gmail keeps roughly a
 * week of log, past which there is nothing to patch from anyway.
 *
 * "Refresh current data" forces one at any time, and remains the only way to
 * correct membership that has gone wrong.
 */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

// Every word in the markup comes from src/copy.js. Done before anything
// reads or paints, so no screen is ever seen with its keys still in it.
applyStaticCopy();

const el = {
  boot: document.getElementById('screen-boot'),
  welcome: document.getElementById('screen-welcome'),
  app: document.getElementById('app'),
  main: document.getElementById('screen-main'),
  connect: document.getElementById('btn-connect'),
  logout: document.getElementById('btn-logout'),
  logoutDialog: document.getElementById('logout-dialog'),
  logoutText: document.getElementById('logout-text'),
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
  navbar: document.getElementById('navbar'),
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

  // The task card, which stands under every signed-in screen beside the footer.
  taskCard: document.getElementById('task-card'),
  taskTitle: document.getElementById('task-title'),
  taskDone: document.getElementById('task-done'),
  taskQueued: document.getElementById('task-queued'),
  taskProgress: document.getElementById('task-progress'),
  taskProgressBar: document.getElementById('task-progress-bar'),
  taskStop: document.getElementById('btn-task-stop'),
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
  senderCount: document.getElementById('sender-count'),
  senderRows: document.getElementById('sender-rows'),
  toolsFilters: document.getElementById('tools-filters'),
  toolsActions: document.getElementById('tools-actions'),
  selectionSummary: document.getElementById('selection-summary'),
  selectAll: document.getElementById('select-all'),
  move: document.getElementById('btn-move'),
  block: document.getElementById('btn-block'),
  trash: document.getElementById('btn-trash'),
  restore: document.getElementById('btn-restore'),
  permissionDialog: document.getElementById('permission-dialog'),
  permissionTitle: document.getElementById('permission-title'),
  permissionText: document.getElementById('permission-text'),
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
  moveConfirm: document.getElementById('btn-move-confirm'),
  moveCancel: document.getElementById('btn-move-cancel'),
  blockDialog: document.getElementById('block-dialog'),
  blockWho: document.getElementById('block-who'),
  blockText: document.getElementById('block-text'),
  blockDomainRow: document.getElementById('block-domain-row'),
  blockDomain: document.getElementById('block-domain'),
  blockDomainLabel: document.getElementById('block-domain-label'),
  blockHint: document.getElementById('block-hint'),

  // The three rule boxes, in each of the dialogs that offers them.
  ruleSenderRow: document.getElementById('rule-sender-row'),
  ruleSender: document.getElementById('rule-sender'),
  ruleSenderLabel: document.getElementById('rule-sender-label'),
  ruleDomainRow: document.getElementById('rule-domain-row'),
  ruleDomain: document.getElementById('rule-domain'),
  ruleDomainLabel: document.getElementById('rule-domain-label'),
  ruleSubjectRow: document.getElementById('rule-subject-row'),
  ruleSubject: document.getElementById('rule-subject'),
  ruleSubjectLabel: document.getElementById('rule-subject-label'),
  ruleHint: document.getElementById('rule-hint'),
  trashRuleSenderRow: document.getElementById('trash-rule-sender-row'),
  trashRuleSender: document.getElementById('trash-rule-sender'),
  trashRuleSenderLabel: document.getElementById('trash-rule-sender-label'),
  trashRuleDomainRow: document.getElementById('trash-rule-domain-row'),
  trashRuleDomain: document.getElementById('trash-rule-domain'),
  trashRuleDomainLabel: document.getElementById('trash-rule-domain-label'),
  trashRuleSubjectRow: document.getElementById('trash-rule-subject-row'),
  trashRuleSubject: document.getElementById('trash-rule-subject'),
  trashRuleSubjectLabel: document.getElementById('trash-rule-subject-label'),
  trashRuleHint: document.getElementById('trash-rule-hint'),

  // One sender's mail.
  mailsScreen: document.getElementById('screen-mails'),
  mailsBack: document.getElementById('btn-mails-back'),
  mailsLabel: document.getElementById('mails-label'),
  mailsTotal: document.getElementById('mails-total'),
  mailsSpinner: document.getElementById('mails-spinner'),
  mailsScope: document.getElementById('mails-scope'),
  mailSortTrigger: document.getElementById('btn-mail-sort'),
  mailSortLabel: document.getElementById('mail-sort-label'),
  mailSortMenu: document.getElementById('mail-sort-menu'),
  mailsFilters: document.getElementById('mails-filters'),
  mailsActions: document.getElementById('mails-actions'),
  mailSelectionSummary: document.getElementById('mail-selection-summary'),
  mailMove: document.getElementById('btn-mail-move'),
  mailBlock: document.getElementById('btn-mail-block'),
  mailTrash: document.getElementById('btn-mail-trash'),
  mailRestore: document.getElementById('btn-mail-restore'),
  mails: document.getElementById('mails'),
  mailHead: document.getElementById('mail-head'),
  mailCount: document.getElementById('mail-count'),
  mailSelectAll: document.getElementById('mail-select-all'),
  mailRows: document.getElementById('mail-rows'),

  // One message.
  messageScreen: document.getElementById('screen-message'),
  messageBack: document.getElementById('btn-message-back'),
  messageSubject: document.getElementById('message-subject'),
  messageScope: document.getElementById('message-scope'),
  messageMove: document.getElementById('btn-message-move'),
  messageBlock: document.getElementById('btn-message-block'),
  messageTrash: document.getElementById('btn-message-trash'),
  messageRestore: document.getElementById('btn-message-restore'),
  messageView: document.getElementById('message-view'),

  // Rules, grouped by where they send mail.
  rulesScreen: document.getElementById('screen-rules'),
  rulesHome: document.getElementById('btn-rules-home'),
  rulesTotal: document.getElementById('rules-total'),
  rulesSpinner: document.getElementById('rules-spinner'),
  rulesFilters: document.getElementById('rules-filters'),
  rulesActions: document.getElementById('rules-actions'),
  rulesScope: document.getElementById('rules-scope'),
  rulesSummary: document.getElementById('rules-summary'),
  rulesDelete: document.getElementById('btn-rules-delete'),
  rulesHead: document.getElementById('rule-head'),
  rulesCount: document.getElementById('rules-count'),
  rulesSelectAll: document.getElementById('rules-select-all'),
  ruleRows: document.getElementById('rule-rows'),

  // One destination's rules.
  ruleDetailScreen: document.getElementById('screen-rule-detail'),
  rulesBack: document.getElementById('btn-rules-back'),
  ruleDetailLabel: document.getElementById('rule-detail-label'),
  ruleDetailTotal: document.getElementById('rule-detail-total'),
  ruleDetailFilters: document.getElementById('rule-detail-filters'),
  ruleDetailActions: document.getElementById('rule-detail-actions'),
  ruleDetailScope: document.getElementById('rule-detail-scope'),
  ruleDetailSummary: document.getElementById('rule-detail-summary'),
  ruleDelete: document.getElementById('btn-rule-delete'),
  ruleDetailHead: document.getElementById('rule-detail-head'),
  ruleSelectAll: document.getElementById('rule-select-all'),
  ruleDetailRows: document.getElementById('rule-detail-rows'),
};

let loading = false;

/** Raised by the stop button; cleared when the next load starts. */
let stopRequested = false;

/** Resolves the moment stop is pressed, so nothing has to wait out a reply. */
let stopSignal = null;

/**
 * Ends the wait for the pass itself, rather than for the worker.
 *
 * A Gmail request already in flight cannot be recalled, and since the task queue
 * arrived it can be sitting in the shared quota pacer for tens of seconds before
 * it is even sent (decision 39). Stop has to mean "stop waiting for it", or the
 * button does nothing for as long as that takes.
 *
 * @type {(() => void) | null}
 */
let abortLoad = null;

/**
 * Which pass is the current one.
 *
 * An abandoned pass carries on running — nothing can cancel a request — so it
 * has to be told to stop *painting*, saving membership, and stamping snapshots.
 * `stopRequested` alone cannot say that: the next load clears it, which would
 * hand the orphan its permissions straight back. A token cannot be un-revoked.
 */
let passId = 0;

/** Survives the re-render a failed retry causes, so the panel doesn't collapse
 *  the details someone just opened to read. */
let detailsOpen = false;

// ── Permissions ──────────────────────────────────────────────────

/**
 * What this grant reaches, as `{ read, write, rules }`.
 *
 * Google's consent screen lets each Gmail permission be unticked on its own, so
 * a sign-in can come back partial — and that is a supported way to use MailBoy
 * rather than a failure. The panel shows what the grant allows, marks what it
 * does not, and asks again at the moment somebody reaches for one of those.
 *
 * Mirrored in memory rather than read per click: `paintCapabilities` runs on
 * every render path and a storage read there would be a promise in the middle of
 * a paint. `refreshCapabilities` is the only writer, and every path that can
 * change a grant goes through it.
 */
let caps = { read: false, write: false, rules: false };

async function refreshCapabilities() {
  caps = await capabilities();
  trace('auth', 'capabilities', { ...caps });
  paintCapabilities();
  return caps;
}

/**
 * The controls that act on something the grant may not cover.
 *
 * Read as functions because `el` is built before this runs, and re-read on every
 * paint because these are the same nodes throughout — the rows underneath them
 * are rebuilt constantly, the tools rows are not.
 *
 * Block sits under `rules`, not `write`: it moves no mail at all and its whole
 * effect is one filter.
 */
const GATED = {
  write: () => [
    el.move,
    el.trash,
    el.restore,
    el.mailMove,
    el.mailTrash,
    el.mailRestore,
    el.messageMove,
    el.messageTrash,
    el.messageRestore,
  ],
  rules: () => [el.block, el.mailBlock, el.messageBlock, el.rulesDelete, el.ruleDelete],
};

/**
 * Note what cannot be done yet, without changing how it looks.
 *
 * Deliberately not `disabled`: a control that does nothing and says nothing is
 * how a permission somebody declined by accident stays declined forever. These
 * stay pressable and the press is what asks.
 *
 * Deliberately not visible either — `.needs-perm` has no CSS behind it. Two
 * marks were tried and both were wrong for the same reason: Move, Delete, the +
 * and the bin are one permission, so they change together, and four faded or
 * greyed controls read as a broken panel rather than as an answer to a question
 * nobody has asked yet. The dialog the press opens is where the difference gets
 * explained. The class and the title stay as the hook, so a mark can come back
 * without re-deriving which controls it belongs on.
 */
function paintCapabilities() {
  for (const [cap, nodes] of Object.entries(GATED)) {
    for (const node of nodes()) {
      node.classList.toggle('needs-perm', !caps[cap]);
      if (caps[cap]) node.removeAttribute('title');
      else node.title = COPY.permission.needed;
    }
  }

  // The folder row's + and bin are rebuilt on every render, so they are marked
  // from one class on the shell rather than one node at a time.
  el.app.classList.toggle('app--no-write', !caps.write);

  const rulesTab = el.navbar.querySelector('.nav-btn[data-tab="rules"]');
  if (!rulesTab) return;
  rulesTab.classList.toggle('needs-perm', !caps.rules);
  if (caps.rules) rulesTab.removeAttribute('title');
  else rulesTab.title = COPY.permission.needed;
}

/** @returns {Promise<boolean>} whether the user chose to be asked by Google. */
function confirmPermission(cap) {
  if (el.permissionDialog.open) return Promise.resolve(false);

  const words = COPY.permission[cap];
  el.permissionTitle.textContent = words.title;
  el.permissionText.textContent = words.text;
  // Escape leaves the previous choice in place, which a second open would then
  // read as a yes. Same reasoning as the logout dialog.
  el.permissionDialog.returnValue = '';

  return new Promise((resolve) => {
    el.permissionDialog.addEventListener(
      'close',
      () => resolve(el.permissionDialog.returnValue === 'go'),
      { once: true }
    );
    el.permissionDialog.showModal();
  });
}

/**
 * The gate every action that needs a permission goes through.
 *
 * Explains first, then hands over to Google — an OAuth window opening straight
 * off a button press is alarming, and the dialog is the only chance to say what
 * the permission is for in MailBoy's own words rather than Google's.
 *
 * Only ever asks for the one scope the capability needs. Re-requesting the whole
 * list would put the permissions somebody has already declined back in front of
 * them every time they press anything.
 *
 * @param {'read' | 'write' | 'rules'} cap
 * @returns {Promise<boolean>} whether the action may now go ahead
 */
async function requireCapability(cap) {
  if (caps[cap]) return true;
  if (!(await confirmPermission(cap))) return false;

  try {
    caps = await requestScopes([CAPABILITIES[cap].ask]);
  } catch (err) {
    // Closing Google's window is a choice, not a failure worth shouting about.
    if (!(err instanceof AuthCancelled)) {
      console.error('[MailBoy] could not request permission:', err);
      flash(COPY.permission.failed, 'error');
    }
    return false;
  } finally {
    paintCapabilities();
  }

  // Google's screen offers the same checkbox again, so "granted" is not the
  // only way back from it.
  if (!caps[cap]) {
    flash(COPY.permission.declined, 'error');
    return false;
  }

  flash(COPY.permission.granted);
  // Whatever the newly permitted thing was is the caller's to get on with — this
  // reports, it does not act, or the screens that ask before they load would run
  // their load twice.
  return true;
}

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

/**
 * The signed-in screens. Only ever one is up, so they are switched as a set
 * rather than each hiding the others itself — six screens is well past where
 * hand-rolled pairs of `hidden` assignments start missing one.
 *
 * They fall into two stacks, which is what the tab bar is: Home is folders →
 * who is filling one → that sender's mail → one message, and Rules is
 * destinations → the rules that send mail there.
 */
const SCREENS = {
  main: () => el.main,
  detail: () => el.detail,
  mails: () => el.mailsScreen,
  message: () => el.messageScreen,
  rules: () => el.rulesScreen,
  ruleDetail: () => el.ruleDetailScreen,
};

/**
 * Which tab each screen belongs to.
 *
 * The bar is painted *from* this rather than set alongside a screen change, so
 * there is no way to end up on a screen with the other tab lit.
 */
const TAB_OF = {
  main: 'home',
  detail: 'home',
  mails: 'home',
  message: 'home',
  rules: 'rules',
  ruleDetail: 'rules',
};

/** Where each tab was left, so switching back does not lose someone's place. */
const lastScreen = { home: 'main', rules: 'rules' };

let currentScreen = 'main';

function showScreen(which) {
  el.boot.hidden = true;
  el.welcome.hidden = true;
  el.app.hidden = false;
  for (const [name, node] of Object.entries(SCREENS)) node().hidden = name !== which;

  currentScreen = which;
  lastScreen[TAB_OF[which]] = which;
  paintTabs();

  setNotice(el.welcomeError, null);
}

function paintTabs() {
  const tab = TAB_OF[currentScreen];
  for (const button of el.navbar.querySelectorAll('.nav-btn')) {
    if (button.dataset.tab === tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

/** Unwind the Home stack to the folder list, one screen at a time so each one
 *  lets go of what it was holding. */
function toHomeRoot() {
  if (!el.messageScreen.hidden) closeMessage();
  if (!el.mailsScreen.hidden) closeMails();
  if (!el.detail.hidden) closeBreakdown();
}

/**
 * Switch tabs, or — pressing the tab already showing — go back to the top of
 * it, which is the one gesture a bar like this is expected to answer.
 *
 * Rules re-reads on every arrival, including that one. It is a single quota unit
 * for every filter on the account, so there is no cheaper thing to do and
 * nothing to decide about staleness.
 */
function showTab(tab) {
  if (TAB_OF[currentScreen] === tab) {
    if (tab === 'home') toHomeRoot();
    else closeRuleGroup();
  } else {
    showScreen(rootedScreen(lastScreen[tab]));
  }

  // Nothing on the Rules screen can be read without the settings permission, so
  // the tab is where it is asked for. The screen is shown either way — a tab
  // that refuses to open says less than one that explains itself — which is what
  // the render before the ask is for: a declined ask leaves that note standing.
  if (tab === 'rules') {
    renderRules();
    void requireCapability('rules').then((ok) => ok && loadRules());
  }
}

/**
 * The remembered screen, or the top of its tab where what it was about has gone.
 *
 * Every one of these is *about* something held in memory — a folder, a sender,
 * an open message, a destination — and an account switch drops all of it. Coming
 * back to a screen with nothing behind it is how you get a blank list with a
 * heading over it.
 */
function rootedScreen(which) {
  const orphaned =
    (which === 'detail' && !openLabel) ||
    (which === 'mails' && !openSender) ||
    (which === 'message' && !openMessageId) ||
    (which === 'ruleDetail' && !openRuleGroup);
  if (!orphaned) return which;
  return TAB_OF[which] === 'rules' ? 'rules' : 'main';
}

function showMain() {
  showScreen('main');
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

// Every glyph in the panel is inline SVG in a 16-unit viewBox — there is no
// icon font, deliberately (see sidepanel.css "Icons"). Stroke weight comes from
// the class the path is mounted under, never from the path itself.
const ICON_ADD = '<path d="M8 3.5v9M3.5 8h9" />';
const ICON_BIN =
  '<path d="M3 4.4h10M6.4 4.4V2.9h3.2v1.5M4.4 4.4l.55 8.05a1 1 0 0 0 1 .95h4.1a1 1 0 0 0 1-.95L11.6 4.4" />';
const ICON_CLOSE = '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />';
// The same glyph the Block button carries (sidepanel.html), so the rule this
// button makes and the row it shows up as are recognisably the same action.
const ICON_BLOCK = '<circle cx="8" cy="8" r="5.4" /><path d="M4.2 11.8L11.8 4.2" />';
// Marks a nested folder row, sitting where the dot does on a top-level one.
const ICON_SUBFOLDER = '<path d="M6 3.5l5 4.5-5 4.5" />';
// The arc flares tangentially into the arrowhead's corner rather than stopping
// on the circle: an L-corner sitting directly on the arc reads as a stub, not
// as an arrow. Same glyph as the top bar's refresh button (sidepanel.html).
const ICON_REFRESH =
  '<path d="M12.72 9.67A5 5 0 1 1 11.54 4.47L14.11 6.89" /><path d="M14.11 3.56V6.89H10.78" />';
// The same power glyph the top bar's Log out carries, for the same action.
const ICON_LOGOUT = '<path d="M8 1.3V8" /><path d="M12.24 4.43a6 6 0 1 1-8.49 0" />';

/**
 * The Block glyph, sized to sit inline in "(⊘ Blocked mails)".
 *
 * A fresh node each call — the Rules tab can pin the destination in both
 * sections at once, and a DOM node belongs to one parent.
 */
function blockIcon() {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="rule-block-icon" viewBox="0 0 16 16" aria-hidden="true">${ICON_BLOCK}</svg>`;
  return wrap.firstElementChild;
}

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

  // A dot marks a leaf — nothing nests under it — and a chevron marks a
  // folder that holds others, whatever depth either sits at. Depth is already
  // conveyed by indent (data-depth in CSS); this is about whether the folder
  // is a container, not where it sits.
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = item.hasChildren
    ? `<svg class="row-icon-chevron" viewBox="0 0 16 16">${ICON_SUBFOLDER}</svg>`
    : '•';

  name.append(icon, document.createTextNode(item.name));

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
    actions.append(actionButton('add', ICON_ADD, COPY.folders.addInside(item.name)));
    if (removable) {
      actions.append(actionButton('delete', ICON_BIN, COPY.folders.removeFolder(item.name), { danger: true }));
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
  if (editable) head.append(actionButton('add', ICON_ADD, COPY.folders.newFolder));
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
    renderGroup(COPY.main.googleFolders, defaultsOf(groups), COPY.main.noGoogleFolders),
    renderGroup(COPY.main.userFolders, groups.user ?? [], COPY.main.noUserFolders, {
      editable: true,
    })
  );

  // A re-render replaces the list wholesale, taking any open editor's DOM with
  // it. Letting the reference go is what stops a create from writing into — and
  // reporting errors against — a detached field nobody can see.
  if (editor && !editor.box.isConnected) editor = null;

  markWorkingRows();

  // Rule rows are named after the folder they point at, so a rebuilt folder
  // list is a reason to redraw them — most visibly on the first load, where the
  // Rules tab can be reached before there are any names to draw with.
  if (!el.rulesScreen.hidden || !el.ruleDetailScreen.hidden) renderRules();
}

/**
 * The whole of Home when the mailbox may not be read.
 *
 * Every other permission is marked on a control that is still there to press;
 * this one has no controls to mark, because without it there are no folders,
 * no counts and no rows — so it takes the screen and carries its own button.
 *
 * `currentGroups` is deliberately left alone. Anything cached from an earlier,
 * wider grant is still a true account of the folder list, and the Rules screen
 * names its destinations from it.
 */
function renderNeedsRead() {
  const card = document.createElement('section');
  card.className = 'permission-card';

  const title = document.createElement('h2');
  title.className = 'permission-card-title';
  title.textContent = COPY.permission.read.title;

  const text = document.createElement('p');
  text.className = 'permission-card-text';
  text.textContent = COPY.permission.read.text;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn--primary btn--sm';
  button.textContent = COPY.permission.read.action;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (await requireCapability('read')) await load({ force: true });
    } finally {
      // Only matters where the ask was declined — a grant replaces this card
      // with the folder list.
      button.disabled = false;
    }
  });

  card.append(title, text, button);
  el.groups.replaceChildren(card);
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
  el.setAttribute('aria-label', COPY.main.measuring);
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
    row.title = COPY.main.countUnavailable;
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
  // way to call one off, so it is never disabled. It carries a visible label
  // as well as the tooltip — the word swaps with the icon rather than just
  // the aria-label/title, since the button shows text now.
  const says = running ? COPY.topbar.stopTitle : COPY.topbar.refreshTitle;
  el.refreshIcon.hidden = running;
  el.stopIcon.hidden = !running;
  el.refreshLabel.textContent = running ? COPY.topbar.stop : COPY.topbar.refresh;
  el.refresh.setAttribute('aria-label', says);
  el.refresh.title = says;
  el.detailSpinner.hidden = !running;
  paintProgress();
  setFooter();
  // Both lists grow a "still reading" row while a pass runs, and lose it when
  // one ends.
  refreshOpenLists();
}

/**
 * Re-render whichever list is on screen.
 *
 * Sizes and senders land every second or so while measuring, and both lists are
 * derived from them — so both have to be redrawn as they arrive, and neither
 * should be redrawn when it is not being looked at. The open message is left
 * alone: its content came from Gmail and a measuring pass says nothing about it.
 */
function refreshOpenLists() {
  if (openSender && !el.mailsScreen.hidden) renderMails();
  else if (openLabel && !el.detail.hidden) renderBreakdown();
  // Not derived from sizes at all — but a rule row is named after the folder it
  // sends mail to, and those names come from the folder list a load rebuilds.
  else if (!el.rulesScreen.hidden || !el.ruleDetailScreen.hidden) renderRules();
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

  el.progressDone.textContent = COPY.notice.done(done, total);
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
 * A short write the user just asked for — a folder being created, rules being
 * removed. It owns the status line for as long as it runs, and the load status
 * it covers is still there afterwards.
 *
 * **Not the long jobs.** Moving mail about has its own card now, because it runs
 * for minutes and a queue can hold several of them; putting that in a line that
 * also has to report a refresh was one slot doing two jobs. What still reaches
 * the footer from a task is its *outcome*, as a flash.
 */
let actionStatus = null;

/** The outcome of one, shown briefly and then given back. */
let flashText = null;
let flashTone = null;
let flashTimer = null;

const FLASH_MS = 7000;

/** How long a failure stays up. Longer than an outcome, because it is the one
 *  thing here that asks the user to do something about it. */
const FLASH_ERROR_MS = 12000;

const FOOTER_TONES = ['footer--busy', 'footer--flash', 'footer--error'];

function setAction(text) {
  actionStatus = text;
  // An outcome supersedes whatever was being reported on the way to it.
  if (text) clearFlash();
  setFooter();
}

function clearFlash() {
  flashText = null;
  flashTone = null;
  clearTimeout(flashTimer);
  flashTimer = null;
}

/**
 * An outcome, held for a few seconds and then given back to whatever the footer
 * was saying before.
 *
 * `tone` is 'error' for anything that did not happen — a refused write, a job
 * that could not finish, an action blocked by another one. Everything else is
 * an outcome and reads as one. This is the only signal the panel gives that
 * something failed: there is no toast and no error dialog for these, so a
 * failure passed in without the tone is a failure the user will not notice.
 */
function flash(text, tone = 'flash') {
  clearFlash();
  flashText = text;
  flashTone = tone;
  flashTimer = setTimeout(
    () => {
      flashText = null;
      flashTone = null;
      setFooter();
    },
    tone === 'error' ? FLASH_ERROR_MS : FLASH_MS
  );
  setFooter();
}

/**
 * The footer's one slot, painted with the tone that belongs to whatever is
 * claiming it. A tone is a class rather than an inline colour so the two themes
 * stay in the stylesheet with everything else.
 */
function paintFooter(text, tone = null) {
  el.footer.classList.remove(...FOOTER_TONES);
  if (tone) el.footer.classList.add(`footer--${tone}`);

  // A failure gets a glyph, because it is the one line here nobody may scroll
  // past. ICON_ALERT is constant markup, which is the only thing innerHTML is
  // used for in this project — the text itself is set as a text node.
  if (tone === 'error') {
    const icon = document.createElement('span');
    icon.innerHTML = ICON_ALERT;
    const glyph = icon.firstElementChild;
    glyph.setAttribute('class', 'footer-icon');
    const label = document.createElement('span');
    label.textContent = text;
    el.footer.replaceChildren(glyph, label);
    return;
  }

  el.footer.textContent = text;
}

function setFooter(timestamp = lastLoaded) {
  lastLoaded = timestamp;

  // Both outrank the load: a refresh runs on its own schedule and says the same
  // thing a second later, where these are answers to something just asked for.
  if (actionStatus) {
    paintFooter(actionStatus, 'busy');
    return;
  }
  if (flashText) {
    paintFooter(flashText, flashTone);
    return;
  }

  // Counting, warm or cold. Once it is done the counts on screen are final,
  // so the timestamp is honest even while sizes are still being read.
  if (progress?.phase === 'counting') {
    paintFooter(COPY.footer.counting(progress.done, progress.total));
    return;
  }

  // Busy, but not counting yet: the pass has not reached enumeration. That gap
  // used to be milliseconds and now is not — a refresh started while the task
  // queue is running waits its turn in the shared quota pacer, which can be tens
  // of seconds (see decision 39). Leaving "Updated 5 minutes ago" up through it
  // says the panel is idle and up to date while it is visibly neither.
  //
  // **Measuring is deliberately not included.** By then enumeration has finished
  // and the counts on screen really are final, so the timestamp is the honest
  // thing to show and the size pass has the card.
  if (busy && !progress) {
    paintFooter(COPY.main.loading);
    return;
  }

  // Measuring with nothing ever loaded. The branch above covers every case that
  // reaches here in practice — `onSizes` stamps the timestamp before it sets the
  // measuring phase — so this is the safety net rather than a path.
  if (!timestamp) {
    paintFooter(busy ? COPY.main.loading : '');
    return;
  }

  paintFooter(COPY.footer.updated(formatAgo(Date.now() - timestamp)));
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
  count: { label: COPY.sorts.count, dir: 'desc', of: (s) => s.count },
  bytes: { label: COPY.sorts.bytes, dir: 'desc', of: (s) => s.bytes },
  rate: { label: COPY.sorts.rate, dir: 'desc', of: (s) => perDay(s) },
  address: { label: COPY.sorts.address, dir: 'asc', of: (s) => s.address || '' },
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
  all: { label: COPY.periods.all, days: 0 },
  y1: { label: COPY.periods.y1, days: 365 },
  m6: { label: COPY.periods.m6, days: 183 },
  m3: { label: COPY.periods.m3, days: 91 },
  m1: { label: COPY.periods.m1, days: 30 },
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
    // Only the ones with a real address. A sender bucketed under a display name
    // has nothing a `from:` rule could be written against, so it can be moved
    // but not ruled about — see `ruleMaterial`.
    addresses: rows.map((sender) => sender.address).filter(Boolean),
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
  // Block follows Move and Delete rather than standing on its own reasoning. It
  // would in fact work here — a rule is about mail that has not arrived, so
  // where the mail on screen is sitting is beside the point — but Trash offers
  // one button in this product, and adding a second is a bigger change than
  // adding a button.
  el.block.hidden = inTrash;
  el.trash.hidden = inTrash;

  // A picker left open goes off screen with its trigger, and would come back
  // still open when the ticks are cleared.
  closeMenus();

  const scope = periodKey === 'all' ? '' : COPY.actions.scopeClause(PERIODS[periodKey].label);
  el.selectionSummary.textContent = COPY.actions.selectedSummary(messages, scope);
  el.selectionSummary.title = COPY.actions.sendersSelected(senders, messages, scope);
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
  // The row opens this sender's mail now, so it is a control rather than a
  // line of text. Not a <button>: it is a grid of its own and the element
  // would fight that, which is the same trade the folder rows make.
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  // The tick is the only part of the row that still toggles, so it stretches
  // the full height of its column rather than being a bare 15px box.
  const { cell: tick, box } = tickBox(
    COPY.breakdown.selectOne(sender.address || sender.name || COPY.breakdown.unknownSender)
  );
  box.checked = picked;

  const who = document.createElement('span');
  who.className = 'sender-who';

  // The address identifies a sender; the display name is whatever they chose
  // to call themselves that day, and the same sender varies it constantly.
  const address = document.createElement('span');
  address.className = 'sender-id';
  address.textContent = sender.address || COPY.breakdown.unknownSender;
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
  row.title = parts.join(' · ') || COPY.breakdown.unknownSender;
  return row;
}

function stillReading() {
  const row = document.createElement('div');
  row.className = 'sender-more';
  row.append(spinner(), Object.assign(document.createElement('span'), {
    textContent: COPY.breakdown.stillReading,
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
    el.senderCount.textContent = '';
    listedSenders = [];
    paintSelection();
    const note = emptyNote(
      !total
        ? COPY.breakdown.nothingYet
        : !cached
          ? COPY.breakdown.noneRead
          : COPY.breakdown.nothingInPeriod
    );
    el.senderRows.replaceChildren(...(busy ? [stillReading(), note] : [note]));
    return;
  }

  el.senderHead.hidden = false;
  el.senderCount.textContent = `(${senders.length.toLocaleString()})`;

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
        COPY.breakdown.moreComing(total - cached)
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
        COPY.breakdown.undated(undated)
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
  el.senderRows.replaceChildren(emptyNote(COPY.breakdown.loading));

  showScreen('detail');
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

/** Every picker behaves identically, so they are wired the same way. */
function closeMenus(except) {
  for (const [trigger, menu] of [
    [el.sortTrigger, el.sortMenu],
    [el.periodTrigger, el.periodMenu],
    [el.mailSortTrigger, el.mailSortMenu],
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
  return !el.sortMenu.hidden || !el.periodMenu.hidden || !el.mailSortMenu.hidden;
}

// ── One sender's mail ────────────────────────────────────────────
//
// The first screen that shows mail rather than figures about it, and the split
// of work is the point:
//
// - **The list is local.** Which messages a sender has in this folder, how big
//   each is and when it arrived all come from the same enumeration and the same
//   cache the breakdown aggregates, so filtering, sorting and paging cost no
//   Gmail calls at all.
// - **The rows are not.** A subject and a first line exist nowhere but on the
//   message. So ten at a time are fetched — one batch, 50 quota units — and
//   held in memory for as long as the screen is up and no longer. Writing them
//   down would break the promise in *What is on disk*.
//
// Ten is what makes that affordable. A scrolling list of a sender's four
// thousand messages would fetch content for all of them.

const MAIL_PAGE = 10;

/** Same shape as SORTS: read the column, and say which way round it starts. */
const MAIL_SORTS = {
  date: { label: COPY.sorts.date, dir: 'desc', of: (id) => dayOf(id) },
  bytes: { label: COPY.sorts.bytes, dir: 'desc', of: (id) => sizeOf(id) ?? 0 },
};

/**
 * Whose mail is listed, which page of it, and how it is ordered.
 * @type {{key: string, address: string, name: string} | null}
 */
let openSender = null;
let mailPage = 0;
let mailSortKey = 'date';
let mailSortDir = MAIL_SORTS.date.dir;

/** The ids the last render listed, in the order it listed them. */
let mailIds = [];

/** Message ids ticked in the open list. Stable, so ticks survive paging. */
let selectedMails = new Set();

/**
 * Subject, first line and exact date per message — fetched a page at a time.
 *
 * Memory only, and cleared with the screen: this is mail content, and the
 * per-message cache on disk deliberately holds nothing of the kind.
 *
 * An id Gmail would not answer for gets an entry all the same, marked `gone`.
 * Without that the row stays permanently "missing" and every render asks again.
 *
 * @type {Map<string, object>}
 */
let mailMeta = new Map();

/** A header fetch is in flight, so the heading can say so. */
let fetchingHeaders = 0;

/**
 * When a refused fetch may be tried again.
 *
 * Without this a batch Gmail will not answer — a 400, a revoked scope — spins:
 * the failure leaves the ids uncached, the retry re-renders, and the re-render
 * asks again. A measuring pass re-rendering this list every second would turn
 * that into a request a second, indefinitely. `fetchMessageHeaders` already
 * retries the transient statuses itself, so anything reaching here is worth
 * waiting on rather than repeating.
 */
let headersBlockedUntil = 0;

const HEADER_RETRY_MS = 30_000;

/**
 * The sender's messages in this folder, in sort order.
 *
 * Re-derived on every render rather than held: a measuring pass keeps adding
 * messages to this sender and a completed job takes them away, and a stale list
 * would page over mail that has moved. It is a filter and a sort over one
 * label's ids, which is nothing beside what the render itself costs.
 *
 * `idsForSelection` is deliberately the same call the actions resolve through,
 * so the rows listed and the mail a Move touches cannot describe different sets.
 */
function mailIdsFor() {
  if (!openLabel || !openSender) return [];

  const ids = idsForSelection(openLabel.id, [openSender.key], sinceDay());
  const { of } = MAIL_SORTS[mailSortKey];
  const sign = mailSortDir === 'asc' ? 1 : -1;

  // The id breaks ties, so paging is deterministic: dates are whole days and
  // sizes collide constantly, and an unstable order would shuffle rows between
  // page 2 and page 3 as the list is re-derived.
  return ids.sort((a, b) => sign * (of(a) - of(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * What is ticked, as the list currently on screen sees it.
 *
 * Filtered against `mailIds` for the same reason the breakdown's is: a tick on
 * a message the current period no longer lists cannot be acted on, so it must
 * not be counted either.
 */
function mailSelectionFacts() {
  const ids = mailIds.filter((id) => selectedMails.has(id));
  return { ids, messages: ids.length };
}

/** The same swap the breakdown does: ticking replaces the sort with actions. */
function paintMailSelection() {
  const { messages } = mailSelectionFacts();
  const picked = messages > 0;

  el.mailsFilters.hidden = picked;
  el.mailsActions.hidden = !picked;

  el.mailSelectAll.checked = picked && messages === mailIds.length;
  el.mailSelectAll.indeterminate = picked && messages < mailIds.length;

  if (!picked) return;

  // Trash offers one thing, and it is the way back — the same rule the
  // breakdown follows, for the same reason (see paintSelection).
  const inTrash = openLabel?.id === 'TRASH';
  el.mailRestore.hidden = !inTrash;
  el.mailMove.hidden = inTrash;
  el.mailBlock.hidden = inTrash;
  el.mailTrash.hidden = inTrash;

  // A picker left open goes off screen with its trigger.
  closeMenus();

  const scope = periodKey === 'all' ? '' : COPY.actions.scopeClause(PERIODS[periodKey].label);
  el.mailSelectionSummary.textContent = COPY.actions.selectedSummary(messages, scope);
  el.mailSelectionSummary.title = COPY.actions.mailsSelected(messages, scope);
}

/** Paint ticks from `selectedMails` rather than trusting the boxes: a measuring
 *  pass rebuilds these rows every second or so. */
function syncMailSelection() {
  for (const row of el.mailRows.querySelectorAll('.mail')) {
    const on = selectedMails.has(row.dataset.id);
    row.classList.toggle('mail--picked', on);
    const box = row.querySelector('input[type="checkbox"]');
    if (box && box.checked !== on) box.checked = on;
  }
  paintMailSelection();
}

function toggleMail(id, on) {
  if (!id) return;
  if (on) selectedMails.add(id);
  else selectedMails.delete(id);
  syncMailSelection();
}

function clearMailSelection() {
  selectedMails = new Set();
  paintMailSelection();
}

function tickBox(label) {
  const cell = document.createElement('label');
  cell.className = 'sender-tick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', label);
  cell.append(box);
  return { cell, box };
}

function renderMail(id) {
  const meta = mailMeta.get(id);

  const row = document.createElement('div');
  row.className = meta?.gone ? 'mail mail--gone' : 'mail';
  row.dataset.id = id;
  // Not a <button>: the row is a grid of its own. Given the role, it has to
  // answer the keyboard like one — same as the folder rows.
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  const picked = selectedMails.has(id);
  row.classList.toggle('mail--picked', picked);

  const { cell, box } = tickBox(COPY.mails.selectOne(meta?.subject || 'this email'));
  box.checked = picked;

  const who = document.createElement('span');
  who.className = 'mail-who';

  const subject = document.createElement('span');
  subject.className = 'mail-subject';

  const snippet = document.createElement('span');
  snippet.className = 'mail-snippet';

  if (!meta) {
    // The figures are cached and land instantly; the subject is a round trip
    // away, so the row appears complete except for the part still coming.
    subject.append(skeleton());
  } else if (meta.gone) {
    subject.textContent = COPY.mails.gone;
    snippet.textContent = COPY.mails.goneWhy;
  } else {
    subject.textContent = meta.subject || COPY.mails.noSubject;
    snippet.textContent = meta.snippet;
  }

  who.append(subject, snippet);

  // Size is exact in the cache and lands with the row.
  const bytes = meta?.bytes || sizeOf(id) || 0;

  // The date is not. The cache keeps whole days and rounds to get them, so
  // roughly half of them sit on the day after the message actually arrived —
  // fine for ordering, which is all the sort needs, and wrong to put on screen.
  // So the column waits for the exact `internalDate` the header fetch brings,
  // rather than showing a date that would silently correct itself a moment
  // later.
  const when = meta?.date ?? 0;
  const date = document.createElement('span');
  date.className = 'sender-figure';
  if (!meta) date.append(skeleton());
  else date.textContent = formatDate(when) || '—';

  row.append(cell, who, figure(formatBytes(bytes)), date);

  const parts = [meta?.subject, formatDateFull(when), formatBytes(bytes)].filter(Boolean);
  row.title = parts.join(' · ');
  return row;
}

/**
 * Numbered pages, windowed to five.
 *
 * A sender with four thousand messages has four hundred pages and no room to
 * list them, so the window is the current page and the next four — enough to
 * jump ahead without the row becoming a scroll of its own. It slides back at
 * the end of the list so the last page is never the only one reachable, and the
 * arrows are what step outside the window.
 */
function renderPager(pages) {
  if (pages <= 1) return null;

  const bar = document.createElement('nav');
  bar.className = 'pager';
  bar.setAttribute('aria-label', COPY.mails.pages);

  const button = (text, page, { label, current = false, disabled = false } = {}) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = current ? 'pager-btn pager-btn--current' : 'pager-btn';
    node.textContent = text;
    node.disabled = disabled;
    if (page !== null) node.dataset.page = String(page);
    node.setAttribute('aria-label', label ?? COPY.mails.page(text));
    if (current) node.setAttribute('aria-current', 'page');
    return node;
  };

  bar.append(
    button('‹', mailPage - 1, { label: COPY.mails.previousPage, disabled: mailPage === 0 })
  );

  const start = Math.max(0, Math.min(mailPage, pages - 5));
  for (let page = start; page < Math.min(pages, start + 5); page++) {
    bar.append(button(String(page + 1), page, { current: page === mailPage }));
  }

  bar.append(
    button('›', mailPage + 1, { label: COPY.mails.nextPage, disabled: mailPage >= pages - 1 })
  );

  return bar;
}

/**
 * Fetch the subjects for the page on screen, then re-render with them.
 *
 * Every id asked for gets an entry, found or not, so a message Gmail will not
 * answer for is asked about once rather than on every render. The re-render
 * then finds nothing missing and does not recurse.
 */
async function ensureHeaders(ids) {
  const missing = ids.filter((id) => !mailMeta.has(id));
  if (!missing.length || Date.now() < headersBlockedUntil) return;

  fetchingHeaders++;
  el.mailsSpinner.hidden = false;

  try {
    const found = await fetchMessageHeaders(missing);
    // Every id asked for, found or not — an entry marked `gone` is what stops
    // a message Gmail will not answer for being asked about on every render.
    for (const id of missing) mailMeta.set(id, shapeHeader(id, found.get(id)));
    headersBlockedUntil = 0;

    if (openSender) renderMails();
  } catch (err) {
    console.warn('[MailBoy] could not read those emails:', err);
    // Nothing is cached, so the rows stay as skeletons and the next render
    // after the cooldown tries again. Deliberately no re-render here: it would
    // be the failing call asking for itself.
    headersBlockedUntil = Date.now() + HEADER_RETRY_MS;
    flash(COPY.mails.readFailed(describeWriteError(err)), 'error');
  } finally {
    fetchingHeaders--;
    el.mailsSpinner.hidden = fetchingHeaders > 0;
  }
}

function renderMails() {
  if (!openSender || !openLabel) return;

  mailIds = mailIdsFor();

  const bytes = mailIds.reduce((sum, id) => sum + (sizeOf(id) ?? 0), 0);
  el.mailsLabel.textContent = openSender.address || openSender.name || COPY.breakdown.unknownSender;
  el.mailsTotal.textContent = mailIds.length
    ? `(${mailIds.length.toLocaleString()} · ${formatBytes(bytes)})`
    : '';

  // The period picker is on the screen behind this one, so the scope has to be
  // stated here or the count is a figure with no visible basis.
  const scope = periodKey === 'all' ? '' : COPY.actions.scopeClause(PERIODS[periodKey].label);
  el.mailsScope.textContent = `${COPY.mails.inFolder(departing())}${scope}`;
  el.mailsScope.title = el.mailsScope.textContent;

  const pages = Math.max(1, Math.ceil(mailIds.length / MAIL_PAGE));
  // A pass that removed messages can leave the page past the end of the list.
  if (mailPage >= pages) mailPage = pages - 1;

  const page = mailIds.slice(mailPage * MAIL_PAGE, mailPage * MAIL_PAGE + MAIL_PAGE);

  el.mailCount.textContent = mailIds.length ? `(${mailIds.length.toLocaleString()})` : '';
  el.mailHead.hidden = !page.length;
  paintMailSelection();

  const nodes = [];
  // Same notice the breakdown carries, at the head for the same reason.
  if (busy) nodes.push(stillReading());

  if (!page.length) {
    nodes.push(
      emptyNote(
        busy
          ? COPY.mails.stillReading
          : COPY.mails.nothingHere
      )
    );
  } else {
    for (const id of page) nodes.push(renderMail(id));
    const pager = renderPager(pages);
    if (pager) nodes.push(pager);
  }

  // Sizes land every second or so while measuring and re-render this list;
  // `replaceChildren` resets the scroll, which yanks the page out from under
  // anyone reading it.
  const scroll = el.mails.scrollTop;
  el.mailRows.replaceChildren(...nodes);
  el.mails.scrollTop = scroll;

  void ensureHeaders(page);
}

function openMails(sender) {
  openSender = { key: senderKey(sender), address: sender.address, name: sender.name };
  mailPage = 0;
  mailIds = [];
  clearMailSelection();
  el.mailHead.hidden = true;
  el.mailRows.replaceChildren(emptyNote(COPY.mails.loading));

  showScreen('mails');
  el.mailsBack.focus();
  renderMails();
}

function closeMails() {
  const previous = openSender?.key;
  openSender = null;
  mailIds = [];
  clearMailSelection();
  // Content, and it belongs to the screen being left.
  mailMeta = new Map();
  closeMenus();

  showScreen('detail');
  renderBreakdown();

  const row = previous && el.senderRows.querySelector(`[data-sender="${CSS.escape(previous)}"]`);
  if (row) row.focus();
  else el.back.focus();
}

/**
 * @param {'date' | 'bytes'} key
 * @param {'asc' | 'desc'} [direction] defaults to whichever way round that
 *   column is useful to start
 */
function setMailSort(key, direction = MAIL_SORTS[key].dir) {
  mailSortKey = key;
  mailSortDir = direction;
  el.mailSortLabel.textContent = MAIL_SORTS[key].label;
  // Re-ordering the whole list changes what page 1 holds, so staying on page 4
  // would be showing a slice of something the user has not seen the start of.
  mailPage = 0;

  for (const option of el.mailSortMenu.querySelectorAll('.picker-option')) {
    option.setAttribute('aria-checked', String(option.dataset.mailsort === key));
  }

  // The column heads and the menu are two ways into the same setting, and
  // aria-sort doubles as the hook the arrow is drawn from.
  for (const head of el.mailHead.querySelectorAll('.col-head[data-mailsort]')) {
    if (head.dataset.mailsort === key) {
      head.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
    } else {
      head.removeAttribute('aria-sort');
    }
  }

  renderMails();
}

// ── One message ──────────────────────────────────────────────────
//
// The only screen that reads a message body, and it reads it as **text**.
//
// Rendering a sender's HTML would mean `innerHTML` over the least trustworthy
// string in the product, and every remote image in it is a read receipt fetched
// the moment the panel draws. `src/mail.js` flattens an HTML part through an
// inert document instead, which runs nothing and loads nothing. The cost is
// layout — a heavily designed newsletter reads as a plain transcript.

/** The message on screen, if any. @type {string | null} */
let openMessageId = null;

/** Move and Delete are always up here, in the place the list behind it put
 *  them — except in Trash, where the rest of the product offers only Restore. */
function paintMessageActions() {
  const inTrash = openLabel?.id === 'TRASH';
  el.messageRestore.hidden = !inTrash;
  el.messageMove.hidden = inTrash;
  el.messageBlock.hidden = inTrash;
  el.messageTrash.hidden = inTrash;
}

function messageLine(text, className) {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

function renderMessage(mail) {
  el.messageSubject.textContent = mail.subject || COPY.mails.noSubject;
  el.messageSubject.title = mail.subject || '';

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const who = document.createElement('strong');
  who.textContent = mail.from.name
    ? `${mail.from.name} <${mail.from.address}>`
    : mail.from.address || COPY.breakdown.unknownSender;
  meta.append(who);

  const when = document.createElement('span');
  when.textContent = [formatDateFull(mail.date), formatBytes(mail.bytes)]
    .filter(Boolean)
    .join(' · ');
  meta.append(when);

  const nodes = [meta];

  if (mail.fromHtml) {
    nodes.push(
      messageLine(
        COPY.message.plainText,
        'message-note'
      )
    );
  }

  nodes.push(
    mail.text
      ? Object.assign(document.createElement('pre'), {
          className: 'message-text',
          textContent: mail.text,
        })
      : emptyNote(COPY.message.noText)
  );

  if (mail.attachments.length) {
    const list = document.createElement('ul');
    list.className = 'message-files';

    const heading = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = COPY.message.attachments(mail.attachments.length);
    heading.append(label);
    list.append(heading);

    for (const file of mail.attachments) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = file.name || COPY.message.unnamed;
      name.title = file.name || '';
      const size = document.createElement('span');
      size.textContent = formatBytes(file.bytes);
      item.append(name, size);
      list.append(item);
    }

    nodes.push(list);
  }

  el.messageView.replaceChildren(...nodes);
}

async function openMessage(id) {
  if (!id) return;
  openMessageId = id;

  // Whatever the list already knows, so the header is not blank for the length
  // of a round trip.
  const known = mailMeta.get(id);
  el.messageSubject.textContent = known?.subject || COPY.mails.noSubject;
  el.messageScope.textContent = COPY.mails.inFolder(departing());
  paintMessageActions();
  el.messageView.replaceChildren(emptyNote(COPY.message.opening));

  showScreen('message');
  el.messageBack.focus();

  try {
    const raw = await getMessage(id);
    // A fast Back followed by a different message.
    if (openMessageId !== id) return;
    renderMessage(shapeMessage(raw));
  } catch (err) {
    console.error('[MailBoy] could not open the message:', err);
    if (openMessageId !== id) return;
    el.messageView.replaceChildren(
      emptyNote(COPY.message.openFailed(describeWriteError(err)))
    );
  }
}

function closeMessage() {
  const previous = openMessageId;
  openMessageId = null;
  el.messageView.replaceChildren();

  showScreen('mails');
  renderMails();

  const row = previous && el.mailRows.querySelector(`[data-id="${CSS.escape(previous)}"]`);
  if (row) row.focus();
  else el.mailsBack.focus();
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
 *
 * `projected` rides along because these numbers may be an action's intent
 * rather than anything Gmail has confirmed, and the panel that owes the
 * reconciling load can be closed before the job ends. Flagging it is what makes
 * the next open pay that debt instead of trusting the projection for a day.
 */
async function saveSnapshot() {
  try {
    const key = await scopedKey(CACHE_NAME);
    if (!key || !currentGroups) return;

    const { [key]: cached } = await chrome.storage.local.get(key);
    if (!cached) return;

    await chrome.storage.local.set({
      [key]: { ...cached, groups: currentGroups, counts: painted, projected },
    });
  } catch (err) {
    console.warn('[MailBoy] could not update the cached folder list:', err);
  }
}

/** Short enough for the status line or the editor, with the detail in the log. */
function describeWriteError(err) {
  // Before the AuthError branch it is a subclass of: reconnecting fixes a stale
  // token and does nothing at all for a permission that was never granted.
  if (err instanceof ScopeError) return COPY.writeErrors.missing;
  if (err instanceof AuthError) return COPY.writeErrors.expired;

  if (err instanceof GmailError) {
    if (err.status === 409) return COPY.writeErrors.duplicate;
    if (err.status === 400) return COPY.writeErrors.badName;
    if (err.status === 403) return COPY.writeErrors.refused;
  }

  // fetch() rejects with a TypeError when it never reached the server.
  if (err instanceof TypeError) return COPY.writeErrors.unreachable;

  return COPY.writeErrors.unknown;
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
  editor.create.textContent = working ? COPY.folders.creating : COPY.folders.create;
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
  input.placeholder = parent ? COPY.folders.newFolderIn(leafOf(parent)) : COPY.folders.newFolder;
  input.setAttribute('aria-label', input.placeholder);
  input.autocomplete = 'off';
  input.spellcheck = false;

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'btn btn--primary btn--sm';
  create.textContent = COPY.folders.create;

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
  setAction(COPY.folders.creatingNamed(leafOf(check.name)));

  try {
    const label = await createFolder(check.name);
    closeEditor();
    setAction(null);
    addFolder(label);
    flash(COPY.folders.created(leafOf(label.name)));
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
    flash(COPY.folders.createFailed(reason), 'error');
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
  // inside it is where the mail is about to go — nobody makes one there for any
  // other reason. So it is rebuilt, and the new row is picked as well as
  // focused, leaving `Move here` as the only thing left to press. The name comes
  // off the row rather than from `label`, so it is the leaf a click would have
  // picked and not the full path.
  if (el.moveDialog.open) {
    renderMoveList();
    const row = moveRowFor(label.id);
    if (row) pickMoveTarget(row.dataset.labelId, row.dataset.labelName);
    row?.focus();
    return;
  }

  rowFor(label.id)?.focus();
}

// ── Deleting ─────────────────────────────────────────────────────

/**
 * Dim the folders a queued delete is working through.
 *
 * They keep their numbers and stay on screen until the job actually finishes —
 * removing a row at the click would claim a completion that a ten-minute Trash
 * pass has not reached. Re-applied after every render, since the rows are
 * rebuilt from scratch each time.
 *
 * Reads the queue rather than one job, so two deletes queued back to back both
 * dim from the moment they are asked for.
 */
function markWorkingRows() {
  for (const row of el.groups.querySelectorAll('.row--working')) {
    row.classList.remove('row--working');
  }
  for (const task of tasks) {
    if (task.kind !== 'folder-delete') continue;
    for (const id of task.labels ?? []) rowFor(id)?.classList.add('row--working');
  }
}

/** The hint tracks the box, because the two outcomes are genuinely different. */
function paintDeleteHint() {
  el.deleteHint.textContent = el.deleteTrash.checked
    ? COPY.deleteFolder.trashHint
    : COPY.deleteFolder.inboxHint;
}

/**
 * @param {number} doomedRules how many rules send mail to this folder, and so
 *   will be deleted alongside it
 * @returns {Promise<{trash: boolean} | null>} null if it was called off
 */
function askDelete(target, children, messages, doomedRules = 0) {
  // showModal throws on an already-open dialog, which a second click would be.
  if (el.deleteDialog.open) return Promise.resolve(null);

  el.deleteName.textContent = COPY.deleteFolder.name(target.name);

  const inside =
    children.length === 1 ? COPY.deleteFolder.oneChild : COPY.deleteFolder.manyChildren(children.length);
  const holds = messages
    ? COPY.deleteFolder.childrenHold(messages)
    : COPY.deleteFolder.childrenEmpty;

  const says = [
    children.length
      ? COPY.deleteFolder.alsoDeletes(inside, holds)
      : messages
        ? COPY.deleteFolder.holds(messages)
        : COPY.deleteFolder.empty,
  ];

  // A rule pointing at a folder that has gone can only ever fail, so it goes
  // with it — and a delete that quietly removed standing instructions the user
  // set up would be the worst kind of surprise, hence saying so here.
  if (doomedRules) {
    says.push(COPY.deleteFolder.rulesGoToo(doomedRules, children.length > 0));
  }

  el.deleteText.textContent = says.join(' ');

  // Nothing to move means there is no choice to offer.
  const movable = messages > 0;
  el.deleteTrash.closest('.checkbox').hidden = !movable;
  el.deleteHint.hidden = !movable;
  el.deleteTrashLabel.textContent = COPY.deleteFolder.trashBox(messages);

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

/**
 * Whether a delete is between the bin being pressed and its dialog being up.
 *
 * There is a round trip in that gap now — one `filters.list`, so the dialog can
 * say what happens to any rules pointing at the folder — and `askDelete`'s own
 * guard cannot cover it: two clicks in that window would both find the dialog
 * closed, and the second `showModal` would throw.
 */
let askingDelete = false;

async function confirmDelete(labelId) {
  if (askingDelete || el.deleteDialog.open) return;

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

  // One quota unit, spent before the dialog so it can say what happens to any
  // rules pointing here. Comes back empty on a failure, which costs the sentence
  // and never the delete.
  const familyIds = family.map((row) => row.id);

  askingDelete = true;
  let choice;
  let doomedRules;
  try {
    doomedRules = await rulesForFolders(familyIds);
    choice = await askDelete(target, children, messages, doomedRules.length);
  } finally {
    askingDelete = false;
  }
  if (!choice) return;

  // The rules go first, and deliberately: a trash pass over a large folder runs
  // for minutes, and a rule left standing through it would file newly arrived
  // mail into a folder that is about to be deleted out from under it. Awaited,
  // because the whole point is that it happens before the job starts; a failure
  // is logged inside deleteRules and must not stop the delete.
  if (doomedRules.length) {
    // Filter ids, deduplicated: one filter can be several rows here.
    const ids = [...new Set(doomedRules.map((rule) => rule.filterId))];
    const { deleted } = await deleteRules(ids).catch(() => ({ deleted: [] }));
    const gone = new Set(deleted);
    rules = rules.filter((rule) => !gone.has(rule.filterId));
  }

  // The folder empties straight away, the same as it does for a selection —
  // and, the same as a selection, the mail does not turn up where it is going
  // until the job says it has arrived. The rows themselves stay until the job
  // says the labels are gone: a folder being emptied is not yet a folder that
  // has been deleted.
  //
  // The inbox path takes the folder's own rows as what it vacates rather than
  // `shedding`, because that is all it does — mail keeps every other folder it
  // is in, which is what makes it a rescue rather than a filing decision.
  queueTask({
    kind: 'folder-delete',
    action: choice.trash ? 'trash' : 'restore-folder',
    ids: family.flatMap((row) => idsIn(row.id)),
    from: choice.trash ? shedding('TRASH') : familyIds,
    destination: choice.trash ? 'TRASH' : 'INBOX',
    trash: choice.trash,
    labels: family.map((row) => ({
      id: row.id,
      name: row.name,
      fullName: row.fullName ?? row.name,
    })),
    // Both paths report a ratio now. The inbox one is over in about a second
    // and simply jumps to full, which is better than being the one task in the
    // queue with no bar.
    total: messages,
  });

  markWorkingRows();
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
  const parts = [COPY.deleteFolder.done(name)];

  if (message.trashed) parts.push(COPY.deleteFolder.trashed(message.trashed));
  else if (message.restored) parts.push(COPY.deleteFolder.restored(message.restored));

  if (message.failed?.length) {
    parts.push(COPY.deleteFolder.someStuck(message.failed.length));
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

/**
 * The task queue as the worker last described it, oldest first.
 *
 * Summaries only — `{id, kind, action, target, total, done, labels, name}` — so
 * this can be re-sent on every batch without a 40,000-id array crossing the port
 * a few times a second. The ids live on the record and travel once, at the
 * ending, where a settlement is worked out from them.
 *
 * @type {object[]}
 */
let tasks = [];

/** Whether anything is moving mail. Not a gate on starting more: see `canAct`. */
const jobRunning = () => tasks.length > 0;

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
/** Every row on screen — Google's folders and yours — as `shedding` counts them. */
const allRows = () => [...defaultsOf(currentGroups ?? {}), ...folderRows()];

function shedding(targetId) {
  return allRows()
    .map((row) => row.id)
    .filter((id) => id !== targetId);
}

// ── Showing an action before Gmail has done it ───────────────────
//
// A trash over a large selection is minutes, and every number on screen used to
// go on describing where the mail was for the whole of it — the row it left,
// the breakdown behind it, the mail list it was ticked in. Pressing Delete and
// watching nothing move reads as the button not working.
//
// **Only the leaving is shown.** The mail drops out of the folder it is going
// from the instant the action is dispatched, and does not appear at its
// destination until the job has actually finished putting it there. So for the
// length of the job it is in no row at all — which is the point: a destination
// row that grew early would invite someone to select that mail and act on it
// while it is still in flight. The status line is what accounts for the
// difference in the meantime.
//
// This is a promise the panel makes on the job's behalf, so it has to be
// settled honestly on every ending — see `settleTask`.

/** Whether the rows are showing an action's intent rather than a real load. */
let projected = false;

/**
 * Whether the counts on screen are a finished enumeration.
 *
 * Only true counts are worth flushing when the panel closes. Mid-enumeration the
 * rows hold a partial pass, and writing those under the previous snapshot's
 * timestamp would leave the next open patching the change log onto numbers that
 * were never right.
 */
let countsSettled = true;

/**
 * The projection each outstanding task is holding, by task id.
 *
 * `ids` is everything the action was dispatched over and `vacated` is what came
 * out of which row — together they are the only way to finish a job off honestly:
 * whatever landed goes to its destination, whatever did not goes back where it
 * came from.
 *
 * **Both are read off the task record**, not merely remembered. That is the
 * whole reason the record carries them, and it is what lets a panel opened
 * hours later stop a job and put the mail back — which the old memory-only
 * projection could not do, and paid for with a full listing every time.
 *
 * @type {Map<string, {action: string, ids: string[], destination: string | null,
 *   vacated: Record<string, string[]>}>}
 */
const projections = new Map();

/**
 * Which rows an action takes the mail **out of**, in the rows MailBoy shows.
 * That is not the list of labels the job sends Gmail, and the gap between the
 * two is the whole of what this has to get right:
 *
 * - A **move** sheds exactly what the job sheds, so those two agree by
 *   construction.
 * - A **trash** sends no label list at all — `messages.trash` is its own call,
 *   and it leaves every user label on the message. In *rows* it is still a
 *   definitive move, because `messages.list` hides trashed mail from every
 *   label but Trash (see `includeSpamTrash` in gmail.js). So a folder's number
 *   drops even though its label is still on the mail, which is exactly what
 *   the next enumeration will find.
 * - A **restore** leaves Trash and nothing else. Where it lands is unknowable
 *   from here — the mail comes back into whatever folders it still carries, and
 *   membership dropped those when it was trashed — which is why a restore is
 *   the one ending that always pays for a real listing.
 *
 * @param {'trash' | 'move' | 'restore'} action
 * @param {string} [targetId] where a move is going
 * @returns {string[]}
 */
function vacating(action, targetId) {
  if (action === 'trash') return shedding('TRASH');
  if (action === 'restore') return ['TRASH'];
  return shedding(targetId);
}

/** Rows carry over whatever `settled` they had: a measuring pass in flight still
 *  owes them sizes, and saying otherwise stops a spinner early over a figure
 *  that is still filling in. */
function paintPatched(touched) {
  if (!touched.length) return;

  const records = recountRows(touched);
  for (const [id, record] of Object.entries(records)) {
    record.settled = painted[id]?.settled ?? false;
  }
  paintRecords(records);
}

/**
 * Take the mail out of the rows it is leaving, and remember enough to finish the
 * job off when the worker reports back.
 *
 * @param {string} id the task holding it
 * @param {{action: string, ids: string[], from: string[],
 *   destination?: string | null}} where
 * @returns {Record<string, string[]>} what came out of which row
 */
function projectTask(id, { action, ids, from, destination = null }) {
  const { touched, removed } = patchMessages(ids, { remove: from });

  projections.set(id, { action, ids: [...ids], destination, vacated: removed });
  projected = true;

  trace('action', `${action} dispatched — showing the mail leaving`, {
    task: id,
    messages: ids.length,
    leaving: touched,
    // Nothing appears here until the job reports back. That is the point.
    destination: destination ?? '(unknowable — will need a listing)',
  });

  paintPatched(touched);
  // The freshness gate means the next open may run no load at all, so a
  // projection that lives only in memory would be undone by closing the panel.
  void saveSnapshot();

  return removed;
}

/**
 * Put an outstanding task's projection back over freshly listed counts.
 *
 * A refresh no longer waits for the queue to drain — somebody who has just asked
 * a folder's worth of mail to move should still be able to re-read the mailbox —
 * and an enumeration finds that mail exactly where it still is, because the job
 * has not moved it yet. Without this, a refresh mid-move would put every hidden
 * email back on screen and then take it away again when the job ended.
 *
 * It also *replaces* what each task believes it vacated, since the rows it is
 * patching are new. That keeps a later stop honest against the counts actually
 * on screen rather than against a set from before the listing.
 */
function reprojectTasks() {
  if (!projections.size) return;

  // Every id the task was dispatched over, not merely the part still
  // outstanding — the queue reports how far along it is, never which ids went.
  // That costs nothing, because removing an id a row no longer holds is a no-op:
  // mail the job has already moved was enumerated where it now is, so it is not
  // in the rows being vacated to begin with.
  const touched = new Set();
  for (const projection of projections.values()) {
    const from = Object.keys(projection.vacated);
    if (!from.length) continue;

    const { touched: rows, removed } = patchMessages(projection.ids, { remove: from });
    projection.vacated = removed;
    for (const rowId of rows) touched.add(rowId);
  }

  trace('action', 're-applied what the queue is holding over a fresh listing', {
    tasks: projections.size,
    rows: [...touched],
  });

  paintPatched([...touched]);
}

/**
 * Settle one task however it ended: put the mail that landed into its
 * destination, put back whatever never moved.
 *
 * **The full listing is the fallback, not the rule.** It used to run on every
 * ending, which meant a clean move of three messages re-listed every row in the
 * mailbox to confirm something the job had already reported. Where the record
 * says exactly which messages are still outstanding and the panel knows where
 * the rest were going, that is the answer — no re-read can improve on it.
 *
 * What is left needing a listing is what is genuinely unknown: a restore, whose
 * destinations were lost when the mail was trashed, and a stopped folder delete,
 * which never tracked ids to begin with.
 *
 * @param {string} id
 * @param {{remaining?: string[], listing?: boolean, why?: string}} outcome
 *   `remaining` are the ids that did **not** move; everything else landed.
 */
function settleTask(id, { remaining = [], listing = false, why } = {}) {
  const projection = projections.get(id);
  projections.delete(id);
  projected = projections.size > 0;

  if (!projection) {
    // Nothing here projected this one — a job adopted from a build before the
    // record carried its own bookkeeping, or an ending arriving twice.
    takeListing(why ?? 'this panel never projected that task');
    return;
  }

  if (listing || projection.action === 'restore' || projection.destination === null) {
    takeListing(why ?? 'a restore lands in folders nothing here can know');
    return;
  }

  const stranded = new Set(remaining);
  const landed = projection.ids.filter((mail) => !stranded.has(mail));
  const touched = new Set();

  trace('action', 'settled from the task’s own record — no listing', {
    task: id,
    landed: landed.length,
    putBack: stranded.size,
    destination: projection.destination,
  });

  if (landed.length) {
    for (const rowId of patchMessages(landed, { add: [projection.destination] }).touched) {
      touched.add(rowId);
    }
  }

  if (stranded.size) {
    // Only the rows these actually came out of, so a message that was never in
    // a row does not get invented into one.
    const back = {};
    for (const [rowId, ids] of Object.entries(projection.vacated)) {
      const mine = ids.filter((mail) => stranded.has(mail));
      if (mine.length) back[rowId] = mine;
    }
    for (const rowId of unpatchMessages(back)) touched.add(rowId);
  }

  paintPatched([...touched]);
  void saveSnapshot();
  stampBookmarkIfSettled();
}

/** The fallback: re-read the mailbox, because what happened is not knowable. */
function takeListing(why) {
  trace('action', `settling by listing the mailbox — ${why}`);
  // A load already running is on its way to those numbers; starting a second
  // one would only be turned away.
  if (!loading) void load({ force: true });
}

/**
 * Move the change-log bookmark past a settled queue.
 *
 * **Only once nothing is outstanding.** Membership describes the mailbox after
 * the jobs, so replaying their own log entries next open would be work for
 * nothing — but a queue with a task still in it is holding mail out of rows
 * Gmail has not moved yet, and bookmarking past that is the one failure the sync
 * cannot detect afterwards.
 *
 * The cost is anything *else* that happened while the queue ran — new mail, a
 * change made in Gmail on another device — which is skipped until the weekly
 * listing.
 */
function stampBookmarkIfSettled() {
  if (projections.size || tasks.length) return;

  void getProfile()
    .then((profile) => stampHistoryId(profile.historyId))
    .catch((err) => console.warn('[MailBoy] could not move the bookmark on:', err));
}

/** How the dialogs name where the mail is coming from. */
function departing() {
  if (!openLabel) return COPY.actions.thisFolder;
  return openLabel.id.startsWith('CATEGORY_') ? COPY.actions.yourInbox : `“${openLabel.name}”`;
}

/** The period picker is off screen in all three places these can be started
 *  from, so every scope line has to carry it. */
function periodClause() {
  return periodKey === 'all' ? '' : COPY.actions.periodClause(PERIODS[periodKey].label);
}

/**
 * Ids of tasks this panel has queued but not yet seen the worker acknowledge.
 *
 * The worker's broadcast is the authority on what is in the queue, and it can
 * land in the gap between the optimistic paint below and the record reaching
 * disk. Without this the card would blink the new task out and back in again.
 *
 * @type {Set<string>}
 */
const enqueuing = new Set();

/**
 * Put an action in the queue: hide the mail it is taking, write the record, and
 * tell the worker there is work.
 *
 * Nothing here waits on anything already running. That is the point of the
 * queue — pressing Move while a Delete is grinding through a folder used to be
 * refused, which is an implementation detail wearing the clothes of a rule.
 *
 * @param {{kind?: 'bulk' | 'folder-delete', action: string, ids: string[],
 *   from: string[], destination?: string | null, add?: string[],
 *   remove?: string[], target?: string, source?: string, total?: number,
 *   labels?: object[], trash?: boolean}} spec `from` is the rows the mail
 *   leaves, which is not the same list as the labels the job sends Gmail — see
 *   `vacating`.
 */
function queueTask({
  kind = 'bulk',
  action,
  ids,
  from,
  destination = null,
  add,
  remove,
  target = '',
  source = '',
  total,
  labels,
  trash,
}) {
  const id = taskId();

  // Take the mail out of the rows it is leaving, now. The job takes minutes, and
  // every re-render until it ends would otherwise redraw the mail exactly where
  // it was — including in the folder it is being taken out of. Where it is
  // *going* waits for the job to say it got there.
  const vacated = projectTask(id, { action, ids, from, destination });

  const task = {
    id,
    kind,
    action,
    startedAt: Date.now(),
    total: total ?? ids.length,
    done: 0,
    add,
    remove,
    target,
    source,
    destination,
    vacated,
    labels,
    trash,
    // A folder delete re-derives its work by listing its own labels, so carrying
    // ids for it would be dead weight — and its `vacated` above is what a
    // settlement puts back. Everything else has to carry its own, because
    // nothing in Gmail records which senders somebody ticked.
    ...(kind === 'bulk' ? { ids: [...ids], remaining: [...ids] } : {}),
  };

  // On screen before the record has even reached disk: the card is the answer to
  // the button, and a write plus a round trip to the worker is long enough to
  // read as nothing having happened.
  enqueuing.add(id);
  tasks = [...tasks, taskSummary(task)];
  paintTasks();

  void enqueueTask(task)
    .then(() => folderChannel().postMessage({ type: 'run' }))
    .catch((err) => {
      console.error('[MailBoy] could not queue that action:', err);
      flash(COPY.move.failed, 'error');
      tasks = tasks.filter((queued) => queued.id !== id);
      paintTasks();
      settleTask(id, { listing: true, why: 'the task could not be written down' });
    })
    .finally(() => enqueuing.delete(id));
}

/** The same shape the worker broadcasts, so the two are interchangeable. */
function taskSummary(task) {
  return {
    id: task.id,
    kind: task.kind,
    action: task.action,
    target: task.target ?? '',
    total: task.total ?? 0,
    done: task.done ?? 0,
    labels: task.labels?.map((label) => label.id) ?? [],
    name: task.labels?.at(-1)?.name ?? '',
  };
}

/**
 * Resolve the ticks to messages and hand the job over.
 *
 * The selection is cleared at the hand-over rather than at the end: the action
 * is under way, the ticks no longer describe anything outstanding, and leaving
 * them up invites a second press of the same button.
 *
 * A job started from an open message ends that screen too — the mail it was
 * showing is on its way somewhere else, and leaving it up would be showing a
 * message in a folder it is leaving.
 */
function dispatchBulk(job, { action, target }) {
  queueTask({
    action,
    ids: job.ids,
    // `target` here is the folder's display name; the id is what a row is keyed
    // on and what `shedding` compares against.
    from: vacating(action, job.add?.[0]),
    // A restore's destinations were lost when the mail was trashed, so there is
    // nothing to settle it with and its ending pays for a listing.
    destination: action === 'trash' ? 'TRASH' : action === 'move' ? job.add?.[0] : null,
    add: job.add,
    remove: job.remove,
    target,
    source: job.source,
  });

  clearSelection();
  clearMailSelection();

  if (!el.messageScreen.hidden) closeMessage();
  else if (!el.mailsScreen.hidden) renderMails();
  else renderBreakdown();
}

/**
 * The one dialog every target-less action uses. Each is a single sentence with
 * the count in the middle, so only the parts around it change.
 *
 * `countText` is for the things being counted that are not emails — rules, most
 * of them. Without it the emphasised middle of a rule dialog would read "3
 * emails", which is precisely what a rule delete does *not* touch.
 *
 * `rule` turns on the pair of rule boxes, and only Delete passes it: a rule that
 * restored future mail would mean nothing, and the dialog is also what confirms
 * deleting rules themselves, where offering to make one would be absurd. The
 * boxes are reset on every open regardless, so a dialog that does not ask for
 * them cannot inherit a tick from one that did.
 *
 * @param {{senders: string[], subject: string | null} | null} [rule]
 * @returns {Promise<{ok: boolean, specs: object[]}>} `specs` is what the boxes
 *   were asking for at the moment the button was pressed — read here rather than
 *   by the caller afterwards, so nothing can come between the click and the read.
 */
function askConfirm({
  verb,
  count,
  countText,
  where,
  text,
  button,
  destructive = false,
  rule = null,
}) {
  // showModal throws on an already-open dialog, which a second click would be.
  if (el.confirmDialog.open) return Promise.resolve({ ok: false, specs: [] });

  // Held for as long as the dialog is up, so ticking a box can recount what it
  // is asking for. Null on a dialog that offers no rules, which is what keeps
  // the hint off there.
  confirmRule = rule;

  el.confirmVerb.textContent = verb;
  el.confirmCount.textContent = countText ?? emails(count);
  el.confirmWhere.textContent = where;
  el.confirmText.textContent = text;
  el.confirmOk.textContent = button;
  el.confirmOk.classList.toggle('dialog-destructive', destructive);

  resetRuleBoxes(TRASH_RULE_BOXES);
  if (rule) {
    paintRuleBoxes(TRASH_RULE_BOXES, rule, { to: COPY.rules.trash, hint: COPY.ruleBoxes.trashHint });
  }

  // Escape leaves the previous choice in place, so a second open would read as
  // a confirmation of the first.
  el.confirmDialog.returnValue = '';

  return new Promise((resolve) => {
    el.confirmDialog.addEventListener(
      'close',
      () => {
        const ok = el.confirmDialog.returnValue === 'go';
        resolve({
          ok,
          specs: ok && rule ? ruleSpecs(TRASH_RULE_BOXES, rule, 'TRASH') : [],
        });
      },
      { once: true }
    );
    el.confirmDialog.showModal();
  });
}

/**
 * What the open confirm dialog could write a rule about, held while it is up.
 *
 * The move dialog keeps the same thing in `moveRule`. Both exist so that ticking
 * a box can recount what is being asked for without the count being passed back
 * through the event.
 *
 * @type {{senders: string[], subject: string | null} | null}
 */
let confirmRule = null;

/**
 * Whether an action can be started at all.
 *
 * There has to be a folder for the removal set to be built against, and that is
 * the whole of it. A job already running is **not** a reason to refuse: actions
 * are queued now, so the answer to "MailBoy is busy" is one more task rather
 * than a message telling somebody to come back later.
 */
function canAct() {
  return Boolean(openLabel);
}

/**
 * Resolve the breakdown's ticks to ids and check nothing has moved out from
 * under them.
 *
 * Always called *before* a dialog opens, and it is the returned array that
 * travels with the job: the number someone is shown has to be the mail that
 * actually moves, not a figure taken from the rows and then re-derived at the
 * click from a cache a measuring pass has moved on since.
 *
 * @returns {{ids: string[], line: string} | null}
 */
function resolveSelection() {
  if (!canAct()) return null;

  const facts = selectionFacts();
  if (!facts.messages) return null;

  const ids = idsForSelection(openLabel.id, facts.keys, sinceDay());
  if (!ids.length) {
    flash(COPY.actions.gone, 'error');
    clearSelection();
    return null;
  }

  const who = COPY.actions.fromSenders(facts.senders);
  return {
    ids,
    line: COPY.actions.fromLine(who, departing(), periodClause()),
    // No subject: a breakdown row is a sender, and the messages behind it carry
    // as many different subjects as they like.
    rule: { senders: facts.addresses, subject: null },
  };
}

/** The subject of one message, as the mail list already has it in memory. */
const subjectOf = (id) => mailMeta.get(id)?.subject || null;

/**
 * The same thing for the mail list, where the ticks are message ids already —
 * no sender to resolve through, so `mailIds` filtering is the whole check.
 *
 * @returns {{ids: string[], line: string} | null}
 */
function resolveMailSelection() {
  if (!canAct() || !openSender) return null;

  const { ids } = mailSelectionFacts();
  if (!ids.length) {
    flash(COPY.actions.gone, 'error');
    clearMailSelection();
    return null;
  }

  const who = openSender.address || openSender.name || COPY.actions.thisSender;
  return {
    ids,
    line: COPY.actions.fromLine(`“${who}”`, departing(), periodClause()),
    // A subject rule is only offered for a single message, because that is the
    // only case where "this subject" names one thing. Ticking twenty messages
    // and getting twenty rules is not what the wording promises.
    rule: {
      senders: openSender.address ? [openSender.address] : [],
      subject: ids.length === 1 ? subjectOf(ids[0]) : null,
    },
  };
}

/**
 * And for the open message, which is a selection of one.
 *
 * The subject rather than the sender: it is what is on screen, and it is what
 * makes the confirmation unmistakably about *this* email.
 *
 * @returns {{ids: string[], line: string} | null}
 */
function resolveOpenMessage() {
  if (!canAct() || !openMessageId) return null;

  const subject = subjectOf(openMessageId) || el.messageSubject.textContent;
  return {
    ids: [openMessageId],
    line: subject
      ? COPY.actions.thisSubject(subject, departing())
      : COPY.actions.thisEmail(departing()),
    // The one place both rules are on offer: there is exactly one sender and
    // exactly one subject on screen.
    rule: {
      senders: openSender?.address ? [openSender.address] : [],
      subject: subject || null,
    },
  };
}

/** @param {{ids: string[], line: string} | null} picked */
async function startTrash(picked) {
  if (!picked) return;
  const { ids, line, rule } = picked;

  const { ok, specs } = await askConfirm({
    verb: COPY.trash.verb,
    count: ids.length,
    where: COPY.trash.where,
    text: COPY.trash.text(line),
    button: COPY.trash.confirm,
    destructive: true,
    // Trash is a destination like any other to a rule, so the same two boxes
    // are on offer here as in the move dialog — the delete handles the mail
    // that is here, a rule handles what arrives.
    rule: rule ?? null,
  });
  if (!ok) return;

  dispatchBulk({ action: 'trash', ids, target: 'Trash', source: openLabel.name }, {
    action: 'trash',
    target: 'Trash',
  });

  // After the dispatch, for the same reason a move's rules are: the projection
  // is what makes the button look like it worked, and a refused filter must not
  // read as the delete having failed.
  if (specs.length) void applyRules(specs, COPY.rules.trash);
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
async function startRestore(picked) {
  if (!picked) return;
  const { ids, line } = picked;

  // No rule boxes: "restore all future mail from this sender" describes nothing
  // — mail does not arrive in Trash.
  const { ok } = await askConfirm({
    verb: COPY.restore.verb,
    count: ids.length,
    where: COPY.restore.where,
    text: COPY.restore.text(line),
    button: COPY.restore.confirm,
  });
  if (!ok) return;

  dispatchBulk({ action: 'restore', ids, add: ['INBOX'], remove: ['TRASH'], target: 'Inbox' }, {
    action: 'restore',
    target: 'Inbox',
  });
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
    sections.push(renderGroup(COPY.main.googleFolders, defaults, '', { counted: false }));
  }
  sections.push(
    renderGroup(COPY.main.userFolders, user, COPY.main.noUserFolders, {
      editable: true,
      counted: false,
      removable: false,
    })
  );

  el.moveList.replaceChildren(...sections);
  // The list is rebuilt whenever a folder is created from inside the dialog, so
  // the pick has to be re-applied rather than living on the element alone.
  paintMoveTarget();
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

/**
 * The folder picked in the open dialog, or null while nothing is picked.
 *
 * Picking is a selection now, not the confirmation — `Move here` is — so the
 * choice has to be held somewhere between the two clicks. Held as `{id, name}`
 * rather than as the row element because the list is rebuilt whenever a folder
 * is created from inside the dialog, which would strand the reference.
 *
 * @type {{ id: string, name: string } | null}
 */
let moveTarget = null;

/**
 * What the open move dialog could write a rule about: the senders behind the
 * selection, and the one subject if the selection is one message.
 *
 * Resolved with the ids and held for the same reason they are — the dialog stays
 * open while folders are made in it, and a measuring pass keeps moving the
 * ground underneath.
 *
 * @type {{senders: string[], subject: string | null} | null}
 */
let moveRule = null;

/**
 * Show which destination is picked, and let `Move here` act only once one is.
 *
 * `aria-current` rather than `aria-pressed`: this is the current item of a set,
 * not a toggle, so clicking the picked folder again leaves it picked.
 */
function paintMoveTarget() {
  for (const row of el.moveList.querySelectorAll('.row')) {
    if (row.dataset.labelId === moveTarget?.id) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
  el.moveConfirm.disabled = !moveTarget;
  // The boxes name the destination once there is one, so picking a folder
  // rewords them. Before a folder is picked there is nothing to name, and "this
  // folder" is still true — the list is right there.
  paintRuleBoxes(MOVE_RULE_BOXES, moveRule, {
    to: moveTarget ? `“${moveTarget.name}”` : COPY.ruleBoxes.thisFolder,
    hint: COPY.ruleBoxes.moveHint,
  });
}

/**
 * The three rule boxes, as they appear in one dialog.
 *
 * There are two sets of them — the move dialog's and the delete confirmation's —
 * and they behave identically. Only the destination they name and the
 * consequence they warn about differ, so both are passed in rather than the
 * whole thing being written twice and drifting.
 */
const MOVE_RULE_BOXES = {
  senderRow: () => el.ruleSenderRow,
  sender: () => el.ruleSender,
  senderLabel: () => el.ruleSenderLabel,
  domainRow: () => el.ruleDomainRow,
  domain: () => el.ruleDomain,
  domainLabel: () => el.ruleDomainLabel,
  subjectRow: () => el.ruleSubjectRow,
  subject: () => el.ruleSubject,
  subjectLabel: () => el.ruleSubjectLabel,
  hint: () => el.ruleHint,
};

const TRASH_RULE_BOXES = {
  senderRow: () => el.trashRuleSenderRow,
  sender: () => el.trashRuleSender,
  senderLabel: () => el.trashRuleSenderLabel,
  domainRow: () => el.trashRuleDomainRow,
  domain: () => el.trashRuleDomain,
  domainLabel: () => el.trashRuleDomainLabel,
  subjectRow: () => el.trashRuleSubjectRow,
  subject: () => el.trashRuleSubject,
  subjectLabel: () => el.trashRuleSubjectLabel,
  hint: () => el.trashRuleHint,
};

/**
 * The distinct domains behind a set of addresses, in the order they first
 * appear. Two senders at the same company are one domain rule, not two.
 *
 * Anything without an `@` is dropped rather than treated as a bare domain: that
 * would turn a malformed `From` into a rule reading `@something`, which is a
 * wider instruction than anybody asked for.
 */
const domainsIn = (addresses) => [
  ...new Set(addresses.filter((address) => address.includes('@')).map(domainOf).filter(Boolean)),
];

/**
 * What the sender box was before a domain tick forced it on, so unticking the
 * domain gives it back rather than silently clearing a yes somebody made.
 *
 * Keyed on the input itself: the two dialogs have their own, and neither should
 * be able to read the other's.
 *
 * @type {WeakMap<HTMLInputElement, boolean>}
 */
const senderWas = new WeakMap();

/**
 * Paint one dialog's three.
 *
 * Each box is shown only where its wording is true. "This sender" and "this
 * domain" both need an address — a sender bucketed under a display name has
 * nothing a `from:` rule could be written against — and "this subject" needs
 * there to be exactly one, which is only ever the case for a single message.
 *
 * @param {object} boxes MOVE_RULE_BOXES or TRASH_RULE_BOXES
 * @param {{senders: string[], subject: string | null} | null} material
 * @param {{to: string, hint: string}} copy `to` is the destination as it reads
 *   in the sentence — a quoted folder name, or `Trash`
 */
function paintRuleBoxes(boxes, material, copy) {
  // Without permission to make rules there is no honest version of these: they
  // are an extra offered alongside a move or a delete, and interrupting that
  // action with a second permission dialog for something nobody came here for
  // is worse than not offering it. The Rules tab is where the permission is
  // asked for, and it is where the boxes come back from.
  const senders = caps.rules ? (material?.senders ?? []) : [];
  const subject = caps.rules ? (material?.subject ?? null) : null;
  const domains = domainsIn(senders);

  boxes.senderRow().hidden = senders.length === 0;
  boxes.senderLabel().textContent =
    senders.length > 1
      ? COPY.ruleBoxes.senders(senders.length, copy.to)
      : COPY.ruleBoxes.sender(copy.to);

  // The domain is named where there is one of it, because which domain this is
  // decides the answer — "everything from gmail.com" is a very different offer
  // from "everything from acme-invoices.com", and the sender's address alone
  // does not make that obvious enough to tick a box on.
  boxes.domainRow().hidden = domains.length === 0;
  boxes.domainLabel().textContent =
    domains.length > 1
      ? COPY.ruleBoxes.domains(domains.length, copy.to)
      : COPY.ruleBoxes.domain(domains[0] ?? '', copy.to);

  boxes.subjectRow().hidden = !subject;
  boxes.subjectLabel().textContent = COPY.ruleBoxes.subject(copy.to);

  syncDomainLock(boxes);
  paintRuleHint(boxes, material, copy);
}

/**
 * Hold the sender box ticked and disabled for as long as the domain box is.
 *
 * A domain rule already catches everything the sender rule would, so the two
 * cannot be a real choice — and leaving the sender box tickable next to a ticked
 * domain box would invite someone to ask for a second rule that does nothing but
 * spend one of Gmail's thousand.
 *
 * Ticked rather than merely greyed: the question the box asks is "does future
 * mail from this sender move", and under a domain rule the honest answer is yes.
 * `ruleSpecs` is where that stops being a second rule.
 */
function syncDomainLock(boxes) {
  const sender = boxes.sender();
  const locked = boxes.domain().checked && !boxes.domainRow().hidden;

  if (locked) {
    if (!sender.disabled) senderWas.set(sender, sender.checked);
    sender.checked = true;
    sender.disabled = true;
  } else if (sender.disabled) {
    sender.checked = senderWas.get(sender) ?? false;
    sender.disabled = false;
  }

  boxes.senderRow().classList.toggle('checkbox--locked', locked);
}

/**
 * What ticking a box actually signs someone up for.
 *
 * Only shown once something is ticked: the distinction between mail that is here
 * and mail that is not is the whole of what these boxes add, and it is noise
 * against a dialog nobody has ticked anything in.
 */
function paintRuleHint(boxes, material, copy) {
  // The destination is beside the point here — only how many rules are being
  // asked for, which is what the boxes decide.
  const wanted = ruleSpecs(boxes, material, '');
  if (!wanted.length) {
    boxes.hint().hidden = true;
    return;
  }

  const lines = [copy.hint];
  // A domain rule is the one box here that catches mail from people who have
  // never written before, which is the whole of what makes it useful and the
  // whole of what makes it worth a second thought.
  if (boxes.domain().checked && !boxes.domainRow().hidden) {
    lines.push(COPY.ruleBoxes.domainWarning);
  }
  // Gmail's ceiling is 1,000 filters across everything the account has ever
  // made, so a selection of a few hundred senders is worth saying out loud
  // before it is spent rather than after.
  if (wanted.length > 25) {
    lines.push(COPY.ruleBoxes.ceiling(wanted.length, MAX_RULES));
  }

  boxes.hint().textContent = lines.join(' ');
  boxes.hint().hidden = false;
}

/**
 * The rules the ticked boxes ask for, as specs `createRules` takes.
 *
 * The boxes are read here rather than remembered, so what is created is what is
 * ticked at the moment the dialog's own button is pressed.
 *
 * **A ticked domain box replaces the sender rules rather than adding to them.**
 * The sender box is ticked and disabled beside it (see `syncDomainLock`) because
 * the answer to what it asks is yes — but a domain rule already catches that
 * mail, so a sender rule as well would be a second filter doing nothing, against
 * an account that is allowed a thousand of them. One rule per distinct domain.
 */
function ruleSpecs(boxes, material, destination) {
  const specs = [];
  const senders = material?.senders ?? [];
  const byDomain = boxes.domain().checked && !boxes.domainRow().hidden;

  if (byDomain) {
    for (const domain of domainsIn(senders)) {
      specs.push({ kind: 'domain', match: domain, destination });
    }
  } else if (boxes.sender().checked && !boxes.senderRow().hidden) {
    for (const address of senders) {
      specs.push({ kind: 'sender', match: address, destination });
    }
  }

  if (boxes.subject().checked && !boxes.subjectRow().hidden && material?.subject) {
    specs.push({ kind: 'subject', match: material.subject, destination });
  }

  return specs;
}

/** Untick and hide a set, so no dialog ever opens carrying a previous yes. */
function resetRuleBoxes(boxes) {
  // Before the ticks: unlocking reads the remembered state back, and there is
  // nothing to remember once a dialog is being reset.
  boxes.domain().checked = false;
  syncDomainLock(boxes);

  boxes.sender().checked = false;
  boxes.subject().checked = false;
  boxes.senderRow().hidden = true;
  boxes.domainRow().hidden = true;
  boxes.subjectRow().hidden = true;
  boxes.hint().hidden = true;
}

function closeMoveDialog() {
  moveIds = null;
  moveTarget = null;
  moveRule = null;
  // Never carried between opens. A rule outlives the action that made it, so a
  // box remembering a previous yes would quietly file mail nobody asked it to —
  // the same reasoning the folder delete's Trash box is cleared under.
  resetRuleBoxes(MOVE_RULE_BOXES);
  // The editor lives inside the dialog; leaving it open would strand a field
  // nobody can see, still holding a half-typed name.
  closeEditor();
  if (el.moveDialog.open) el.moveDialog.close();
}

function startMove(picked) {
  if (el.moveDialog.open || !picked) return;

  // The removal set is built from the folder list, so a move cannot be started
  // before that list exists — a half-built one would shed only some folders and
  // leave the mail in two places, which is the one outcome this must not have.
  if (!currentGroups) {
    flash(COPY.actions.foldersNotReady, 'error');
    return;
  }

  const { ids, line, rule } = picked;

  moveIds = ids;
  // Never inherited from a previous open: the dialog opens with nothing picked
  // and `Move here` disabled, whatever was chosen last time.
  moveTarget = null;
  moveRule = rule ?? null;
  resetRuleBoxes(MOVE_RULE_BOXES);
  el.moveCount.textContent = emails(ids.length);
  el.moveText.textContent = COPY.move.text(line);

  // renderMoveList paints the boxes on its way through paintMoveTarget.
  renderMoveList();
  el.moveDialog.showModal();
}

/** Clicking a folder picks it. Nothing moves until `Move here` is pressed. */
function pickMoveTarget(labelId, name) {
  if (!labelId) return;
  moveTarget = { id: labelId, name };
  paintMoveTarget();
}

/**
 * `Move here` — the confirmation.
 *
 * A move is definitive and cannot be undone as one action, so the destination
 * is chosen and then confirmed rather than dispatched on the first click that
 * lands in a dense list of folder names.
 */
function confirmMove() {
  const ids = moveIds;
  const labelId = moveTarget?.id;
  const name = moveTarget?.name ?? '';
  if (!openLabel || !labelId || !ids?.length) return;

  // Read before the dialog is torn down, since closing it clears the boxes.
  const specs = ruleSpecs(MOVE_RULE_BOXES, moveRule, labelId);

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
    { action: 'move', target: name }
  );

  // After the dispatch, not before it: the projection is what makes the button
  // look like it worked, and it should not queue behind a settings write. The
  // rules are a second, independent thing — a refused filter must not read as
  // the move having failed, which is why nothing here is awaited or thrown.
  if (specs.length) void applyRules(specs, `“${name}”`);
}

/**
 * Create the rules a move was ticked for.
 *
 * The list is re-read first, for one quota unit, and that buys two things worth
 * more than the unit: an existing rule saying the same thing is not made twice,
 * and Gmail's 1,000-filter ceiling is checked against the account's real total
 * rather than against what MailBoy happens to remember.
 *
 * "Saying the same thing" now includes a filter the user made in Gmail, since
 * those are read too. That is the answer worth having: a second filter doing
 * what one already does is clutter and one more against the ceiling, and the
 * mail lands where it was going to land either way.
 *
 * The outcome is a flash, which a long move's status line will sit on top of
 * (see `setFooter`) — the Rules tab is the durable answer either way.
 *
 * `whenFailed` is passed because the usual line reassures about a move that is
 * already under way, and Block dispatches no move at all: telling someone their
 * emails are moving when nothing is would be the one wrong thing to say.
 */
async function applyRules(specs, where, whenFailed = COPY.rules.addFailedDuringMove) {
  try {
    const { rules: existing, filters } = await listRules();
    rules = existing;
    rulesLoaded = true;

    const fresh = specs.filter((spec) => !existing.some((rule) => sameRule(rule, spec)));
    if (!fresh.length) {
      flash(COPY.rules.alreadyHad(specs.length));
      return;
    }

    const room = MAX_RULES - filters;
    if (room <= 0) {
      flash(COPY.rules.full(MAX_RULES), 'error');
      return;
    }

    const wanted = fresh.slice(0, room);
    const { created, failed } = await createRules(wanted);
    rules = [...rules, ...created];
    renderRules();

    const parts = [];
    if (created.length) {
      parts.push(
        created.length === 1
          ? COPY.rules.added(where)
          : COPY.rules.addedMany(created.length, where)
      );
    }
    if (fresh.length > wanted.length) {
      parts.push(COPY.rules.noRoom(fresh.length - wanted.length));
    }
    if (failed.length) parts.push(COPY.rules.someFailed(failed.length));

    // A refused rule takes the failure tone even where others landed: this is
    // the only signal the panel gives that one did not, and the neutral voice
    // here reads exactly like the line saying the rest were added.
    flash(parts.join(' '), failed.length ? 'error' : undefined);
  } catch (err) {
    console.error('[MailBoy] could not add the rule:', err);
    flash(whenFailed, 'error');
  }
}

// ── Blocking a sender ────────────────────────────────────────────
//
// The only action in the product that moves no mail. A block is one rule and
// nothing else — everything from this sender goes straight to Trash from now on
// — so it shares `applyRules` with the boxes in the move and delete dialogs and
// owns none of the job machinery those actions need.
//
// It is deliberately *not* the Trash box on the delete confirmation with the
// delete taken away. That box is an afterthought to an action about the mail
// already here; this is the whole ask, which is why it gets a button in the
// tools row and a dialog whose one sentence is about mail that has not arrived.
//
// **A block is about senders, not about the ticks.** On the breakdown that is
// every sender ticked; on the two mail screens it is the sender whose mail is
// being read, whichever messages happen to be selected. A rule cannot be about
// ten particular messages, and pretending otherwise in the wording would be a
// promise Gmail has no way to keep.

/**
 * The addresses the open block dialog would write rules about.
 *
 * Held while it is up for the same reason `moveRule` is: ticking the domain box
 * has to recount what is being asked for, and the lists behind the dialog keep
 * moving as a measuring pass lands.
 *
 * @type {string[]}
 */
let blockAddresses = [];

/**
 * Who a Block from the breakdown would be about.
 *
 * `selectionFacts().addresses` already drops the senders bucketed under a
 * display name — there is nothing a `from:` rule could be written against for
 * those — so the difference between that and the row count is what `skipped`
 * reports. Saying it out loud beats quietly blocking four of five.
 *
 * @returns {{addresses: string[], skipped: number, count: number} | null}
 */
function blockFromSelection() {
  const facts = selectionFacts();
  if (!facts.senders) return null;
  return {
    addresses: [...new Set(facts.addresses.map((address) => address.toLowerCase()))],
    skipped: facts.senders - facts.addresses.length,
    count: facts.senders,
  };
}

/**
 * And from either mail screen, where the subject of a block is the sender whose
 * list is open rather than anything ticked in it.
 */
function blockOpenSender() {
  if (!openSender) return null;
  const address = openSender.address;
  return {
    addresses: address ? [address.toLowerCase()] : [],
    skipped: address ? 0 : 1,
    count: 1,
  };
}

/**
 * The rules the dialog is currently asking for.
 *
 * The sender rules are the default rather than a box, because blocking *is* the
 * sender rule — the box only widens it. A ticked domain box replaces them rather
 * than adding to them, for the same reason it does in the other two dialogs: a
 * domain rule is a strictly wider sender rule with the same action, so making
 * both would spend two of Gmail's thousand filters to do one thing.
 */
function blockSpecs() {
  const matches = blockByDomain() ? domainsIn(blockAddresses) : blockAddresses;
  const kind = blockByDomain() ? 'domain' : 'sender';
  return matches.map((match) => ({ kind, match, destination: 'TRASH' }));
}

/** The row's own visibility is part of the answer: a box nobody can see cannot
 *  be what is being asked for, however it was left. */
const blockByDomain = () => el.blockDomain.checked && !el.blockDomainRow.hidden;

/** What ticking the box, or blocking a great many senders at once, signs up for. */
function paintBlockHint() {
  const lines = [];
  // The one box here that catches mail from people who have never written
  // before — the whole of what makes a domain block useful, and the whole of
  // what makes it worth a second thought.
  if (blockByDomain()) {
    lines.push(COPY.block.domainWarning);
  }
  // Gmail's ceiling is 1,000 filters across everything the account ever made,
  // and a breakdown selection can run to hundreds of senders.
  const wanted = blockSpecs().length;
  if (wanted > 25) {
    lines.push(COPY.ruleBoxes.ceiling(wanted, MAX_RULES));
  }

  el.blockHint.textContent = lines.join(' ');
  el.blockHint.hidden = lines.length === 0;
}

/**
 * Block whoever the screen's selection points at.
 *
 * @param {{addresses: string[], skipped: number, count: number} | null} material
 */
async function startBlock(material) {
  // showModal throws on an already-open dialog, which a second click would be.
  if (!material || el.blockDialog.open) return;

  if (!material.addresses.length) {
    flash(
      material.count === 1 ? COPY.block.noAddress : COPY.block.noAddresses,
      'error'
    );
    return;
  }

  blockAddresses = material.addresses;
  const domains = domainsIn(blockAddresses);

  el.blockWho.textContent =
    blockAddresses.length === 1
      ? COPY.block.who(blockAddresses[0])
      : COPY.block.manyWho(blockAddresses.length);

  const skipped = material.skipped
    ? COPY.block.skipped(material.skipped, material.count)
    : '';

  el.blockText.textContent = `${COPY.block.text}${skipped}`;

  // Named, because which domain this is decides the answer: "everyone at
  // gmail.com" is a very different offer from "everyone at acme-invoices.com",
  // and the sender's address alone does not make that obvious enough to tick.
  el.blockDomainLabel.textContent =
    domains.length > 1
      ? COPY.block.domainsBox(domains.length)
      : COPY.block.domainBox(domains[0] ?? '');
  el.blockDomainRow.hidden = domains.length === 0;

  // Unticked on every open. A rule outlives the action that made it, so a box
  // remembering a previous yes would go on destroying mail nobody asked it to —
  // the same reasoning every other rule box is cleared under.
  el.blockDomain.checked = false;
  paintBlockHint();

  // Escape leaves the previous choice in place, so a second open would read as
  // a confirmation of the first.
  el.blockDialog.returnValue = '';

  const specs = await new Promise((resolve) => {
    el.blockDialog.addEventListener(
      'close',
      () => {
        // Read here rather than by the caller afterwards, so nothing can come
        // between the click and the read.
        resolve(el.blockDialog.returnValue === 'go' ? blockSpecs() : []);
        blockAddresses = [];
      },
      { once: true }
    );
    el.blockDialog.showModal();
  });

  if (specs.length) void applyRules(specs, COPY.rules.trash, COPY.block.ruleFailed);
}

// ── The task card ────────────────────────────────────────────────
//
// Its own card, beside the footer rather than inside a screen, because mail is
// moved from four different screens and a report that only appears on one of
// them is not a report. The load keeps its own card in its own place above this
// one, so a refresh started mid-move says what it always said.
//
// **The bar is determinate**, and honestly so: a queue knows exactly how many
// emails it set out to move and exactly how many it has. No time estimate — a
// queue can hold a move that takes a second behind a trash that takes twenty
// minutes, so a single rate would be a number that means nothing. What the body
// says instead is why it is slow, which is the thing somebody actually wants to
// know.

/** What the head of the queue is doing, in one line. */
function taskTitle(task) {
  if (!task) return COPY.tasks.title.working;
  if (task.kind === 'folder-delete') {
    return task.name ? COPY.tasks.title.emptying(task.name) : COPY.tasks.title.deleting;
  }
  if (task.action === 'trash') return COPY.tasks.title.trash;
  if (task.action === 'restore') return COPY.tasks.title.restore;
  if (task.action === 'move' && task.target) return COPY.tasks.title.move(task.target);
  return COPY.tasks.title.working;
}

function paintTasks() {
  const [head, ...waiting] = tasks;
  el.taskCard.hidden = !head;
  if (!head) return;

  el.taskTitle.textContent = taskTitle(head);
  el.taskQueued.textContent = waiting.length ? COPY.tasks.queued(waiting.length) : '';

  // `done` can overshoot: a message under both a parent's folder and a child's
  // is counted once per row, and Gmail moves it once.
  const total = tasks.reduce((sum, task) => sum + (task.total ?? 0), 0);
  const done = Math.min(
    tasks.reduce((sum, task) => sum + (task.done ?? 0), 0),
    total
  );

  el.taskDone.textContent = total ? COPY.tasks.done(done, total) : '';
  el.taskProgress.classList.toggle('progress--indeterminate', !total);

  if (!total) {
    el.taskProgressBar.style.width = '';
    el.taskProgress.removeAttribute('aria-valuenow');
    return;
  }

  const percent = Math.round((done / total) * 100);
  el.taskProgressBar.style.width = `${percent}%`;
  el.taskProgress.setAttribute('aria-valuenow', String(percent));
}

/**
 * Stop everything queued.
 *
 * One button for the whole queue rather than one per task: they are one piece of
 * work as far as the mailbox is concerned, and a card offering four stops in a
 * side panel is a worse answer than a card offering one.
 *
 * The panel does not wait to hear back. The worker empties the queue and reports
 * each task's outstanding ids, which is what `settleTask` puts back — but the
 * card should go the moment the button is pressed, or a stop reads as having
 * done nothing for as long as the batch in flight takes.
 */
function stopTasks() {
  if (!tasks.length) return;
  trace('job', 'stop pressed — calling off the whole queue', { tasks: tasks.length });
  chrome.runtime.sendMessage({ type: 'stop', job: 'tasks' }).catch(() => {});

  // The card goes now, not when the worker gets round to answering. Same call
  // `stopLoad` makes: the panel has no reason to sit through a batch already in
  // flight, and a stop button that leaves the thing it stopped on screen reads
  // as not having worked. The mail comes back as each ending lands.
  tasks = [];
  paintTasks();
  markWorkingRows();
}

function summariseBulk(message, action, target) {
  if (action === 'trash') {
    const parts = [COPY.trash.done(message.trashed ?? 0)];
    if (message.failed?.length) parts.push(COPY.trash.someStuck(message.failed.length));
    return parts.join(' ');
  }
  if (action === 'restore') return COPY.restore.done(message.moved ?? 0);
  return COPY.move.done(message.moved ?? 0, target);
}

// ── Talking to the worker about the queue ────────────────────────

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

/**
 * Nothing here re-sends a task: the worker owns the queue, and the record on
 * disk is what makes reconnecting safe.
 *
 * Two kinds of message. `tasks` is the queue as it stands and is purely a
 * report — it paints the card and dims the folders being emptied, and never
 * settles anything. `task-ended` is the one that changes numbers, because only
 * an ending knows which mail actually moved.
 */
function onFolderMessage(message) {
  if (message?.type === 'tasks') {
    // A task this panel has just queued may not be in the worker's answer yet.
    // Dropping it here would blink it out of the card and back in again.
    const known = new Set(message.queue.map((task) => task.id));
    const mine = tasks.filter((task) => enqueuing.has(task.id) && !known.has(task.id));

    tasks = [...message.queue, ...mine];
    paintTasks();
    markWorkingRows();
    return;
  }

  if (message?.type !== 'task-ended') return;

  const name = message.name || 'Folder';

  // Neither of these settles anything. The task is still in the worker's queue
  // and will be tried again, so the mail it is holding stays held — putting it
  // back now would show it moving, moving back, and then moving again. The card
  // stays up for the same reason, and because the stop button on it is the way
  // out.
  if (message.ending === 'throttled') {
    // Not an error, and not worded as one: nothing failed and nothing was
    // refused. Google is limiting how fast mail can be moved, which is the one
    // thing about this product a user cannot be expected to guess.
    trace('job', 'task throttled — it stays queued', { task: message.id });
    flash(COPY.tasks.throttled);
    return;
  }

  if (message.ending === 'failed') {
    console.error('[MailBoy] task failed:', message.message);
    flash(COPY.tasks.retrying, 'error');
    return;
  }

  tasks = tasks.filter((task) => task.id !== message.id);
  paintTasks();

  const stopped = message.ending === 'stopped';

  if (message.kind === 'folder-delete') {
    if (stopped) {
      markWorkingRows();
      flash(COPY.deleteFolder.stopped(name));
      // A folder delete keeps no ids of its own — it re-derives its work by
      // listing — so what it managed before the stop is genuinely unknown.
      settleTask(message.id, { listing: true, why: 'the delete was stopped partway' });
      return;
    }

    removeFolders((message.labels ?? []).map((label) => label.id));
    flash(summariseDelete(message, name));
    // Both paths have a destination the panel knows — Trash, or the inbox — so
    // a completed one settles from the record. The job lists its own labels
    // rather than taking the ids the panel projected, so the two sets can differ
    // slightly where mail arrived mid-job; the weekly listing squares that up.
    settleTask(message.id, { remaining: [] });
    return;
  }

  const summary = summariseBulk(message, message.action, message.target ?? '');
  flash(stopped ? COPY.tasks.stopped(message.remaining?.length ?? 0) : summary);

  // `remaining` is exactly the mail that did not move — refusals on a completed
  // run, everything untouched on a stopped one — and the record carried it, so
  // there is nothing here that needs a re-read to find out.
  settleTask(message.id, { remaining: message.remaining ?? [] });
}

/**
 * Whether the queue has been read off disk and turned into panel state.
 *
 * Until it has, `jobOutstanding` falls back to the record itself; afterwards it
 * must not, since the worker's word is the current one.
 */
let jobsAdopted = false;

/**
 * Housekeeping at boot, so a failure here costs the dimming, never the panel.
 *
 * Hands back the promise because one caller has to wait on it: a full listing
 * run before the queue is in hand would put every email a task is holding back
 * onto the rows it is leaving, with nothing left to hide it again.
 */
function watchPendingJobs() {
  return adoptPendingTasks()
    .catch((err) => console.warn('[MailBoy] could not pick up the task queue:', err))
    .finally(() => {
      jobsAdopted = true;
    });
}

/**
 * Pick up whatever the queue is still holding — a job from a previous open, or
 * one the worker was killed partway through.
 *
 * **This is what makes the hiding survive a reopen.** The record carries what
 * each task took out of which row, so the panel can re-establish the projection
 * it never made, finish it off when the task ends, and put the mail back if
 * somebody presses stop. The old memory-only projection could do none of that,
 * and paid for a full listing every time instead.
 */
async function adoptPendingTasks() {
  const queued = await readTasks();
  if (!queued.length) return;

  for (const task of queued) {
    if (projections.has(task.id)) continue;

    const vacated = task.vacated ?? {};
    projections.set(task.id, {
      action: task.action,
      // A folder delete keeps no id list of its own — it re-derives its work by
      // listing its labels — so what it hid is read back out of `vacated`. That
      // is the right set either way: settling only ever concerns mail that was
      // actually taken out of a row.
      ids: task.ids ?? [...new Set(Object.values(vacated).flat())],
      destination: task.destination ?? null,
      vacated,
    });
  }

  projected = projections.size > 0;
  tasks = queued.map(taskSummary);

  trace('job', 'adopted the queue left by a previous open', {
    tasks: tasks.length,
    holding: queued.reduce((sum, task) => sum + (task.remaining?.length ?? 0), 0),
  });

  paintTasks();
  markWorkingRows();
  folderChannel();
}

// ── Rules ────────────────────────────────────────────────────────
//
// The other tab. Every filter on the account that files mail into a folder by
// sender or subject, in two sections — the ones MailBoy made, then the ones it
// found — because a filter someone wrote in Gmail years ago is doing exactly
// what a MailBoy rule does, and a screen showing only half of them would be
// describing half a mailbox. The mark in `src/rules.js` is what tells the two
// apart, and it decides nothing else: both sections are read, drawn, grouped and
// deleted by the same code, which is what keeps them looking the same.
//
// Always grouped by where they send mail, because "everything from these six
// senders goes to Receipts" is the decision someone actually made. Which sender
// triggers which rule is the detail inside that, so it is a screen down.
//
// **A row is not a filter.** Gmail lets one filter add several labels, and each
// destination is its own row here — see the Rule typedef. Deleting any of them
// deletes the filter, so it takes the others with it, and `confirmRuleDelete`
// says so before it happens.
//
// **Read on arrival, held in memory, never written down.** `filters.list` hands
// back every filter on the account for one quota unit with no paging, so there
// is nothing an incremental flow could save and no staleness to reason about —
// which is why none of this touches the snapshot, the membership record or the
// change-log bookmark. It is also the only honest option: a subject rule carries
// a real mail subject, and *What is on disk* says those are never stored.

/** Every rule MailBoy manages, as of the last visit to the tab. */
let rules = [];

/** Whether that list has ever been read, as opposed to being empty. */
let rulesLoaded = false;
let rulesLoading = false;

/** @type {Error | null} */
let rulesError = null;

/** Destination rows ticked on the Rules screen, by `<origin>:<labelId>` key. */
let selectedDestinations = new Set();

/** Rule row ids ticked in a destination's drill-down. */
let selectedRules = new Set();

/**
 * Which destination the drill-down is showing.
 * @type {{key: string, id: string, name: string | null, origin: string} | null}
 */
let openRuleGroup = null;

/** What the last render listed — which is what "select all" is allowed to mean. */
let listedGroups = [];
let listedRules = [];


/**
 * The folder a rule sends mail to, by name.
 *
 * Null means MailBoy shows no folder with that id — almost always a folder
 * deleted in Gmail's own settings, since a delete here takes its rules with it.
 * Only ever asked once the folder list exists; before that every rule would look
 * orphaned, which is why `renderRuleGroups` checks first.
 */
function folderNameOf(labelId) {
  const row = allRows().find((row) => row.id === labelId);
  return row ? (row.fullName ?? row.name) : null;
}

/**
 * The two sections, in the order they are shown.
 *
 * MailBoy's own first: they are the ones this panel made, the ones it explains
 * how to make, and the only ones a folder delete tidies up after. Everything
 * else is the account's own and is listed rather than managed.
 *
 * Nothing but the wording lives here. Both sections render through the same
 * row, tick, drill-down and delete, which is the point.
 */
const RULE_SECTIONS = [
  { origin: 'mailboy', ...COPY.rules.mine },
  { origin: 'existing', ...COPY.rules.existing },
];

const sectionOf = (origin) => RULE_SECTIONS.find((section) => section.origin === origin);

/**
 * The key a destination row is ticked and addressed by.
 *
 * Not the label id on its own: the same folder can be the destination of a
 * MailBoy rule and of one made in Gmail, which is two rows in two sections.
 */
const groupKeyOf = (rule) => `${rule.origin}:${rule.destination}`;

/**
 * Whether a destination is the blocking one.
 *
 * A rule sending future mail to Trash *is* a block — it is exactly what the
 * Block button makes — so the tab says so rather than calling it "Move to
 * Trash", which describes the mechanism and buries the intent. It reads that way
 * whatever made it: the Block button, the Trash box on a delete confirmation,
 * and a "Delete it" filter written years ago in Gmail all mean the same thing.
 */
const isBlockDestination = (labelId) => labelId === 'TRASH';

/**
 * Pinned first, whatever its rule count.
 *
 * It is the one destination on the screen that destroys mail, so it is the one
 * worth finding without reading — and unlike the folder rows it is a single
 * fixed row rather than one of a list somebody named, so nothing is displaced by
 * putting it at the top. Per section, since the two are separate lists.
 */
const rulePinned = (group) => (isBlockDestination(group.id) ? 0 : 1);

/** One section's rules, gathered under the folders they send mail to. */
function ruleGroups(origin) {
  const byDestination = new Map();
  for (const rule of rules) {
    if (rule.origin !== origin) continue;
    const list = byDestination.get(rule.destination);
    if (list) list.push(rule);
    else byDestination.set(rule.destination, [rule]);
  }

  return [...byDestination.entries()]
    .map(([id, list]) => ({
      key: `${origin}:${id}`,
      origin,
      id,
      name: folderNameOf(id),
      rules: list,
    }))
    .sort(
      (a, b) =>
        rulePinned(a) - rulePinned(b) ||
        b.rules.length - a.rules.length ||
        (a.name ?? '').localeCompare(b.name ?? '')
    );
}

/**
 * Re-read every rule on the account.
 *
 * Runs on every arrival at the tab, including pressing Rules while already on
 * it — one quota unit is cheaper than any scheme for deciding whether it is
 * worth spending.
 */
async function loadRules() {
  if (rulesLoading) return;

  rulesLoading = true;
  rulesError = null;
  el.rulesSpinner.hidden = false;
  renderRules();

  try {
    const { rules: found } = await listRules();
    rules = found;
    rulesLoaded = true;

    // A tick names a rule that may have been deleted elsewhere since.
    const live = new Set(rules.map((rule) => rule.id));
    selectedRules = new Set([...selectedRules].filter((id) => live.has(id)));
    const groups = new Set(rules.map(groupKeyOf));
    selectedDestinations = new Set(
      [...selectedDestinations].filter((key) => groups.has(key))
    );

    // The folder this drill-down is about has no rules left pointing at it.
    if (openRuleGroup && !groups.has(openRuleGroup.key)) closeRuleGroup();
  } catch (err) {
    rulesError = err;
    console.error('[MailBoy] could not read your rules:', err);
  } finally {
    rulesLoading = false;
    el.rulesSpinner.hidden = true;
    renderRules();
  }
}

/** Whichever of the two rule screens is up. */
function renderRules() {
  if (!el.rulesScreen.hidden) renderRuleGroups();
  else if (!el.ruleDetailScreen.hidden) renderRuleDetail();
}

/** The tick, as a stretched label — the same target the sender rows use. */
function ruleTick(checked, label) {
  const cell = document.createElement('label');
  cell.className = 'sender-tick';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.setAttribute('aria-label', label);

  cell.append(box);
  return cell;
}

/**
 * What a list says when it has nothing at all to list, and why.
 *
 * Only for the case where *neither* section has anything — a section that is
 * empty on its own says so under its own heading, so the structure stays legible
 * rather than collapsing to one sentence that describes the wrong half.
 */
function ruleNote() {
  // Ahead of the error, because a declined permission is not a fault and there
  // is nothing to try again in a moment.
  if (!caps.rules) return COPY.rules.needsPermission;
  if (rulesError) return COPY.rules.readFailed;
  if (!rulesLoaded) return COPY.rules.readingRules;
  return COPY.rules.noneAtAll;
}

/** A section's heading, sitting between the rows rather than in the sticky head. */
function ruleSectionHead(title) {
  const head = document.createElement('h2');
  head.className = 'rule-section';
  head.textContent = title;
  return head;
}

function renderRuleGroups() {
  // Before the folder list exists every destination would render as a folder
  // that no longer exists, which is a much more alarming thing to say than
  // "still reading". The load calls back in through renderSkeleton.
  //
  // Not where the rules permission is missing, though: there are no rules to
  // name, and announcing a read of the folder list would describe a wait that is
  // not happening. That case falls through to `ruleNote`, which says so.
  //
  // A grant covering rules but not mail is the other way round — every rule is
  // readable and none of them is nameable, and no wait will fix it, so it says
  // that instead of promising a list that is not coming.
  if (caps.rules && !currentGroups) {
    listedGroups = [];
    el.rulesHead.hidden = true;
    el.ruleRows.replaceChildren(
      emptyNote(caps.read ? COPY.rules.readingFolders : COPY.rules.needsFolders)
    );
    paintRuleSelection();
    return;
  }

  const sections = RULE_SECTIONS.map((section) => ({
    ...section,
    groups: ruleGroups(section.origin),
  }));

  // Flat and in section order, because that is what "select all" and the
  // indeterminate state are about: everything listed, whichever half it is in.
  const groups = sections.flatMap((section) => section.groups);
  listedGroups = groups;

  el.rulesTotal.textContent = rules.length ? `(${ruleCount(rules.length)})` : '';
  el.rulesCount.textContent = groups.length ? `· ${groups.length.toLocaleString()}` : '';
  el.rulesScope.textContent = COPY.rules.scope;

  el.rulesHead.hidden = !groups.length;
  if (!groups.length) {
    el.ruleRows.replaceChildren(emptyNote(ruleNote()));
    paintRuleSelection();
    return;
  }

  // Preserved for the same reason the breakdown preserves it: a re-render
  // arriving under someone mid-list should not throw them back to the top.
  const scroll = el.ruleRows.parentElement.scrollTop;
  el.ruleRows.replaceChildren(
    // Both headings stand whether or not their section has anything under them:
    // an empty half saying so is information, where a heading that comes and
    // goes makes the list look like it is showing something different.
    ...sections.flatMap((section) => [
      ruleSectionHead(section.title),
      ...(section.groups.length
        ? section.groups.map(renderRuleGroupRow)
        : [emptyNote(section.empty)]),
    ])
  );
  el.ruleRows.parentElement.scrollTop = scroll;

  paintRuleSelection();
}

function renderRuleGroupRow(group) {
  // Pinned at the top of its section and named for what it is rather than for
  // where it sends mail — see `isBlockDestination`. It is also the one row here
  // that ends in mail being destroyed, so it keeps its colour.
  const blocking = isBlockDestination(group.id);

  const row = document.createElement('div');
  row.className = blocking ? 'rule rule--group rule--danger' : 'rule rule--group';
  // The key, not the label id: the same folder can be a destination in both
  // sections, and those are two rows that tick independently.
  row.dataset.destination = group.key;
  // It navigates, so it answers the keyboard like the folder and sender rows do.
  // Not a <button>: the row is a grid of its own.
  row.setAttribute('role', 'button');
  row.tabIndex = 0;

  const what = document.createElement('span');
  what.className = 'rule-what';

  const name = document.createElement('span');
  // Never orphaned when it is the block row: Trash is one of MailBoy's own
  // folders and always resolves, unlike a deleted user folder.
  name.className = blocking || group.name ? 'rule-name' : 'rule-name rule-name--orphan';

  const lead = document.createElement('span');
  lead.className = 'rule-lead';
  lead.textContent = COPY.rules.moveTo;
  name.append(lead);

  // "Move to Trash (⊘ Blocked mails)" rather than a sentence of its own: the
  // mechanism reads the same as every other row, and the parenthetical — icon
  // and all — is what marks this one out. Everything in it takes the danger
  // colour: the bare text inherits it from `.rule--danger .rule-name`, and the
  // icon's stroke is `currentColor`. Only the lead stays muted, same as every
  // other row.
  name.append(group.name ?? (blocking ? COPY.rules.trash : COPY.rules.orphan));
  if (blocking) name.append(COPY.rules.blocked);

  what.append(name);

  if (!blocking && !group.name) {
    const why = document.createElement('span');
    why.className = 'rule-kind';
    why.textContent = COPY.rules.orphanWhy;
    what.append(why);
  }

  const count = document.createElement('span');
  count.className = 'rule-count';
  // Blank at one. A destination with a single rule is the common case, and a
  // column of "1"s down the side of every row is a number nobody reads telling
  // them what the row already says. It earns its place only where opening the
  // row would show more than the one thing.
  count.textContent = group.rules.length > 1 ? group.rules.length.toLocaleString() : '';

  row.append(
    ruleTick(
      selectedDestinations.has(group.key),
      blocking
        ? COPY.rules.selectBlockRow
        : COPY.rules.selectDestination(group.name ?? COPY.rules.orphan)
    ),
    what,
    count
  );
  return row;
}

/** How a single rule reads. The three kinds are one sentence each, deliberately. */
function ruleSentence(rule) {
  if (rule.kind === 'sender') return { lead: COPY.rules.fromSender, body: rule.match };
  // "anyone at" rather than the bare domain: the whole point of the kind is that
  // it catches senders nobody has seen yet, and a row reading "All mails from
  // example.com" would look like an address that had lost its front half.
  if (rule.kind === 'domain') return { lead: COPY.rules.fromDomain, body: rule.match };
  return { lead: COPY.rules.withSubject, body: `“${rule.match}”` };
}

function renderRuleDetail() {
  if (!openRuleGroup) return;

  // Scoped by section as well as by folder: a drill-down opened from "Existing
  // filters" must not quietly list MailBoy's own rules to the same place.
  const mine = rules.filter(
    (rule) => rule.origin === openRuleGroup.origin && rule.destination === openRuleGroup.id
  );
  listedRules = mine;

  const name = folderNameOf(openRuleGroup.id) ?? openRuleGroup.name;
  // The same sentence the row that was opened carried, icon and all — a heading
  // that read differently from the row that opened it would look like a
  // different screen.
  if (isBlockDestination(openRuleGroup.id)) {
    el.ruleDetailLabel.replaceChildren(
      `${COPY.rules.moveTo}${name ?? COPY.rules.trash}${COPY.rules.blockedBeforeIcon}`,
      blockIcon(),
      COPY.rules.blockedAfterIcon
    );
  } else {
    el.ruleDetailLabel.textContent = `${COPY.rules.moveTo}${name ?? COPY.rules.orphan}`;
  }
  el.ruleDetailTotal.textContent = mine.length ? `(${ruleCount(mine.length)})` : '';
  el.ruleDetailScope.textContent = sectionOf(openRuleGroup.origin)?.scope ?? '';

  // The head carries the select-all, and there is nothing to select.
  el.ruleDetailHead.hidden = !mine.length;
  if (!mine.length) {
    el.ruleDetailRows.replaceChildren(emptyNote(ruleNote()));
    paintRuleSelection();
    return;
  }

  const scroll = el.ruleDetailRows.parentElement.scrollTop;
  el.ruleDetailRows.replaceChildren(...mine.map(renderRuleRow));
  el.ruleDetailRows.parentElement.scrollTop = scroll;

  paintRuleSelection();
}

function renderRuleRow(rule) {
  const row = document.createElement('div');
  row.className = 'rule rule--single';
  row.dataset.rule = rule.id;

  const what = document.createElement('span');
  what.className = 'rule-what';

  const name = document.createElement('span');
  name.className = 'rule-name rule-name--wrap';

  const { lead, body } = ruleSentence(rule);
  const prefix = document.createElement('span');
  prefix.className = 'rule-lead';
  prefix.textContent = lead;
  name.append(prefix, body);

  what.append(name);
  row.append(ruleTick(selectedRules.has(rule.id), COPY.rules.selectRule(`${lead}${body}`)), what);
  return row;
}

/**
 * The same tools-row swap the breakdown makes, on whichever rule screen is up.
 * One button, because a rule cannot be moved anywhere and there is nothing about
 * one to trash.
 */
function paintRuleSelection() {
  const onGroups = !el.rulesScreen.hidden;
  const picked = onGroups
    ? listedGroups.filter((group) => selectedDestinations.has(group.key))
    : listedRules.filter((rule) => selectedRules.has(rule.id));

  const filters = onGroups ? el.rulesFilters : el.ruleDetailFilters;
  const actions = onGroups ? el.rulesActions : el.ruleDetailActions;
  const summary = onGroups ? el.rulesSummary : el.ruleDetailSummary;
  const box = onGroups ? el.rulesSelectAll : el.ruleSelectAll;
  const listed = onGroups ? listedGroups : listedRules;

  const any = picked.length > 0;
  filters.hidden = any;
  actions.hidden = !any;

  box.checked = any && picked.length === listed.length;
  box.indeterminate = any && picked.length < listed.length;

  if (!any) return;

  // A destination row stands for every rule under it, so the summary counts
  // rules either way — that is what a delete would actually remove.
  const total = onGroups
    ? picked.reduce((sum, group) => sum + group.rules.length, 0)
    : picked.length;
  summary.textContent = ruleCount(total);
  summary.title = onGroups
    ? COPY.rules.destinations(picked.length, ruleCount(total))
    : ruleCount(total);
}

function toggleDestination(key, on) {
  if (key === undefined) return;
  if (on) selectedDestinations.add(key);
  else selectedDestinations.delete(key);
  syncRuleRows(el.ruleRows, '.rule', 'destination', selectedDestinations);
}

function toggleRule(id, on) {
  if (id === undefined) return;
  if (on) selectedRules.add(id);
  else selectedRules.delete(id);
  syncRuleRows(el.ruleDetailRows, '.rule', 'rule', selectedRules);
}

/** Paint the ticks from the set rather than trusting the boxes, exactly as the
 *  sender list does — these rows are rebuilt whenever the folder list is. */
function syncRuleRows(container, selector, key, chosen) {
  for (const row of container.querySelectorAll(selector)) {
    const on = chosen.has(row.dataset[key]);
    row.classList.toggle('rule--picked', on);
    const box = row.querySelector('input[type="checkbox"]');
    if (box && box.checked !== on) box.checked = on;
  }
  paintRuleSelection();
}

function openRuleGroupFor(key) {
  const group = listedGroups.find((group) => group.key === key);
  if (!group) return;

  openRuleGroup = { key: group.key, id: group.id, name: group.name, origin: group.origin };
  // Ticks belong to the screen they were made on: a destination ticked in the
  // list behind is not the same choice as a rule ticked in here.
  selectedRules = new Set();

  showScreen('ruleDetail');
  el.rulesBack.focus();
  renderRuleDetail();
}

function closeRuleGroup() {
  if (!openRuleGroup) return;

  const previous = openRuleGroup.key;
  openRuleGroup = null;
  selectedRules = new Set();

  showScreen('rules');
  renderRuleGroups();

  const row = el.ruleRows.querySelector(`[data-destination="${CSS.escape(previous)}"]`);
  if (row) row.focus();
}

/**
 * Confirm, then remove.
 *
 * The consequences are the whole point of the dialog, and they are not the ones
 * a delete usually has: no mail moves, nothing that was filed comes back, and
 * the only thing that changes is what happens to mail that has not arrived. The
 * irreversible part is the rule itself — Gmail has no way to restore a filter.
 *
 * **A row is not a filter, and that shows up here.** Gmail cannot remove part of
 * a filter, so deleting a row belonging to one that files into several folders
 * takes its other rows with it — including rows in the list behind, which nobody
 * ticked. `alsoGoing` is that set, and it is counted rather than assumed so the
 * dialog can name it before the button is pressed.
 *
 * @param {object[]} doomed the ticked rows — `Rule`s, not filters
 */
async function confirmRuleDelete(doomed, where) {
  if (!doomed.length) return;

  // Deliberately not gated on the queue. Deleting a filter is a settings write
  // that moves no mail and costs 5 quota units, so there is nothing for it to
  // race and nothing for it to starve — and refusing it while a folder empties
  // would be exactly the arbitrary "come back later" the queue exists to end.
  const ticked = new Set(doomed.map((rule) => rule.id));
  const filterIds = new Set(doomed.map((rule) => rule.filterId));
  const alsoGoing = rules.filter(
    (rule) => filterIds.has(rule.filterId) && !ticked.has(rule.id)
  );
  const total = doomed.length + alsoGoing.length;

  const { ok } = await askConfirm({
    verb: COPY.common.delete,
    countText: ruleCount(total),
    where,
    text: COPY.rules.deleteText + (alsoGoing.length ? COPY.rules.alsoGoing(alsoGoing.length) : ''),
    button: total === 1 ? COPY.rules.deleteOne : COPY.rules.deleteMany,
    destructive: true,
  });
  if (!ok) return;

  setAction(COPY.rules.deleting(ruleCount(total)));

  try {
    const { deleted, failed } = await deleteRules([...filterIds]);
    const gone = new Set(deleted);
    const stuck = new Set(failed);
    // Rows, not filters: what someone counted on screen and what Gmail was
    // addressed about are different units, and the report is about the rows.
    const removed = rules.filter((rule) => gone.has(rule.filterId)).length;
    const kept = rules.filter((rule) => stuck.has(rule.filterId)).length;
    rules = rules.filter((rule) => !gone.has(rule.filterId));
    selectedDestinations = new Set();
    selectedRules = new Set();

    setAction(null);

    // The drill-down was about a folder nothing points at any more.
    const groups = new Set(rules.map(groupKeyOf));
    if (openRuleGroup && !groups.has(openRuleGroup.key)) closeRuleGroup();
    else renderRules();

    flash(
      kept
        ? COPY.rules.deletedSome(ruleCount(removed), ruleCount(kept))
        : COPY.rules.deleted(ruleCount(removed))
    );
  } catch (err) {
    console.error('[MailBoy] could not delete those rules:', err);
    setAction(null);
    flash(COPY.rules.deleteFailed, 'error');
    // Whatever did or did not go, the list on screen is now a guess.
    void loadRules();
  }
}

/** Delete every rule under the ticked destinations. */
function deletePickedGroups() {
  const groups = listedGroups.filter((group) => selectedDestinations.has(group.key));
  const doomed = groups.flatMap((group) => group.rules);
  // "blocking senders" rather than "moving mail to Trash", so the dialog names
  // the row that was ticked. Only where the block row is the whole selection:
  // a mixed set is described by its count either way.
  const where =
    groups.length !== 1
      ? `moving mail to ${groups.length.toLocaleString()} folders`
      : isBlockDestination(groups[0].id)
        ? 'blocking senders'
        : `moving mail to “${groups[0].name ?? 'a deleted folder'}”`;
  void confirmRuleDelete(doomed, where);
}

/** Delete the ticked rules within one destination. */
function deletePickedRules() {
  const doomed = listedRules.filter((rule) => selectedRules.has(rule.id));
  const name = folderNameOf(openRuleGroup?.id ?? '') ?? openRuleGroup?.name;
  void confirmRuleDelete(
    doomed,
    isBlockDestination(openRuleGroup?.id ?? '')
      ? 'blocking senders'
      : `moving mail to “${name ?? 'a deleted folder'}”`
  );
}

/**
 * Which of MailBoy's own rules point at the folders a delete is about to remove.
 *
 * One quota unit, spent before the delete dialog opens so it can say what will
 * happen to them. A failure here costs the sentence and never the delete.
 *
 * **Only MailBoy's.** A filter the user made in Gmail is theirs, and taking one
 * away as a side effect of deleting a folder is a bigger liberty than tidying up
 * after ourselves — the more so since one filter can file into several folders,
 * and Gmail offers no way to remove just the doomed one. Those are left to show
 * up in the Rules tab as pointing at a folder that no longer exists, where
 * deleting them is a deliberate act.
 */
async function rulesForFolders(labelIds) {
  const wanted = new Set(labelIds);
  // Without permission to read filters there are none of MailBoy's to tidy up
  // after — nothing could have made one. Skipping the call keeps the delete off
  // a 403 it would only swallow anyway.
  if (!caps.rules) return [];

  try {
    const { rules: found } = await listRules();
    rules = found;
    rulesLoaded = true;
    return found.filter((rule) => rule.origin === 'mailboy' && wanted.has(rule.destination));
  } catch (err) {
    console.warn('[MailBoy] could not check which rules point at this folder:', err);
    return [];
  }
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
    return COPY.errors.offline;
  }

  if (err instanceof GmailError) {
    if (err.reason === 'accessNotConfigured' || err.reason === 'SERVICE_DISABLED') {
      return COPY.errors.notConfigured;
    }
    if (err.reason === 'rateLimitExceeded' || err.reason === 'userRateLimitExceeded') {
      return COPY.errors.busy;
    }
    if (err.status >= 500) {
      return COPY.errors.google;
    }
    return COPY.errors.refused;
  }

  // fetch() rejects with a TypeError when it never reached the server.
  if (err instanceof TypeError) {
    return COPY.errors.unreachable;
  }

  return COPY.errors.unknown;
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
 * Button with a glyph and a label, returned as parts so the label can change
 * without wiping the icon.
 *
 * @param {string} glyph One of the ICON_* path constants.
 */
function iconButton(className, glyph, label) {
  const el = document.createElement('button');
  el.className = className;

  // innerHTML over a module constant, never over anything from the API.
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'btn-glyph');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = glyph;

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

  const retry = iconButton('btn btn--primary btn--sm', ICON_REFRESH, COPY.errors.retry);
  const signOut = iconButton('btn btn--ghost btn--sm', ICON_LOGOUT, COPY.errors.logout);

  signOut.el.addEventListener('click', () => handleLogout());

  retry.el.addEventListener('click', async () => {
    retry.el.disabled = true;
    signOut.el.disabled = true;
    retry.label.textContent = COPY.errors.retrying;
    retry.icon.classList.add('btn-glyph--spin');

    // A repeat failure re-renders an identical state, so without a floor on
    // the pending state the click looks like it did nothing at all.
    await Promise.all([load({ force: true }), new Promise((done) => setTimeout(done, 450))]);

    // On success this state is gone; on failure a fresh one replaced it.
    if (retry.el.isConnected) {
      retry.el.disabled = false;
      signOut.el.disabled = false;
      retry.label.textContent = COPY.errors.retry;
      retry.icon.classList.remove('btn-glyph--spin');
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
  summary.textContent = COPY.errors.details;
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
  // Named, because this button is about refreshing. A task has its own lifetime
  // and pressing stop on a refresh must not abandon one half-done.
  chrome.runtime.sendMessage({ type: 'stop', job: 'measure' }).catch(() => {});
  stopSignal?.();

  // And the same for the pass in this page. `stopRequested` only takes effect at
  // the next check inside `collect`, which is on the far side of whatever
  // request is in flight — and while the task queue is spending the same quota
  // budget, that request may not even have been sent yet. Without this the
  // button did nothing visible for tens of seconds, which reads as broken.
  abortLoad?.();
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

/**
 * Size and sender for mail the change log has just turned up.
 *
 * A sync patches counts without reading a single message, so a row that gains
 * new mail counts it immediately and knows nothing about it — its size would sit
 * short until the weekly listing. This is the piece that closes that, and it is
 * a gain over the old behaviour rather than a cost: new mail used to go
 * unmeasured for as long as the freshness gate held, which was a whole day.
 *
 * Safe to call while the worker is already measuring: `measure()` there returns
 * early if a pass is running, and its own queue picks these up on the next wake.
 */
async function measureNewMail(ids) {
  stopRequested = false;
  setBusy(true);
  setProgress('measuring', 0, ids.length);
  trace('measure', 'sizing mail the change log turned up', { messages: ids.length });

  try {
    await measureInWorker(ids, (_found, done, total) => setProgress('measuring', done, total));
    // The worker did the writing, so this copy is behind.
    await reloadMessages();
    trace('measure', 'done');

    // Every row, not just the ones that gained mail: a message read here counts
    // towards each row that holds it, and dedup means one read settles several.
    paintPatched(allRows().map((row) => row.id));
    refreshOpenLists();
  } catch (err) {
    console.warn('[MailBoy] could not measure the new mail:', err);
  } finally {
    setProgress(null);
    // A load started while this ran owns the chrome now, and clearing it here
    // would leave that load with no card and a button reading "Refresh".
    if (!loading) setBusy(false);
  }
}

// ── Loading ──────────────────────────────────────────────────────

/** Whether the snapshot on screen can stand as the base for a change-log sync. */
async function isFresh() {
  try {
    const key = await scopedKey(CACHE_NAME);
    if (!key) return false;

    const { [key]: cached } = await chrome.storage.local.get(key);

    // A projected snapshot is what an action was asked to do, not what Gmail
    // did. It is never a base to patch from, however recent — the panel that
    // promised it may have been closed before the job reported back, and the
    // listing is what makes that honest again.
    if (cached?.projected) {
      trace('open', 'the snapshot is an unsettled action — listing');
      return false;
    }

    if (!cached?.counts) {
      trace('open', 'no snapshot to patch from — listing');
      return false;
    }

    const age = Date.now() - cached.generatedAt;
    if (age >= REFRESH_AFTER_MS) {
      trace('open', 'snapshot past its week — listing', { days: Math.round(age / 864e5) });
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the queue is still moving mail about.
 *
 * It no longer *blocks* a load, which is the change a queue forced: a job can
 * now run for the best part of an hour while more are added behind it, and
 * refusing to re-read the mailbox for all of that is refusing the one button
 * that fixes a wrong number. What it does instead is decide two things:
 *
 * - **An open with nothing to prove skips the read entirely.** A change-log sync
 *   would be patching onto a projection rather than onto Gmail's own answer, and
 *   a full listing costs thousands of units against the job it is racing. The
 *   numbers on screen are the projection, which is the honest picture until the
 *   queue drains.
 * - **A refresh someone actually pressed goes ahead**, and puts the projection
 *   back over the fresh counts afterwards — see `reprojectTasks`.
 *
 * **The queue is the signal, not a stale record.** The worker's broadcast keeps
 * `tasks` current; the record is consulted only for the first load of a session,
 * which runs before `watchPendingJobs` has had a chance to read it.
 */
async function jobOutstanding() {
  if (jobRunning()) return true;
  if (jobsAdopted) return false;

  try {
    const queued = await readTasks();
    if (queued.length) {
      trace('job', 'the queue was left running by a previous open', { tasks: queued.length });
    }
    return queued.length > 0;
  } catch (err) {
    console.warn('[MailBoy] could not check for a pending job:', err);
    return false;
  }
}

/**
 * Bring the numbers up to date from Gmail's change log rather than by listing
 * every folder — two quota units against several thousand.
 *
 * @returns {Promise<boolean>} whether it worked. A `false` is ordinary: no
 *   bookmark yet, or one Gmail has forgotten. The caller lists instead.
 */
async function syncFromHistory() {
  const labels = await listLabels();
  const groups = buildGroups(labels);

  const { synced, changed = [], added = [] } = await syncHistory(groups);
  if (!synced) return false;

  renderSkeleton(groups);
  repaint();
  paintPatched(changed);
  refreshOpenLists();

  trace('open', 'up to date from the change log — no listing needed');

  // New mail has nothing cached about it, so its rows would count it and never
  // size it. Not awaited — a first sight of a big thread is minutes, and the
  // counts above are already on screen.
  if (added.length) void measureNewMail(added);

  return true;
}

/**
 * A complete load's snapshot.
 *
 * The `projected` flag rides along from the live state rather than being fixed
 * at false. These numbers are Gmail's own **except** where a task in the queue
 * has had its projection put back over them, and a refresh is allowed to run
 * mid-move now — so a pass can finish and still be describing what MailBoy was
 * asked to do rather than what Gmail has done. Flagging it is what makes the
 * next open pay that debt instead of syncing onto a prediction.
 */
async function writeSnapshot(generatedAt, groups, counts, when) {
  try {
    const key = await scopedKey(CACHE_NAME);
    if (!key) return;
    await chrome.storage.local.set({ [key]: { generatedAt, groups, counts, projected } });
    trace('snapshot', `saved — ${when}`, { projected });
  } catch (err) {
    console.warn('[MailBoy] could not cache this pass:', err);
  }
}

/**
 * @param {{force?: boolean}} [options] `force` skips straight to a full listing —
 *   what the refresh button and the error-state retry both want.
 */
async function load({ force = false } = {}) {
  if (loading) return;

  // Not an error and not a retry: the mailbox is unreadable because somebody
  // said so on the consent screen, and the only way forward is to ask again.
  // Every path below this reads Gmail, so the gate is here rather than at each
  // of them.
  if (!caps.read) {
    trace('open', 'no permission to read the mailbox');
    setBusy(false);
    renderNeedsRead();
    return;
  }

  trace('open', force ? 'asked for a full listing' : 'deciding how to catch up');

  // Before either path. A queue in flight rules out the cheap one either way —
  // a sync would patch the change log onto a projection — and rules out the
  // expensive one unless somebody actually asked for it. See `jobOutstanding`.
  const queueBusy = await jobOutstanding();
  if (queueBusy && !force) {
    trace('open', 'the queue is still moving mail — reading nothing');
    membershipReady = restoreMembership();
    return;
  }

  if (!force && (await isFresh())) {
    // Put the last enumeration's ids back in memory first — the sync patches
    // them, and a breakdown aggregates over them.
    membershipReady = restoreMembership();

    try {
      if (await syncFromHistory()) return;
    } catch (err) {
      // Never fatal: the listing below is what this was trying to avoid, not
      // something it has replaced. An auth problem simply surfaces there, where
      // it is already handled.
      console.warn('[MailBoy] change-log sync failed; listing instead:', err);
    }
  }

  // The previous enumeration's ids, so a breakdown opened during this pass has
  // something to aggregate rather than an empty list. `collect` replaces them
  // when its own enumeration lands.
  membershipReady = restoreMembership();

  const mine = ++passId;
  loading = true;
  stopRequested = false;
  stopSignal = null;
  setBusy(true);

  /**
   * Whether this pass is still the one whose word counts.
   *
   * An abandoned pass keeps running — a Gmail request cannot be recalled — so
   * every hook below is gated on this rather than left to repaint rows, save
   * membership or stamp a snapshot on behalf of a load nobody is waiting for.
   */
  const current = () => mine === passId && !stopRequested;

  /** Resolved by `stopLoad`, which is how the button stops meaning "eventually". */
  const abandoned = Symbol('stopped');
  const stopped = new Promise((resolve) => {
    abortLoad = () => resolve(abandoned);
  });

  async function runPass() {
    const labels = await listLabels();
    // The wait above is where a stop most often lands now — the label list is
    // this pass's first request, and it queues behind whatever the task queue is
    // spending. Rebuilding the rows for a pass that has been called off would
    // blank numbers that are on screen and correct.
    if (!current()) return abandoned;

    const groups = buildGroups(labels);
    renderSkeleton(groups);
    // Rows were just rebuilt; put back whatever was already known so a refresh
    // shows stale numbers rather than placeholders.
    repaint();

    const generatedAt = Date.now();
    countsSettled = false;

    const counts = await collect(groups, {
      // Deliberately not stamping the timestamp here: counts land in stages,
      // and "Updated just now" while later rows are still filling in is a lie.
      onCounts: (records) => {
        if (current()) paintRecords(records);
      },
      onCounting: (done, total) => {
        if (current()) setProgress('counting', done, total);
      },
      onSizes: (records, done, total) => {
        if (!current()) return;
        paintRecords(records);

        // Enumeration has just finished and replaced `counts` with Gmail's own
        // answer — which still holds every email the queue is in the middle of
        // moving. Hiding it again is what keeps a refresh started mid-move from
        // putting all of that mail back on the rows it is leaving. After
        // `paintRecords` rather than before it: this pass's first payload was
        // built before the hook ran, and nothing is drawn between the two.
        //
        // Only at the first firing. From the second on, `collect` re-derives
        // patched rows on its own way out.
        if (!countsSettled) reprojectTasks();
        // Sizes arriving behind an open list should show up in it.
        refreshOpenLists();
        // Enumeration is finished by the time this first fires, so the counts
        // are final and worth stamping — sizes carry on in the card.
        setFooter(generatedAt);
        setProgress('measuring', done, total);

        // And worth *saving*, at that same first firing. The size pass that
        // follows runs for minutes, and writing the snapshot only at the end of
        // it meant closing the panel mid-measure threw away a finished
        // enumeration — `collect` has already stored the membership and the
        // bookmark by now, so the next open would re-list a mailbox it had just
        // read. Nothing here claims the sizes are done: rows keep spinning, and
        // the worker keeps measuring whether the panel is open or not.
        //
        // `painted` rather than `records`: this payload was built before the
        // re-projection above ran, and what is on screen is the thing worth
        // keeping.
        if (!countsSettled) {
          countsSettled = true;
          void writeSnapshot(generatedAt, groups, painted, 'counts final, sizes still coming');
        }
      },
      measure: measureInWorker,
      // Not `stopRequested`: the next load clears that, and an orphan whose
      // stop had been lifted would go on to save membership and a bookmark for
      // a pass nobody is waiting for. A pass token cannot be un-revoked.
      stopped: () => !current(),
    });

    return { groups, counts, generatedAt };
  }

  try {
    // The pass, or the stop — whichever answers first. A request already in
    // flight cannot be recalled, so an abandoned pass is left to unwind on its
    // own: `current()` keeps it from painting or writing anything, and nothing
    // here waits for it.
    const outcome = await Promise.race([runPass(), stopped]);
    if (outcome === abandoned || !current()) {
      trace('listing', 'pass abandoned — stop pressed');
      return;
    }

    const { groups, counts, generatedAt } = outcome;
    paintRecords(counts);
    setProgress(null);
    setFooter(generatedAt);

    // Enumeration has replaced whatever an action projected — **except** for
    // anything the queue is still holding, which `reprojectTasks` put straight
    // back and which nothing but the job's own ending can settle.
    projected = projections.size > 0;
    countsSettled = true;
    await writeSnapshot(generatedAt, groups, counts, 'pass complete');
  } catch (err) {
    setProgress(null);
    console.error('[MailBoy] load failed:', err);
    if (err instanceof AuthError) {
      const key = await scopedKey(CACHE_NAME);
      if (key) await chrome.storage.local.remove(key);
      showWelcome(COPY.welcome.expired);
    } else {
      renderErrorState(err);
    }
  } finally {
    // A load that has already been superseded must not put the chrome back:
    // the pass that replaced it owns the button and the card now.
    if (mine === passId) {
      loading = false;
      abortLoad = null;
      setProgress(null);
      setBusy(false);
    }
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
  // Mail content, and it belongs to the mailbox being left. Nothing here was
  // ever written to disk, so letting go of it is the whole of forgetting it.
  openSender = null;
  openMessageId = null;
  mailIds = [];
  selectedMails = new Set();
  mailMeta = new Map();
  mailPage = 0;
  currentGroups = null;
  closeEditor();
  closeMoveDialog();
  // Whatever was being deleted or moved belonged to the mailbox being left. The
  // queue survives under that account's namespace; this is only the panel
  // letting go of it.
  tasks = [];
  enqueuing.clear();
  paintTasks();
  // The next mailbox has its own queue, and it has not been looked for yet — so
  // the record has to be consulted again on its first load.
  jobsAdopted = false;
  // Nothing on screen is a projection any more, because nothing is on screen.
  projected = false;
  projections.clear();
  setAction(null);
  // Rules belong to the mailbox that made them, and a subject rule carries a
  // real mail subject — the same reason the mail screens are cleared. Nothing
  // here was on disk, so letting go of it is the whole of forgetting it.
  rules = [];
  rulesLoaded = false;
  rulesError = null;
  openRuleGroup = null;
  listedGroups = [];
  listedRules = [];
  selectedDestinations = new Set();
  selectedRules = new Set();
  el.senderRows.replaceChildren();
  el.mailRows.replaceChildren();
  el.messageView.replaceChildren();
  el.ruleRows.replaceChildren();
  el.ruleDetailRows.replaceChildren();
  el.groups.replaceChildren();
  setProgress(null);
  setFooter(null);
  // Back to the folder list, and the other tab back to its own top: what each
  // one was left on describes the mailbox being left.
  lastScreen.rules = 'rules';
  showScreen('main');
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

  // These may be an earlier open's projection of an action rather than
  // anything Gmail confirmed, and the debt goes with them: `isFresh` will have
  // said no, and if that load never lands the flag keeps the next one honest.
  projected = Boolean(cached.projected);
}

// ── Events ───────────────────────────────────────────────────────

el.connect.addEventListener('click', async () => {
  el.connect.disabled = true;
  el.connect.textContent = COPY.welcome.connecting;
  setNotice(el.welcomeError, null);

  try {
    await getToken({ interactive: true });
    // Before anything is drawn: the grant may be partial, and every screen from
    // here is painted against what it allows.
    await refreshCapabilities();
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
    // Signing back in within the retention window can find a queue that was
    // halted by the sign-out still outstanding — a logout stops the tasks and
    // deliberately keeps them, since they belong to that mailbox.
    void watchPendingJobs();
  } catch (err) {
    // Closing the Google window is a choice, not a failure worth shouting about.
    if (err instanceof AuthCancelled) {
      showWelcome(null);
    } else {
      console.error('[MailBoy] connect failed:', err);
      showWelcome(COPY.welcome.failed);
    }
  } finally {
    el.connect.disabled = false;
    el.connect.textContent = COPY.welcome.connect;
  }
});

/** Every key one mailbox occupies. They are only ever erased together. */
async function eraseAccountData(id) {
  await clearMessages(id);
  await forgetMembership(id);
  await chrome.storage.local.remove([
    keyFor(id, CACHE_NAME),
    keyFor(id, IDENTITY_NAME),
    // The queue *is* mail data: a task carries the message ids it is working
    // through, since nothing in the mailbox can re-derive which senders somebody
    // ticked. A folder delete in it is intent rather than data, but it is keyed
    // the same way and has nothing left to act on once the rest of this is gone.
    tasksKey(id),
    // Anything an older build left behind, which the queue would otherwise
    // adopt on the next open of an account that has just been erased.
    ...legacyKeys(id),
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
    el.logoutText.textContent = COPY.logout.text(
      el.account.textContent || COPY.logout.mailboxFallback
    );
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
  // panel idle and unaware of it. Naming no job stops the queue too, for the
  // same reason — the token every task is spending is about to go.
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

// Never disabled, for the same reason the refresh button is not: it is the only
// way to call the queue off, and a queue that cannot be called off is the thing
// somebody will close the browser over.
el.taskStop.addEventListener('click', stopTasks);

/**
 * Keep what the panel has worked out when it is closed.
 *
 * A size pass runs for minutes and the sizes land in `painted` a second at a
 * time, so closing the panel halfway used to drop all of it back to the last
 * saved snapshot. This costs one write and means reopening carries on from where
 * it was rather than from where it started.
 *
 * **Only counts that are finished**, hence `countsSettled` — a partial
 * enumeration written under the previous snapshot's timestamp is exactly what
 * the next open would then patch the change log onto. Membership and the
 * bookmark are untouched: this writes what is on screen, and neither of those is.
 *
 * Best effort by nature. The write may not land before the page goes, which
 * costs the progress and nothing else.
 */
addEventListener('pagehide', () => {
  trace('snapshot', countsSettled ? 'panel closing — flushing' : 'panel closing mid-count — not flushing');
  if (countsSettled) void saveSnapshot();
});

/**
 * The + that stands where a pressed one stood, after a render replaced it.
 *
 * There is only ever one heading +, so a press with no row behind it can only
 * have been that one.
 */
function liveAddButton(labelId) {
  const within = labelId ? `.row[data-label-id="${CSS.escape(labelId)}"]` : '.group-head';
  return el.groups.querySelector(`${within} .row-action[data-action="add"]`);
}

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

    // 'cancel' belongs to the editor and is wired where it is built.
    const kind = action.dataset.action;
    const labelId = action.closest('.row')?.dataset.labelId;

    // Both change the mailbox, so both are gated — but only the ungranted path
    // pays for it. With the permission in hand this stays synchronous, which is
    // what it has always been and what keeps the editor opening on the node that
    // was actually pressed.
    if (caps.write) {
      if (kind === 'add') handleAdd(action);
      else if (kind === 'delete') void confirmDelete(labelId);
      return;
    }

    void requireCapability('write').then((ok) => {
      if (!ok) return;
      if (kind === 'delete') {
        void confirmDelete(labelId);
        return;
      }
      // A dialog and a round trip to Google are seconds, and the list is rebuilt
      // whenever sizes land — so the + that was pressed may be out of the
      // document. Opening the editor into a detached row would put it nowhere.
      const live = liveAddButton(labelId);
      if (live) handleAdd(live);
    });
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

/** The sender a row stands for, as `openMails` wants it. */
function senderRowFor(row) {
  return listedSenders.find((sender) => senderKey(sender) === row.dataset.sender);
}

el.senderRows.addEventListener('click', (event) => {
  // The label already toggled its own box and fired `change` above. It is now
  // the only part of the row that ticks — the rest of it opens the mail.
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.sender');
  if (!row) return;

  // A drag that ended up selecting text is somebody copying an address, not a
  // click — an address is the one thing on this screen worth copying.
  if (!window.getSelection()?.isCollapsed) return;

  const sender = senderRowFor(row);
  if (sender) openMails(sender);
});

el.senderRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  // The checkbox answers the keyboard itself; the row must not also open.
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.sender');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.

  const sender = senderRowFor(row);
  if (sender) openMails(sender);
});

el.selectAll.addEventListener('change', () => {
  // Exactly what is listed, which is the period's doing — a sender out of scope
  // cannot be acted on, so "all" cannot mean it.
  selected = el.selectAll.checked ? new Set(listedSenders.map(senderKey)) : new Set();
  syncSelection();
});

// Every one of these is gated on a permission the grant may not carry, and the
// gate is what asks for it. `resolveSelection` is read *after* the gate rather
// than passed into it: the dialog and Google's window are seconds during which a
// measuring pass keeps adding to these senders.
el.trash.addEventListener('click', async () => {
  if (await requireCapability('write')) void startTrash(resolveSelection());
});
el.restore.addEventListener('click', async () => {
  if (await requireCapability('write')) void startRestore(resolveSelection());
});
el.move.addEventListener('click', async () => {
  if (await requireCapability('write')) startMove(resolveSelection());
});
// No `resolveSelection` and no `canAct`: a block moves no mail, so there is
// nothing to resolve to ids and no reason a running job should hold it up —
// filters are a different Gmail surface with its own quota.
el.block.addEventListener('click', async () => {
  if (await requireCapability('rules')) void startBlock(blockFromSelection());
});
el.moveConfirm.addEventListener('click', confirmMove);
el.moveCancel.addEventListener('click', closeMoveDialog);

// ── One sender's mail ────────────────────────────────────────────

el.mailsBack.addEventListener('click', closeMails);

// The box inside the label toggles itself, so this covers that half.
el.mailRows.addEventListener('change', (event) => {
  const box = event.target.closest('input[type="checkbox"]');
  const row = box?.closest('.mail');
  if (row) toggleMail(row.dataset.id, box.checked);
});

el.mailRows.addEventListener('click', (event) => {
  const page = event.target.closest('.pager-btn');
  if (page) {
    mailPage = Number(page.dataset.page);
    // Back to the top: the pager is at the bottom of the list, and staying
    // there would land the next page mid-way through itself.
    el.mails.scrollTop = 0;
    renderMails();
    return;
  }

  // The label already toggled its own box and fired `change` above.
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.mail');
  if (!row) return;

  // A drag that ended up selecting text is somebody copying a subject line.
  if (!window.getSelection()?.isCollapsed) return;

  void openMessage(row.dataset.id);
});

el.mailRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  // The checkbox and the pager buttons are real controls and answer the
  // keyboard themselves.
  if (event.target.closest('.sender-tick, .pager-btn')) return;

  const row = event.target.closest('.mail');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.
  void openMessage(row.dataset.id);
});

/**
 * Every message this sender has in scope, not just the ten on screen.
 *
 * Pagination is a viewport, not a scope: someone who opens a sender with four
 * hundred messages and presses the header box means all four hundred. The
 * summary beside the buttons says how many, so the figure is never implied.
 */
el.mailSelectAll.addEventListener('change', () => {
  selectedMails = el.mailSelectAll.checked ? new Set(mailIds) : new Set();
  syncMailSelection();
});

el.mailHead.addEventListener('click', (event) => {
  const head = event.target.closest('.col-head[data-mailsort]');
  if (!head) return;

  // Clicking the column already in use turns it round; clicking the other moves
  // to it the way round that column starts.
  const key = head.dataset.mailsort;
  setMailSort(key, key === mailSortKey ? (mailSortDir === 'asc' ? 'desc' : 'asc') : undefined);
});

el.mailTrash.addEventListener('click', async () => {
  if (await requireCapability('write')) void startTrash(resolveMailSelection());
});
el.mailRestore.addEventListener('click', async () => {
  if (await requireCapability('write')) void startRestore(resolveMailSelection());
});
el.mailMove.addEventListener('click', async () => {
  if (await requireCapability('write')) startMove(resolveMailSelection());
});
el.mailBlock.addEventListener('click', async () => {
  if (await requireCapability('rules')) void startBlock(blockOpenSender());
});

// ── Rules ────────────────────────────────────────────────────────

el.navbar.addEventListener('click', (event) => {
  const tab = event.target.closest('.nav-btn');
  if (tab) showTab(tab.dataset.tab);
});

// The only back that crosses tabs. Nothing inside Rules leads here, so the
// screen behind it is the mailbox — the same thing pressing the Home tab does,
// which is why it goes through showTab rather than showScreen: Home has its own
// remembered place and this must not take it somewhere else.
el.rulesHome.addEventListener('click', () => showTab('home'));

el.rulesBack.addEventListener('click', closeRuleGroup);

// The box inside the label toggles itself, so this covers that half.
el.ruleRows.addEventListener('change', (event) => {
  const box = event.target.closest('input[type="checkbox"]');
  const row = box?.closest('.rule');
  if (row) toggleDestination(row.dataset.destination, box.checked);
});

el.ruleRows.addEventListener('click', (event) => {
  // The label already toggled its own box and fired `change` above. The rest of
  // the row opens what is inside it — the same split the sender rows make.
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.rule');
  if (!row) return;
  // A drag that ended in a text selection is somebody copying a folder name.
  if (!window.getSelection()?.isCollapsed) return;

  openRuleGroupFor(row.dataset.destination);
});

el.ruleRows.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('.sender-tick')) return;

  const row = event.target.closest('.rule');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.
  openRuleGroupFor(row.dataset.destination);
});

el.ruleDetailRows.addEventListener('change', (event) => {
  const box = event.target.closest('input[type="checkbox"]');
  const row = box?.closest('.rule');
  if (row) toggleRule(row.dataset.rule, box.checked);
});

// Exactly what is listed. On the destinations screen that is every rule on the
// account, both sections; inside one, every rule sending mail there.
el.rulesSelectAll.addEventListener('change', () => {
  selectedDestinations = el.rulesSelectAll.checked
    ? new Set(listedGroups.map((group) => group.key))
    : new Set();
  syncRuleRows(el.ruleRows, '.rule', 'destination', selectedDestinations);
});

el.ruleSelectAll.addEventListener('change', () => {
  selectedRules = el.ruleSelectAll.checked
    ? new Set(listedRules.map((rule) => rule.id))
    : new Set();
  syncRuleRows(el.ruleDetailRows, '.rule', 'rule', selectedRules);
});

// Gated for completeness rather than because it can be reached without the
// permission: nothing is listed to tick without it. Cheap, and it means the
// screen has no button that silently does nothing.
el.rulesDelete.addEventListener('click', async () => {
  if (await requireCapability('rules')) void deletePickedGroups();
});
el.ruleDelete.addEventListener('click', async () => {
  if (await requireCapability('rules')) void deletePickedRules();
});

// The hint appears only once something is ticked, in whichever dialog is up.
// The wording is already right — only the hint has to react, and the sender box
// has to follow the domain box's lock either way round.
for (const box of [el.ruleSender, el.ruleDomain, el.ruleSubject]) {
  box.addEventListener('change', () => {
    syncDomainLock(MOVE_RULE_BOXES);
    paintRuleHint(MOVE_RULE_BOXES, moveRule, {
      to: moveTarget ? `“${moveTarget.name}”` : 'this folder',
      hint: COPY.ruleBoxes.moveHint,
    });
  });
}

for (const box of [el.trashRuleSender, el.trashRuleDomain, el.trashRuleSubject]) {
  box.addEventListener('change', () => {
    syncDomainLock(TRASH_RULE_BOXES);
    paintRuleHint(TRASH_RULE_BOXES, confirmRule, { to: COPY.rules.trash, hint: COPY.ruleBoxes.trashHint });
  });
}

// ── One message ──────────────────────────────────────────────────

el.messageBack.addEventListener('click', closeMessage);

el.messageTrash.addEventListener('click', async () => {
  if (await requireCapability('write')) void startTrash(resolveOpenMessage());
});
el.messageRestore.addEventListener('click', async () => {
  if (await requireCapability('write')) void startRestore(resolveOpenMessage());
});
el.messageMove.addEventListener('click', async () => {
  if (await requireCapability('write')) startMove(resolveOpenMessage());
});
el.messageBlock.addEventListener('click', async () => {
  if (await requireCapability('rules')) void startBlock(blockOpenSender());
});

// The hint appears only once the box is ticked, and the count it carries is the
// box's doing.
el.blockDomain.addEventListener('change', paintBlockHint);
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
  if (row) pickMoveTarget(row.dataset.labelId, row.dataset.labelName);
});

el.moveList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('.row-action, .folder-editor')) return;

  const row = event.target.closest('.row');
  if (!row) return;
  event.preventDefault(); // Space would scroll the list.
  pickMoveTarget(row.dataset.labelId, row.dataset.labelName);
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
wirePicker(el.mailSortTrigger, el.mailSortMenu, 'mailsort', setMailSort);

document.addEventListener('click', (event) => {
  if (anyMenuOpen() && !event.target.closest('.picker')) closeMenus();
});

// Puts the defaults on the triggers and the ticks beside them.
setSort(sortKey);
setPeriod(periodKey);
setMailSort(mailSortKey);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // A dialog closes itself on Escape; without this the same press would also
  // close the breakdown standing behind it.
  if (
    el.logoutDialog.open ||
    el.permissionDialog.open ||
    el.deleteDialog.open ||
    el.confirmDialog.open ||
    el.blockDialog.open ||
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
  } else if (!el.messageScreen.hidden) {
    // One step back per press, down the same path the screens were opened on —
    // and within the tab they were opened in, never across the two.
    closeMessage();
  } else if (!el.mailsScreen.hidden) {
    closeMails();
  } else if (!el.detail.hidden) {
    closeBreakdown();
  } else if (!el.ruleDetailScreen.hidden) {
    closeRuleGroup();
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

  // A local read, and everything below is painted against it — including
  // `load`, which shows the permission card instead of reading a mailbox it is
  // not allowed to.
  await refreshCapabilities();

  await painting;
  showMain();
  // Both already have a token, and the mailbox load should not queue behind a
  // userinfo round trip just to fill in the header.
  const [switched] = await Promise.all([loadIdentity(), load()]);

  // The silent renewal came back as a different mailbox from the one this open
  // painted and loaded — everything on screen belongs to the account left
  // behind, and `forgetMailbox` has already cleared it. Read the new one.
  //
  // The queue is adopted *first* here, unlike the ordinary path below: the load
  // that follows is a full listing, and it would find every email a task is
  // moving still sitting where it was. `reprojectTasks` is what hides it again,
  // and it can only do that for tasks the panel has read.
  if (switched) {
    await watchPendingJobs();
    await load({ force: true });
    return;
  }

  // Last on the ordinary path, because it dims rows the load has to have drawn
  // first. Nothing above it re-lists: an open with a queue outstanding reads
  // nothing at all, which is what makes the ordering safe here.
  void watchPendingJobs();
})();
