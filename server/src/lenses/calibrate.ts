// Between — the calibration WRITER (P2, server side). The reader (calibration.ts) and the honesty
// check (bias.ts) sit beside it. Given the owner's hold-out labels this derives their thresholds,
// measures their self-report honesty, and persists both — the only sanctioned writer of those keys.
//
// ── Rubric v2 (2026-07-22). What changed, and why ──────────────────────────────
//
// v1 asked the owner to rate each message on a severity ladder — benign / joke / mild / harsh /
// cruel. Two things were wrong with that, and they compounded.
//
// The SAMPLE was drawn by sorting each side by the model's own tension and taking the top spread. So
// the owner was shown, almost entirely, the messages the model already believed were hostile — and
// then their labels were compared against the model's threshold to decide whether the model's
// threshold was right. Selecting on the variable you are about to validate against leaves nothing to
// disagree about: the calm messages the model may have misjudged were never on screen. v2 draws a
// STRATIFIED sample — high, middle and low model-tension bands, per side — so the owner labels
// messages the model thinks are quiet as well as the ones it thinks are loud, and the comparison can
// actually fail.
//
// The RUBRIC asked for a judgement of severity, which is a judgement of intent: "meant to wound"
// cannot be read off the text, only inferred, and inference about one's own messages is exactly
// where a defensive labeler has room to move. It is also the axis on which two honest people
// disagree hardest. v2 asks instead what is OBSERVABLE in the words — was someone called a name, was
// there a threat, were they brushed off, was there an attempt to repair. A stranger reading the same
// message can check the answer, which is the property the whole calibration needs.
//
// Sampling is seeded and reproducible. The seed is recorded with the calibration, so the draw that
// produced a given set of thresholds can be reconstructed exactly — an unreproducible sample makes
// the thresholds unauditable, and this file's entire output is a claim about someone's own honesty.
import type { BetweenDB } from '../store/db';
import { computeSelfReportBias, hostileLabel, type BiasLabel, type SelfReportBias } from './bias';
import { emotionByMessage } from './l1';

export const RUBRIC_VERSION = 2;

/**
 * The v2 rubric. Five points, each a thing a reader can point at in the text.
 *
 * Single-select, strongest-thing-present: several can be true of one message, and asking for the
 * hardest keeps the scale ordered without asking anyone to weigh intent.
 */
export type OwnerLabelV2 = 'none' | 'repair' | 'dismissal' | 'name_calling' | 'threat' | 'skip';

/** Ordered by how hard the behaviour is, for the severity comparison in bias.ts. */
export const V2_SEVERITY: Record<string, number> = {
  none: 0, repair: 0, dismissal: 1, name_calling: 2, threat: 3,
};

/** Which v2 labels count as a hard message. `repair` is observable and deliberately not hostile. */
export const V2_HOSTILE = new Set<string>(['dismissal', 'name_calling', 'threat']);

// ── seeded sampling ──────────────────────────────────────────────────────────

/** mulberry32 — small, fast, and identical everywhere, which is all a reproducible draw needs. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * The default seed for a thread: a function of the archive's own shape.
 *
 * Deriving it from the data rather than the clock means the same archive always produces the same
 * hold-out, so a calibration can be re-examined later without having had the foresight to write the
 * seed down. A caller who wants a genuinely fresh draw passes its own seed, and that seed is what
 * gets recorded.
 */
export function defaultSeed(db: BetweenDB, threadId: number): number {
  const r = db.raw.prepare(
    `SELECT COUNT(*) AS n, COALESCE(MIN(sent_at_ms), 0) AS a, COALESCE(MAX(sent_at_ms), 0) AS b
       FROM messages WHERE thread_id = ? AND is_reaction = 0`,
  ).get(threadId) as { n: number; a: number; b: number };
  // A plain mix; this picks a starting point, it is not protecting anything. The constant is the
  // golden-ratio one, written in hex as it usually is — and as it must be here, because as decimal
  // digits it is ten long and the privacy sweep reads it as a phone number.
  return ((threadId * 0x9E3779B1) ^ (r.n * 40503) ^ (r.a >>> 7) ^ (r.b >>> 3)) >>> 0;
}

