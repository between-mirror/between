// Between — the calibration WRITER (Phase 5 P2, server side). The reader (calibration.ts) and the
// honesty check (bias.ts) already existed, but nothing ever wrote app_meta — so every stranger silently
// ran on the developer's own thread-25 defaults and the self-report-bias defence was inert dead code
// (the single biggest validity threat when Between is handed to someone less introspective than its
// author). This module closes that gap: given the owner's hold-out labels, it derives their thresholds,
// measures their self-report honesty, and persists BOTH keys. After this runs, calibrationStatus() flips
// to calibrated and gateFor() reads a real leniency bump instead of falling back to the default 0.66.
import type { BetweenDB } from '../store/db';
import { computeSelfReportBias, type BiasLabel, type SelfReportBias } from './bias';
import { emotionByMessage } from './l1';

const HOSTILE_LABELS = new Set(['mild', 'harsh', 'cruel']);

// ── the hold-out sample the owner labels (P2) ─────────────────────────────────
// The model's tension is DELIBERATELY not returned to the client: the owner must label blind, or the
// score anchors them and the honesty check measures nothing. The server keeps the tension and rejoins
// it on submit. Sampling is deterministic (no RNG): both directions, weighted toward the higher-tension
// messages the calibration actually turns on — including the owner's OWN hard messages, which is the
// whole point of the leniency check.
export interface HoldoutItem { id: number; dir: 'ME' | 'THEM'; text: string; ms: number }
const speaker = (d: string): 'ME' | 'THEM' => (d === 'outgoing' || d === 'draft' ? 'ME' : 'THEM');

function spread<T>(sorted: T[], k: number): T[] {
  if (sorted.length <= k) return sorted;
  const out: T[] = [];
  const step = sorted.length / k;
  for (let i = 0; i < k; i++) out.push(sorted[Math.floor(i * step)]);
  return out;
}

export function sampleHoldout(db: BetweenDB, threadId: number, n = 40): HoldoutItem[] {
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages
              WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != '' ORDER BY sent_at_ms ASC, id ASC`)
    .all(threadId) as { id: number; ms: number; dir: string; body: string }[];
  const items = rows.map((r) => ({ id: r.id, ms: r.ms, dir: speaker(r.dir), text: r.body, tension: scores.get(r.id)?.tension ?? 0 }));
  // per direction: sort by tension desc (so the hardest messages are always included), take an even spread
  const forDir = (d: 'ME' | 'THEM', k: number) =>
    spread(items.filter((i) => i.dir === d).sort((a, b) => b.tension - a.tension || a.id - b.id), k);
  const me = forDir('ME', Math.ceil(n / 2));
  const them = forDir('THEM', Math.floor(n / 2));
  const out: HoldoutItem[] = [];
  for (let i = 0; i < Math.max(me.length, them.length); i++) {
    if (me[i]) out.push({ id: me[i].id, dir: 'ME', text: me[i].text, ms: me[i].ms });   // interleave, tension stripped
    if (them[i]) out.push({ id: them[i].id, dir: 'THEM', text: them[i].text, ms: them[i].ms });
  }
  return out.slice(0, n);
}

// Rejoin the owner's blind labels to the model's tension + direction, server-side, to build BiasLabel[].
export interface OwnerMark { id: number; label: string }
export function biasLabelsFromMarks(db: BetweenDB, threadId: number, marks: OwnerMark[]): BiasLabel[] {
  const scores = emotionByMessage(db, threadId);
  const dirRows = db.raw.prepare('SELECT id, direction AS dir FROM messages WHERE thread_id = ?').all(threadId) as { id: number; dir: string }[];
  const dir = new Map(dirRows.map((r) => [r.id, speaker(r.dir)] as const));
  return marks
    .filter((m) => dir.has(m.id) && typeof m.label === 'string')
    .map((m) => ({ dir: dir.get(m.id)!, tension: scores.get(m.id)?.tension ?? 0, label: m.label }));
}

/** F1 of (model tension ≥ t) against an owner-label predicate, over the scored hold-out. */
function f1At(scored: BiasLabel[], t: number, actual: (l: BiasLabel) => boolean): number {
  let tp = 0, fp = 0, fn = 0;
  for (const l of scored) {
    const pred = l.tension >= t, act = actual(l);
    if (pred && act) tp++; else if (pred && !act) fp++; else if (!pred && act) fn++;
  }
  const prec = tp / (tp + fp || 1), rec = tp / (tp + fn || 1);
  return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
}

/** Pick this owner's hostile/severe tension thresholds by maximizing F1 against their own labels.
 *  Their calibration, not the product's — a gentler or harsher labeler moves their own line. */
export function deriveThresholds(labels: BiasLabel[]): { hostile_tension: number; severe_tension: number } {
  const scored = labels.filter((l) => l.label && l.label !== 'skip');
  if (scored.length < 8) return { hostile_tension: 2, severe_tension: 3 }; // too few to tune — keep neutral prior
  let hostile = 2, bestH = -1;
  for (const t of [1, 2, 3]) { const f = f1At(scored, t, (l) => HOSTILE_LABELS.has(l.label)); if (f > bestH) { bestH = f; hostile = t; } }
  let severe = Math.min(hostile + 1, 3), bestS = -1;
  for (const t of [2, 3]) { const f = f1At(scored, t, (l) => l.label === 'cruel'); if (f > bestS) { bestS = f; severe = t; } }
  if (severe <= hostile) severe = Math.min(hostile + 1, 3);
  return { hostile_tension: hostile, severe_tension: severe };
}

export interface CalibrationResult { bias: SelfReportBias; thresholds: { hostile_tension: number; severe_tension: number } }

/** Apply an owner's hold-out labels: derive + persist their thresholds AND their self-report-bias
 *  verdict. Idempotent (overwrites both meta keys). This is the ONLY sanctioned writer of the two keys. */
export function applyCalibration(db: BetweenDB, labels: BiasLabel[]): CalibrationResult {
  const bias = computeSelfReportBias(labels);
  const thresholds = deriveThresholds(labels);
  db.setMeta('self_report_bias', JSON.stringify(bias));
  db.setMeta('calibration', JSON.stringify(thresholds));
  return { bias, thresholds };
}
