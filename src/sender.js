// Turning a raw `From:` header into something groupable.
//
// Grouping has to key on the address, never the display string: the same
// sender arrives as "Amazon", "Amazon.com" and "Amazon Orders" across a
// mailbox, and bucketing by what is shown would split one sender into three.

/**
 * RFC 2047 encoded words: `=?UTF-8?B?SGVsbG8=?=` or `=?UTF-8?Q?Hello_there?=`.
 * Display names carry these constantly and they are unreadable left as-is.
 */
function decodeQuotedPrintable(body) {
  const text = body.replace(/_/g, ' ');
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && i + 2 < text.length) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeWords(text) {
  // Whitespace between two adjacent encoded words is a separator, not content.
  const joined = text.replace(/\?=\s+=\?/g, '?==?');

  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, body) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
          : decodeQuotedPrintable(body);
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // An unknown charset or malformed payload: the raw form beats nothing.
      return whole;
    }
  });
}

/**
 * @param {string} value a raw From header
 * @returns {{address: string, name: string}} address lowercased for grouping,
 *   name decoded for display and possibly empty
 */
export function parseFrom(value) {
  const raw = (value ?? '').trim();
  if (!raw) return { address: '', name: '' };

  // Angle brackets win when present; a bare address is the other common shape.
  const angled = /<([^<>]*)>\s*$/.exec(raw);
  const address = (angled ? angled[1] : raw).trim().toLowerCase();

  let name = angled ? raw.slice(0, angled.index).trim() : '';
  // A quoted display name may itself contain commas: "Last, First" <a@b.c>
  name = name.replace(/^"(.*)"$/s, '$1').trim();

  return { address, name: decodeWords(name) };
}
