// Between — T-L4: the abuse-pattern schema, repair-aware coercive counting, and the power-balance
// gate math (one-directional trips; mutual doesn't; the gate needs coercive evidence, not heat alone;
// recency weighting shifts the overall stance). Pure functions — no DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { l4ResultSchema } from '../src/airlock/schemas';
import { countCoercive, powerBalanceGate, buildEraAggregates, getL4ByEpisode, materializeL4Jobs, gateFor, isL4SampleConfirmed, recordL4SampleConfirmed, type EraAgg } from '../src/lenses/abuse';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { refreshEpisodes, getEpisodes } from '../src/lenses/episodes';
import { refreshEras } from '../src/lenses/eras';
import { createAirlockStore } from '../src/airlock/store';

describe('T-L4 schema', () => {
  it('accepts a well-formed result and rejects bad side/kind/severity', () => {
    expect(l4ResultSchema.safeParse({ patterns: [{ side: 'them', kind: 'threat', evidence_ids: ['m1'], severity: 3, repair_context: false }] }).success).toBe(true);
    expect(l4ResultSchema.safeParse({ patterns: [{ side: 'nobody', kind: 'threat', evidence_ids: ['m1'], severity: 3 }] }).success).toBe(false);
    expect(l4ResultSchema.safeParse({ patterns: [{ side: 'me', kind: 'narcissist', evidence_ids: ['m1'], severity: 2 }] }).success).toBe(false);
    expect(l4ResultSchema.safeParse({ patterns: [{ side: 'me', kind: 'contempt', evidence_ids: [], severity: 2 }] }).success).toBe(false);
    expect(l4ResultSchema.safeParse({ patterns: [{ side: 'me', kind: 'contempt', evidence_ids: ['m1'], severity: 5 }] }).success).toBe(false);
  });
});

describe('T-L4 countCoercive (repair-aware)', () => {
  it('counts coercive markers by side and ignores non-coercive kinds and repair_context', () => {
    const c = countCoercive([
      { side: 'them', kind: 'threat', evidence_ids: ['m1'], severity: 3 },
      { side: 'them', kind: 'monitoring', evidence_ids: ['m2'], severity: 2 },
      { side: 'them', kind: 'coercive_demand', evidence_ids: ['m3'], severity: 3 },
      { side: 'them', kind: 'contempt', evidence_ids: ['m4'], severity: 2 },          // not coercive
      { side: 'me', kind: 'threat', evidence_ids: ['m5'], severity: 3, repair_context: true }, // suppressed
      { side: 'me', kind: 'coercive_demand', evidence_ids: ['m6'], severity: 1 },
    ]);
    expect(c).toEqual({ them: 3, me: 1 });
  });
});

const era = (startMs: number, endMs: number, p: Partial<EraAgg>): EraAgg =>
  ({ startMs, endMs, episodes: 1, severeMe: 0, severeThem: 0, initMe: 0, initThem: 0, coerciveMe: 0, coerciveThem: 0, ...p });

describe('T-L4 power-balance gate', () => {
  it('trips to a support frame when severe, initiation, AND coercion all point one way', () => {
    const g = powerBalanceGate([era(0, 1, { severeThem: 20, severeMe: 1, initThem: 10, initMe: 1, coerciveThem: 8, coerciveMe: 0 })]);
    expect(g.eras[0]).toMatchObject({ direction: 'them', tripped: true, frame: 'support' });
    expect(g.stance).toMatchObject({ direction: 'them', frame: 'support' });
  });

  it('does not trip when hostility runs both ways', () => {
    const g = powerBalanceGate([era(0, 1, { severeThem: 10, severeMe: 9, initThem: 5, initMe: 5, coerciveThem: 4, coerciveMe: 4 })]);
    expect(g.eras[0]).toMatchObject({ direction: null, tripped: false, frame: 'two_readings' });
  });

  it('will not trip on heat alone — coercive evidence (from the stage-2 drain) is required', () => {
    // severe + initiation strongly one-directional, but NO coercive markers (share defaults to 0.5)
    const g = powerBalanceGate([era(0, 1, { severeThem: 50, severeMe: 1, initThem: 20, initMe: 0, coerciveThem: 0, coerciveMe: 0 })]);
    expect(g.eras[0].tripped).toBe(false);
    expect(g.eras[0].frame).toBe('two_readings');
  });

  it('recency weighting shifts the overall stance toward the recent era', () => {
    const OLD = Date.UTC(2019, 0, 1), NEW = Date.UTC(2024, 0, 1);
    const eras = [
      era(OLD, OLD + 1, { severeMe: 300, initMe: 10, coerciveMe: 10 }),   // old, strongly 'me', high volume
      era(NEW, NEW + 1, { severeThem: 100, initThem: 10, coerciveThem: 10 }), // recent, strongly 'them'
    ];
    // no decay (huge half-life): the older high-volume 'me' era wins
    expect(powerBalanceGate(eras, { halfLifeMs: 1e15 }).stance.direction).toBe('me');
    // with ~1-year half-life the recent 'them' era dominates → stance shifts
    expect(powerBalanceGate(eras).stance.direction).toBe('them');
  });
});

