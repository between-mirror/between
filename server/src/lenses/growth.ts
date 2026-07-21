// Between — L11 "your own line": the owner's conduct as a first-class, honest story. Per quarter:
// how he answers her hostility (reciprocate / soft / withdraw), his own hostile + severe share. This
// is the series that shows someone climbing out of a cycle — and the relapse quarters, told straight.
// Deterministic; no model calls. A ≤150-word growth_note render can sit on top later.
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { calibrationFor } from './calibration';

const H = 3_600_000;
const RECIP_WINDOW_MS = 2 * H;

export interface GrowthQuarter {
  quarter: string;   // YYYY-Qn
  startMs: number;
  volMe: number;
  hostileMe: number;
  severeMe: number;
  hostShareMe: number;   // his hostile / his messages
  severeShareMe: number; // his severe / his messages
  recip: number; soft: number; withdrew: number; recipDenom: number;
  recipRate: number;     // of her hostile messages he answered, how often he answered hostile
  withdrawRate: number;  // …how often he withdrew (no reply within the window)
}

function quarterOf(ms: number): { q: string; startMs: number } {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const qn = Math.floor(d.getUTCMonth() / 3); // 0..3
  return { q: `${y}-Q${qn + 1}`, startMs: Date.UTC(y, qn * 3, 1) };
}

export function computeGrowthQuarterly(db: BetweenDB, threadId: number): GrowthQuarter[] {
  const cal = calibrationFor(db);
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(
      `SELECT id, sent_at_ms AS ms, direction AS dir FROM messages
        WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
        ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all(threadId) as { id: number; ms: number; dir: string }[];
  const flat = rows.map((r) => {
    const s = scores.get(r.id);
    return { ms: r.ms, me: r.dir === 'outgoing' || r.dir === 'draft', t: s?.tension ?? 0 };
  });

  interface Q { startMs: number; volMe: number; hostileMe: number; severeMe: number; recip: number; soft: number; withdrew: number; recipDenom: number }
  const qs = new Map<string, Q>();
  const get = (ms: number): Q => {
    const { q, startMs } = quarterOf(ms);
    let a = qs.get(q);
    if (!a) { a = { startMs, volMe: 0, hostileMe: 0, severeMe: 0, recip: 0, soft: 0, withdrew: 0, recipDenom: 0 }; qs.set(q, a); }
    return a;
  };

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    const a = get(f.ms);
    if (f.me) {
      a.volMe++;
      if (f.t >= cal.hostileTension) a.hostileMe++;
      if (f.t >= cal.severeTension) a.severeMe++;
    } else if (f.t >= cal.hostileTension) {
      a.recipDenom++;
      let cls: 'recip' | 'soft' | 'withdrew' = 'withdrew';
      for (let j = i + 1; j < flat.length && flat[j].ms - f.ms <= RECIP_WINDOW_MS; j++) {
        if (flat[j].me) { cls = flat[j].t >= cal.hostileTension ? 'recip' : 'soft'; break; }
      }
      a[cls]++;
    }
  }

  return [...qs.entries()]
    .sort((x, y) => x[1].startMs - y[1].startMs)
    .map(([quarter, a]) => ({
      quarter, startMs: a.startMs, volMe: a.volMe, hostileMe: a.hostileMe, severeMe: a.severeMe,
      hostShareMe: a.volMe ? a.hostileMe / a.volMe : 0,
      severeShareMe: a.volMe ? a.severeMe / a.volMe : 0,
      recip: a.recip, soft: a.soft, withdrew: a.withdrew, recipDenom: a.recipDenom,
      recipRate: a.recipDenom ? a.recip / a.recipDenom : 0,
      withdrawRate: a.recipDenom ? a.withdrew / a.recipDenom : 0,
    }));
}

const METRIC_KEY = 'growth_quarterly';

export function refreshGrowth(db: BetweenDB, threadId: number): GrowthQuarter[] {
  const series = computeGrowthQuarterly(db, threadId);
  db.raw
    .prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, ?, 'all', 0, ?)`)
    .run(threadId, METRIC_KEY, JSON.stringify(series));
  return series;
}

export function getGrowth(db: BetweenDB, threadId: number): GrowthQuarter[] {
  const row = db.raw
    .prepare(`SELECT value_json AS v FROM metrics WHERE thread_id = ? AND metric_key = ? AND period = 'all' AND period_start_ms = 0`)
    .get(threadId, METRIC_KEY) as { v: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.v) as GrowthQuarter[]; } catch { return []; }
}
