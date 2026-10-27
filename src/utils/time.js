/**
 * Hotel-local dates. The database stores UTC; "today", arrivals and departures are
 * worked out in the hotel's time zone from settings (for example Africa/Lagos).
 */

function offsetMs(timeZone, at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export const isValidTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** 'YYYY-MM-DD' for a moment, in the hotel's time zone. */
export const localDate = (at, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** Start of a local day as a UTC Date. */
function startOfLocalDay(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let start = guess - offsetMs(timeZone, new Date(guess));
  start = guess - offsetMs(timeZone, new Date(start)); // second pass handles DST changes
  return new Date(start);
}

/** { start, end } in UTC covering one local calendar day. */
export function dayRange(dateStr, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: startOfLocalDay(dateStr, timeZone), end: startOfLocalDay(next, timeZone) };
}

export const todayRange = (timeZone, now = new Date()) => dayRange(localDate(now, timeZone), timeZone);
