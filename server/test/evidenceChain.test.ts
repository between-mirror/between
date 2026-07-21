// Between — Phase-A evidence-chain hardening (the July 2026 review's P0-2/P0-4/P1-8/P1-9).
// Synthetic data only; the mock engine stands in for a live drain. These lock the seal on the
// raw-result bypass: no raw model file, no schema-invalid payload, and no unreceipted summary text
// can reach a frozen reflection — only the app-cleaned, re-validated payload can.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';
import { planAnalysis, materializeCustomJob } from '../src/airlock/plan';
import { drain } from '../src/airlock/engine';
import { ingestResults, getValidatedResult } from '../src/airlock/ingestResults';
import { createAirlockStore } from '../src/airlock/store';
import { airlockPaths, writeJsonAtomic, readJson, listJobFiles } from '../src/airlock/paths';
import { runFirstReflection, buildReduceMaterial } from '../src/lenses/firstReflection';
import { composeBlocks } from '../src/lenses/render';
import { emotionCoverage } from '../src/lenses/l1';
import { validateLensResult } from '../src/airlock/schemas';
import type { JobFile } from '../src/airlock/types';
import type { RenderBlock } from '../src/airlock/schemas';

const OWNER = 1;
const THEM = 2;
const THREAD = 1;
const BASE = Date.UTC(2021, 4, 1, 9, 0, 0);

let dk = 0;
function msg(dir: Direction, t: number, body: string): GraphMessage {
  const out = dir === 'outgoing';
  return {
    threadTempId: THREAD, senderContactTempId: out ? OWNER : THEM, direction: dir, kind: 'sms',
    sentAtMs: t, bodyText: body, isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: out ? 2 : 1, rawMsgBox: null, dedupKey: `syn-${dk++}`,
    recipients: [{ contactTempId: out ? THEM : OWNER, role: 'to' }], attachments: [],
  };
}

function buildGraph(n: number): ResolvedGraph {
  const messages: GraphMessage[] = [];
  for (let i = 0; i < n; i++) {
    const dir: Direction = i % 2 === 0 ? 'outgoing' : 'incoming';
    messages.push(msg(dir, BASE + i * 60_000, `A note about our week together, number ${i}.`));
  }
  return {
    sourceFile: { path: 'syn.xml', contentSha256: 'e'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: n },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: THEM, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Robin', firstSeenMs: BASE, lastSeenMs: BASE + n * 60_000 }],
    threads: [{ tempId: THREAD, participantSignature: 'sig-robin', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: BASE, lastMs: BASE + n * 60_000, messageCount: n }],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages,
  };
}

interface Env { tmp: string; db: BetweenDB; airlock: string; close(): void }
function makeEnv(n: number): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'between-evchain-'));
  const db = openDb(join(tmp, 'test.db'));
  db.bulkInsertGraph(buildGraph(n));
  return { tmp, db, airlock: join(tmp, 'airlock'), close() { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

function firstJob(airlock: string): JobFile {
  const p = airlockPaths(airlock);
  return readJson<JobFile>(join(p.jobsDir, listJobFiles(p.jobsDir)[0]));
}

async function seedL1(env: Env): Promise<void> {
  planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
  await drain({ airlockDir: env.airlock, engine: 'mock' });
  ingestResults(env.db, { airlockDir: env.airlock });
}

// ── P0-2 · getValidatedResult is the only sanctioned read of a Phase-2 payload ──────────────
describe('P0-2 getValidatedResult (the sanctioned, DB-only payload read)', () => {
  it('returns the cleaned payload only when the owning job reached done', async () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const jf = firstJob(env.airlock);
      // A pending job (planned, not yet drained) has no result → missing.
      const pending = getValidatedResult(env.db, jf.input_hash, 'l1_emotion');
      expect(pending.ok).toBe(false);
      if (!pending.ok) expect(pending.reason).toBe('missing');

      // Drain + ingest → a done result reads back cleaned + validated.
      await drain({ airlockDir: env.airlock, engine: 'mock' });
      ingestResults(env.db, { airlockDir: env.airlock });
      const ok = getValidatedResult(env.db, jf.input_hash, 'l1_emotion');
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.payload).toBeTruthy();

      // Flip the job to error → the same stored payload is no longer readable.
      createAirlockStore(env.db).setJobStatus(jf.job_id, 'error', 'forced');
      const errored = getValidatedResult(env.db, jf.input_hash, 'l1_emotion');
      expect(errored.ok).toBe(false);
      if (!errored.ok) expect(errored.reason).toBe('not_done');
    } finally { env.close(); }
  });

  it('declines a refused job (no frozen artifact from a refusal)', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = firstJob(env.airlock);
      writeJsonAtomic(join(paths.resultsDir, `${jf.job_id}.json`), {
        job_id: jf.job_id, input_hash: jf.input_hash, status: 'refused',
        refusal: { detected: true, reason: 'safety preamble' },
      });
      ingestResults(env.db, { airlockDir: env.airlock });
      const v = getValidatedResult(env.db, jf.input_hash, 'l1_emotion');
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe('refused');
    } finally { env.close(); }
  });
});

