// Between — T-EPX (render post-validation) + letter material assembly. A rendered sentence whose claim
// lost its receipts is dropped; the episode note stores only what survives. The letter material carries
// the gate stance + eras + top episodes + a receipt universe for the (Fable) render to cite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { refreshEpisodes, getEpisodes, getEpisodeById } from '../src/lenses/episodes';
import { refreshEras } from '../src/lenses/eras';
import { composeBlocks, finalizeEpisodeNote } from '../src/lenses/render';
import { buildLetterMaterial } from '../src/lenses/letter';

const T0 = Date.UTC(2024, 4, 1, 12);

let tmpDir: string;
let db: BetweenDB;
let ids: number[];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-render-'));
  db = openDb(join(tmpDir, 'test.db'));
  ids = seedThread(db, [
    { dir: 'incoming', ms: T0, tension: 2, body: 'you never help' },
    { dir: 'incoming', ms: T0 + 60_000, tension: 3, body: 'unbelievable' },
    { dir: 'incoming', ms: T0 + 120_000, tension: 2, body: 'again' },
    { dir: 'outgoing', ms: T0 + 180_000, tension: 2, body: 'stop' },
    { dir: 'incoming', ms: T0 + 240_000, tension: 2, body: 'done' },
    { dir: 'outgoing', ms: T0 + 300_000, warmth: 2, body: 'sorry, come home' },
  ]);
  refreshEpisodes(db, 1);
  refreshEras(db, 1);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-EPX block composition', () => {
  it('drops an evidence block whose receipts do not resolve (pure)', () => {
    const out = composeBlocks(
      [
        { kind: 'observation', text: 'You went quiet before it ended.', evidence_ids: ['m1'] },
        { kind: 'tentative_interpretation', text: 'She threatened to leave.', evidence_ids: ['m999999'] },
      ],
      new Set(['m1']),
    );
    expect(out.dropped).toBe(1);
    // The unreceipted claim is gone; what remains is the surviving observation plus the app's own
    // closing question (VOICE §6b), which asserts nothing and so needs no receipt.
    expect(out.body.startsWith('You went quiet before it ended.')).toBe(true);
    expect(out.body).not.toContain('threatened');
    expect(out.evidence).toEqual({ 'You went quiet before it ended.': ['m1'] });
  });

  it('finalizes an episode note, storing only receipt-backed prose', () => {
    const [e] = getEpisodes(db, 1);
    const real = `m${ids[0]}`;
    const res = finalizeEpisodeNote(db, e.id, {
      title: 'a hard hour',
      blocks: [
        { kind: 'observation', text: 'You went quiet before it ended.', evidence_ids: [real] },
        { kind: 'tentative_interpretation', text: 'She threatened to leave.', evidence_ids: ['m999999'] },
      ],
    });
    expect(res.dropped).toBe(1);
    const note = getEpisodeById(db, e.id)!.narrative as { title: string; note: string };
    expect(note.title).toBe('a hard hour');
    expect(note.note).toBe('You went quiet before it ended.');
    expect(note.note).not.toContain('threaten');
  });
});

describe('S4 letter material', () => {
  it('assembles the gate stance, eras, headline, top episodes and a receipt universe', () => {
    const m = buildLetterMaterial(db, 1);
    expect(['support', 'two_readings']).toContain(m.gate.frame);
    expect(Array.isArray(m.eras)).toBe(true);
    expect(m.headline.severeThem).toBeGreaterThanOrEqual(1);
    expect(m.topEpisodes.length).toBeGreaterThanOrEqual(1);
    expect(m.receiptIds.length).toBeGreaterThan(0);
    expect(m.span.startMs).toBeGreaterThan(0);
  });
});
