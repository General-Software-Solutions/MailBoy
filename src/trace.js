// Flow tracing: which path an open, a sync or an action actually took.
//
// None of the change-log work has been run against a real mailbox yet, and most
// of what could go wrong there fails *quietly* — a sync that silently refuses
// and falls back to listing looks exactly like a sync that worked, only slower.
// So every decision branch says which way it went and why.
//
// **Ids and counts only, never mail content.** Subjects, snippets and bodies are
// not written to disk (see CLAUDE.md, *What is on disk*) and they should not be
// written to a console either.
//
// Turn this off before publishing.

const TRACE = true;

/**
 * @param {string} area which flow — `open`, `sync`, `listing`, `action`,
 *   `bookmark`, `measure`, `snapshot`, `job`, `rules`, `quota`. Kept to a small
 *   set on purpose, so the console can be filtered down to one of them.
 * @param {string} message what happened, and where a branch was taken, why
 * @param {object} [detail] figures worth having, logged as an object so the
 *   console keeps it foldable rather than stringifying it into the line
 */
export function trace(area, message, detail) {
  if (!TRACE) return;
  const line = `[MailBoy] ${area} · ${message}`;
  if (detail === undefined) console.log(line);
  else console.log(line, detail);
}