// ── P0-4 · envelope verification (job_id / input_hash / filename) or quarantine ─────────────
describe('P0-4 envelope verification', () => {
  it('quarantines a result whose input_hash does not match the job, never caching it', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = firstJob(env.airlock);
      const realId = `m${jf.chunk.start_msg_id}`;
      // Correct job_id + filename, but a TAMPERED input_hash — an otherwise schema-valid payload.
      writeJsonAtomic(join(paths.resultsDir, `${jf.job_id}.json`), {
        job_id: jf.job_id, input_hash: `sha256:${'0'.repeat(64)}`, status: 'done',
        result: { messages: [{ message_id: realId, valence: 0, warmth: 0, tension: 0 }], window: { summary: 'x', notes: [] } },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.quarantined).toBe(1);
      expect(summary.ingested).toBe(0);

      const store = createAirlockStore(env.db);
      expect(store.resultExists(jf.input_hash)).toBe(false);
      expect(store.resultExists(`sha256:${'0'.repeat(64)}`)).toBe(false);
      const job = store.getJob(jf.job_id);
      expect(job?.status).toBe('error');
      expect(job?.error).toBe('envelope_mismatch');
      // The file left results/ and landed in quarantine/.
      expect(existsSync(join(paths.resultsDir, `${jf.job_id}.json`))).toBe(false);
      expect(existsSync(join(paths.quarantineDir, `${jf.job_id}.json`))).toBe(true);
    } finally { env.close(); }
  });

  it('quarantines a result dropped under the wrong filename', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = firstJob(env.airlock);
      const realId = `m${jf.chunk.start_msg_id}`;
      // Real envelope (job_id + input_hash) but written under a stranger's filename.
      writeJsonAtomic(join(paths.resultsDir, 'not-the-job.json'), {
        job_id: jf.job_id, input_hash: jf.input_hash, status: 'done',
        result: { messages: [{ message_id: realId, valence: 0, warmth: 0, tension: 0 }], window: { summary: 'x', notes: [] } },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.quarantined).toBe(1);
      expect(summary.ingested).toBe(0);
      expect(createAirlockStore(env.db).resultExists(jf.input_hash)).toBe(false);
      expect(existsSync(join(paths.quarantineDir, 'not-the-job.json'))).toBe(true);
    } finally { env.close(); }
  });

  it('a correct envelope is unaffected (clean drain ingests with zero quarantined)', async () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      await drain({ airlockDir: env.airlock, engine: 'mock' });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.quarantined).toBe(0);
      expect(summary.ingested).toBeGreaterThan(0);
    } finally { env.close(); }
  });
});

// ── P1-7 · exact L1 coverage — a partial or padded window is rejected whole ──────────────────
describe('P1-7 exact L1 coverage', () => {
  function ownIds(jf: JobFile): string[] {
    const all = [...jf.chunk.transcript.matchAll(/\[m(\d+)\]/g)].map((m) => `m${m[1]}`);
    const prefix = new Set(jf.chunk.overlap_prefix_ids.map((id) => `m${id}`));
    return all.filter((id) => !prefix.has(id));
  }
  function writeL1(env: Env, jf: JobFile, ids: string[]): void {
    writeJsonAtomic(join(airlockPaths(env.airlock).resultsDir, `${jf.job_id}.json`), {
      job_id: jf.job_id, input_hash: jf.input_hash, status: 'done',
      result: { messages: ids.map((id) => ({ message_id: id, valence: 0, warmth: 0, tension: 0 })), window: { summary: 'x', notes: [] } },
    });
  }

  it('rejects a window that leaves an own message unscored (missing)', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const jf = firstJob(env.airlock);
      const own = ownIds(jf);
      writeL1(env, jf, own.slice(0, own.length - 1)); // drop the last own message
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.errored).toBe(1);
      expect(summary.ingested).toBe(0);
      const job = createAirlockStore(env.db).getJob(jf.job_id);
      expect(job?.status).toBe('error');
      expect(job?.error).toContain('coverage_mismatch');
    } finally { env.close(); }
  });

  it('rejects a window that scores a message twice (duplicate)', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const jf = firstJob(env.airlock);
      const own = ownIds(jf);
      writeL1(env, jf, [...own, own[0]]); // one scored twice
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.errored).toBe(1);
      expect(summary.ingested).toBe(0);
      expect(createAirlockStore(env.db).getJob(jf.job_id)?.error).toContain('coverage_mismatch');
    } finally { env.close(); }
  });

  it('a full mock drain scores every substantive message → coverage 100%', async () => {
    const env = makeEnv(60);
    try {
      await seedL1(env);
      const cov = emotionCoverage(env.db, THREAD);
      expect(cov.eligibleMessages).toBe(60);
      expect(cov.scoredMessages).toBe(60);
      expect(cov.coverage).toBe(1);
      expect(cov.coveragePct).toBe(100);
      expect(cov.modelComplete).toBe(true);
    } finally { env.close(); }
  });
});

