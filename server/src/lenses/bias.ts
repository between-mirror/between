// Between — self-report bias detector. The calibration (hold-out labels + episode grades) is the
// owner's OWN ground truth, and the whole system leans on it. But most people see the other person's
// role far more readily than their own: a defensive labeler soft-pedals their own hostile messages and
// hardens the partner's, which would bias the power-balance gate toward "I'm the victim." This is the
// single biggest validity threat when Between is handed to someone less introspective than its author.
//
// The defence: the model scores every message INDEPENDENTLY of the labels. So we can compare the owner's
// labels to the model's read, split by direction, and measure the asymmetry. When the owner is lenient
// on themselves relative to their partner, we (1) SAY so, plainly, and (2) make the gate need MORE
// one-directional evidence before it will speak in a support frame. The model-detected coercive markers
// (never user-labeled) remain the robust backstop. Honesty in, honesty out — and honesty about the input.

export interface BiasLabel {
  dir: 'ME' | 'THEM';
  tension: number;   // the MODEL's tension for this message (independent of the label)
  /**
   * The owner's label, under either rubric.
   *   v1 (severity):  benign | joke | mild | harsh | cruel | skip
   *   v2 (observable): none | repair | dismissal | name_calling | threat | skip
   */
  label: string;
}

// Both vocabularies live here on purpose. A calibration taken under v1 stays valid until its owner
// re-runs one — their thresholds are still their thresholds — so this module has to keep reading v1
// labels correctly for as long as any v1 record exists. Merging the two into one scale would
// silently reinterpret answers people gave to a different question.
const V1_HOSTILE = new Set(['mild', 'harsh', 'cruel']);
const V2_HOSTILE = new Set(['dismissal', 'name_calling', 'threat']);
const SEVERITY: Record<string, number> = {
  // v1 — a judgement of how bad it was.
  benign: 0, joke: 0, mild: 1, harsh: 2, cruel: 3,
  // v2 — what is observable in the words. `repair` is a real behaviour and is not hostility.
  none: 0, repair: 0, dismissal: 1, name_calling: 2, threat: 3,
};

/** True when a label from either rubric marks a hard message. */
export function hostileLabel(label: string): boolean {
  return V1_HOSTILE.has(label) || V2_HOSTILE.has(label);
}

export interface SelfReportBias {
  n: number;
  ownHighTension: number;      // own messages the model scored hostile (tension ≥ 2)
  otherHighTension: number;
  selfHostileRate: number;     // of own high-tension messages, fraction the owner ALSO called hostile
  otherHostileRate: number;    // …of the partner's
  leniencyBias: number;        // otherHostileRate − selfHostileRate. > 0 = self-lenient (the dangerous way)
  ownMeanSeverity: number;     // mean labeled severity (0–3) on own high-tension messages
  otherMeanSeverity: number;
  // 'insufficient' = too few model-hostile messages on either side to measure the asymmetry honestly.
  verdict: 'self_lenient' | 'balanced' | 'self_critical' | 'insufficient';
  gateThresholdBump: number;   // added to the gate's directional threshold when cautious (0..~0.12)
  note: string;                // one honest sentence for the owner ("calibration asymmetry" framing)
}

/** The minimum model-hostile messages required, on EACH side, before the asymmetry means anything.
 *  Below it — or with an empty denominator — the verdict is 'insufficient', never a false zero rate. */
export const MIN_HOSTILE_SAMPLE = 8;

const rate = (hostile: number, total: number) => (total ? hostile / total : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Measure how much the owner's labels DISAGREE with the model's read, by side (the "calibration
 *  asymmetry"). Self-lenient (own softened relative to partner) is the dangerous direction. Pure. */
export function computeSelfReportBias(labels: BiasLabel[]): SelfReportBias {
  const scored = labels.filter((l) => l.label && l.label !== 'skip');
  const ownHi = scored.filter((l) => l.dir === 'ME' && l.tension >= 2);
  const otherHi = scored.filter((l) => l.dir === 'THEM' && l.tension >= 2);
  const selfHostileRate = rate(ownHi.filter((l) => hostileLabel(l.label)).length, ownHi.length);
  const otherHostileRate = rate(otherHi.filter((l) => hostileLabel(l.label)).length, otherHi.length);
  const leniencyBias = otherHostileRate - selfHostileRate;
  const meanSev = (xs: BiasLabel[]) => (xs.length ? xs.reduce((s, l) => s + (SEVERITY[l.label] ?? 0), 0) / xs.length : 0);

  // Minimum-sample guard (P1-10): with too few model-hostile messages on either side, or an empty
  // denominator, the asymmetry is noise — declare 'insufficient' rather than reading a spurious rate.
  const insufficient = ownHi.length < MIN_HOSTILE_SAMPLE || otherHi.length < MIN_HOSTILE_SAMPLE;
  const verdict: SelfReportBias['verdict'] = insufficient
    ? 'insufficient'
    : leniencyBias > 0.15 ? 'self_lenient' : leniencyBias < -0.15 ? 'self_critical' : 'balanced';

  // Both self-lenient AND insufficient raise the gate threshold — caution is the conservative direction.
  const gateThresholdBump = verdict === 'self_lenient'
    ? Math.min(0.12, Math.max(0, leniencyBias) * 0.3)
    : verdict === 'insufficient'
      ? 0.12 // can't verify the owner's honesty → be maximally conservative before taking a side
      : 0;

  const note = verdict === 'self_lenient'
    ? 'Calibration asymmetry: you labeled your own hard messages more gently than your partner’s. That’s the common human tilt — so the gate now needs more one-directional evidence before it will take a side, and leans on the model’s own reading rather than your labels.'
    : verdict === 'self_critical'
      ? 'Calibration asymmetry: you labeled your own hard messages at least as harshly as your partner’s — the uncommon direction. Read the direction as one perspective to review and consider, not a verdict; the model still weighs both sides.'
      : verdict === 'insufficient'
        ? 'Not enough model-hostile messages on both sides to measure calibration asymmetry honestly. The reading stays cautious and holds the frame more neutral.'
        : 'Calibration asymmetry is small: your labels weighed both sides about evenly.';

  return {
    n: scored.length,
    ownHighTension: ownHi.length, otherHighTension: otherHi.length,
    selfHostileRate: r2(selfHostileRate), otherHostileRate: r2(otherHostileRate),
    leniencyBias: r2(leniencyBias),
    ownMeanSeverity: r2(meanSev(ownHi)), otherMeanSeverity: r2(meanSev(otherHi)),
    verdict, gateThresholdBump: r2(gateThresholdBump), note,
  };
}
