/**
 * Booking heatmap: how busy bookable resources are, by weekday and hour of day.
 *
 * A cell's utilisation is the booked hours that fell in that weekday and hour,
 * divided by the hours that could have been booked: every bookable resource,
 * for each such weekday in the window. So 50 % at Tuesday 10:00 means that, over
 * the window, half of all resource-hours at Tuesday 10:00 were booked.
 *
 * The window is whole local days ending yesterday, in the time zone given, so
 * every weekday is counted over complete days.
 */

export type HeatmapBooking = { startTime: Date; endTime: Date };

export type HeatmapCell = {
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  /** 0-23, local hour. */
  hour: number;
  bookedHours: number;
  utilisationPct: number;
};

export type Heatmap = {
  timeZone: string;
  days: number;
  /** First and last instant of the window (UTC). */
  from: Date;
  to: Date;
  resourceCount: number;
  totalBookedHours: number;
  cells: HeatmapCell[];
  /** The busiest cell, or null when nothing was booked. */
  busiest: HeatmapCell | null;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** True when `timeZone` is a zone name this runtime knows (e.g. "Asia/Calcutta"). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes to add to UTC to get local time in `timeZone` at that moment. */
export function offsetMinutes(at: Date, timeZone: string): number {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / MIN);
}

// 1970-01-01 was a Thursday; with Monday = 0 that is 3.
const weekdayOfLocalDay = (localDay: number) => (((localDay + 3) % 7) + 7) % 7;

export function buildHeatmap(
  bookings: HeatmapBooking[],
  opts: { now: Date; days: number; timeZone: string; resourceCount: number }
): Heatmap {
  const { now, days, timeZone, resourceCount } = opts;

  const nowOffset = offsetMinutes(now, timeZone);
  const todayLocalDay = Math.floor((now.getTime() + nowOffset * MIN) / DAY);
  const firstLocalDay = todayLocalDay - days;
  const lastLocalDay = todayLocalDay - 1;
  // Local midnight, back in UTC.
  const from = new Date(firstLocalDay * DAY - nowOffset * MIN);
  const to = new Date(todayLocalDay * DAY - nowOffset * MIN);

  // How many of each weekday the window holds.
  const occurrences = Array<number>(7).fill(0);
  for (let d = firstLocalDay; d <= lastLocalDay; d++) occurrences[weekdayOfLocalDay(d)]++;

  const bookedMinutes = Array.from({ length: 7 }, () => Array<number>(24).fill(0));

  // The zone's offset can change (daylight saving); look it up per hour of UTC time.
  const offsetCache = new Map<number, number>();
  const offsetAt = (ms: number) => {
    const key = Math.floor(ms / HOUR);
    let off = offsetCache.get(key);
    if (off === undefined) {
      off = offsetMinutes(new Date(ms), timeZone);
      offsetCache.set(key, off);
    }
    return off;
  };

  for (const b of bookings) {
    let cursor = Math.max(b.startTime.getTime(), from.getTime());
    const end = Math.min(b.endTime.getTime(), to.getTime());
    while (cursor < end) {
      const local = cursor + offsetAt(cursor) * MIN;
      const hourStartLocal = Math.floor(local / HOUR) * HOUR;
      const sliceEnd = Math.min(end, cursor + (hourStartLocal + HOUR - local));
      const localDay = Math.floor(local / DAY);
      const hour = Math.floor((local - localDay * DAY) / HOUR);
      bookedMinutes[weekdayOfLocalDay(localDay)][hour] += (sliceEnd - cursor) / MIN;
      cursor = sliceEnd;
    }
  }

  const cells: HeatmapCell[] = [];
  let totalBookedHours = 0;
  let busiest: HeatmapCell | null = null;
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      const bookedHours = Math.round((bookedMinutes[weekday][hour] / 60) * 100) / 100;
      const capacity = resourceCount * occurrences[weekday];
      const pct = capacity > 0 ? Math.min(100, (bookedHours / capacity) * 100) : 0;
      const cell: HeatmapCell = { weekday, hour, bookedHours, utilisationPct: Math.round(pct * 10) / 10 };
      cells.push(cell);
      totalBookedHours += bookedHours;
      if (bookedHours > 0 && (!busiest || cell.utilisationPct > busiest.utilisationPct)) busiest = cell;
    }
  }

  return {
    timeZone,
    days,
    from,
    to,
    resourceCount,
    totalBookedHours: Math.round(totalBookedHours * 100) / 100,
    cells,
    busiest,
  };
}