// ── P1-8 · re-validate the CLEANED payload; below-schema after filtering → rejected whole ────
describe('P1-8 post-filter re-validation', () => {
  it('rejects a reduce whose observation loses all its receipts (nulled below schema)', () => {
    const env = makeEnv(60);
    try {
      // A reduce job over real member ids 1..3. strengths cite a REAL id (survive); the observation
      // cites only fabricated ids, so cleaning nulls it — pushing the payload below frReduceResultSchema.
      const { jobId, inputHash } = materializeCustomJob(env.db, {
        lens: 'first_reflection_reduce', threadId: THREAD, transcript: 'material [m1] [m2] [m3]',
        memberIds: [1, 2, 3], airlockDir: env.airlock,
      });
      const paths = airlockPaths(env.airlock);
      writeJsonAtomic(join(paths.resultsDir, `${jobId}.json`), {
        job_id: jobId, input_hash: inputHash, status: 'done',
        result: {
          strengths: [{ claim: 'You reached first when it went quiet.', evidence_ids: ['m1'] }],
          observation: { pattern: 'p', reading_a: 'a', reading_b: 'b', evidence_ids: ['m9999999', 'm8888888'] },
          question_seed: 'q',
        },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.errored).toBe(1);
      expect(summary.ingested).toBe(0);

      const store = createAirlockStore(env.db);
      expect(store.resultExists(inputHash)).toBe(false);
      const job = store.getJob(jobId);
      expect(job?.status).toBe('error');
      expect(job?.error).toBe('post_filter_invalid');
    } finally { env.close(); }
  });
});

// ── P1-9 · the unreceipted window summary never enters the reduce material ───────────────────
describe('P1-9 unreceipted summary excluded from reduce', () => {
  it('reduce material carries evidence-bearing notes + per-message scores, never the summary text', async () => {
    const env = makeEnv(200);
    try {
      await seedL1(env);
      const { material } = buildReduceMaterial(env.db, THREAD, null, null);
      // The mock window summary must NOT be in the material...
      expect(material).not.toContain('Neutral logistics');
      expect(material).not.toContain('"summary"');
      // ...but the evidence-bearing note claim and per-message scores must be.
      expect(material).toContain('Even, matter-of-fact exchange.');
      expect(material).toContain('"scores"');
      expect(material).toMatch(/"id":\s*"m\d+"/);
    } finally { env.close(); }
  });
});

// ── P0-3 · evidence-bearing blocks — no rendered sentence without its receipts ────────────────
describe('P0-3 evidence-bearing blocks contract', () => {
  const V = new Set(['m1', 'm2', 'm3']);

  it('ten evidence-free observation blocks render to NOTHING', () => {
    const blocks: RenderBlock[] = Array.from({ length: 10 }, (_unused, i) => ({
      kind: 'observation' as const, text: `Claim number ${i} with only a fabricated receipt.`, evidence_ids: ['m999999'],
    }));
    const out = composeBlocks(blocks, V);
    expect(out.body).toBe('');
    expect(out.evidence).toEqual({});
    expect(out.dropped).toBe(10);
  });

  it('a mixed payload renders only the resolving blocks (with only their resolving ids)', () => {
    const out = composeBlocks([
      { kind: 'observation', text: 'You reached first.', evidence_ids: ['m1'] },
      { kind: 'observation', text: 'A fabricated claim.', evidence_ids: ['m999999'] },
      { kind: 'tentative_interpretation', text: 'Maybe the pace was pressure.', evidence_ids: ['m2', 'm999999'] },
    ], V);
    expect(out.body).toContain('You reached first.');
    expect(out.body).toContain('Maybe the pace was pressure.');
    expect(out.body).not.toContain('A fabricated claim.');
    expect(out.dropped).toBe(1);
    expect(out.evidence['Maybe the pace was pressure.']).toEqual(['m2']); // fabricated id filtered out
  });

  // Since v0.3.0 the model cannot author a bridge at all, so "cap the model's bridges" and "drop an
  // orphaned bridge" are no longer things that can happen — the composer inserts bridges itself,
  // after the drop pass, between blocks that survived. What remains testable is that the cap holds and
  // that a model-supplied bridge never reaches prose. (Full coverage in templates.test.ts.)
  it('bridge cap holds: the app never composes more than 2, however long the reading', () => {
    const out = composeBlocks(
      Array.from({ length: 5 }, (_u, i) => ({
        kind: 'observation' as const, text: `Kept ${i}.`, evidence_ids: [`m${i + 1}`],
      })),
      V,
    );
    expect(out.blocks.filter((b) => b.kind === 'bridge').length).toBeLessThanOrEqual(2);
  });

  it('a model-supplied bridge never reaches the prose', () => {
    const out = composeBlocks([
      { kind: 'observation', text: 'Fabricated, dropped.', evidence_ids: ['m999999'] },
      { kind: 'bridge', text: 'a bridge the model tried to write', evidence_ids: [] },
      { kind: 'observation', text: 'Kept.', evidence_ids: ['m1'] },
    ], V);
    expect(out.body).not.toContain('a bridge the model tried to write');
    expect(out.body).toContain('Kept.');
  });

  it('caps the title — a label that bypasses composeBlocks cannot be a paragraph', () => {
    const ok = { title: 'A first reading', blocks: [{ kind: 'observation', text: 'ok', evidence_ids: ['m1'] }] };
    expect(validateLensResult('first_reflection_render', ok).ok).toBe(true);
    const tooLong = { title: 'x'.repeat(200), blocks: [{ kind: 'observation', text: 'ok', evidence_ids: ['m1'] }] };
    expect(validateLensResult('first_reflection_render', tooLong).ok).toBe(false);
  });

  it('ask_answer follows the blocks contract (blocks validate; old prose does not)', () => {
    const okBlocks = { blocks: [{ kind: 'observation', text: 'The words show X.', evidence_ids: ['m1'] }] };
    expect(validateLensResult('ask_answer', okBlocks).ok).toBe(true);
    const oldProse = { answer_md: 'X', claims_used: [{ sentence_fragment: 'X', evidence_ids: ['m1'] }] };
    expect(validateLensResult('ask_answer', oldProse).ok).toBe(false);
    // A schema-valid observation still requires ≥1 evidence id.
    const noEvidence = { blocks: [{ kind: 'observation', text: 'ungrounded', evidence_ids: [] }] };
    expect(validateLensResult('ask_answer', noEvidence).ok).toBe(false);
  });
});

// ── P0-2 · a schema-invalid stored render can never reach a frozen reflection ────────────────
describe('P0-2 raw-result bypass sealed', () => {
  it('firstReflection.ts reads no raw result files — the payload door is getValidatedResult only', () => {
    const src = readFileSync(new URL('../src/lenses/firstReflection.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/readRawResult/);
    // No reading from the transport dirs for a payload; results are transport, the DB is truth.
    expect(src).not.toMatch(/resultsDir|archiveDir/);
    expect(src).toMatch(/getValidatedResult/);
  });

  it('a schema-invalid render payload yields an honest decline, never a frozen reading', async () => {
    const env = makeEnv(200);
    try {
      await seedL1(env);
      const first = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      expect(first.status).toBe('created');
      const store = createAirlockStore(env.db);
      expect(store.listReflections(THREAD, 'first_reflection')).toHaveLength(1);

      // Simulate an engine that emitted a render the app CANNOT clean into schema: missing body_md,
      // an empty evidence_ids array (violates .min(1)). Under the sealed contract getValidatedResult
      // re-validates the stored payload and refuses it — so no second, ungrounded reading is frozen.
      const hash = (env.db.raw
        .prepare("SELECT input_hash FROM analysis_results WHERE lens = 'first_reflection_render' LIMIT 1")
        .get() as { input_hash: string }).input_hash;
      env.db.raw.prepare('UPDATE analysis_results SET result_json = ? WHERE input_hash = ?')
        .run(JSON.stringify({ title: 'Injected', claims_used: [{ sentence_fragment: 'x', evidence_ids: [] }] }), hash);

      const second = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      expect(second.status).toBe('declined');
      if (second.status === 'declined') expect(second.reason).toBe('no_engine');
      // The corrupt render created NO new reflection — the first (grounded) one stands alone.
      expect(store.listReflections(THREAD, 'first_reflection')).toHaveLength(1);
    } finally { env.close(); }
  });
});
