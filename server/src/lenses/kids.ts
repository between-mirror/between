// Between — L9 "around the kids": exposure-PROXIMITY only. From the episode layer (which already
// flags kid_named within ±proximity), how many hostile episodes had a kid nearby, by side, over time.
// This view never claims what a child saw or felt — the epistemic-limit line (VOICE §6) is permanent
// UI. Unconfigured (no kid_names in app_meta) → configured:false and the view invites setup instead.
import type { BetweenDB } from '../store/db';
import { getEpisodes, kidNameMatcher } from './episodes';

export interface KidsYear {
  year: number;
  totalEpisodes: number;
  kidEpisodes: number;        // episodes with a kid named within the span ± proximity
  kidEpisodeShare: number;    // kidEpisodes / totalEpisodes
  hostileMe: number;          // hostile messages by side inside kid-nearby episodes
  hostileThem: number;
  severe: number;             // severe messages (either side) inside kid-nearby episodes
}

export interface KidsProximity {
  threadId: number;
  configured: boolean;        // false when app_meta kid_names is unset
  byYear: KidsYear[];
  totalKidEpisodes: number;
}

export function computeKidsProximity(db: BetweenDB, threadId: number): KidsProximity {
  const configured = kidNameMatcher(db) != null;
  const eps = getEpisodes(db, threadId);
  const years = new Map<number, KidsYear>();
  const get = (y: number): KidsYear => {
    let a = years.get(y);
    if (!a) { a = { year: y, totalEpisodes: 0, kidEpisodes: 0, kidEpisodeShare: 0, hostileMe: 0, hostileThem: 0, severe: 0 }; years.set(y, a); }
    return a;
  };
  for (const e of eps) {
    const a = get(new Date(e.startMs).getUTCFullYear());
    a.totalEpisodes++;
    if (e.kidNamed) {
      a.kidEpisodes++;
      a.hostileMe += e.hostileMe;
      a.hostileThem += e.hostileThem;
      a.severe += e.severeMe + e.severeThem;
    }
  }
  const byYear = [...years.values()].sort((x, y) => x.year - y.year)
    .map((a) => ({ ...a, kidEpisodeShare: a.totalEpisodes ? a.kidEpisodes / a.totalEpisodes : 0 }));
  return { threadId, configured, byYear, totalKidEpisodes: byYear.reduce((s, a) => s + a.kidEpisodes, 0) };
}

const METRIC_KEY = 'kids_proximity';

export function refreshKids(db: BetweenDB, threadId: number): KidsProximity {
  const value = computeKidsProximity(db, threadId);
  db.raw
    .prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, ?, 'all', 0, ?)`)
    .run(threadId, METRIC_KEY, JSON.stringify(value));
  return value;
}

export function getKids(db: BetweenDB, threadId: number): KidsProximity | null {
  const row = db.raw
    .prepare(`SELECT value_json AS v FROM metrics WHERE thread_id = ? AND metric_key = ? AND period = 'all' AND period_start_ms = 0`)
    .get(threadId, METRIC_KEY) as { v: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.v) as KidsProximity; } catch { return null; }
}
