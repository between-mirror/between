// Between — T-BIAS: the self-report bias detector. A defensive labeler (lenient on self, harsh on the
// partner) must be caught and must raise the gate's bar; an even-handed or self-critical labeler must not.
import { describe, it, expect } from 'vitest';
import { computeSelfReportBias, type BiasLabel } from '../src/lenses/bias';

// helpers: N high-tension (model tension 3) messages from a side, labeled a given way
const msgs = (dir: 'ME' | 'THEM', n: number, label: string): BiasLabel[] =>
  Array.from({ length: n }, () => ({ dir, tension: 3, label }));

describe('T-BIAS self-report bias', () => {
  it('flags a self-lenient labeler and raises the gate threshold', () => {
    // own hard messages called benign; partner's hard messages called cruel
    const b = computeSelfReportBias([...msgs('ME', 10, 'benign'), ...msgs('THEM', 10, 'cruel')]);
    expect(b.verdict).toBe('self_lenient');
    expect(b.selfHostileRate).toBe(0);
    expect(b.otherHostileRate).toBe(1);
    expect(b.leniencyBias).toBe(1);
    expect(b.gateThresholdBump).toBeGreaterThan(0);
  });

  it('does not penalize an even-handed labeler', () => {
    const b = computeSelfReportBias([...msgs('ME', 10, 'harsh'), ...msgs('THEM', 10, 'harsh')]);
    expect(b.verdict).toBe('balanced');
    expect(b.gateThresholdBump).toBe(0);
  });

  it('recognizes a self-critical labeler (harder on self)', () => {
    const b = computeSelfReportBias([...msgs('ME', 10, 'cruel'), ...msgs('THEM', 10, 'benign')]);
    expect(b.verdict).toBe('self_critical');
    expect(b.leniencyBias).toBeLessThan(0);
    expect(b.gateThresholdBump).toBe(0);
  });

  it('ignores low-tension and skipped messages', () => {
    const b = computeSelfReportBias([
      { dir: 'ME', tension: 0, label: 'benign' }, // low tension — not counted in the rate
      { dir: 'THEM', tension: 3, label: 'skip' }, // skipped — excluded
      ...msgs('ME', 4, 'harsh'), ...msgs('THEM', 4, 'harsh'),
    ]);
    expect(b.ownHighTension).toBe(4);
    expect(b.otherHighTension).toBe(4);
  });

  // ── P1-10: minimum-N, no zero-rate artifacts, and the deleted "trust it" line ──
  it('declares insufficient below the minimum sample and stays conservative', () => {
    const b = computeSelfReportBias([...msgs('ME', 5, 'benign'), ...msgs('THEM', 5, 'cruel')]);
    expect(b.verdict).toBe('insufficient');
    expect(b.gateThresholdBump).toBeGreaterThan(0); // caution even without a confident read
  });

  it('never reads a confident verdict from a one-message partner sample (no zero-rate artifact)', () => {
    const b = computeSelfReportBias([...msgs('ME', 12, 'harsh'), ...msgs('THEM', 1, 'benign')]);
    expect(b.verdict).toBe('insufficient'); // NOT self_critical from N=1
  });

  it('declares insufficient (not a confident verdict) when a side has no messages at all', () => {
    const b = computeSelfReportBias([...msgs('ME', 12, 'benign')]);
    expect(b.verdict).toBe('insufficient');
    expect(b.verdict).not.toBe('self_lenient');
  });

  it('no longer tells the owner the gate can "trust" a self-critical calibration', () => {
    const b = computeSelfReportBias([...msgs('ME', 10, 'cruel'), ...msgs('THEM', 10, 'benign')]);
    expect(b.verdict).toBe('self_critical');
    expect(b.note.toLowerCase()).not.toContain('trust it');
    expect(b.note.toLowerCase()).not.toContain('unusually honest');
    expect(b.note.toLowerCase()).toContain('review and consider');
  });
});
