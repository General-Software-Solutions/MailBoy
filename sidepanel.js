import {
  AuthCancelled,
  AuthError,
  getToken,
  logout,
  rememberAccount,
} from './src/auth.js';
import { GmailError, getUserInfo, listLabels } from './src/gmail.js';
import { formatAgo, formatBytes, formatTimeLeft } from './src/format.js';
import { buildGroups } from './src/labels.js';
import { collect, forgetMembership, restoreMembership } from './src/mailbox.js';
import { clearMessages } from './src/messages.js';

const CACHE_KEY = 'snapshot';
const IDENTITY_KEY = 'identity';

/**
 * How stale the numbers may get before an open re-reads them.
 *
 * Enumeration costs a few seconds of listing every time, and a mailbox does not
 * change enough between openings of a side panel to be worth paying that on
 * each one. "Refresh current data" is there for when it does.
 */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const el = {
  welcome: document.getElementById('screen-welcome'),
  main: document.getElementById('screen-main'),
  connect: document.getElementById('btn-connect'),
  logout: document.getElementById('btn-logout'),
  refresh: document.getElementById('btn-refresh'),
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
};

let loading = false;

/** Survives the re-render a failed retry causes, so the panel doesn't collapse
 *  the details someone just opened to read. */
let detailsOpen = false;

// ── Screens ──────────────────────────────────────────────────────

function showWelcome(message) {
  el.main.hidden = true;
  el.welcome.hidden = false;
  el.connect.disabled = false;
  setNotice(el.welcomeError, message);
}

function showMain() {
  el.welcome.hidden = true;
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

function renderRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.labelId = item.id;
  row.dataset.depth = String(item.depth ?? 0);

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

  row.append(name, count);
  return row;
}

function renderGroup(title, items, emptyText) {
  const section = document.createElement('section');
  section.className = 'group';

  const heading = document.createElement('h2');
  heading.className = 'group-title';
  heading.textContent = title;
  section.append(heading);

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    section.append(empty);
    return section;
  }

  for (const item of items) section.append(renderRow(item));
  return section;
}

function renderSkeleton(groups) {
  el.groups.replaceChildren(
    renderGroup('Mailboxes', groups.mailboxes, 'None found.'),
    renderGroup('Categories', groups.categories, 'Categories are turned off.'),
    renderGroup('Your labels', groups.user, 'No labels of your own yet.')
  );
}

/**
 * Everything currently on screen, kept so a re-render can restore it. Rebuilding
 * the rows for a refresh would otherwise drop numbers we already have back to
 * placeholders for as long as the refresh takes.
 */
let painted = {};

