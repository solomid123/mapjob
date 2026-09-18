/**
 * An explicit "posted between these two dates" filter.
 *
 * The date popover used to be, in its own words, a "calendar simulation": it
 * hardcoded September 2026, drew thirty cells with no weekday alignment, marked
 * the 4th as today forever, and collapsed any click onto one of three coarse
 * buckets. It looked like a date picker and answered a different question.
 *
 * Rather than add a second filter alongside `lastPosted`, a range is encoded
 * into the same string as `range:<start>:<end>`. That one value is already
 * threaded through the feed loader, the Adzuna query builder and the client
 * filter, and widening it beats plumbing a parallel piece of state through all
 * three. Anything that does not recognise the prefix still sees a truthy,
 * non-'all' value, so "a filter is active" keeps working untouched.
 */
export const RANGE_PREFIX = 'range:';

export type PostedRange = { start: string; end: string };

/** `YYYY-MM-DD` in local time. Deliberately not toISOString(), which converts
 *  to UTC first and hands back yesterday for anyone east of Greenwich. */
export const toISODate = (d: Date): string => {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

export const encodePostedRange = (start: string, end: string): string =>
  `${RANGE_PREFIX}${start}:${end}`;

export const parsePostedRange = (value?: string): PostedRange | null => {
  if (!value || !value.startsWith(RANGE_PREFIX)) return null;
  const [start, end] = value.slice(RANGE_PREFIX.length).split(':');
  if (!start || !end) return null;
  return { start, end };
};

/** Whole days between an ISO date and today, both taken at local midnight so
 *  the answer does not change depending on the time of day. */
export const daysAgo = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return 0;
  const then = new Date(y, m - 1, d).getTime();
  const today = new Date();
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((midnight - then) / 86_400_000);
};

/** Short label for the collapsed search pill, e.g. "1 - 10 Sep". */
export const formatPostedRange = (range: PostedRange): string => {
  const fmt = (iso: string, withMonth: boolean) => {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return withMonth
      ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      : `${date.getDate()}`;
  };
  const sameMonth = range.start.slice(0, 7) === range.end.slice(0, 7);
  if (range.start === range.end) return fmt(range.start, true);
  return `${fmt(range.start, !sameMonth)} \u2013 ${fmt(range.end, true)}`;
};

/** The calendar grid for a month: leading blanks so the 1st lands on its real
 *  weekday, then the days. */
export const monthGrid = (year: number, month: number): (number | null)[] => {
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
};
