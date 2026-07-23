// Between — T-FINDINGS: the final insight layer. Hand-built fixture exercising the ledger, kids
// framing, exit signature (the named pause), apology economics, and the wearing-down quarters.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { enableResearchLayer, withdrawResearchConsent, clearResearchFlag } from './helpers/research';
import { refreshEpisodes } from '../src/lenses/episodes';
import { refreshEras } from '../src/lenses/eras';
import { computeLedger, computeKidsFraming, computeExitSignature, computeApologyEconomics, computeWearingDown, buildFindingsMaterial } from '../src/lenses/findings';
import { finalizeFindingsReading } from '../src/lenses/render';

const T0 = Date.UTC(2024, 5, 1, 12);
const M = 60_000, HR = 3_600_000;

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-find-'));
  db = openDb(join(tmpDir, 'test.db'));
  enableResearchLayer(db); // the findings READING is a research preview; open both doors to exercise it
  seedThread(db, [
    { dir: 'incoming', ms: T0, tension: 3, body: 'go kill yourself' },                        // death_wish · them
    { dir: 'incoming', ms: T0 + M, tension: 2, body: 'you never help with our kids' },         // our-kids · them
    { dir: 'outgoing', ms: T0 + 2 * M, tension: 0, body: "i need an hour, i'm not leaving this" }, // owner's in-episode last → NOTICE
    { dir: 'incoming', ms: T0 + 3 * M, tension: 2, body: 'my kids deserve better than you' },  // my-kids · them
    { dir: 'incoming', ms: T0 + 4 * M, tension: 2, body: 'unbelievable' },
    { dir: 'incoming', ms: T0 + 5 * M, tension: 2, body: 'done' },                              // 5 them-hostile → 1 episode
    { dir: 'outgoing', ms: T0 + 8 * HR, tension: 0, body: "i'm sorry i hit you" },              // physical + apology · me (first repair)
    { dir: 'incoming', ms: T0 + 8 * HR + 30 * M, tension: 2, body: 'fuck you' },                // apology met with fire
  ]);
  refreshEpisodes(db, 1);
  refreshEras(db, 1);
});

afterAll(() => { clearResearchFlag(); db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-FINDINGS', () => {
  it('A — the ledger of hands catches death-wishes and physical disclosures by side', () => {
    const l = computeLedger(db, 1);
    expect(l.byDir.death_wish.them).toBe(1);
    expect(l.byDir.physical.me).toBe(1);
    expect(l.entries.some((e) => e.category === 'physical' && e.dir === 'me')).toBe(true);
  });

  it('B — kids framing separates my-kids from our-kids by side', () => {
    const k = computeKidsFraming(db, 1);
    expect(k.total.ourThem).toBe(1);
    expect(k.total.myThem).toBe(1);
    expect(k.total.myMe).toBe(0);
  });

  it('D — the exit signature classifies the owner’s in-episode close (the named pause)', () => {
    const x = computeExitSignature(db, 1);
    expect(x.overall.withdraw_notice).toBe(1);
    expect(x.byEra.reduce((s, e) => s + e.total, 0)).toBe(1);
  });

  it('C — apology economics: who repairs first, and apologies met with fire', () => {
    const a = computeApologyEconomics(db, 1);
    expect(a.firstRepairAfterPeak.me).toBe(1);        // the "i'm sorry" 8h after the fight
    expect(a.metWithFire.me.total).toBe(1);
    expect(a.metWithFire.me.rejected).toBe(1);         // met with "fuck you" within 2h
  });

  it('E — the wearing-down curve buckets by quarter, both sides', () => {
    const w = computeWearingDown(db, 1);
    const q = w.quarters.find((x) => x.quarter === '2024-Q2');
    expect(q).toBeDefined();
    expect(q!.me.n).toBeGreaterThan(0);
    expect(q!.them.n).toBeGreaterThan(0);
  });

  it('material — banks the heavy moments as citeable receipts and carries every section', () => {
    const m = buildFindingsMaterial(db, 1);
    expect(m.receiptIds.length).toBeGreaterThan(0);      // physical(me) + death_wish(them) fixtures
    for (const tag of ['A · THE LEDGER', 'B · KIDS', 'C · THE APOLOGY', 'D · YOUR EXIT', 'E · THE WEARING', 'POWER-BALANCE'])
      expect(m.material).toContain(tag);
    // every banked id appears as an m<id> the render can cite
    for (const id of m.receiptIds) expect(m.material).toContain(`m${id}`);
  });

  it('reading — freezes as findings_reading and drops sentences citing unbanked receipts', () => {
    const { receiptIds, span } = buildFindingsMaterial(db, 1);
    const good = `m${receiptIds[0]}`;
    const render = {
      title: 'The findings',
      blocks: [
        { kind: 'observation', text: 'You reached first more than she did.', evidence_ids: [good] },        // resolves → kept
        { kind: 'observation', text: 'She said the unsayable to you once.', evidence_ids: ['m999999'] },     // no such msg → dropped
      ],
    };
    const out = finalizeFindingsReading(db, 1, render as any, receiptIds, span, '2026-07-12');
    expect(out.dropped).toBe(1);
    const row = db.raw.prepare("SELECT content_md FROM reflections WHERE id = ?").get(out.reflectionId) as { content_md: string };
    expect(row.content_md).toContain('You reached first more than she did');
    expect(row.content_md).not.toContain('She said the unsayable');
  });

  it('P1-11 — with the research layer OFF, the findings reading declines (counts stay available)', () => {
    withdrawResearchConsent(db);
    const { receiptIds, span } = buildFindingsMaterial(db, 1);
    const render = { title: 'The findings', blocks: [{ kind: 'observation', text: 'A directional claim.', evidence_ids: [`m${receiptIds[0]}`] }] };
    const out = finalizeFindingsReading(db, 1, render as any, receiptIds, span, '2026-07-12');
    const row = db.raw.prepare('SELECT content_md FROM reflections WHERE id = ?').get(out.reflectionId) as { content_md: string };
    expect(row.content_md).not.toContain('A directional claim');
    expect(row.content_md.toLowerCase()).toContain('research preview');
    // The decline must not send the reader looking for a switch that does not exist.
    expect(row.content_md.toLowerCase()).not.toMatch(/in settings/);
    // the deterministic A–E counts are unaffected by the gate
    expect(computeLedger(db, 1).byDir.death_wish.them).toBe(1);
    enableResearchLayer(db);
  });
});
