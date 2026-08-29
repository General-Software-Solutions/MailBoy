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
