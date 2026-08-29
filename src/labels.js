// Turning Gmail's flat, SHOUTY label list into something worth looking at.

/** Mailboxes worth surfacing, in reading order. Others are deliberately dropped. */
const MAILBOX_ORDER = [
  'INBOX',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
];

const CATEGORY_ORDER = [
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

const DISPLAY_NAMES = {
  INBOX: 'Inbox',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  SENT: 'Sent',
  DRAFT: 'Drafts',
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
 */
function asTree(labels) {
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
    return {
      id: label.id,
      name: parts.slice(depth).join('/'),
      fullName: label.name,
      depth: Math.min(depth, 3),
    };
  });
}

export function buildGroups(labels) {
  const system = labels.filter((label) => label.type === 'system');
  const user = labels.filter((label) => label.type === 'user');

  return {
    mailboxes: byOrder(system, MAILBOX_ORDER),
    categories: byOrder(system, CATEGORY_ORDER),
    user: asTree(user),
  };
}
