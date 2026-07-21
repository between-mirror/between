// Between — F2 era layer. Deterministic change-point segmentation over a thread's monthly signals →
// a handful of contiguous eras. The letter, the trajectory dashboard, and the power-balance gate all
// speak in eras. No ML: binary segmentation on piecewise means with a min-segment and a shift floor.
//
// Segmentation input series (per month, z-normalized before splitting):
//   log volume · them-volume share · his hostile share · her hostile share · his reciprocation ·
//   her episode-initiation share · median repair latency (h)
// Episode-derived series are carried forward across months with no episodes (LOCF from the mean).
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { calibrationFor } from './calibration';
import { getEpisodes } from './episodes';

const H = 3_600_000;
const RECIP_WINDOW_MS = 2 * H;

export interface MonthPoint {
  ym: string;            // YYYY-MM (UTC)
  startMs: number;       // first ms of the month (UTC)
  volMe: number;
  volThem: number;
  volTotal: number;
  themVolShare: number;  // them / total
  hostShareMe: number;   // his hostile msgs / his msgs
  hostShareThem: number; // her hostile msgs / her msgs
  recipRate: number;     // when she's hostile, how often he answers hostile within 2h
  themInitShare: number; // episodes that month she initiated / episodes that month (LOCF)
  repairLatencyH: number;// median hours from episode end to first repair (LOCF)
}

/** The MonthPoint fields fed to the segmenter, in order. */
const FEATURES: (keyof MonthPoint)[] = [
  'volTotal', 'themVolShare', 'hostShareMe', 'hostShareThem', 'recipRate', 'themInitShare', 'repairLatencyH',
];

