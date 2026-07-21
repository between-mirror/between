// Between — T-ENGINE-MODE: the engine preference must be a SAFE default and load-bearing (it gates
// paid inference), not another recorded-but-ignored flag.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { getEngineMode, setEngineMode, paidBatchAllowed } from '../src/lenses/engineMode';

let tmpDir: string;
let db: BetweenDB;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'between-em-')); db = openDb(join(tmpDir, 'test.db')); });
afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-ENGINE-MODE', () => {
  it('defaults to the safe local-only when unset or garbage', () => {
    expect(getEngineMode(db)).toBe('local-only');
    db.setMeta('engine_mode', 'nonsense');
    expect(getEngineMode(db)).toBe('local-only');
    expect(paidBatchAllowed('local-only')).toBe(false);   // the default cannot bill
  });

  it('only api-key mode permits paid off-device inference', () => {
    expect(paidBatchAllowed('api-key')).toBe(true);
    expect(paidBatchAllowed('subscription')).toBe(false); // subscription runs interactively, not a headless paid batch
    expect(paidBatchAllowed('local-only')).toBe(false);
  });

  it('round-trips a valid mode and rejects an invalid one', () => {
    expect(setEngineMode(db, 'api-key')).toBe('api-key');
    expect(getEngineMode(db)).toBe('api-key');
    expect(() => setEngineMode(db, 'cloud' as never)).toThrow(/invalid engine mode/i);
  });
});
