// Between — T-TRAJ: S1 trajectory aggregation. Ground-truth month counts on a hand-built fixture,
// the deluge-day threshold, and that a month's [startMs,endMs] resolves to its messages (receipts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { computeTrajectory } from '../src/lenses/trajectory';

const JAN = Date.UTC(2024, 0, 5, 12);
const FEB = Date.UTC(2024, 1, 5, 12);

let tmpDir: string;
let db: BetweenDB;
let ids: number[];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-traj-'));
  db = openDb(join(tmpDir, 'test.db'));
  ids = seedThread(db, [
    { dir: 'incoming', ms: JAN, tension: 3 },              // her hostile+severe
    { dir: 'outgoing', ms: JAN + 60_000, tension: 2 },     // he reciprocates within 2h
    { dir: 'incoming', ms: JAN + 120_000, warmth: 2 },     // her warm
    { dir: 'incoming', ms: FEB, tension: 2 },              // her hostile
    { dir: 'outgoing', ms: FEB + 60_000, tension: 0 },     // he answers soft
    { dir: 'incoming', ms: FEB + 120_000, tension: 2 },    // her hostile, no reply → withdrew
  ]);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-TRAJ month aggregation', () => {
  it('counts volume, hostility, severity, warmth, and answer-mode by side per month', () => {
    const t = computeTrajectory(db, 1);
    expect(t.months).toHaveLength(2);
    const [jan, feb] = t.months;

    expect(jan).toMatchObject({
      volThem: 2, volMe: 1, hostileThem: 1, severeThem: 1, hostileMe: 1, severeMe: 0,
      warmThem: 1, warmMe: 0, recipDenom: 1, recip: 1, soft: 0, withdrew: 0,
    });
    expect(feb).toMatchObject({
      volThem: 2, volMe: 1, hostileThem: 2, severeThem: 0, hostileMe: 0,
      recipDenom: 2, recip: 0, soft: 1, withdrew: 1,
    });
    expect(Array.isArray(t.eras)).toBe(true);
  });

  it('flags deluge days at the configured threshold', () => {
    const t = computeTrajectory(db, 1, { delugeMin: 2 });
    expect(t.delugeMin).toBe(2);
    expect(t.delugeDays).toHaveLength(1);             // only Feb 5 has ≥2 of her hostile
    expect(t.delugeDays[0]).toMatchObject({ date: '2024-02-05', herHostile: 2, herTotal: 2 });
  });

  it('exposes a month range that resolves to its messages (receipts click-through)', () => {
    const t = computeTrajectory(db, 1);
    const jan = t.months[0];
    const inJan = db.getMessages(1, { afterMs: jan.startMs - 1, beforeMs: jan.endMs + 1, limit: 50, order: 'asc' });
    expect(inJan.map((m) => m.id).sort((a, b) => a - b)).toEqual(ids.slice(0, 3).sort((a, b) => a - b));
  });
});
