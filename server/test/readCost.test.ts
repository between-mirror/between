// Between — T-READCOST: the estimate gate's dollar side must be honest and mode-aware. A run only
// "spends" in api-key mode; local-only and subscription never report a bill; nothing to run → $0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { setEngineMode } from '../src/lenses/engineMode';
import { estimateReadCost } from '../src/lenses/readCost';

let tmpDir: string;
let db: BetweenDB;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'between-rc-')); db = openDb(join(tmpDir, 'test.db')); });
afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-READCOST', () => {
  it('nothing to run → $0, never spends, whatever the mode', () => {
    setEngineMode(db, 'api-key');
    const c = estimateReadCost(db, 'l1_emotion', 0);
    expect(c.usdLow).toBe(0);
    expect(c.usdHigh).toBe(0);
    expect(c.spends).toBe(false);
  });

  it('local-only (the default) never reports a bill, even with real work', () => {
    const c = estimateReadCost(db, 'l1_emotion', 500);
    expect(c.engineMode).toBe('local-only');
    expect(c.spends).toBe(false);          // local model / decline — nothing billed
    expect(c.usdHigh).toBeGreaterThan(0);  // the "if you were paying" figure is still computed
    expect(c.note).toMatch(/local-only/i);
  });

  it('subscription runs interactively — no per-run charge reported', () => {
    setEngineMode(db, 'subscription');
    expect(estimateReadCost(db, 'first_reflection', 3).spends).toBe(false);
  });

  it('api-key with real work SPENDS, and the range brackets a positive estimate', () => {
    setEngineMode(db, 'api-key');
    const c = estimateReadCost(db, 'l1_emotion', 1000);
    const low = c.usdLow ?? 0, high = c.usdHigh ?? 0;
    expect(c.spends).toBe(true);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);   // a range, not false precision
    expect(c.note).toMatch(/API key/i);
  });

  it('cost scales with the number of windows to run', () => {
    setEngineMode(db, 'api-key');
    const small = estimateReadCost(db, 'l1_emotion', 100).usdHigh!;
    const big = estimateReadCost(db, 'l1_emotion', 2000).usdHigh!;
    expect(big).toBeGreaterThan(small);
  });

  // Regression: an earlier fallback (520 out/window) priced a whole-archive L1 grunt at ~$6 while the
  // Batch API billed ~$30 — a 5x understatement, the exact surprise this feature exists to prevent.
  it('a whole-archive L1 grunt (~3000 windows) is priced in the real ~$20–$50 band, not a fraction of it', () => {
    setEngineMode(db, 'api-key');
    const c = estimateReadCost(db, 'l1_emotion', 3006);
    expect(c.usdLow!).toBeGreaterThan(18);   // never the old ~$6 undershoot
    expect(c.usdHigh!).toBeLessThan(60);
  });

  // The written reading runs on the subscription/local prose tier, not the paid Batch key — so it must
  // NEVER report an API-key spend, and its price is a couple of calls, not the L1 window backlog.
  it('the first reflection never spends the API key, even in api-key mode, whatever the L1 backlog', () => {
    setEngineMode(db, 'api-key');
    const withBacklog = estimateReadCost(db, 'first_reflection', 3000);
    const noBacklog = estimateReadCost(db, 'first_reflection', 0);
    expect(withBacklog.spends).toBe(false);
    expect(noBacklog.spends).toBe(false);
    expect(withBacklog.usdHigh!).toBeLessThan(5);        // two calls, not hundreds of dollars
    expect(withBacklog.note).not.toMatch(/API key/i);    // honest note: subscription/local, not a key bill
  });
});
