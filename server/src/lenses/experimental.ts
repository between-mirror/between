// Between — the research gate on the interpretive layer (P1-11, tightened 2026-07-22).
//
// The high-stakes interpretive layer — the L4 abuse stage-2 drain, the power-balance SUPPORT frame,
// the other-side reading, and the findings reading — is text-only, calibration-dependent, and NOT
// externally validated. It is the layer most easily misread as a neutral verdict: in a custody
// fight, or by someone profiling the partner they are already controlling. The deterministic
// findings A–E COUNTS remain available regardless; only the directional/interpretive layer gates.
//
// ── Why there is no switch in the app ────────────────────────────────────────
//
// It used to be reachable by an HTTP call from the app's own origin, described in STATUS as a
// Settings opt-in "with sober consent". Two things were wrong with that. There was no such Settings
// control — the claim described an affordance nobody had built — and a one-click toggle is the wrong
// shape for this regardless: the thing on the other side of it is a research preview that no
// clinician has validated, and a checkbox in a settings pane reads like a feature preference.
//
// So activation now takes a deliberate, out-of-band act: a line hand-written into
// between.config.json, or an environment variable set on the command line. Neither is something
// anyone does by accident, and neither is reachable from a page. What it is NOT is removed —
// removing it would leave Era 5's clinician panel unable to evaluate the thing they are being asked
// to evaluate, and "we deleted it" is not the same claim as "it is off".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BetweenDB } from '../store/db';

const CONSENT_KEY = 'research_layer_consent';

/** Both doors, named where a reader will look for them. */
export const RESEARCH_ENV = 'BETWEEN_RESEARCH_LAYER';
export const RESEARCH_CONFIG_KEY = 'researchInterpretiveLayer';

function repoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/**
 * The config door: `"researchInterpretiveLayer": true` in between.config.json, written by hand.
 *
 * Takes the path so the door can be tested through the same code the lenses call. A documented way
 * in that nothing exercises is how a gate quietly stops being a gate.
 */
export function researchModeFromConfig(configPath = join(repoRoot(), 'between.config.json')): boolean {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    return cfg[RESEARCH_CONFIG_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Whether research mode is switched on at all — the flag, and nothing else.
 *
 * Deliberately takes no database state. A gate an ordinary build can flip is a gate that a bug, or a
 * borrowed browser tab, can flip.
 */
export function researchModeFlag(): boolean {
  return process.env[RESEARCH_ENV] === '1' || researchModeFromConfig();
}

/**
 * Whether an interpretive reading may actually run: the flag AND a recorded acknowledgement.
 *
 * The consent is per-database and survives from the old toggle, where it was the one genuinely good
 * part — someone should have to read what this layer is before it writes anything about the person
 * they live with. Setting an environment variable is a decision about a process; this is a decision
 * about an archive, and they are not the same act.
 */
export function experimentalLensesEnabled(db?: BetweenDB): boolean {
  if (!researchModeFlag()) return false;
  return db ? researchConsentRecorded(db) : true;
}

/** Whether the operator has acknowledged what they switched on, in this database. */
export function researchConsentRecorded(db: BetweenDB): boolean {
  return db.getMeta(CONSENT_KEY) === '1';
}

/** Record the acknowledgement. Called by the CLI after the operator confirms, never by a route. */
export function recordResearchConsent(db: BetweenDB): void {
  db.setMeta(CONSENT_KEY, '1');
}

/**
 * The first-activation consent text. Unchanged in substance from the version behind the old toggle;
 * it is now shown by the CLI at the point of activation, where it is read rather than dismissed.
 */
export const RESEARCH_CONSENT = [
  'Research preview — not validated.',
  '',
  'You are switching on the interpretive layer: the abuse-pattern stage-2 read, the power-balance',
  'support frame, the other-side reading, and the findings reading. These describe patterns in',
  'behavioural language, from text alone, tuned by your own calibration.',
  '',
  'No clinician has evaluated them. There are no published false-positive or false-negative numbers,',
  'because the study that would produce them has not been run. They are not a diagnosis, not an',
  'assessment, and not evidence — and they are most dangerous exactly where they are most tempting:',
  'in a custody dispute, or in the hands of someone building a case about a person.',
  '',
  'The deterministic counts do not need this and never did.',
].join('\n');

/** Honest decline copy for an interpretive reading requested while the layer is off. */
export const EXPERIMENTAL_DECLINE =
  'This reading is part of Between’s interpretive layer — a research preview, off in ordinary '
  + 'builds, and not externally validated. It is not something to switch on from a settings pane: '
  + 'activation is documented for evaluators in docs/STATUS.md. The counting views do not need it.';
