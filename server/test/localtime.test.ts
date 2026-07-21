// Between — lived-timezone bucketing (P2-14 / the timezone finding). Day-level surfaces must bucket by
// the owner's OWN wall clock, and must handle historical DST — a fixed offset would put the wrong hour
// on half the year. These lock the lib and the river's day bucketing end-to-end.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { computeEmotionDaily } from '../src/lenses/l1';
import { setTimezone } from '../src/lib/localtime';
import { makeLocalizer, localDayKey, localHour, isValidTimeZone, getTimezone } from '../src/lib/localtime';

describe('P2-14 localtime lib', () => {
  it('a 23:30 message on the US west coast lands on the local day, not the next UTC day', () => {
    // 2024-06-15 23:30 America/Los_Angeles (PDT, -07:00) = 2024-06-16 06:30 UTC.
    const ms = Date.UTC(2024, 5, 16, 6, 30);
    expect(localDayKey(ms, 'UTC')).toBe('2024-06-16');
    expect(localDayKey(ms, 'America/Los_Angeles')).toBe('2024-06-15'); // still the 15th, locally
    expect(localHour(ms, 'America/Los_Angeles')).toBe(23);
  });

  it('handles the DST transition day (spring forward) correctly', () => {
    // 2024-03-10 02:30-ish is skipped in US DST; a UTC 10:00 that day is 03:00 PDT (after the jump),
    // and a UTC 08:00 is 00:00 PST (before) → both still the 10th locally.
    const beforeJump = Date.UTC(2024, 2, 10, 8, 0);  // 00:00 PST
    const afterJump = Date.UTC(2024, 2, 10, 18, 0);  // 11:00 PDT
    expect(localDayKey(beforeJump, 'America/Los_Angeles')).toBe('2024-03-10');
    expect(localDayKey(afterJump, 'America/Los_Angeles')).toBe('2024-03-10');
    // The offset differs across the jump — a fixed-offset hack would misbucket one of them.
    expect(localHour(beforeJump, 'America/Los_Angeles')).toBe(0);
    expect(localHour(afterJump, 'America/Los_Angeles')).toBe(11);
  });

  it('validates IANA zones and falls back to UTC on garbage', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(makeLocalizer('nonsense').tz).toBe('UTC');
  });
});

describe('P2-14 the river buckets by the owner timezone', () => {
  it('recomputes day buckets when the timezone changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'between-tz-'));
    const db = openDb(join(dir, 'test.db'));
    try {
      // A message at 2024-06-16 06:30 UTC = 2024-06-15 23:30 in Los Angeles.
      const ms = Date.UTC(2024, 5, 16, 6, 30);
      seedThread(db, [
        { dir: 'outgoing', ms, tension: 0, warmth: 1, body: 'late night note' },
        { dir: 'incoming', ms: ms + 60_000, tension: 0, warmth: 1, body: 'reply' },
      ]);

      // Default (UTC) → the 16th.
      expect(getTimezone(db)).toBe('UTC');
      let series = computeEmotionDaily(db, 1);
      expect(series.map((p) => p.date)).toContain('2024-06-16');

      // Switch to LA → the same message now buckets on the 15th (its lived evening).
      setTimezone(db, 'America/Los_Angeles');
      series = computeEmotionDaily(db, 1);
      expect(series.map((p) => p.date)).toContain('2024-06-15');
      expect(series.map((p) => p.date)).not.toContain('2024-06-16');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
