// Between — T-AMB: the sentiment-free baseline stats. Hand-computed volume, cadence, first-of-day,
// language (word map, emoji, "I love you", question rate) on a tiny fixture.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { computeAmbient, refreshAmbient, getAmbient } from '../src/lenses/ambient';

const D1 = Date.UTC(2024, 5, 1, 9, 0);
const D2 = Date.UTC(2024, 5, 2, 8, 0);

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-amb-'));
  db = openDb(join(tmpDir, 'test.db'));
  seedThread(db, [
    { dir: 'outgoing', ms: D1, body: 'good morning sunshine ❤️' },
    { dir: 'incoming', ms: D1 + 5 * 60_000, body: 'morning! coffee?' },  // her, question, replies in 5 min
    { dir: 'outgoing', ms: Date.UTC(2024, 5, 1, 22, 0), body: 'i love you goodnight' }, // ily me
    { dir: 'incoming', ms: D2, body: 'i love you too 😊 breakfast?' },   // ily her, question, first of day 2
  ]);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-AMB baseline stats', () => {
  it('counts volume, activity, and per-side totals', () => {
    const a = computeAmbient(db, 1);
    expect(a.volume).toMatchObject({ total: 4, me: 2, them: 2, activeDays: 2 });
  });

  it('reads cadence, first-of-day, questions, and "I love you"', () => {
    const a = computeAmbient(db, 1);
    expect(a.cadence.medianReplyMinThem).toBe(5);            // her 5-minute reply
    expect(a.cadence.firstOfDay).toEqual({ me: 1, them: 1 }); // day1 you first, day2 her first
    expect(a.language.iLoveYou).toEqual({ me: 1, them: 1 });
    expect(a.language.questionRateThem).toBe(100);           // both her messages ask something
    expect(a.language.questionRateMe).toBe(0);
  });

  it('builds a word map and emoji tally (stopwords filtered)', () => {
    const a = computeAmbient(db, 1);
    expect(a.language.topEmoji.map((e) => e.e)).toEqual(expect.arrayContaining(['❤️', '😊']));
    const meWords = a.language.topWordsMe.map((w) => w.w);
    expect(meWords).toContain('morning');
    expect(meWords).not.toContain('you'); // stopword
  });

  it('computes extras: goodnight/goodmorning, monthly volume, double-texting', () => {
    const a = computeAmbient(db, 1);
    expect(a.extras.goodnight.me).toBe(1);   // "i love you goodnight"
    expect(a.extras.goodmorning.me).toBe(1); // "good morning sunshine"
    expect(a.monthlyVolume).toHaveLength(1); // all June 2024
    expect(a.monthlyVolume[0]).toMatchObject({ ym: '2024-06', me: 2, them: 2 });
    expect(a.extras.lastOfDay).toEqual({ me: 1, them: 1 }); // day1 ends with you (22:00), day2 with her
  });

  it('round-trips through the metrics cache', () => {
    const stored = refreshAmbient(db, 1);
    expect(getAmbient(db, 1)).toEqual(stored);
  });
});
