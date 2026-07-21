// Between — T-CAL: per-owner calibration override (GAMEPLAN-PHASE3 guardrail 11). The shipped
// constants are defaults; the owner's hold-out values live in app_meta and must win, with sane
// fallbacks for missing/garbage input. Also proves the episode clusterer honours an override.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { DEFAULT_CALIBRATION, calibrationFor } from '../src/lenses/calibration';
import { clusterEpisodes } from '../src/lenses/episodes';
import type { EpisodeMsg } from '../src/lenses/episodes';

let autoId = 1;
function burst(ms: number, n: number, tension: number): EpisodeMsg[] {
  return Array.from({ length: n }, (_, i): EpisodeMsg =>
    ({ id: autoId++, ms: ms + i * 60_000, me: false, tension, warmth: 0, kid: false }));
}

function withDb<T>(fn: (db: BetweenDB) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'between-cal-'));
  const db = openDb(join(dir, 'c.db'));
  try { return fn(db); } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}

describe('T-CAL calibration override', () => {
  it('returns the shipped defaults when app_meta has no calibration row', () => {
    withDb((db) => expect(calibrationFor(db)).toEqual(DEFAULT_CALIBRATION));
  });

  it('merges partial overrides over defaults and ignores unknown keys', () => {
    withDb((db) => {
      db.setMeta('calibration', JSON.stringify({ hostile_tension: 3, min_hostile: 2, source: 'holdout-2026-07-11' }));
      const c = calibrationFor(db);
      expect(c.hostileTension).toBe(3);
      expect(c.minHostile).toBe(2);
      expect(c.severeTension).toBe(DEFAULT_CALIBRATION.severeTension); // an untouched key still defaults
    });
  });

  it('falls back entirely on unparseable JSON, and per-key on non-numeric values', () => {
    withDb((db) => {
      db.setMeta('calibration', 'not json');
      expect(calibrationFor(db)).toEqual(DEFAULT_CALIBRATION);
      db.setMeta('calibration', JSON.stringify({ hostile_tension: 'high' }));
      expect(calibrationFor(db).hostileTension).toBe(DEFAULT_CALIBRATION.hostileTension);
    });
  });

  it('clusterEpisodes honours an override threshold (raising the bar drops a tension-2 fight)', () => {
    const T0 = Date.UTC(2024, 0, 1, 12);
    const msgs = burst(T0, 6, 2); // six tension-2 messages, one minute apart
    expect(clusterEpisodes(msgs)).toHaveLength(1);                                                   // default hostile=2 → one episode
    expect(clusterEpisodes(msgs, { ...DEFAULT_CALIBRATION, hostileTension: 3 })).toHaveLength(0);    // raise the bar → nothing hostile
  });
});
