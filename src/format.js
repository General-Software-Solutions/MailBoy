/**
 * Byte counts as something readable: "812 B", "4.2 MB", "1.1 GB".
 *
 * 1024-based, which is what Gmail's own storage figures use — a mailbox Google
 * calls 2.1 GB should not read as 2.3 GB here.
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  // A decimal only where it carries information: "1.4 MB", but "812 KB".
  const decimals = unit > 0 && value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago something happened: "just now", "9 minutes ago", "3 hours ago".
 *
 * Counts are only re-read once a day, so this routinely has to describe gaps of
 * many hours — minutes alone would read as "847 minutes ago".
 */
export function formatAgo(elapsed) {
  if (!Number.isFinite(elapsed) || elapsed < 45_000) return 'just now';

  // Each unit is chosen from its own rounded value, so 59.7 minutes becomes
  // "1 hour ago" rather than "60 minutes ago".
  const minutes = Math.round(elapsed / MINUTE);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;

  const hours = Math.round(elapsed / HOUR);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;

  const days = Math.round(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/**
 * How often something arrives, across a span: "3/week", "12/month".
 *
 * The rate is over the gaps between messages, not the messages themselves —
 * two messages ten days apart is one every ten days, not two. So `count - 1`
 * gaps over the span.
 *
 * @param {number} count messages whose date is known
 * @param {number} days between the first and the last of them
 */
export function formatRate(count, days) {
  if (!Number.isFinite(count) || count < 2) return '';

  // Everything on one day still describes a real rate; treat it as a day.
  const perDay = (count - 1) / Math.max(days, 1);

  const [rate, unit] =
    perDay >= 1
      ? [perDay, 'day']
      : perDay * 7 >= 1
        ? [perDay * 7, 'week']
        : perDay * 30.44 >= 1
          ? [perDay * 30.44, 'month']
          : [perDay * 365.25, 'year'];

  // A decimal only where it carries information, as with byte counts.
  const shown = rate >= 10 ? Math.round(rate) : Number(rate.toFixed(1));
  return `${shown}/${unit}`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * A message's date, short enough for a column that is about 70px wide:
 * "12 Aug" this year, "12 Aug 24" before that.
 *
 * The year is what carries the information — two messages a week apart do not
 * need to be told apart at a glance, two messages two years apart do — so it is
 * the only part that earns its width, and only when it is not the current one.
 * The full date lives in the row's tooltip.
 */
export function formatDate(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';

  const when = new Date(ms);
  const stem = `${when.getDate()} ${MONTHS[when.getMonth()]}`;
  const year = when.getFullYear();

  return year === new Date().getFullYear() ? stem : `${stem} ${String(year).slice(2)}`;
}

/** The unabbreviated form, for a tooltip or an open message. */
export function formatDateFull(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * How much longer something has to run: "about 6 minutes left".
 *
 * Rounded deliberately coarsely — this is an estimate from an observed rate,
 * and a figure like "5 minutes 12 seconds" would claim a precision it does not
 * have.
 */
export function formatTimeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds < 45) return 'less than a minute left';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `about ${hoursText} ${rest} minutes left` : `about ${hoursText} left`;
}
