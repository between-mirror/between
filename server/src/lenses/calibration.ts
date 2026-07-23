// Between — per-owner calibration (GAMEPLAN-PHASE3 guardrail 11). The episode/abuse thresholds are a
// PER-OWNER value derived from that owner's hold-out labeling, not product constants. They live in
// app_meta ('calibration', JSON); the values here are shipped DEFAULTS only, so a stranger with an
// empty DB still gets sane behaviour. calibrationFor() merges any stored overrides over the defaults.
import type { BetweenDB } from '../store/db';

export interface Calibration {
  hostileTension: number;  // avg tension ≥ this = hostile (owner hold-out: 2 → 82% prec / 90% rec / 100% harsh+cruel)
  severeTension: number;   // avg tension ≥ this = severe
  warmWarmth: number;      // warmth ≥ this = a warm / repair message
  gapMs: number;           // max gap between consecutive hostile msgs inside one episode
  minHostile: number;      // fewer hostile msgs than this = a spat, not an episode
  repairWindowMs: number;  // look this far past the last hostile msg for the first warm one
  kidProximityMs: number;  // kid-name within the span ± this = kid nearby
}

export const DEFAULT_CALIBRATION: Calibration = {
  hostileTension: 2,
  severeTension: 3,
  warmWarmth: 2,
  gapMs: 6 * 3_600_000,
  minHostile: 5,
  repairWindowMs: 24 * 3_600_000,
  kidProximityMs: 3_600_000,
};

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Whether THIS owner has actually calibrated — i.e. run the hold-out labeling that writes both
 *  app_meta 'calibration' (their thresholds) and 'self_report_bias' (their honesty check). When false,
 *  every threshold is a shipped product default tuned to a DIFFERENT person, and the self-lenient
 *  defence is inert — so anything directional (the power-balance gate, the findings framing) must be
 *  surfaced as PROVISIONAL, never as a conclusion tuned to them. This is the load-bearing guard for a
 *  next owner who is less introspective than the tool's author. */
export interface CalibrationStatus {
  calibrated: boolean;
  hasThresholds: boolean;
  hasBias: boolean;
  /**
   * Which rubric the stored calibration was taken under. A record written before rubric v2 existed
   * carries no version and reads as 1 — it is not stale and does not need redoing. The owner
   * answered a different question honestly, their thresholds are still theirs, and the only thing
   * that would be dishonest is to relabel their answers as if they had been given under v2.
   */
  rubricVersion: number | null;
  note: string;
}

export function calibrationStatus(db: BetweenDB): CalibrationStatus {
  const raw = db.getMeta('calibration');
  const hasThresholds = !!raw;
  const hasBias = !!db.getMeta('self_report_bias');
  const calibrated = hasThresholds && hasBias;

  let rubricVersion: number | null = null;
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      rubricVersion = num(o.rubric_version, 1);
    } catch { rubricVersion = 1; }
  }

  const note = calibrated
    ? rubricVersion !== null && rubricVersion < 2
      ? 'Calibrated to you: thresholds and a self-report honesty check are on file, taken under the earlier rubric. Still yours, still in force — re-run it only if you want to.'
      : 'Calibrated to you: thresholds and a self-report honesty check are on file.'
    : 'NOT yet calibrated to you — running on shipped defaults tuned to a different person. Read any direction as provisional until you complete the calibration session.';
  return { calibrated, hasThresholds, hasBias, rubricVersion, note };
}

/** Read the owner's calibration from app_meta ('calibration' JSON), merged over the shipped defaults.
 *  Unknown/missing keys fall back to the default; unparseable JSON falls back entirely. */
export function calibrationFor(db: BetweenDB): Calibration {
  const raw = db.getMeta('calibration');
  if (!raw) return { ...DEFAULT_CALIBRATION };
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw) as Record<string, unknown>; } catch { return { ...DEFAULT_CALIBRATION }; }
  return {
    hostileTension: num(o.hostile_tension, DEFAULT_CALIBRATION.hostileTension),
    severeTension: num(o.severe_tension, DEFAULT_CALIBRATION.severeTension),
    warmWarmth: num(o.warm_warmth, DEFAULT_CALIBRATION.warmWarmth),
    gapMs: num(o.gap_ms, DEFAULT_CALIBRATION.gapMs),
    minHostile: num(o.min_hostile, DEFAULT_CALIBRATION.minHostile),
    repairWindowMs: num(o.repair_window_ms, DEFAULT_CALIBRATION.repairWindowMs),
    kidProximityMs: num(o.kid_proximity_ms, DEFAULT_CALIBRATION.kidProximityMs),
  };
}