function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthStartMs(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Build the per-month signal series for a thread (pure read; no writes). */
export function buildMonthlySeries(db: BetweenDB, threadId: number): MonthPoint[] {
  const cal = calibrationFor(db);
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(
      `SELECT id, sent_at_ms AS ms, direction AS dir FROM messages
        WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
        ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all(threadId) as { id: number; ms: number; dir: string }[];
  const flat = rows.map((r) => ({
    ms: r.ms,
    me: r.dir === 'outgoing' || r.dir === 'draft',
    t: scores.get(r.id)?.tension ?? 0,
  }));
  if (!flat.length) return [];

  interface Agg { volMe: number; volThem: number; hostMe: number; hostThem: number; recipNum: number; recipDen: number }
  const months = new Map<string, Agg>();
  const agg = (ym: string): Agg => {
    let a = months.get(ym);
    if (!a) { a = { volMe: 0, volThem: 0, hostMe: 0, hostThem: 0, recipNum: 0, recipDen: 0 }; months.set(ym, a); }
    return a;
  };
  for (let i = 0; i < flat.length; i++) {
    const m = flat[i];
    const a = agg(monthKey(m.ms));
    if (m.me) { a.volMe++; if (m.t >= cal.hostileTension) a.hostMe++; }
    else {
      a.volThem++;
      if (m.t >= cal.hostileTension) {
        a.hostThem++;
        // reciprocation: his first reply within the window
        for (let j = i + 1; j < flat.length && flat[j].ms - m.ms <= RECIP_WINDOW_MS; j++) {
          if (flat[j].me) { a.recipDen++; if (flat[j].t >= cal.hostileTension) a.recipNum++; break; }
        }
      }
    }
  }

  // episode-derived signals per month
  const eps = getEpisodes(db, threadId);
  const epMonth = new Map<string, { init: number; count: number; latencies: number[] }>();
  for (const e of eps) {
    const ym = monthKey(e.startMs);
    let g = epMonth.get(ym);
    if (!g) { g = { init: 0, count: 0, latencies: [] }; epMonth.set(ym, g); }
    g.count++;
    if (e.initiator === 'them') g.init++;
    if (e.repairedAtMs != null) g.latencies.push((e.repairedAtMs - e.endMs) / H);
  }

  const orderedYms = [...months.keys()].sort();
  const points: MonthPoint[] = orderedYms.map((ym) => {
    const a = months.get(ym)!;
    const g = epMonth.get(ym);
    return {
      ym, startMs: monthStartMs(ym),
      volMe: a.volMe, volThem: a.volThem, volTotal: a.volMe + a.volThem,
      themVolShare: a.volMe + a.volThem ? a.volThem / (a.volMe + a.volThem) : 0,
      hostShareMe: a.volMe ? a.hostMe / a.volMe : 0,
      hostShareThem: a.volThem ? a.hostThem / a.volThem : 0,
      recipRate: a.recipDen ? a.recipNum / a.recipDen : 0,
      themInitShare: g && g.count ? g.init / g.count : NaN,
      repairLatencyH: g && g.latencies.length ? median(g.latencies) : NaN,
    };
  });

  // carry-forward the episode-derived series across episode-less months (LOCF, seeded from the mean)
  for (const key of ['themInitShare', 'repairLatencyH'] as const) {
    const known = points.filter((p) => !Number.isNaN(p[key])).map((p) => p[key]);
    const seed = known.length ? known.reduce((s, x) => s + x, 0) / known.length : 0;
    let last = seed;
    for (const p of points) { if (Number.isNaN(p[key])) p[key] = last; else last = p[key]; }
  }
  return points;
}

export interface SegmentOpts { minSegment?: number; sigma?: number; maxEras?: number }

function zNormalize(rows: number[][]): number[][] {
  const n = rows.length, f = rows[0]?.length ?? 0;
  const out = rows.map((r) => r.slice());
  for (let c = 0; c < f; c++) {
    let mean = 0; for (let i = 0; i < n; i++) mean += rows[i][c]; mean /= n;
    let v = 0; for (let i = 0; i < n; i++) v += (rows[i][c] - mean) ** 2;
    const sd = Math.sqrt(v / n) || 1;
    for (let i = 0; i < n; i++) out[i][c] = (rows[i][c] - mean) / sd;
  }
  return out;
}

const EPS = 1e-6;

/** Mean per-feature standardized mean-shift for splitting [start,end] at t (right = [t,end]), Cohen's-d
 *  style: |Δmean| / pooled WITHIN-segment SD. Measuring against within-segment noise (not the global
 *  spread) is what lets a small real shift buried in noise stay below the floor while a clean one clears
 *  it. Rows are pre-z-normalized so EPS is a safe floor for a genuinely noiseless (perfectly clean) shift. */
function meanShift(norm: number[][], start: number, end: number, t: number): number {
  const f = norm[0].length;
  const n = end - start + 1;
  let sum = 0;
  for (let c = 0; c < f; c++) {
    let mL = 0; for (let i = start; i < t; i++) mL += norm[i][c]; mL /= (t - start);
    let mR = 0; for (let i = t; i <= end; i++) mR += norm[i][c]; mR /= (end - t + 1);
    let ssL = 0; for (let i = start; i < t; i++) ssL += (norm[i][c] - mL) ** 2;
    let ssR = 0; for (let i = t; i <= end; i++) ssR += (norm[i][c] - mR) ** 2;
    const pooled = Math.sqrt((ssL + ssR) / n); // pooled within-segment SD
    sum += Math.abs(mL - mR) / Math.max(pooled, EPS);
  }
  return sum / f;
}

/**
 * Binary segmentation on piecewise means. Rows are z-normalized per feature, then recursively split
 * at the month that maximizes the mean |Δmean| across features; a split is accepted only if both
 * halves are ≥ minSegment months and the shift exceeds `sigma`. Capped at `maxEras` segments. Pure.
 */
export function segmentEras(rows: number[][], opts: SegmentOpts = {}): { start: number; end: number }[] {
  const minSeg = opts.minSegment ?? 4;
  const sigma = opts.sigma ?? 0.75;
  const maxEras = opts.maxEras ?? 6;
  const n = rows.length;
  if (n < 2 * minSeg) return [{ start: 0, end: n - 1 }];
  const norm = zNormalize(rows);
  let segs = [{ start: 0, end: n - 1 }];
  while (segs.length < maxEras) {
    let best: { s: number; t: number; shift: number } | null = null;
    for (let s = 0; s < segs.length; s++) {
      const { start, end } = segs[s];
      if (end - start + 1 < 2 * minSeg) continue;
      for (let t = start + minSeg; t <= end - minSeg + 1; t++) {
        const shift = meanShift(norm, start, end, t);
        if (!best || shift > best.shift) best = { s, t, shift };
      }
    }
    if (!best || best.shift <= sigma) break;
    const { start, end } = segs[best.s];
    segs.splice(best.s, 1, { start, end: best.t - 1 }, { start: best.t, end });
  }
  return segs.sort((a, b) => a.start - b.start);
}

export interface Era {
  startMs: number;
  endMs: number;         // last ms of the era's final month
  months: number;
  stats: Record<string, number>; // raw (un-normalized) per-feature means over the era, for receipts/display
  name: string | null;
  summary: string | null;
}

/** Compute a thread's eras (pure; no writes). Returns [] when there aren't enough months to segment. */
export function computeEras(db: BetweenDB, threadId: number, opts: SegmentOpts = {}): Era[] {
  const months = buildMonthlySeries(db, threadId);
  if (months.length === 0) return [];
  const rows = months.map((m) => FEATURES.map((f) => m[f] as number));
  const segs = segmentEras(rows, opts);
  return segs.map(({ start, end }) => {
    const slice = months.slice(start, end + 1);
    const stats: Record<string, number> = {};
    for (const f of FEATURES) {
      stats[f] = slice.reduce((s, m) => s + (m[f] as number), 0) / slice.length;
    }
    const lastStart = months[end].startMs;
    const d = new Date(lastStart);
    const endMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1; // last ms of the final month
    return { startMs: months[start].startMs, endMs, months: slice.length, stats, name: null, summary: null };
  });
}

const METRIC_KEY = 'eras';

/** Compute + cache a thread's eras into metrics (key='eras', period='all'). Preserves any existing
 *  era name/summary whose startMs still matches (worthwhile-tier naming survives a recompute). */
export function refreshEras(db: BetweenDB, threadId: number, opts: SegmentOpts = {}): Era[] {
  const prior = getEras(db, threadId);
  const priorByStart = new Map(prior.map((e) => [e.startMs, e]));
  const eras = computeEras(db, threadId, opts).map((e) => {
    const p = priorByStart.get(e.startMs);
    return p ? { ...e, name: p.name, summary: p.summary } : e;
  });
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json)
       VALUES (?, ?, 'all', 0, ?)`,
    )
    .run(threadId, METRIC_KEY, JSON.stringify(eras));
  return eras;
}

/** Set an era's name + summary (matched by startMs) in the stored eras row (worthwhile-tier naming). */
export function setEraNameSummary(db: BetweenDB, threadId: number, startMs: number, name: string, summary: string): boolean {
  const eras = getEras(db, threadId);
  const e = eras.find((x) => x.startMs === startMs);
  if (!e) return false;
  e.name = name; e.summary = summary;
  db.raw
    .prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, 'eras', 'all', 0, ?)`)
    .run(threadId, JSON.stringify(eras));
  return true;
}

/** Read a thread's cached eras (empty array if none computed yet). */
export function getEras(db: BetweenDB, threadId: number): Era[] {
  const row = db.raw
    .prepare(
      `SELECT value_json AS v FROM metrics
        WHERE thread_id = ? AND metric_key = ? AND period = 'all' AND period_start_ms = 0`,
    )
    .get(threadId, METRIC_KEY) as { v: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.v) as Era[]; } catch { return []; }
}
