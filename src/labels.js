// Turning Gmail's flat, SHOUTY label list into something worth looking at.

// Everything is a folder here. Gmail's own distinction between a "system
// label" and a "category" is an implementation detail of theirs; both are
// folders Google made, and they read as one group.

/**
 * Google's own folders worth surfacing, in reading order. Others are dropped.
 *
 * These three are where *incoming* mail sits, and a message is in at most one
 * of them.
 *
 * **SENT and DRAFT are deliberately not here.** MailBoy is about mail that
 * arrived and needs sorting; a message you wrote is not something you file.
 * Keeping them would also make deleting a folder dangerous, because Gmail
 * labels *threads*: label a conversation and your own replies in it carry that
 * label too. A folder delete that returns its mail to the inbox would then put
 * your sent replies there. Excluding what you wrote — here, from user-folder
 * counts, and from everything a delete acts on — is what makes that safe.
 *
 * Gmail also returns UNREAD, STARRED and IMPORTANT, and those are dropped for a
 * different reason: they are states a message carries while sitting somewhere
 * else, so a starred inbox message would be counted twice in one section and
 * their sizes would overlap the rows above.
 */
const MAILBOX_ORDER = ['INBOX', 'SPAM', 'TRASH'];

const CATEGORY_ORDER = [
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

const DISPLAY_NAMES = {
  INBOX: 'Inbox',
  SPAM: 'Spam',
  TRASH: 'Trash',
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

function byOrder(labels, order) {
  const byId = new Map(labels.map((label) => [label.id, label]));
  return order
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((label) => ({
      id: label.id,
      name: DISPLAY_NAMES[label.id] ?? label.name,
      depth: 0,
    }));
}

/**
 * Gmail encodes nesting in the name ("Work/Clients/Acme"), so we show the leaf
 * name and indent by depth. Membership is still flat — a child label's count
 * says nothing about its parent's.
 *
 * Exported because creating and deleting a folder both rebuild this list
 * without re-reading the mailbox, and depth is not something the caller can
 * patch by hand: adding "Work/Clients" turns an existing top-level
 * "Work/Clients/Acme" into an indented child of it, three rows away.
 *
 * @param {{id: string, name: string}[]} labels raw labels, named by full path
 */
export function buildTree(labels) {
  const sorted = [...labels].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

  const present = new Set(sorted.map((label) => label.name));

  return sorted.map((label) => {
    const parts = label.name.split('/');
    // Only indent when the ancestor label actually exists, otherwise a label
    // literally named "a/b" would render as an orphaned child.
    let depth = 0;
    for (let i = 1; i < parts.length; i++) {
      if (present.has(parts.slice(0, i).join('/'))) depth = i;
    }
    // Whether anything nests under this one — not the same question as depth,
    // which is about this folder's own position. A top-level folder with
    // subfolders and a three-deep leaf are both real, and the row icon marks
    // which kind a folder is (see renderRow), not how deep it sits.
    const prefix = `${label.name}/`;
    const hasChildren = sorted.some((other) => other.name.startsWith(prefix));
    return {
      id: label.id,
      name: parts.slice(depth).join('/'),
      fullName: label.name,
      depth: Math.min(depth, 3),
      hasChildren,
      // Counts what arrived under this folder, not what you wrote in it. Gmail
      // labels threads, so a conversation you replied to puts that label on
      // your own replies too — and with Sent and Drafts no longer shown, a row
      // counting them would be counting into folders that are not on screen.
      // The same scope is what a delete acts on, which is what keeps a folder's
      // number and the mail a delete touches the same set.
      scope: 'incoming',
    };
  });
}

/**
 * Google's folders, with the categories nested under Inbox as the breakdown
 * they are.
 *
 * **Category rows are scoped to the inbox.** A category label stays on a
 * message forever — Gmail assigns it at delivery and keeps it after archiving,
 * which is why `category:promotions` finds archived mail. Unscoped, Promotions
 * could out-count Inbox and the five would not add up to anything. Narrowed to
 * `in:inbox` they partition Inbox exactly, which is what lets them sit under it.
 *
 * An empty category is dropped from the list rather than shown as 0. Gmail
 * hands back all five whether or not the mailbox uses tabs, so a mailbox with
 * tabs switched off would otherwise show four permanent zeroes under Inbox.
 * The flag rides on the row because only the panel knows the count — see
 * `paintRow`.
 */
function googleFolders(system) {
  const rows = byOrder(system, MAILBOX_ORDER);
  const categories = byOrder(system, CATEGORY_ORDER).map((row) => ({
    ...row,
    depth: 1,
    scope: 'inbox',
    hideWhenEmpty: true,
  }));

  // Inbox is the one default folder that is ever a container in the tree —
  // the categories nest under it, whether or not any of them end up hidden
  // for being empty (that is decided later, per row, from the count).
  const withChildren = rows.map((row) =>
    row.id === 'INBOX' && categories.length > 0 ? { ...row, hasChildren: true } : row
  );

  const at = withChildren.findIndex((row) => row.id === 'INBOX');
  if (at === -1) return [...withChildren, ...categories];
  return [...withChildren.slice(0, at + 1), ...categories, ...withChildren.slice(at + 1)];
}

/**
 * The rows nested under `fullName`, deepest first.
 *
 * Nesting lives only in the name, so this is a string test and not a lookup:
 * anything beginning `Work/` is inside `Work`. The trailing slash is what keeps
 * a sibling called `Workshop` out of it.
 *
 * Deepest first because that is the order they have to be deleted in — Gmail
 * removes only the label named, so taking the parent out first would leave its
 * children behind as top-level folders for however long the rest of the pass
 * takes, and orphan them for good if it failed in between.
 *
 * @param {{fullName?: string}[]} rows the user folders, as `asTree` returns them
 * @returns {object[]}
 */
export function descendantsOf(rows, fullName) {
  if (!fullName) return [];
  const prefix = `${fullName}/`;

  return rows
    .filter((row) => row.fullName?.startsWith(prefix))
    .sort((a, b) => b.fullName.length - a.fullName.length);
}

export function buildGroups(labels) {
  const system = labels.filter((label) => label.type === 'system');
  const user = labels.filter((label) => label.type === 'user');

  return {
    defaults: googleFolders(system),
    user: buildTree(user),
  };
}
