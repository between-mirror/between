// Between — T-L11: the owner-conduct quarterly series. Hand-computed answer-mode + hostile/severe
// shares across two quarters, then a store round-trip.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { computeGrowthQuarterly, refreshGrowth, getGrowth } from '../src/lenses/growth';

const Q1 = Date.UTC(2024, 0, 10, 12); // Jan → Q1
const Q2 = Date.UTC(2024, 3, 10, 12); // Apr → Q2

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-growth-'));
  db = openDb(join(tmpDir, 'test.db'));
  seedThread(db, [
    { dir: 'incoming', ms: Q1, tension: 2 },            // her hostile
    { dir: 'outgoing', ms: Q1 + 60_000, tension: 2 },   // he reciprocates
    { dir: 'outgoing', ms: Q1 + 120_000, tension: 3 },  // his own severe
    { dir: 'incoming', ms: Q2, tension: 2 },            // her hostile
    { dir: 'outgoing', ms: Q2 + 60_000, tension: 0 },   // he answers soft
    { dir: 'incoming', ms: Q2 + 120_000, tension: 2 },  // her hostile, no reply → withdrew
  ]);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-L11 growth quarterly', () => {
  it('computes answer mode and his own hostile/severe share per quarter', () => {
    const g = computeGrowthQuarterly(db, 1);
    expect(g.map((q) => q.quarter)).toEqual(['2024-Q1', '2024-Q2']);
    const [q1, q2] = g;
    expect(q1).toMatchObject({ volMe: 2, hostileMe: 2, severeMe: 1, hostShareMe: 1, severeShareMe: 0.5, recipDenom: 1, recip: 1, recipRate: 1, withdrawRate: 0 });
    expect(q2).toMatchObject({ volMe: 1, hostileMe: 0, severeMe: 0, recipDenom: 2, recip: 0, soft: 1, withdrew: 1, recipRate: 0, withdrawRate: 0.5 });
  });

  it('round-trips through the metrics cache', () => {
    const stored = refreshGrowth(db, 1);
    expect(getGrowth(db, 1)).toEqual(stored);
  });
});