function paintRecords(records) {
  for (const [labelId, incoming] of Object.entries(records)) {
    const previous = painted[labelId];

    // A fresh count arrives before its size has been recomputed. Where the
    // count is unchanged the old size still describes the same messages, so
    // keep showing it rather than flashing a spinner over a number we have.
    const record =
      incoming &&
      incoming.bytes === undefined &&
      previous?.bytes !== undefined &&
      previous.count === incoming.count
        ? { ...incoming, bytes: previous.bytes, pending: previous.pending, settled: previous.settled }
        : incoming;

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
 * @param {{count: number, total?: number, bytes?: number, pending?: number,
 *   settled?: boolean} | null} record
 */
function paintRow(labelId, record) {
  const row = el.groups.querySelector(`[data-label-id="${CSS.escape(labelId)}"]`);
  if (!row) return;

  const cell = row.querySelector('.row-count');
  const num = row.querySelector('.row-num');
  const size = row.querySelector('.row-size');

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
  const short = record.bytes === undefined || (record.pending ?? 0) > 0;
  const measuring = short && !record.settled;

  if (record.count === 0) {
    size.replaceChildren();
  } else if (measuring) {
    size.replaceChildren(spinner());
  } else if (record.bytes === undefined) {
    size.replaceChildren();
  } else {
    size.textContent = `(${formatBytes(record.bytes)})`;
  }
  // Settled but short: a real figure, just known to be missing some messages.
  size.classList.toggle('row-size--partial', short && !measuring);

  const title = [];
  if (record.total !== undefined) {
    title.push(`${count} filed away`, `${record.total.toLocaleString()} in the label`);
  }
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
  el.refresh.disabled = running;
  el.refresh.querySelector('.icon').classList.toggle('icon--spin', running);
  paintProgress();
  setFooter();
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
  el.groups.classList.toggle('groups--locked', busy);
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

function setFooter(timestamp = lastLoaded) {
  lastLoaded = timestamp;

  // Counting, warm or cold. Once it is done the counts on screen are final,
  // so the timestamp is honest even while sizes are still being read.
  if (progress?.phase === 'counting') {
    el.footer.textContent = `Counting labels… ${progress.done} of ${progress.total}`;
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
      body: 'MailBoy needs a connection to read your labels from Gmail.',
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
      body: 'MailBoy asked Gmail for your labels and was refused.',
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
    body: "MailBoy couldn't load your labels.",
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
async function measureInWorker(order, onBatch) {
  // A killed worker drops the port. It resumes on its own from the alarm, so
  // reconnecting and asking again is all that is needed — and because the
  // cache filters what it has already read, nothing is measured twice.
  for (let attempt = 0; attempt < 60; attempt++) {
    const outcome = await new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'measure' });

      port.onMessage.addListener((message) => {
        if (message?.type === 'progress') {
          onBatch(new Map(Object.entries(message.sizes ?? {})), message.done, message.total);
        } else if (message?.type === 'done') {
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

    if (outcome === 'done') return;
    await new Promise((done) => setTimeout(done, 1000));
  }
}

// ── Loading ──────────────────────────────────────────────────────

/** Whether the snapshot on screen is recent enough to stand on its own. */
async function isFresh() {
  try {
    const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
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
    void restoreMembership();
    return;
  }

  loading = true;
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
        // Enumeration is finished by the time this first fires, so the counts
        // are final and worth stamping — sizes carry on in the card.
        setFooter(generatedAt);
        setProgress('measuring', done, total);
      },
      measure: measureInWorker,
    });

    paintRecords(counts);
    setProgress(null);
    setBusy(false);
    setFooter(generatedAt);

    await chrome.storage.local.set({
      [CACHE_KEY]: { generatedAt, groups, counts },
    });
  } catch (err) {
    setProgress(null);
    console.error('[MailBoy] load failed:', err);
    if (err instanceof AuthError) {
      await chrome.storage.local.remove(CACHE_KEY);
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
    if (!info) return;

    const email = info.email ?? null;
    const photo = info.picture ?? null;

    setAccount(email);
    setPhoto(photo);

    if (email) await rememberAccount(email);
    await chrome.storage.local.set({ [IDENTITY_KEY]: { email, photo } });
  } catch (err) {
    // Identity is decoration; never let it break the panel.
    console.warn('[MailBoy] identity unavailable:', err);
  }
}

async function paintIdentityCache() {
  const { [IDENTITY_KEY]: cached } = await chrome.storage.local.get(IDENTITY_KEY);
  if (!cached) return;
  setAccount(cached.email);
  setPhoto(cached.photo);
}

/** Paint the last known good view instantly, then refresh behind it. */
async function paintCache() {
  const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
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
    // Header first, so it is populated even if the mailbox load fails.
    await loadIdentity();
    await load();
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

async function handleLogout() {
  await logout();
  await chrome.storage.local.remove([CACHE_KEY, IDENTITY_KEY]);
  // Sizes are mail data. Signing out should leave nothing behind, even though
  // rebuilding the cache is the slowest thing the panel does.
  await clearMessages();
  await forgetMembership();
  painted = {};
  el.groups.replaceChildren();
  setProgress(null);
  setBusy(false);
  setFooter(null);
  setAccount(null);
  setPhoto(null);
  showWelcome(null);
}

el.logout.addEventListener('click', () => handleLogout());

el.refresh.addEventListener('click', () => load({ force: true }));

// ── Boot ─────────────────────────────────────────────────────────

(async function init() {
  try {
    // Silent only: opening a sign-in window unprompted would be hostile.
    await getToken({ interactive: false });
  } catch {
    showWelcome(null);
    return;
  }

  showMain();
  await Promise.all([paintIdentityCache(), paintCache()]);
  // Both already have a token, and the mailbox load should not queue behind a
  // userinfo round trip just to fill in the header.
  await Promise.all([loadIdentity(), load()]);
})();
