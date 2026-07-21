// Between — the experimental-lenses gate (P1-11). The high-stakes interpretive layer — the L4 abuse
// stage-2 drain, the power-balance SUPPORT frame, the other-side reading, and the findings reading — is
// text-only, calibration-dependent, and NOT externally validated. It is the layer most easily misread as
// a neutral verdict (in a custody fight, by an abuser profiling a partner). So it is OFF by default and
// only turns on when the owner opts in through Settings with sober consent. The deterministic findings
// A–E COUNTS remain available regardless; only the directional/support/interpretive layer gates.
import type { BetweenDB } from '../store/db';

const KEY = 'experimental_lenses';

/** Whether the owner has opted into the experimental interpretive layer. Fail-safe default: OFF. */
export function experimentalLensesEnabled(db: BetweenDB): boolean {
  return db.getMeta(KEY) === '1';
}

export function setExperimentalLenses(db: BetweenDB, on: boolean): boolean {
  db.setMeta(KEY, on ? '1' : '0');
  return on;
}

/** Honest decline copy for an experimental reading requested while the layer is off. */
export const EXPERIMENTAL_DECLINE =
  'This reading is part of Between’s experimental, text-only interpretive layer — off by default, and '
  + 'not externally validated. If you want it, turn on Experimental readings in Settings, knowing it is '
  + 'exploratory, not a verdict on anyone.';
