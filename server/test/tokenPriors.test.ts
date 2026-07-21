// Between — T-PRIOR: measured-usage priors for self-improving cost estimates. recordUsage() seeds the
// EMA on the first sample and blends (alpha 0.3) on later ones; getPrior() reads it back. The store is
// the sole writer, so this exercises the app_meta 'token_priors' read-modify-write path end to end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { recordUsage, getPrior } from '../src/lenses/tokenPriors';

function withDb<T>(fn: (db: BetweenDB) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'between-prior-'));
  const db = openDb(join(dir, 'p.db'));
  try { return fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe('T-PRIOR token usage priors', () => {
  it('returns null before any usage is recorded', () => {
    withDb((db) => expect(getPrior(db, 'l1_emotion', 'claude-haiku-4-5')).toBeNull());
  });

  it('seeds the EMA from the first sample verbatim', () => {
    withDb((db) => {
      recordUsage(db, 'l1_emotion', 'claude-haiku-4-5', 1000, 400);
      expect(getPrior(db, 'l1_emotion', 'claude-haiku-4-5')).toEqual({ inTokens: 1000, outTokens: 400, n: 1 });
    });
  });

  it('EMA-updates on the second sample and counts samples', () => {
    withDb((db) => {
      recordUsage(db, 'l1_emotion', 'claude-haiku-4-5', 1000, 400);
      recordUsage(db, 'l1_emotion', 'claude-haiku-4-5', 2000, 800); // alpha 0.3
      const p = getPrior(db, 'l1_emotion', 'claude-haiku-4-5')!;
      expect(p.inTokens).toBeCloseTo(1300, 6);  // 1000 + 0.3*(2000-1000)
      expect(p.outTokens).toBeCloseTo(520, 6);  // 400  + 0.3*(800-400)
      expect(p.n).toBe(2);
    });
  });

  it('keys priors independently by lens and model', () => {
    withDb((db) => {
      recordUsage(db, 'l1_emotion', 'claude-haiku-4-5', 1000, 400);
      recordUsage(db, 'ask_answer', 'claude-haiku-4-5', 5000, 300);
      recordUsage(db, 'l1_emotion', 'claude-opus-4-8', 1200, 600);
      expect(getPrior(db, 'l1_emotion', 'claude-haiku-4-5')).toEqual({ inTokens: 1000, outTokens: 400, n: 1 });
      expect(getPrior(db, 'ask_answer', 'claude-haiku-4-5')).toEqual({ inTokens: 5000, outTokens: 300, n: 1 });
      expect(getPrior(db, 'l1_emotion', 'claude-opus-4-8')).toEqual({ inTokens: 1200, outTokens: 600, n: 1 });
    });
  });
});