// Regression: real archives aren't id-ordered, so an l4 result must map to its episode by membership,
// not by chunk.start_msg_id — and repair_context coercive markers must be suppressed in the aggregate.
describe('T-L4 aggregation (DB)', () => {
  let tmpDir: string;
  let db: BetweenDB;
  let epStart: number;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'between-l4agg-'));
    db = openDb(join(tmpDir, 'test.db'));
    db.setMeta('experimental_lenses', '1'); // the L4 layer is experimental; opt in to exercise it
    const T0 = Date.UTC(2024, 5, 1, 12);
    const ids = seedThread(db, [
      { dir: 'incoming', ms: T0, tension: 3, body: 'get out of my house' },
      { dir: 'incoming', ms: T0 + 60_000, tension: 3, body: 'no access no decisions' },
      { dir: 'incoming', ms: T0 + 120_000, tension: 2, body: 'again' },
      { dir: 'outgoing', ms: T0 + 180_000, tension: 3, body: 'answer or I block you' },
      { dir: 'incoming', ms: T0 + 240_000, tension: 2, body: 'done' },
    ]);
    refreshEpisodes(db, 1);
    refreshEras(db, 1);
    epStart = getEpisodes(db, 1)[0].startMsgId;
    const [jobId] = materializeL4Jobs(db, 1, tmpDir, getEpisodes(db, 1));
    const inputHash = (db.raw.prepare('SELECT input_hash AS h FROM analysis_jobs WHERE id = ?').get(jobId) as { h: string }).h;
    createAirlockStore(db).upsertResult({
      inputHash, jobId, lens: 'l4_episode_patterns',
      result: { patterns: [
        { side: 'them', kind: 'threat', evidence_ids: [`m${ids[0]}`], severity: 3 },
        { side: 'them', kind: 'coercive_demand', evidence_ids: [`m${ids[1]}`], severity: 3 },
        { side: 'me', kind: 'threat', evidence_ids: [`m${ids[3]}`], severity: 2, repair_context: true }, // suppressed
      ] },
      validation: { schema_ok: true, retries: 0 }, refusal: { detected: false, reason: null }, modelNote: 'test', sampleCount: 1,
    });
  });

  afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('maps the l4 result to its episode by membership (not min id)', () => {
    const m = getL4ByEpisode(db, 1);
    expect(m.size).toBe(1);
    expect(m.has(epStart)).toBe(true);
  });

  it('aggregates coercive markers per era, suppressing repair_context', () => {
    const total = buildEraAggregates(db, 1).reduce((s, a) => ({ me: s.me + a.coerciveMe, them: s.them + a.coerciveThem }), { me: 0, them: 0 });
    expect(total.them).toBe(2); // threat + coercive_demand
    expect(total.me).toBe(0);   // the me threat was repair_context → not counted
  });
});

