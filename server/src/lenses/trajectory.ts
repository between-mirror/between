// Between — S1 trajectory: the honest two-metric story as a single deterministic aggregation (no
// model calls). (a) what ARRIVES — monthly hostile/severe counts by side + a warmth overlay; (b) how
// it's ANSWERED — when the other side is hostile, does the owner reciprocate / answer soft / withdraw;
// plus era bands (F2) and a deluge-day strip. Every month carries [startMs,endMs] so the UI clicks
// through to the messages underneath (receipts all the way down).
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { calibrationFor } from './calibration';
import { getEras, type Era } from './eras';

const H = 3_600_000;
const RECIP_WINDOW_MS = 2 * H;
const DEFAULT_DELUGE_MIN = 20; // her hostile messages in a UTC day = a "deluge day"

export interface TrajectoryMonth {
  ym: string; startMs: number; endMs: number;
  volMe: number; volThem: number;
  hostileMe: number; hostileThem: number;
  severeMe: number; severeThem: number;
  warmMe: number; warmThem: number;          // warmth ≥ threshold — the both-things-true overlay
  recip: number; soft: number; withdrew: number; recipDenom: number; // when SHE is hostile, his answer
}

export interface DelugeDay { date: string; herHostile: number; herTotal: number }

export interface Trajectory {
  threadId: number;
  months: TrajectoryMonth[];
  eras: Era[];
  delugeDays: DelugeDay[];
  delugeMin: number;
}

interface Flat { ms: number; me: boolean; t: number; w: number }

function loadFlat(db: BetweenDB, threadId: number): Flat[] {
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(
      `SELECT id, sent_at_ms AS ms, direction AS dir FROM messages
        WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
        ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all(threadId) as { id: number; ms: number; dir: string }[];
  return rows.map((r) => {
    const s = scores.get(r.id);
    return { ms: r.ms, me: r.dir === 'outgoing' || r.dir === 'draft', t: s?.tension ?? 0, w: s?.warmth ?? 0 };
  });
}

export function computeTrajectory(db: BetweenDB, threadId: number, opts: { delugeMin?: number } = {}): Trajectory {
  const cal = calibrationFor(db);
  const delugeMin = opts.delugeMin ?? DEFAULT_DELUGE_MIN;
  const flat = loadFlat(db, threadId);

  type M = Omit<TrajectoryMonth, 'ym' | 'startMs' | 'endMs'>;
  const months = new Map<string, M>();
  const monthOf = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const get = (ym: string): M => {
    let m = months.get(ym);
    if (!m) { m = { volMe: 0, volThem: 0, hostileMe: 0, hostileThem: 0, severeMe: 0, severeThem: 0, warmMe: 0, warmThem: 0, recip: 0, soft: 0, withdrew: 0, recipDenom: 0 }; months.set(ym, m); }
    return m;
  };

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i];
    const m = get(monthOf(f.ms));
    if (f.me) {
      m.volMe++;
      if (f.t >= cal.hostileTension) m.hostileMe++;
      if (f.t >= cal.severeTension) m.severeMe++;
      if (f.w >= cal.warmWarmth) m.warmMe++;
    } else {
      m.volThem++;
      if (f.w >= cal.warmWarmth) m.warmThem++;
      if (f.t >= cal.hostileTension) {
        m.hostileThem++;
        if (f.t >= cal.severeTension) m.severeThem++;
        // how he answers her hostility: first reply within the window
        m.recipDenom++;
        let cls: 'recip' | 'soft' | 'withdrew' = 'withdrew';
        for (let j = i + 1; j < flat.length && flat[j].ms - f.ms <= RECIP_WINDOW_MS; j++) {
          if (flat[j].me) { cls = flat[j].t >= cal.hostileTension ? 'recip' : 'soft'; break; }
        }
        m[cls]++;
      }
    }
  }

  const months2: TrajectoryMonth[] = [...months.keys()].sort().map((ym) => {
    const [y, mo] = ym.split('-').map(Number);
    return { ym, startMs: Date.UTC(y, mo - 1, 1), endMs: Date.UTC(y, mo, 1) - 1, ...months.get(ym)! };
  });

  // deluge strip: her hostile messages per UTC day, kept when ≥ delugeMin
  const dayMap = new Map<string, DelugeDay>();
  for (const f of flat) {
    if (f.me) continue;
    const date = new Date(f.ms).toISOString().slice(0, 10);
    let g = dayMap.get(date);
    if (!g) { g = { date, herHostile: 0, herTotal: 0 }; dayMap.set(date, g); }
    g.herTotal++;
    if (f.t >= cal.hostileTension) g.herHostile++;
  }
  const delugeDays = [...dayMap.values()].filter((d) => d.herHostile >= delugeMin).sort((a, b) => (a.date < b.date ? -1 : 1));

  return { threadId, months: months2, eras: getEras(db, threadId), delugeDays, delugeMin };
}
