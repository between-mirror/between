// Between — lived-timezone bucketing (P2-14 / the review's timezone finding). Day-level and
// hour-of-day surfaces (the river, the heatmap, busiest day/hour) must bucket by the owner's OWN
// wall clock, not UTC — a 23:30 message on the US west coast belongs to that evening, not the next
// UTC day. We use Intl with the owner's IANA zone so historical DST is handled correctly (a fixed
// offset would put the wrong hour on half the year). The owner's zone lives in app_meta 'timezone'.
//
// Month/quarter-level surfaces (eras, growth quarters, findings quarters) may stay UTC — the review
// explicitly exempts them; only day-level and finer granularity need the lived clock.
import type { BetweenDB } from '../store/db';

const KEY = 'timezone';

/** Is this a valid IANA zone name the runtime knows? */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    // Throws RangeError on an unknown zone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The owner's IANA timezone (app_meta 'timezone'), defaulting to UTC when unset/invalid. */
export function getTimezone(db: BetweenDB): string {
  const tz = db.getMeta(KEY);
  return isValidTimeZone(tz) ? tz : 'UTC';
}

/** Persist the owner's IANA timezone. Callers must recompute cached day-level metrics after this. */
export function setTimezone(db: BetweenDB, tz: string): string {
  if (!isValidTimeZone(tz)) throw new Error(`invalid IANA timezone: ${tz}`);
  db.setMeta(KEY, tz);
  return tz;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface Localizer {
  tz: string;
  /** YYYY-MM-DD in the owner's lived timezone. */
  dayKey(ms: number): string;
  /** 0–23 hour of day in the owner's lived timezone. */
  hour(ms: number): number;
  /** 0=Sun..6=Sat day of week in the owner's lived timezone. */
  dow(ms: number): number;
}

/** Build a reusable localizer bound to one zone. One Intl formatter is created and reused, so a hot
 *  loop over a whole archive stays cheap. */
export function makeLocalizer(tz: string): Localizer {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  });
  const partsOf = (ms: number): { y: string; mo: string; d: string; h: number; wd: number } => {
    const map: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(ms))) map[p.type] = p.value;
    let h = Number(map.hour);
    if (h === 24) h = 0; // some engines emit '24' for local midnight under hour12:false
    return { y: map.year, mo: map.month, d: map.day, h, wd: WEEKDAY[map.weekday] ?? 0 };
  };
  return {
    tz: zone,
    dayKey: (ms) => { const p = partsOf(ms); return `${p.y}-${p.mo}-${p.d}`; },
    hour: (ms) => partsOf(ms).h,
    dow: (ms) => partsOf(ms).wd,
  };
}

/** One-shot helpers (build a formatter per call — fine for small/occasional use, not hot loops). */
export function localDayKey(ms: number, tz: string): string { return makeLocalizer(tz).dayKey(ms); }
export function localHour(ms: number, tz: string): number { return makeLocalizer(tz).hour(ms); }
export function localDow(ms: number, tz: string): number { return makeLocalizer(tz).dow(ms); }
