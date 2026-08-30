// Turning a raw Gmail message into something the panel can put on screen.
//
// This is the one part of MailBoy that handles mail *content* rather than
// figures about it, and two rules shape all of it:
//
// 1. **Nothing here is ever cached.** Subjects, snippets and bodies are the
//    mail itself. The size/sender cache is safe to keep because neither figure
//    can change and neither says anything about what a message contains; this
//    does, so it lives no longer than the screen showing it.
//
// 2. **A body is rendered as text, never as HTML.** MV3 forbids the panel from
//    running remote code, and building a message's markup into the page would
//    mean `innerHTML` over the least trustworthy string in the product — plus
//    every tracking pixel and remote font the sender put in it, fetched the
//    moment it renders. So an HTML part is flattened to text through an inert
//    `DOMParser` document, which runs no scripts and loads no resources.

import { decodeWords, parseFrom } from './sender.js';

/** Header lookup is case-insensitive; Gmail's own casing is not promised. */
function headerOf(payload, name) {
  const wanted = name.toLowerCase();
  return payload?.headers?.find((header) => header.name?.toLowerCase() === wanted)?.value ?? '';
}

/**
 * What a row in the mail list shows.
 *
 * @param {string} id
 * @param {object} [raw] the message resource, absent when Gmail would not
 *   answer for it — the row still exists and has to say so rather than vanish.
 */
export function shapeHeader(id, raw) {
  if (!raw) return { id, gone: true, subject: '', snippet: '', bytes: 0, date: 0 };

  return {
    id,
    gone: false,
    subject: decodeWords(headerOf(raw.payload, 'Subject')).trim(),
    // Gmail's own first-line extract, already plain and already trimmed. It
    // arrives HTML-escaped, which is only visible on a message whose text
    // contains an ampersand or an angle bracket.
    snippet: unescapeEntities(raw.snippet ?? ''),
    from: parseFrom(headerOf(raw.payload, 'From')),
    bytes: Number(raw.sizeEstimate ?? 0),
    date: Number(raw.internalDate ?? 0),
  };
}

/**
 * Gmail escapes its snippets, and only ever with these five — it is producing
 * an extract of plain text, not markup. A table beats a throwaway DOM document
 * per row, and it works the same wherever this runs.
 */
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function unescapeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]);
}

/**
 * Everything an open message shows.
 *
 * @returns {{id: string, subject: string, from: object, to: string,
 *   date: number, bytes: number, text: string, fromHtml: boolean,
 *   attachments: object[]}}
 */
export function shapeMessage(raw) {
  const body = bodyOf(raw?.payload);

  return {
    id: raw?.id ?? '',
    subject: decodeWords(headerOf(raw?.payload, 'Subject')).trim(),
    from: parseFrom(headerOf(raw?.payload, 'From')),
    to: decodeWords(headerOf(raw?.payload, 'To')).trim(),
    date: Number(raw?.internalDate ?? 0),
    bytes: Number(raw?.sizeEstimate ?? 0),
    text: body.text,
    // Worth saying on screen: a flattened HTML mail has lost its layout, and
    // someone comparing it against Gmail should know why.
    fromHtml: body.fromHtml,
    attachments: attachmentsOf(raw?.payload),
  };
}

/**
 * The readable part of a message.
 *
 * `text/plain` wins wherever it exists — it is what the sender wrote for
 * exactly this case, and it needs no flattening. Otherwise the HTML part is
 * reduced to text.
 */
function bodyOf(payload) {
  const plain = findPart(payload, 'text/plain');
  if (plain) return { text: decodePart(plain).trim(), fromHtml: false };

  const html = findPart(payload, 'text/html');
  if (html) return { text: htmlToText(decodePart(html)), fromHtml: true };

  return { text: '', fromHtml: false };
}

/**
 * Depth-first search for a readable part of one MIME type.
 *
 * Anything carrying a filename is skipped: an attached .txt is a file the
 * message came with, not the message.
 */
function findPart(part, mimeType) {
  if (!part || part.filename) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;

  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/** base64url, decoded through the charset the part declares. */
function decodePart(part) {
  const data = part.body?.data;
  if (!data) return '';

  try {
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

    const declared = /charset="?([^";\s]+)"?/i.exec(headerOf(part, 'Content-Type'));
    try {
      return new TextDecoder(declared?.[1] ?? 'utf-8').decode(bytes);
    } catch {
      // An unknown charset label makes TextDecoder throw outright; UTF-8 is
      // right far more often than it is wrong.
      return new TextDecoder().decode(bytes);
    }
  } catch (err) {
    console.warn('[MailBoy] could not decode a message part:', err);
    return '';
  }
}

/** Elements whose end is a line break once the markup is gone. */
const BLOCKS = 'p, div, br, tr, li, h1, h2, h3, h4, h5, h6, blockquote, table';

/**
 * Cells get a space, not a break.
 *
 * HTML mail is built out of layout tables, so a newline per cell would turn a
 * three-column header into three lines and a newsletter into a column of
 * fragments. Without any separator, though, adjacent cells fuse into one word.
 */
const CELLS = 'td, th';

/**
 * Flatten HTML to text, safely.
 *
 * `DOMParser` builds a document detached from this one: scripts in it never
 * run, and `<img>`/`<link>`/`<iframe>` never fetch anything. That is the whole
 * reason it is used here rather than a throwaway element in the page — mail is
 * the last string in the product worth handing to the live DOM, and a remote
 * image in it is a read receipt.
 */
function htmlToText(html) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return html;
  }

  for (const node of doc.querySelectorAll('style, script, head, title, noscript')) node.remove();
  // Without this every block runs into the next and the whole message is one
  // paragraph — which is what makes a flattened mail unreadable rather than
  // merely plain.
  for (const node of doc.querySelectorAll(CELLS)) node.after(' ');
  for (const node of doc.querySelectorAll(BLOCKS)) node.after('\n');

  const text = doc.body?.textContent ?? '';
  return text
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Files the message came with — names and sizes only.
 *
 * Deliberately not downloadable: fetching an attachment means pulling its bytes
 * into the panel, which is a different promise from the one on the tin. Saying
 * what is attached is what makes the size figure on the row make sense.
 */
function attachmentsOf(part, out = []) {
  if (!part) return out;

  if (part.filename) {
    out.push({
      name: decodeWords(part.filename),
      bytes: Number(part.body?.size ?? 0),
      mimeType: part.mimeType ?? '',
    });
    return out;
  }

  for (const child of part.parts ?? []) attachmentsOf(child, out);
  return out;
}
