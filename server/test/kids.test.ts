// Between — T-L9: kid PROXIMITY only. A kid-named hostile episode is counted by side; the view is
// unconfigured until app_meta kid_names is set. (The epistemic-limit UI line is enforced by T-VOICE.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { refreshEpisodes } from '../src/lenses/episodes';
import { computeKidsProximity } from '../src/lenses/kids';

const T0 = Date.UTC(2024, 5, 1, 12);

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-kids-'));
  db = openDb(join(tmpDir, 'test.db'));
  // a 5-message hostile burst from her, one line naming a kid → one kid-nearby episode
  seedThread(db, [
    { dir: 'incoming', ms: T0, tension: 2, body: 'you never listen' },
    { dir: 'incoming', ms: T0 + 60_000, tension: 3, body: 'and Milo saw all of it' },
    { dir: 'incoming', ms: T0 + 120_000, tension: 2, body: 'unbelievable' },
    { dir: 'incoming', ms: T0 + 180_000, tension: 2, body: 'again' },
    { dir: 'incoming', ms: T0 + 240_000, tension: 2, body: 'done' },
  ]);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-L9 kids proximity', () => {
  it('is unconfigured until kid_names is set', () => {
    refreshEpisodes(db, 1); // episodes exist, but kid_names not set yet
    const before = computeKidsProximity(db, 1);
    expect(before.configured).toBe(false);
    expect(before.byYear[0].kidEpisodes).toBe(0); // no matcher → no kid flagged
  });

  it('counts kid-nearby hostile episodes by side once configured', () => {
    db.setMeta('kid_names', JSON.stringify(['Milo']));
    refreshEpisodes(db, 1); // recompute with the matcher live
    const k = computeKidsProximity(db, 1);
    expect(k.configured).toBe(true);
    expect(k.totalKidEpisodes).toBe(1);
    const y = k.byYear.find((r) => r.year === 2024)!;
    expect(y).toMatchObject({ kidEpisodes: 1, totalEpisodes: 1, kidEpisodeShare: 1, hostileThem: 5, hostileMe: 0 });
    expect(y.severe).toBe(1); // the one tension-3 line
  });
});