// The runtime hard stop — the honesty spine. A support frame is a directional verdict; it must not
// escape (a) an uncalibrated archive, or (b) a full drain the owner never sample-confirmed.
describe('T-L4 runtime hard stop', () => {
  let tmpDir: string;
  let db: BetweenDB;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'between-l4hs-'));
    db = openDb(join(tmpDir, 'test.db'));
    db.setMeta('experimental_lenses', '1'); // opt into the experimental layer; the OFF case is tested separately
    const T0 = Date.UTC(2024, 5, 1, 12);
    // one episode, unambiguously them: five severe incoming, them-initiated, with coercive markers
    const ids = seedThread(db, [
      { dir: 'incoming', ms: T0, tension: 3, body: 'answer me or I call everyone you know' },
      { dir: 'incoming', ms: T0 + 60_000, tension: 3, body: 'you get no money no car no phone' },
      { dir: 'incoming', ms: T0 + 120_000, tension: 3, body: 'i am watching your location' },
      { dir: 'incoming', ms: T0 + 180_000, tension: 3, body: 'answer now' },
      { dir: 'incoming', ms: T0 + 240_000, tension: 3, body: 'do not test me' },
    ]);
    refreshEpisodes(db, 1);
    refreshEras(db, 1);
    // materialize the SAMPLE (a subset — allowed pre-confirmation) and attach a them-coercive l4 result
    const [jobId] = materializeL4Jobs(db, 1, tmpDir, getEpisodes(db, 1));
    const inputHash = (db.raw.prepare('SELECT input_hash AS h FROM analysis_jobs WHERE id = ?').get(jobId) as { h: string }).h;
    createAirlockStore(db).upsertResult({
      inputHash, jobId, lens: 'l4_episode_patterns',
      result: { patterns: [
        { side: 'them', kind: 'threat', evidence_ids: [`m${ids[0]}`], severity: 3 },
        { side: 'them', kind: 'coercive_demand', evidence_ids: [`m${ids[1]}`], severity: 3 },
        { side: 'them', kind: 'monitoring', evidence_ids: [`m${ids[2]}`], severity: 2 },
      ] },
      validation: { schema_ok: true, retries: 0 }, refusal: { detected: false, reason: null }, modelNote: 'test', sampleCount: 1,
    });
  });
  afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it('the RAW gate trips to support(them) on this fixture — establishing the baseline', () => {
    expect(powerBalanceGate(buildEraAggregates(db, 1)).stance).toMatchObject({ direction: 'them', frame: 'support' });
  });

  it('gateFor SUPPRESSES the support frame while the owner is uncalibrated', () => {
    const g = gateFor(db, 1);
    expect(g.stance.frame).toBe('two_readings');   // no verdict without calibration
    expect(g.stance.uncalibrated).toBe(true);
    expect(g.eras.every((e) => e.frame === 'two_readings')).toBe(true);
  });

  it('once calibrated, gateFor lets the earned support frame through', () => {
    db.setMeta('calibration', JSON.stringify({ hostile_tension: 2, severe_tension: 3 }));
    db.setMeta('self_report_bias', JSON.stringify({ verdict: 'balanced', gateThresholdBump: 0 }));
    const g = gateFor(db, 1);
    expect(g.stance.frame).toBe('support');
    expect(g.stance.direction).toBe('them');
    expect(g.stance.uncalibrated).toBe(false);
    expect(g.stance.experimental).toBe(true);
  });

  // P1-11: even fully calibrated AND on the strongest support fixture, the experimental layer OFF means
  // NO support frame ever escapes — the whole point of gating the interpretive layer by default.
  it('with experimental_lenses OFF, no support frame escapes even when calibrated', () => {
    db.setMeta('experimental_lenses', '0'); // owner has NOT opted in
    const g = gateFor(db, 1);
    expect(g.stance.frame).toBe('two_readings');
    expect(g.stance.experimental).toBe(false);
    expect(g.eras.every((e) => e.frame === 'two_readings')).toBe(true);
    // and the L4 stage-2 refuses entirely
    expect(() => materializeL4Jobs(db, 1, tmpDir, getEpisodes(db, 1))).toThrow(/experimental/i);
    db.setMeta('experimental_lenses', '1'); // restore for any later assertions
  });

  it('the full L4 drain refuses until the sample-and-agree pass is recorded', () => {
    expect(isL4SampleConfirmed(db, 1)).toBe(false);
    expect(() => materializeL4Jobs(db, 1, tmpDir)).toThrow(/sample-and-agree/i);   // full set (no subset) blocked
    recordL4SampleConfirmed(db, 1, ['fair', 'fair', 'understated'], '2026-07-12');
    expect(isL4SampleConfirmed(db, 1)).toBe(true);
    expect(() => materializeL4Jobs(db, 1, tmpDir)).not.toThrow();                  // now allowed
  });
});
