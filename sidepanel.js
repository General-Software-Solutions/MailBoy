import {
  AuthCancelled,
  AuthError,
  getToken,
  logout,
  rememberAccount,
} from './src/auth.js';
import { countUnfiled, getLabel, GmailError, getUserInfo, listLabels } from './src/gmail.js';
import { buildGroups } from './src/labels.js';

const CACHE_KEY = 'snapshot';
const IDENTITY_KEY = 'identity';
const CONCURRENCY = 6;

const el = {
  welcome: document.getElementById('screen-welcome'),
  main: document.getElementById('screen-main'),
  connect: document.getElementById('btn-connect'),
  logout: document.getElementById('btn-logout'),
  welcomeError: document.getElementById('welcome-error'),
  account: document.getElementById('account'),
  avatarPhoto: document.getElementById('avatar-photo'),
  avatarFallback: document.getElementById('avatar-fallback'),
  groups: document.getElementById('groups'),
  footer: document.getElementById('footer'),
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

function renderRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.labelId = item.id;
  row.dataset.depth = String(item.depth ?? 0);

  const name = document.createElement('span');
  name.className = 'row-name';
  name.textContent = item.name;

  const count = document.createElement('span');
  count.className = 'row-count';
  count.append(Object.assign(document.createElement('span'), { className: 'skeleton' }));

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
 * @param {string} labelId
 * @param {{count: number, exact?: boolean, unread?: number, total?: number}} record
 */
function fillCount(labelId, record) {
  const row = el.groups.querySelector(`[data-label-id="${CSS.escape(labelId)}"]`);
  if (!row) return;

  const cell = row.querySelector('.row-count');

  if (!record) {
    cell.textContent = '—';
    row.title = 'Count unavailable.';
    return;
  }

  const value = record.count.toLocaleString();
  cell.textContent = record.exact === false ? `${value}+` : value;
  cell.classList.toggle('row-count--zero', record.count === 0);

  if (record.total !== undefined) {
    row.title = `${value} filed away · ${record.total.toLocaleString()} total`;
  }

  if (record.unread) {
    const pill = document.createElement('span');
    pill.className = 'unread';
    pill.textContent = record.unread.toLocaleString();
    pill.title = `${record.unread.toLocaleString()} unread`;
    row.insertBefore(pill, cell);
  }
}

function setFooter(timestamp) {
  if (!timestamp) {
    el.footer.textContent = '';
    return;
  }
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  const when =
    minutes < 1 ? 'just now' : minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  el.footer.textContent = `Updated ${when}`;
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
    await Promise.all([load(), new Promise((done) => setTimeout(done, 450))]);

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
  el.footer.textContent = '';
}

// ── Loading ──────────────────────────────────────────────────────

/** Runs `worker` over `items` with a bounded number in flight at once. */
async function pool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await worker(item);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        console.warn('[MailBoy] count failed for', item?.id, err);
        fillCount(item.id, null);
      }
    }
  });
  await Promise.all(runners);
}

async function load() {
  if (loading) return;
  loading = true;

  try {
    const labels = await listLabels();
    const groups = buildGroups(labels);
    renderSkeleton(groups);

    /** @type {Record<string, object>} */
    const counts = {};
    const record = (id, value) => {
      counts[id] = value;
      fillCount(id, value);
    };

    // System labels and categories: labels.get already carries the totals.
    await pool([...groups.mailboxes, ...groups.categories], CONCURRENCY, async (item) => {
      const detail = await getLabel(item.id);
      record(item.id, {
        count: detail.messagesTotal ?? 0,
        exact: true,
        unread: item.id === 'INBOX' ? detail.messagesUnread ?? 0 : 0,
      });
    });

    // User labels: the headline number is mail filed under the label and
    // nowhere else, which needs a real search per label.
    await pool(groups.user, CONCURRENCY, async (item) => {
      const [detail, unfiled] = await Promise.all([
        getLabel(item.id),
        countUnfiled(item.id),
      ]);
      record(item.id, { ...unfiled, total: detail.messagesTotal ?? 0 });
    });

    const generatedAt = Date.now();
    setFooter(generatedAt);
    await chrome.storage.local.set({
      [CACHE_KEY]: { generatedAt, groups, counts },
    });
  } catch (err) {
    console.error('[MailBoy] load failed:', err);
    if (err instanceof AuthError) {
      await chrome.storage.local.remove(CACHE_KEY);
      showWelcome('Gmail access expired. Please connect again.');
    } else {
      renderErrorState(err);
    }
  } finally {
    loading = false;
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
  for (const [id, value] of Object.entries(cached.counts ?? {})) {
    fillCount(id, value);
  }
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
  el.groups.replaceChildren();
  el.footer.textContent = '';
  setAccount(null);
  setPhoto(null);
  showWelcome(null);
}

el.logout.addEventListener('click', () => handleLogout());

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
  await loadIdentity();
  await load();
})();