export interface HoldoutItem { id: number; dir: 'ME' | 'THEM'; text: string; ms: number }
const speaker = (d: string): 'ME' | 'THEM' => (d === 'outgoing' || d === 'draft' ? 'ME' : 'THEM');

/** The model's own three bands. Deliberately its categories, so "low" means the model called it calm. */
export type Band = 'low' | 'mid' | 'high';
export function bandOf(tension: number): Band {
  if (tension >= 2) return 'high';
  if (tension >= 1) return 'mid';
  return 'low';
}

/** Fisher–Yates against a seeded generator: a draw that is random but reproducible. */
function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface HoldoutSample {
  items: HoldoutItem[];
  seed: number;
  rubricVersion: number;
  /** How many landed in each band per side — the evidence that the draw was actually stratified. */
  strata: Record<'ME' | 'THEM', Record<Band, number>>;
}

/**
 * Draw the blind hold-out: equal halves per side, and within each side an even split across the
 * model's low / mid / high tension bands.
 *
 * The model's tension never leaves the server. The owner must label blind or the score anchors them
 * and the honesty check measures nothing.
 */
export function sampleHoldout(
  db: BetweenDB, threadId: number, n = 42, seed?: number,
): HoldoutSample {
  const useSeed = seed ?? defaultSeed(db, threadId);
  const rand = rng(useSeed);
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages
              WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
              ORDER BY sent_at_ms ASC, id ASC`)
    .all(threadId) as { id: number; ms: number; dir: string; body: string }[];

  const items = rows.map((r) => ({
    id: r.id, ms: r.ms, dir: speaker(r.dir), text: r.body,
    band: bandOf(scores.get(r.id)?.tension ?? 0),
  }));

  const perSide = Math.floor(n / 2);
  const strata: HoldoutSample['strata'] = {
    ME: { low: 0, mid: 0, high: 0 }, THEM: { low: 0, mid: 0, high: 0 },
  };

  const drawSide = (dir: 'ME' | 'THEM'): typeof items => {
    const mine = items.filter((i) => i.dir === dir);
    const byBand: Record<Band, typeof items> = {
      low: shuffle(mine.filter((i) => i.band === 'low'), rand),
      mid: shuffle(mine.filter((i) => i.band === 'mid'), rand),
      high: shuffle(mine.filter((i) => i.band === 'high'), rand),
    };
    const want = Math.floor(perSide / 3);
    const picked: typeof items = [];
    // First pass: an equal share of each band.
    for (const b of ['high', 'mid', 'low'] as Band[]) {
      const take = byBand[b].splice(0, want);
      picked.push(...take);
      strata[dir][b] += take.length;
    }
    // A short band gives its slots back rather than shrinking the sample — but the shortfall is
    // reported in `strata`, so a thread with no calm messages cannot silently look stratified.
    for (const b of ['high', 'mid', 'low'] as Band[]) {
      while (picked.length < perSide && byBand[b].length) {
        picked.push(byBand[b].shift()!);
        strata[dir][b] += 1;
      }
    }
    return picked;
  };

  const me = shuffle(drawSide('ME'), rand);
  const them = shuffle(drawSide('THEM'), rand);

  // Interleave so the owner never labels a long run of one person's messages — a run invites a
  // rhythm, and a rhythm is a habit rather than a judgement.
  const out: HoldoutItem[] = [];
  for (let i = 0; i < Math.max(me.length, them.length); i++) {
    if (me[i]) out.push({ id: me[i].id, dir: 'ME', text: me[i].text, ms: me[i].ms });
    if (them[i]) out.push({ id: them[i].id, dir: 'THEM', text: them[i].text, ms: them[i].ms });
  }
  return { items: out.slice(0, n), seed: useSeed, rubricVersion: RUBRIC_VERSION, strata };
}

// ── rejoining the blind labels ───────────────────────────────────────────────

export interface OwnerMark { id: number; label: string }

/** Rejoin the owner's blind labels to the model's tension + direction, server-side. */
export function biasLabelsFromMarks(db: BetweenDB, threadId: number, marks: OwnerMark[]): BiasLabel[] {
  const scores = emotionByMessage(db, threadId);
  const dirRows = db.raw.prepare('SELECT id, direction AS dir FROM messages WHERE thread_id = ?')
    .all(threadId) as { id: number; dir: string }[];
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

export interface Thresholds { hostile_tension: number; severe_tension: number }

/** The shipped prior. Returned whenever the labels cannot honestly move it. */
const NEUTRAL: Thresholds = { hostile_tension: 2, severe_tension: 3 };

/** Pick this owner's thresholds by maximizing F1 against their own labels. A PROPOSAL, not a decision. */
export function deriveThresholds(labels: BiasLabel[]): Thresholds {
  const scored = labels.filter((l) => l.label && l.label !== 'skip');
  if (scored.length < 8) return { ...NEUTRAL };                       // too few to tune

  // No hostile label anywhere means there is nothing to fit a threshold TO, and the F1 sweep does
  // not degrade gracefully: with zero actual-positives every candidate scores 0, `f > bestH` is true
  // only for the first one, and t = 1 wins on tie-break. So an owner who honestly answered "nothing
  // of the kind" to all forty-two came out with hostile ≥ 1 — STRICTER than the shipped default, and
  // marked "calibrated to you", which also drops the provisional warning. The person who reported
  // the least hostility got the reading with the most. An ordinary archive labelled honestly is the
  // common case, not an edge one: v2 has no catch-all mild option and two thirds of the stratified
  // draw comes from the model's own low and mid bands.
  const hostileCount = scored.filter((l) => hostileLabel(l.label)).length;
  if (hostileCount < 3) return { ...NEUTRAL };

  // The sweep also learns nothing when the model's tension has no SPREAD across this sample. If
  // every message sits in one band, exactly one candidate threshold predicts anything at all — and
  // it predicts everything, so it scores above zero and wins uncontested while the others sit at an
  // artefactual zero they could never have beaten. That is not the labels choosing a threshold; it
  // is the only option that was allowed to score. It lands on hostile ≥ 1 from an archive whose
  // owner marked three messages, which is the same harm as the no-positives case: a stricter
  // reading than the shipped default, presented as calibrated to them.
  const separating = [1, 2, 3].filter((t) => {
    const pos = scored.filter((l) => l.tension >= t).length;
    return pos > 0 && pos < scored.length;
  }).length;
  if (separating < 2) return { ...NEUTRAL };

  let hostile = 2, bestH = -1;
  for (const t of [1, 2, 3]) {
    const f = f1At(scored, t, (l) => hostileLabel(l.label));
    if (f > bestH) { bestH = f; hostile = t; }
  }
  // A sweep in which every candidate scores zero has learned nothing — it did not pick 1, it
  // defaulted to the first thing it tried. That happens with no hostile labels, and it happens again
  // when the model has scored nothing at all (no L1 pass run, so every tension is 0 and no threshold
  // separates anything). Either way the honest answer is the prior, not the strictest option.
  if (bestH <= 0) return { ...NEUTRAL };
  const severeCount = scored.filter((l) => (V2_SEVERITY[l.label] ?? 0) >= 3 || l.label === 'cruel').length;
  let severe = Math.min(hostile + 1, 3);
  if (severeCount >= 3) {
    let bestS = -1;
    for (const t of [2, 3]) {
      const f = f1At(scored, t, (l) => (V2_SEVERITY[l.label] ?? 0) >= 3 || l.label === 'cruel');
      if (f > bestS) { bestS = f; severe = t; }
    }
  }
  if (severe <= hostile) severe = Math.min(hostile + 1, 3);
  return { hostile_tension: hostile, severe_tension: severe };
}

// ── the review step ──────────────────────────────────────────────────────────

export interface Disagreement {
  id: number;
  dir: 'ME' | 'THEM';
  text: string;
  ms: number;
  label: string;
  /** 'model_harder' = the model called it hard and the owner did not. 'owner_harder' = the reverse. */
  kind: 'model_harder' | 'owner_harder';
}

export interface CalibrationReview {
  thresholds: Thresholds;
  bias: SelfReportBias;
  disagreements: Disagreement[];
  rubricVersion: number;
  seed: number | null;
}

/**
 * Propose thresholds and show the owner where the model read their archive differently — WITHOUT
 * writing anything.
 *
 * v1 went straight from labels to persisted thresholds by maximizing F1. That is a silent decision
 * about someone's own words: the number that follows them through every later reading was chosen by
 * an optimizer they never saw, over disagreements nobody mentioned. Where the two readings differ is
 * the single most informative thing this whole exercise produces, and it was being thrown away. So
 * it is surfaced, and the owner confirms or goes back and adjusts before anything is written.
 */
export function reviewCalibration(
  db: BetweenDB, threadId: number, marks: OwnerMark[], seed: number | null = null,
): CalibrationReview {
  const labels = biasLabelsFromMarks(db, threadId, marks);
  const thresholds = deriveThresholds(labels);
  const bias = computeSelfReportBias(labels);

  const byId = new Map(marks.map((m) => [m.id, m.label] as const));
  const rows = db.raw.prepare(
    `SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS text FROM messages WHERE thread_id = ?`,
  ).all(threadId) as { id: number; ms: number; dir: string; text: string | null }[];
  const meta = new Map(rows.map((r) => [r.id, r] as const));
  const scores = emotionByMessage(db, threadId);

  const disagreements: Disagreement[] = [];
  for (const [id, label] of byId) {
    if (!label || label === 'skip') continue;
    const row = meta.get(id);
    if (!row) continue;
    const tension = scores.get(id)?.tension ?? 0;
    const modelHard = tension >= thresholds.hostile_tension;
    const ownerHard = hostileLabel(label);
    if (modelHard === ownerHard) continue;
    disagreements.push({
      id, dir: speaker(row.dir), text: row.text ?? '', ms: row.ms, label,
      kind: modelHard ? 'model_harder' : 'owner_harder',
    });
  }
  disagreements.sort((a, b) => a.ms - b.ms);

  return { thresholds, bias, disagreements, rubricVersion: RUBRIC_VERSION, seed };
}

// ── the commit ───────────────────────────────────────────────────────────────

export interface CalibrationResult {
  bias: SelfReportBias;
  thresholds: Thresholds;
  rubricVersion: number;
}

/**
 * Persist the owner's calibration. The ONLY sanctioned writer of the two app_meta keys.
 *
 * The record carries `rubric_version`, so a calibration taken under v1 stays exactly as valid as it
 * was — the thresholds it produced are still that owner's thresholds — and is not silently
 * reinterpreted as if it had been taken under a rubric that did not exist when they answered.
 */
export function applyCalibration(
  db: BetweenDB, labels: BiasLabel[], opts: { seed?: number | null; thresholds?: Thresholds } = {},
): CalibrationResult {
  const bias = computeSelfReportBias(labels);
  const thresholds = opts.thresholds ?? deriveThresholds(labels);
  db.setMeta('self_report_bias', JSON.stringify(bias));
  db.setMeta('calibration', JSON.stringify({
    ...thresholds,
    rubric_version: RUBRIC_VERSION,
    seed: opts.seed ?? null,
    calibrated_at: new Date().toISOString(),
  }));
  return { bias, thresholds, rubricVersion: RUBRIC_VERSION };
}
