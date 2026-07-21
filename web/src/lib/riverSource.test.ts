// Between Mirror — which river layer is honest to show (Era 1, v0.3.0).
//
// The model-scored coverage number has existed since v0.2.0 and was reported honestly. What it never
// did was *gate* anything: the river drew the model layer whenever any model data existed, so a
// thread the model had seen 60% of rendered as though it had seen all of it. An unscored message
// reads as neutral, so a thin drain doesn't look thin — it looks calm. That is the worst possible
// failure mode for this particular chart.
//
// So the decision moves here, into one pure function with the honesty rule written into it: below the
// floor the deterministic layer is what gets drawn, and the coverage line says so in both directions.
import { describe, it, expect } from 'vitest';
import { riverSource, readState, MODEL_COVERAGE_FLOOR } from './riverSource';
import type { EmotionSeries } from './api';

const series = (over: Partial<EmotionSeries> = {}): EmotionSeries => ({
  threadId: 1,
  available: true,
  scoredWindows: 10,
  totalWindows: 10,
  refusedWindows: 0,
  erroredWindows: 0,
  eligibleMessages: 100,
  scoredMessages: 100,
  coveragePct: 100,
  modelComplete: true,
  daily: [{ date: '2024-01-01', count: 3, warmth: 0.4, tension: 0.1, valence: 0.2 }],
  generatedAt: null,
  ...over,
});

describe('the coverage floor gates the river', () => {
  it('the floor is 95%', () => {
    expect(MODEL_COVERAGE_FLOOR).toBe(0.95);
  });

  it('at 94% it shows the deterministic layer, and says so', () => {
    const s = riverSource(series({ coveragePct: 94, scoredMessages: 94, modelComplete: false }));
    expect(s.layer).toBe('deterministic');
    expect(s.note).toBe('Model-scored: 94% — showing the deterministic layer.');
  });

  it('at 96% it shows the model layer, and still says how much was scored', () => {
    const s = riverSource(series({ coveragePct: 96, scoredMessages: 96, modelComplete: true }));
    expect(s.layer).toBe('model');
    expect(s.note).toBe('Model-scored: 96%.');
  });

  it('at exactly the floor the model layer is allowed', () => {
    const s = riverSource(series({ coveragePct: 95, scoredMessages: 95, modelComplete: true }));
    expect(s.layer).toBe('model');
  });

  it('never trusts the flag alone — the numbers have to agree with it', () => {
    // modelComplete arrives over the wire. If a server ever sent a true flag with thin coverage, the
    // client must not draw a river the archive cannot support.
    const s = riverSource(series({ coveragePct: 40, scoredMessages: 40, modelComplete: true }));
    expect(s.layer).toBe('deterministic');
  });

  it('shows the deterministic layer with no note at all before any drain', () => {
    const s = riverSource(series({ available: false, coveragePct: 0, scoredMessages: 0, modelComplete: false }));
    expect(s.layer).toBe('deterministic');
    expect(s.note).toBeNull();   // nothing has been read yet; a coverage line would be noise
  });

  it('names refused and errored windows when there are any', () => {
    const s = riverSource(series({ coveragePct: 80, scoredMessages: 80, modelComplete: false, refusedWindows: 2, erroredWindows: 1 }));
    expect(s.note).toContain('2 stretches were declined');
    expect(s.note).toContain('1 errored');
  });

  it('says nothing about refusals when there were none', () => {
    const s = riverSource(series({ coveragePct: 80, scoredMessages: 80, modelComplete: false }));
    expect(s.note).not.toContain('declined');
    expect(s.note).not.toContain('errored');
  });
});

// Found by the pre-v0.3.0 adversarial review: the read-invite above the chart said "This river is
// drawn from a close reading" whenever ANY model window existed, sitting directly above a chart the
// gate had just demoted to the deterministic layer and captioned "showing the deterministic layer".
// Two claims about one chart, and the false one was larger and higher up the page.
describe('the read-invite agrees with the chart underneath it', () => {
  it('claims a close reading only when the model layer is actually drawn', () => {
    expect(readState(series({ coveragePct: 96, scoredMessages: 96, modelComplete: true }))).toBe('read');
  });

  it('says partly-read when there is model data but not enough to draw it', () => {
    expect(readState(series({ coveragePct: 40, scoredMessages: 40, modelComplete: false }))).toBe('partial');
  });

  it('says unread before any drain', () => {
    expect(readState(series({ available: false, coveragePct: 0, scoredMessages: 0, modelComplete: false }))).toBe('unread');
    expect(readState(null)).toBe('unread');
  });
});
