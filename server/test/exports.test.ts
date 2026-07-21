// Between — T-EXP + T-PACK. Exports: deterministic hash (generated-at is header-only), verbatim body
// carries no narrative/reflection prose, ids resolve. Pack: assembles the frozen reflection + a
// narrated episode (and excludes nothing frozen), receipts present.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { refreshEpisodes, getEpisodes } from '../src/lenses/episodes';
import { buildExport } from '../src/lenses/exports';
import { buildTherapyPack } from '../src/lenses/therapyPack';

const T0 = Date.UTC(2024, 2, 1, 12);
const NARR = 'NARRATIVE_NOTE_SENTINEL';
const REFL = 'REFLECTION_BODY_SENTINEL';

let tmpDir: string;
let db: BetweenDB;
let ids: number[];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-exp-'));
  db = openDb(join(tmpDir, 'test.db'));
  ids = seedThread(db, [
    { dir: 'incoming', ms: T0, tension: 2, body: 'you never help' },
    { dir: 'incoming', ms: T0 + 60_000, tension: 3, body: 'unbelievable' },
    { dir: 'incoming', ms: T0 + 120_000, tension: 2, body: 'again and again' },
    { dir: 'incoming', ms: T0 + 180_000, tension: 2, body: 'done with this' },
    { dir: 'incoming', ms: T0 + 240_000, tension: 2, body: 'goodbye' },
    { dir: 'outgoing', ms: T0 + 300_000, warmth: 2, body: 'I am sorry, come home' },
  ]);
  refreshEpisodes(db, 1);
  const [e] = getEpisodes(db, 1);
  db.raw.prepare('UPDATE episodes SET narrative_json = ? WHERE id = ?').run(JSON.stringify({ title: 'a hard night', note: NARR }), e.id);
  db.raw.prepare(
    `INSERT INTO reflections (thread_id, lens, range_start_ms, range_end_ms, content_md, evidence_json, prompt_version, model_note, generated_at)
     VALUES (1, 'first_reflection', ?, ?, ?, '{}', 1, 'test', '2026-07-11')`,
  ).run(T0, T0 + 300_000, `${REFL} — a first reading.`);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-EXP record-grade export', () => {
  it('hashes the message body deterministically, independent of the generated-at stamp', () => {
    const a = buildExport(db, 1, {});
    const b = buildExport(db, 1, { generatedAt: '2020-01-01T00:00:00Z' });
    expect(a.sha256).toBe(b.sha256);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.markdown).toContain(a.sha256); // integrity line present
  });

  it('keeps model prose (narrative / reflection) out of the verbatim body', () => {
    const a = buildExport(db, 1, {});
    expect(a.bodyMd).toContain('you never help');
    expect(a.bodyMd).not.toContain(NARR);
    expect(a.bodyMd).not.toContain(REFL);
  });

  it('exports only ids that resolve to real messages', () => {
    const a = buildExport(db, 1, {});
    expect(a.ids.length).toBe(6);
    for (const id of a.ids) {
      expect(db.raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(id)).toBeTruthy();
    }
  });
});

describe('T-PACK therapy pack', () => {
  it('assembles the frozen reflection and the narrated episode', () => {
    const p = buildTherapyPack(db, 1, { generatedAt: '2026-07-11' });
    expect(p.reflections).toBeGreaterThanOrEqual(1);
    expect(p.episodeNotes).toBe(1);
    expect(p.markdown).toContain(REFL);   // the frozen reading is included
    expect(p.markdown).toContain(NARR);   // the validated episode note is included
    expect(p.markdown).toContain('What the record shows');
  });
});
