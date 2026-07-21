// PARSE agent — classifiers. Synthetic data only; speakers are ME / THEM.
import { describe, it, expect } from 'vitest';
import { classifyReaction, detectLanguage, threadCoverage } from '../src/ingest/classify';
import type { MsgKind, Direction } from '../src/types';

describe('classifyReaction', () => {
  it('flags all six tapback verbs with the right kind', () => {
    const cases: Array<[string, string]> = [
      ['Liked "see you at five"', 'liked'],
      ['Loved "the photo you sent"', 'loved'],
      ['Emphasized "we need to talk"', 'emphasized'],
      ['Laughed at "that is ridiculous"', 'laughed'],
      ['Disliked "not going to happen"', 'disliked'],
      ['Questioned "are you sure about that"', 'questioned'],
    ];
    for (const [body, kind] of cases) {
      const r = classifyReaction(body);
      expect(r.isReaction).toBe(true);
      expect(r.kind).toBe(kind);
    }
  });

  it('accepts curly quotes as well as straight quotes', () => {
    const r = classifyReaction('Loved “thanks so much”');
    expect(r.isReaction).toBe(true);
    expect(r.kind).toBe('loved');
  });

  it('is case-sensitive and anchored — ordinary sentences are not reactions', () => {
    expect(classifyReaction('liked "this"').isReaction).toBe(false); // lowercase verb
    expect(classifyReaction('I really liked "the show"').isReaction).toBe(false); // not anchored
    expect(classifyReaction('Loved it').isReaction).toBe(false); // no quoted original
    expect(classifyReaction('just a normal message').isReaction).toBe(false);
  });

  it('returns not-a-reaction for null/empty bodies', () => {
    expect(classifyReaction(null)).toEqual({ isReaction: false, kind: null });
    expect(classifyReaction('')).toEqual({ isReaction: false, kind: null });
  });
});

describe('detectLanguage', () => {
  it('tags a non-English snippet', () => {
    expect(detectLanguage('Hola, ¿cómo estás? Nos vemos mañana en la casa de tu madre'))
      .toBe('es');
  });

  it('tags an English snippet', () => {
    expect(detectLanguage('Hello there, how are you doing today my friend?')).toBe('en');
  });

  it('returns null for null, empty, or too-short text', () => {
    expect(detectLanguage(null)).toBeNull();
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('   ')).toBeNull();
    expect(detectLanguage('ok')).toBeNull(); // < 4 chars
  });

  it('returns null when there is nothing linguistic to go on', () => {
    expect(detectLanguage('\u{1F600}\u{1F600}\u{1F600}')).toBeNull(); // emoji only
  });
});

describe('threadCoverage', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const base = Date.UTC(2021, 0, 1);
  const msg = (dayOffset: number): { sentAtMs: number; kind: MsgKind; direction: Direction } => ({
    sentAtMs: base + dayOffset * DAY,
    kind: 'sms',
    direction: 'incoming',
  });

  it('trusts a steadily active thread (no long gap)', () => {
    const msgs = Array.from({ length: 30 }, (_, i) => msg(i * 3));
    expect(threadCoverage(msgs)).toEqual({ confidence: 1.0, note: null });
  });

  it('trusts a thread with too few messages to judge', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => msg(i * 40));
    expect(threadCoverage(msgs)).toEqual({ confidence: 1.0, note: null });
  });

  it('lowers confidence when a busy run abruptly goes silent for many months', () => {
    // 25 busy messages over ~72 days, then a ~7-month silence.
    const busy = Array.from({ length: 25 }, (_, i) => msg(i * 3)); // days 0..72
    const after = msg(72 + 210); // 210-day (~7 month) gap
    const r = threadCoverage([...busy, after]);
    expect(r.confidence).toBe(0.4);
    expect(r.note).toBeTruthy();
    expect(r.note).toContain('may be missing');
  });

  it('uses the milder 0.6 for a 3-to-6 month silence after a busy run', () => {
    const busy = Array.from({ length: 25 }, (_, i) => msg(i * 3)); // days 0..72
    const after = msg(72 + 120); // ~4 month gap
    const r = threadCoverage([...busy, after]);
    expect(r.confidence).toBe(0.6);
    expect(r.note).toBeTruthy();
  });

  it('does not lower confidence when the thread was not busy before the gap', () => {
    // Only 3 messages before a long gap, then activity resumes.
    const before = [msg(0), msg(1), msg(2)];
    const resumed = Array.from({ length: 20 }, (_, i) => msg(300 + i * 2));
    const r = threadCoverage([...before, ...resumed]);
    expect(r).toEqual({ confidence: 1.0, note: null });
  });

  it('sorts defensively before measuring the gap', () => {
    const busy = Array.from({ length: 25 }, (_, i) => msg(i * 3));
    const after = msg(72 + 210);
    const shuffled = [after, ...busy].reverse();
    expect(threadCoverage(shuffled).confidence).toBe(0.4);
  });
});
