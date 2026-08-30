// Which mailbox the data on disk belongs to.
//
// Everything MailBoy caches — sizes, senders, membership, the snapshot — is a
// description of one mailbox, so every key it writes is namespaced by account.
// That namespacing is what lets a scan outlive a logout and lets two accounts
// be signed in and out of without either one's numbers bleeding into the
// other's. Without it there is one global cache and the only safe thing to do
// at logout is erase it.
//
// The id is Google's `sub`, not the address: `sub` survives a rename and an
// address does not, and adopting a renamed address as a new account would cost
// a full re-read of a mailbox already measured.
//
// The active account is deliberately never memoised. It is one small local
// read, while the alternative is the panel and the service worker each holding
// their own idea of which mailbox they are writing into — a disagreement that
// would corrupt a cache silently and with no way back.

const ACTIVE_KEY = 'account:active';
const INDEX_KEY = 'account:index';

/**
 * How long a signed-out mailbox's data is kept before it is erased.
 *
 * Re-reading a large mailbox takes minutes, so wiping at logout makes signing
 * out an expensive act and makes switching between two accounts unusable. A
 * week covers both without leaving mail metadata on disk indefinitely for
 * someone who signed out and never came back.
 */
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

/** Namespace for one account's keys. */
export const keyFor = (id, name) => `acct:${id}:${name}`;

export const keysFor = (id, names) => names.map((name) => keyFor(id, name));

/** @returns {Promise<string | null>} */
export async function activeAccount() {
  try {
    const { [ACTIVE_KEY]: id } = await chrome.storage.local.get(ACTIVE_KEY);
    return id ?? null;
  } catch {
    return null;
  }
}

/** A key in the signed-in account's namespace, or null when nobody is. */
export async function scopedKey(name) {
  const id = await activeAccount();
  return id ? keyFor(id, name) : null;
}

async function readIndex() {
  try {
    const { [INDEX_KEY]: index } = await chrome.storage.local.get(INDEX_KEY);
    return index && typeof index === 'object' ? index : {};
  } catch {
    return {};
  }
}

/**
 * Point the cache at this mailbox, stamping it as seen.
 *
 * @returns {Promise<boolean>} whether this is a different mailbox from the one
 *   that was active — the caller has to drop anything it is holding in memory,
 *   which belongs to the previous account.
 */
export async function setActiveAccount(id, email) {
  const previous = await activeAccount();
  const index = await readIndex();

  index[id] = { email: email ?? index[id]?.email ?? '', lastSeen: Date.now() };
  await chrome.storage.local.set({ [ACTIVE_KEY]: id, [INDEX_KEY]: index });

  return previous !== id;
}

/**
 * Sign out without erasing. The stamp left behind is what the retention window
 * counts from, so the clock starts at the logout rather than at the last load.
 *
 * @returns {Promise<string | null>} the account that was signed in
 */
export async function releaseAccount() {
  const id = await activeAccount();
  if (!id) return null;

  const index = await readIndex();
  if (index[id]) {
    index[id].lastSeen = Date.now();
    await chrome.storage.local.set({ [INDEX_KEY]: index });
  }
  await chrome.storage.local.remove(ACTIVE_KEY);

  return id;
}

/** When this account was last signed in, or 0 if it is not known. */
export async function lastSeen(id) {
  const index = await readIndex();
  return index[id]?.lastSeen ?? 0;
}

/**
 * Accounts whose data is past the retention window. The signed-in one is never
 * included, however long ago it was stamped — it is in use.
 */
export async function expiredAccounts() {
  const active = await activeAccount();
  const index = await readIndex();
  const cutoff = Date.now() - RETAIN_MS;

  return Object.entries(index)
    .filter(([id, entry]) => id !== active && !(entry?.lastSeen > cutoff))
    .map(([id]) => id);
}

/** Forget an account was ever here. The caller erases its data first. */
export async function dropAccount(id) {
  const index = await readIndex();
  if (!(id in index)) return;
  delete index[id];
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}
