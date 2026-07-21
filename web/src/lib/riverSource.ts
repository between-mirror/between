// Between Mirror — which river layer is honest to show, and what to say about it.
//
// One pure decision, deliberately kept out of the chart component so it can be tested without a DOM
// and so there is exactly one place that can get it wrong.
//
// The rule (P1-7, enforced from v0.3.0): an unscored message reads as neutral. So a thread the model
// has only partly read does not look partly read — it looks calm. Drawing the model layer over thin
// coverage is therefore the single most misleading thing this chart can do, and the coverage number
// existing in the DTO was never protection against it. Below the floor, the deterministic (VADER)
// layer is what gets drawn, and the caption says which layer you are looking at either way.
import type { EmotionSeries } from './api';

/** Matches the server's L1_COVERAGE_FLOOR. Below this, the model layer is not the reading. */
export const MODEL_COVERAGE_FLOOR = 0.95;

export type RiverLayer = 'model' | 'deterministic';

export interface RiverSource {
  /** Which series the chart may draw. */
  layer: RiverLayer;
  /** A quiet line under the chart, or null when there is nothing honest to say yet. */
  note: string | null;
}

/**
 * Decide the layer from the series' own coverage.
 *
 * `modelComplete` arrives over the wire, so it is treated as a claim to be checked rather than a
 * fact: the layer is only promoted when the numbers themselves clear the floor. A server bug, an old
 * cached response, or a hand-rolled build must not be able to talk this client into drawing a river
 * the archive cannot support.
 */
export function riverSource(series: EmotionSeries): RiverSource {
  const eligible = series.eligibleMessages ?? 0;
  const scored = series.scoredMessages ?? 0;
  const ratio = eligible > 0 ? scored / eligible : 0;
  const complete = series.modelComplete === true && ratio >= MODEL_COVERAGE_FLOOR;

  // Nothing has been read yet. A coverage line here would be noise in front of an unasked question —
  // the ask-to-read affordance is what belongs on screen, not a 0%.
  if (!series.available || scored === 0) return { layer: 'deterministic', note: null };

  const pct = series.coveragePct ?? Math.round(ratio * 100);
  const parts: string[] = [];
  parts.push(complete ? `Model-scored: ${pct}%.` : `Model-scored: ${pct}% — showing the deterministic layer.`);

  // Refusals and errors are the *reason* coverage is short. Leaving them out would make a declined
  // stretch look like one that simply hasn't been read yet.
  const refused = series.refusedWindows ?? 0;
  const errored = series.erroredWindows ?? 0;
  if (refused > 0 || errored > 0) {
    const bits: string[] = [];
    if (refused > 0) bits.push(`${refused} ${refused === 1 ? 'stretch was' : 'stretches were'} declined`);
    if (errored > 0) bits.push(`${errored} errored`);
    parts.push(`${bits.join(', ')} — those messages are still here to read yourself.`);
  }

  return { layer: complete ? 'model' : 'deterministic', note: parts.join(' ') };
}

export type ReadState = 'unread' | 'partial' | 'read';

/**
 * What the invite above the chart may claim. Driven by the SAME decision the chart is, because the
 * two were allowed to disagree: the invite read "This river is drawn from a close reading" whenever a
 * single window had been drained, directly above a chart the gate had demoted to the deterministic
 * layer and captioned as such.
 *
 * 'partial' is its own state on purpose. "Not read" and "read 40% of" are different situations for
 * the person deciding whether to spend more time or money, and collapsing them into a boolean is what
 * produced the contradiction.
 */
export function readState(series: EmotionSeries | null): ReadState {
  if (!series || !series.available || (series.scoredMessages ?? 0) === 0) return 'unread';
  return riverSource(series).layer === 'model' ? 'read' : 'partial';
}
