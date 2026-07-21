// Between — Phase 2 airlock tests (docs/TESTING.md §4). Synthetic 555-01xx actors only, built
// directly via db.bulkInsertGraph; the mock engine stands in for any live drain (no network, no
// model). Covers T2.1–T2.9, with the two BUILD-BLOCKING contracts (T2.7 evidence, T2.8 sole-writer)
// made explicit, named, and strong.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';
import { computeHash, canonical } from '../src/airlock/hash';
import { planAnalysis, buildWindows, loadRangeMessages } from '../src/airlock/plan';
import { drain } from '../src/airlock/engine';
import { ingestResults, reconcile } from '../src/airlock/ingestResults';
import { createAirlockStore } from '../src/airlock/store';
import { airlockPaths, writeJsonAtomic, readJson } from '../src/airlock/paths';
import { finalizeReflection } from '../src/lenses/firstReflection';
import type { JobFile } from '../src/airlock/types';
import type { FrRenderResult } from '../src/airlock/schemas';

const OWNER = 1;
const THEM = 2;
const THREAD = 1;
const BASE = Date.UTC(2022, 0, 1, 9, 0, 0);

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
    messages.push(msg(dir, BASE + i * 60_000, `Thinking about the weekend plan, note ${i}.`));
  }
  return {
    sourceFile: { path: 'syn.xml', contentSha256: 'c'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: n },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'friend' },
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
  const tmp = mkdtempSync(join(tmpdir(), 'between-airlock-'));
  const db = openDb(join(tmp, 'test.db'));
  db.bulkInsertGraph(buildGraph(n));
  return { tmp, db, airlock: join(tmp, 'airlock'), close() { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

function resultFiles(airlock: string): string[] {
  const dir = airlockPaths(airlock).resultsDir;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
}
function jobFiles(airlock: string): string[] {
  const dir = airlockPaths(airlock).jobsDir;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_manifest.json') : [];
}

// ── T2.1 hash determinism ─────────────────────────────────────────────────────
describe('T2.1 hash determinism', () => {
  const input = { promptId: 'l1-emotion', promptVersion: 1, params: { a: 1, b: 2 }, chunkText: '[m1] ME: hi', outputSchema: { type: 'object', required: ['x', 'y'] } };

  it('is stable across runs for identical inputs (hash + job id)', () => {
    const a = computeHash(input);
    const b = computeHash({ ...input, params: { b: 2, a: 1 } }); // key order must not matter
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.jobId).toBe(b.jobId);
    expect(a.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.jobId).toMatch(/^job_[a-z2-7]{16}$/);
  });

  it('changes on any single-byte change to chunk text, params, version, or schema', () => {
    const base = computeHash(input).inputHash;
    expect(computeHash({ ...input, chunkText: '[m1] ME: hi ' }).inputHash).not.toBe(base);
    expect(computeHash({ ...input, promptVersion: 2 }).inputHash).not.toBe(base);
    expect(computeHash({ ...input, params: { a: 1, b: 3 } }).inputHash).not.toBe(base);
    expect(computeHash({ ...input, outputSchema: { type: 'object', required: ['x', 'z'] } }).inputHash).not.toBe(base);
  });

  it('canonical sorts keys and drops insignificant whitespace', () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });
});

// ── T2.3 windowing ────────────────────────────────────────────────────────────
describe('T2.3 windowing / overlap', () => {
  it('aligns to message boundaries, tiles own spans, overlaps 2–3 turns, respects the budget', () => {
    const env = makeEnv(130);
    try {
      const msgs = loadRangeMessages(env.db, THREAD, null, null);
      expect(msgs).toHaveLength(130);
      const windows = buildWindows(THREAD, msgs);
      expect(windows.length).toBeGreaterThanOrEqual(3);

      // Own spans tile the messages with no gaps and no duplicates.
      const ownIds = windows.flatMap((w) => w.ownMsgs.map((m) => m.id));
      expect(ownIds).toEqual(msgs.map((m) => m.id));

      for (let k = 0; k < windows.length; k++) {
        const w = windows[k];
        // Message-count budget: single-message turns close a window at 55.
        expect(w.ownMsgs.length).toBeLessThanOrEqual(55);
        // Boundaries match the own messages.
        expect(w.chunkFile.start_msg_id).toBe(w.ownMsgs[0].id);
        expect(w.chunkFile.end_msg_id).toBe(w.ownMsgs[w.ownMsgs.length - 1].id);
        if (k === 0) {
          expect(w.chunkFile.overlap_prefix_ids).toHaveLength(0);
        } else {
          // Overlap = last 2–3 turns of the previous window, and a subset of it.
          const prevOwn = new Set(windows[k - 1].ownMsgs.map((m) => m.id));
          expect(w.chunkFile.overlap_prefix_ids.length).toBeGreaterThanOrEqual(2);
          expect(w.chunkFile.overlap_prefix_ids.length).toBeLessThanOrEqual(3);
          for (const id of w.chunkFile.overlap_prefix_ids) expect(prevOwn.has(id)).toBe(true);
        }
      }
      expect(windows[0].ownMsgs).toHaveLength(55);
    } finally { env.close(); }
  });
});

// ── T2.2 cache no-op + single-window invalidation ─────────────────────────────
describe('T2.2 cache no-op + invalidation', () => {
  it('planning twice creates zero new jobs, and editing one message invalidates its window + overlap neighbor', async () => {
    const env = makeEnv(130);
    try {
      const store = createAirlockStore(env.db);
      const first = planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const windowCount = first.estimate.windowCount;
      expect(windowCount).toBe(3);
      const filesAfterFirst = jobFiles(env.airlock).length;
      const rowsAfterFirst = (env.db.raw.prepare('SELECT count(*) n FROM analysis_jobs').get() as { n: number }).n;
      expect(filesAfterFirst).toBe(windowCount);
      expect(rowsAfterFirst).toBe(windowCount);

      // Plan again → zero NEW jobs (idempotent on files + rows).
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      expect(jobFiles(env.airlock).length).toBe(filesAfterFirst);
      expect((env.db.raw.prepare('SELECT count(*) n FROM analysis_jobs').get() as { n: number }).n).toBe(rowsAfterFirst);

      // Drain + ingest → all cached.
      await drain({ airlockDir: env.airlock, engine: 'mock' });
      ingestResults(env.db, { airlockDir: env.airlock });
      const cachedPlan = planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', dryRun: true, airlockDir: env.airlock });
      expect(cachedPlan.estimate.cached).toBe(windowCount);
      expect(cachedPlan.estimate.toRun).toBe(0);

      // Edit message id 55 — last own message of window 1 and part of window 2's overlap prefix.
      env.db.raw.prepare('UPDATE messages SET body_text = ? WHERE id = 55').run('A completely different message now.');
      const afterEdit = planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', dryRun: true, airlockDir: env.airlock });
      expect(afterEdit.estimate.windowCount).toBe(3);
      expect(afterEdit.estimate.toRun).toBe(2);            // window 1 (own) + window 2 (overlap)
      expect(afterEdit.estimate.cached).toBe(windowCount - 2);
      void store;
    } finally { env.close(); }
  });
});

// ── T2.4 Zod validation rejects schema-violating results ──────────────────────
describe('T2.4 validation loop', () => {
  it('rejects a valid-JSON-but-schema-violating result (bad range / missing evidence_ids)', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = readJson<JobFile>(join(paths.jobsDir, jobFiles(env.airlock)[0]));

      writeJsonAtomic(join(paths.resultsDir, `${jf.job_id}.json`), {
        job_id: jf.job_id, input_hash: jf.input_hash, status: 'done',
        result: {
          messages: [{ message_id: 'm1', valence: 5, warmth: 0, tension: 0 }], // valence out of range
          window: { summary: 'x', notes: [{ claim: 'no receipts' }] },          // missing evidence_ids
        },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.errored).toBe(1);
      expect(summary.ingested).toBe(0);
      const store = createAirlockStore(env.db);
      expect(store.resultExists(jf.input_hash)).toBe(false);
      expect(store.getJob(jf.job_id)?.status).toBe('error');
    } finally { env.close(); }
  });
});

// ── T2.5 refusal path ─────────────────────────────────────────────────────────
describe('T2.5 refusal path', () => {
  it('marks a refusal-shaped result as refused and records it (never a silent gap)', async () => {
    const { REFUSED_WINDOW } = await import('../src/airlock/voice');
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = readJson<JobFile>(join(paths.jobsDir, jobFiles(env.airlock)[0]));
      writeJsonAtomic(join(paths.resultsDir, `${jf.job_id}.json`), {
        job_id: jf.job_id, input_hash: jf.input_hash, status: 'refused',
        refusal: { detected: true, reason: 'safety preamble' },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.refused).toBe(1);
      const store = createAirlockStore(env.db);
      expect(store.getJob(jf.job_id)?.status).toBe('refused');
      const row = store.getResult(jf.input_hash);
      expect(row).toBeDefined();
      expect(String(row?.refusal_json)).toContain('safety preamble');
      // The UI copy for this state is the exact VOICE string (never an empty gap).
      expect(REFUSED_WINDOW).toBe("Couldn't score this stretch. The messages are still here to read yourself.");
    } finally { env.close(); }
  });
});

// ── T2.6 crash resume ─────────────────────────────────────────────────────────
describe('T2.6 crash resume', () => {
  it('reconciles from results/ with zero lost or duplicated work when a drain is interrupted', async () => {
    const env = makeEnv(130);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const total = jobFiles(env.airlock).length;
      expect(total).toBe(3);

      // Engine wrote results but the app crashed BEFORE ingesting (drain never touches the DB).
      await drain({ airlockDir: env.airlock, engine: 'mock' });
      expect(resultFiles(env.airlock).length).toBe(total);
      expect((env.db.raw.prepare('SELECT count(*) n FROM analysis_results').get() as { n: number }).n).toBe(0);

      // Simulate a partial crash: one result was never written.
      const victim = resultFiles(env.airlock)[0];
      rmSync(join(airlockPaths(env.airlock).resultsDir, victim));

      // Relaunch reconcile: ingests the k that exist, no duplication.
      const first = reconcile(env.db, { airlockDir: env.airlock });
      expect(first.ingested).toBe(total - 1);
      const secondPass = reconcile(env.db, { airlockDir: env.airlock });
      expect(secondPass.ingested).toBe(0); // already archived → no double work

      // Re-drain the still-pending job, then reconcile again → full coverage, still no dupes.
      await drain({ airlockDir: env.airlock, engine: 'mock' });
      reconcile(env.db, { airlockDir: env.airlock });
      const stored = (env.db.raw.prepare('SELECT count(*) n FROM analysis_results').get() as { n: number }).n;
      expect(stored).toBe(total);
    } finally { env.close(); }
  });
});

// ── T2.7 ⛔ BUILD-BLOCKING — evidence contract end-to-end ──────────────────────
describe('T2.7 evidence contract (BUILD-BLOCKING)', () => {
  it('drops an ID-less claim at ingest (map + reduce): a claim whose ids do not resolve is removed', () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const paths = airlockPaths(env.airlock);
      const jf = readJson<JobFile>(join(paths.jobsDir, jobFiles(env.airlock)[0]));
      const realId = `m${jf.chunk.start_msg_id}`;
      // Score every message in the window (exact L1 coverage, P1-7) — the note, not the coverage,
      // is what this test exercises.
      const allIds = [...jf.chunk.transcript.matchAll(/\[m(\d+)\]/g)].map((m) => `m${m[1]}`);

      writeJsonAtomic(join(paths.resultsDir, `${jf.job_id}.json`), {
        job_id: jf.job_id, input_hash: jf.input_hash, status: 'done',
        result: {
          messages: allIds.map((id) => ({ message_id: id, valence: 0, warmth: 1, tension: 0 })),
          window: {
            summary: 'mixed',
            notes: [
              { claim: 'real, grounded claim', evidence_ids: [realId], confidence: 'surer' },
              { claim: 'planted claim with a fabricated receipt', evidence_ids: ['m9999999'] },
            ],
          },
        },
      });
      const summary = ingestResults(env.db, { airlockDir: env.airlock });
      expect(summary.ingested).toBe(1);
      expect(summary.claimsDropped).toBe(1);

      const store = createAirlockStore(env.db);
      const stored = JSON.parse(store.getResult(jf.input_hash)!.result_json as string);
      expect(stored.window.notes).toHaveLength(1);
      expect(stored.window.notes[0].evidence_ids).toEqual([realId]);
      // Every surviving evidence id resolves to a real message row.
      for (const n of stored.window.notes) {
        for (const id of n.evidence_ids) {
          const row = env.db.raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(Number(id.slice(1)));
          expect(row).toBeDefined();
        }
      }
    } finally { env.close(); }
  });

  it('composition drops an evidence-bearing block whose backing receipts do not resolve', () => {
    const env = makeEnv(60);
    try {
      // Two blocks: one grounded in a REAL id, one planted with a fabricated id.
      const renderPayload: FrRenderResult = {
        title: 'A first reading',
        blocks: [
          { kind: 'observation', text: 'You showed up when it counted.', evidence_ids: ['m1'] },
          { kind: 'observation', text: 'The archive proves an outlandish thing that never happened.', evidence_ids: ['m8888888'] },
        ],
      };
      const out = finalizeReflection(env.db, { threadId: THREAD, fromMs: null, toMs: null, renderPayload, modelNote: 'mock' });

      expect(out.droppedSentences).toBe(1);
      expect(out.contentMd).toContain('You showed up when it counted');
      expect(out.contentMd).not.toContain('outlandish thing that never happened');
      // The only surviving block resolves to a real message row.
      expect(Object.keys(out.evidence)).toEqual(['You showed up when it counted.']);
      expect(out.evidence['You showed up when it counted.']).toEqual(['m1']);
      const row = env.db.raw.prepare('SELECT 1 FROM messages WHERE id = 1').get();
      expect(row).toBeDefined();
    } finally { env.close(); }
  });

  it('never renders a model title over an all-dropped (evidence-free) body', () => {
    const env = makeEnv(60);
    try {
      // The single block's only receipt is fabricated → body composes to empty. A scary model title
      // must NOT become a standalone headline over nothing (P0-3 title hardening).
      const renderPayload: FrRenderResult = {
        title: 'The night it all went wrong',
        blocks: [{ kind: 'observation', text: 'A claim with only a fabricated receipt.', evidence_ids: ['m9999999'] }],
      };
      const out = finalizeReflection(env.db, { threadId: THREAD, fromMs: null, toMs: null, renderPayload, modelNote: 'mock' });
      expect(out.title).toBe('A first reading');
      expect(out.contentMd).not.toContain('The night it all went wrong');
    } finally { env.close(); }
  });
});

// ── drain engine guard: no silent fallback to mock on an unhandled engine (P0-5 defense in depth) ──
describe('drain engine guard', () => {
  it('throws on an unsupported engine instead of falling through to the mock', async () => {
    const env = makeEnv(10);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      await expect(drain({ airlockDir: env.airlock, engine: 'batch' })).rejects.toThrow(/unsupported engine/i);
      // and nothing was written (the mock would have written results)
      expect(resultFiles(env.airlock).length).toBe(0);
    } finally { env.close(); }
  });
});

// ── T2.8 ⛔ BUILD-BLOCKING — sole writer ───────────────────────────────────────
describe('T2.8 sole writer (BUILD-BLOCKING)', () => {
  it('the drain engine performs ZERO db writes; only the app ingest writes to the DB', async () => {
    const env = makeEnv(130);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const jobCount = jobFiles(env.airlock).length;

      const beforeResults = (env.db.raw.prepare('SELECT count(*) n FROM analysis_results').get() as { n: number }).n;
      const pendingBefore = (env.db.raw.prepare("SELECT count(*) n FROM analysis_jobs WHERE status = 'pending'").get() as { n: number }).n;
      expect(beforeResults).toBe(0);
      expect(pendingBefore).toBe(jobCount);

      // Run the engine. It must write results/*.json and touch the DB not at all.
      const summary = await drain({ airlockDir: env.airlock, engine: 'mock' });
      expect(summary.processed).toBe(jobCount);
      expect(resultFiles(env.airlock).length).toBe(jobCount);

      const afterResults = (env.db.raw.prepare('SELECT count(*) n FROM analysis_results').get() as { n: number }).n;
      const pendingAfter = (env.db.raw.prepare("SELECT count(*) n FROM analysis_jobs WHERE status = 'pending'").get() as { n: number }).n;
      expect(afterResults).toBe(0);       // engine wrote no results rows
      expect(pendingAfter).toBe(jobCount); // engine flipped no job statuses

      // Only now — the app — ingests, and only now does the DB change.
      const ingest = ingestResults(env.db, { airlockDir: env.airlock });
      expect(ingest.ingested).toBe(jobCount);
      expect((env.db.raw.prepare('SELECT count(*) n FROM analysis_results').get() as { n: number }).n).toBe(jobCount);
      expect((env.db.raw.prepare("SELECT count(*) n FROM analysis_jobs WHERE status = 'done'").get() as { n: number }).n).toBe(jobCount);
    } finally { env.close(); }
  });

  it('the engine module imports nothing from the store/db layer (mechanical guarantee)', () => {
    const src = readFileSync(new URL('../src/airlock/engine.ts', import.meta.url), 'utf8');
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    for (const l of importLines) {
      expect(l).not.toMatch(/store\/db|\.\.\/store|openDb/);
    }
    expect(src).not.toMatch(/\.prepare\(/);       // no SQL
    expect(src).not.toMatch(/bulkInsertGraph/);
  });
});

// ── T2.9 capacity honesty ─────────────────────────────────────────────────────
describe('T2.9 capacity honesty', () => {
  it('a dry-run shows the VOICE estimate before any run and writes no jobs', () => {
    const env = makeEnv(130);
    try {
      const outcome = planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', dryRun: true, airlockDir: env.airlock });
      expect(outcome.materialized).toBe(false);
      expect(jobFiles(env.airlock).length).toBe(0);
      const e = outcome.estimate;
      expect(e.windowCount).toBe(3);
      expect(e.toRun).toBe(3);
      expect(e.drains).toBe(1);
      expect(e.copy).toBe(`This will read 3 stretches of conversation — about 1 sittings, roughly ${e.timeEstimate}. Nothing is ever read twice.`);
    } finally { env.close(); }
  });

  it('the drain summary reports processed / errored / refused / remaining', async () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const summary = await drain({ airlockDir: env.airlock, engine: 'mock' });
      expect(summary).toMatchObject({ engine: 'mock', errored: 0, refused: 0, remaining: 0 });
      expect(typeof summary.processed).toBe('number');
    } finally { env.close(); }
  });
});

// ── T2.11 Ollama graceful degradation (no live model) ─────────────────────────
describe('T2.11 ollama adapter graceful degradation', () => {
  it('degrades gracefully when Ollama is absent: no throw, no results, jobs stay pending', async () => {
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const pending = jobFiles(env.airlock).length;
      const summary = await drain({ airlockDir: env.airlock, engine: 'ollama', ollamaUrl: 'http://127.0.0.1:1' });
      expect(summary.engine).toBe('ollama');
      expect(summary.processed).toBe(0);
      expect(resultFiles(env.airlock).length).toBe(0);
      expect(summary.remaining).toBe(pending);
    } finally { env.close(); }
  });
});

// ── T2.11b Ollama self-correction: schema-rail clamp + one-shot retry ──────────
// Local models (e.g. llama3.1) routinely overshoot the L1 rails (valence past ±1) or drop the
// required `window` object on the emotionally charged windows that matter most. The adapter must
// clamp the rails and, per the airlock engine contract, retry ONCE on a schema mismatch — so a
// salvageable window is not thrown away, and a truly bad one still fails closed (never reaches the DB).
describe('T2.11b ollama clamp + one-shot self-correction retry', () => {
  afterEach(() => vi.unstubAllGlobals());

  // Ollama streams NDJSON ({response,done} per line) — model the wire format, splitting a line
  // mid-chunk so the adapter's buffered line reassembly is exercised.
  function ndjsonBody(fullText: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const line1 = JSON.stringify({ response: fullText, done: false }) + '\n';
    const line2 = JSON.stringify({ done: true }) + '\n';
    const mid = Math.floor(line1.length / 2);
    const chunks = [line1.slice(0, mid), line1.slice(mid), line2];
    return new ReadableStream({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    });
  }
  // Stub the Ollama HTTP endpoint; `responder(ids, call)` shapes each reply from the [mID] anchors.
  function stubOllama(responder: (ids: string[], call: number) => unknown): () => number {
    let call = 0;
    vi.stubGlobal('fetch', async (_url: string, opts: { body: string }) => {
      call++;
      const body = JSON.parse(opts.body) as { prompt: string };
      const ids = [...body.prompt.matchAll(/\[m(\d+)\]/g)].map((m) => `m${m[1]}`);
      const payload = responder(ids, call);
      return { ok: true, body: ndjsonBody(JSON.stringify(payload)) } as unknown as Response;
    });
    return () => call;
  }
  const readResult = (env: Env) =>
    readJson<any>(join(airlockPaths(env.airlock).resultsDir, jobFiles(env.airlock)[0]));

  it('clamps out-of-range valence/warmth/tension to the schema rails, no retry needed', async () => {
    const env = makeEnv(10);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const calls = stubOllama((ids) => ({
        messages: ids.map((id) => ({ message_id: id, valence: 1.6, warmth: 2.4, tension: -0.2 })),
        window: { summary: 'even, matter-of-fact', notes: [] },
      }));
      await drain({ airlockDir: env.airlock, engine: 'ollama' });
      const res = readResult(env);
      expect(res.status).toBe('done');
      expect(res.validation.retries).toBe(0);
      expect(calls()).toBe(1);                       // clamp fixed the rails; no round-trip
      expect(res.result.messages[0].valence).toBe(1);
      expect(res.result.messages[0].warmth).toBe(2);
      expect(res.result.messages[0].tension).toBe(0);
    } finally { env.close(); }
  });

  it('retries ONCE with the validation error when the window object is missing, then succeeds', async () => {
    const env = makeEnv(10);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const calls = stubOllama((ids, call) =>
        call === 1
          ? { messages: ids.map((id) => ({ message_id: id, valence: 1.7, warmth: 2, tension: 1 })) } // no window
          : {
              messages: ids.map((id) => ({ message_id: id, valence: 0.5, warmth: 2, tension: 1 })),
              window: { summary: 'recovered on retry', notes: [] },
            });
      await drain({ airlockDir: env.airlock, engine: 'ollama' });
      const res = readResult(env);
      expect(calls()).toBe(2);                        // exactly one retry
      expect(res.status).toBe('done');
      expect(res.validation.retries).toBe(1);
      expect(res.result.window.summary).toBe('recovered on retry');
      expect(res.result.messages[0].valence).toBe(0.5);
    } finally { env.close(); }
  });

  it('gives up after one retry and writes an error result the app ingest rejects', async () => {
    const env = makeEnv(10);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const calls = stubOllama((ids) => ({
        messages: ids.map((id) => ({ message_id: id, valence: 5, warmth: 9, tension: 9 })),
        window: null, // unrecoverable: window can never validate
      }));
      await drain({ airlockDir: env.airlock, engine: 'ollama' });
      const res = readResult(env);
      expect(calls()).toBe(2);                        // tried, retried, still bad
      expect(res.status).toBe('error');
      expect(res.validation.retries).toBe(1);
      expect(res.result).toBeUndefined();             // no invalid payload persisted
      const ingest = ingestResults(env.db, { airlockDir: env.airlock });
      expect(ingest.errored).toBe(1);
      expect(ingest.ingested).toBe(0);
    } finally { env.close(); }
  });

  it('normalizes soft-constraint violations (long summary/note, off-enum tone_flags) instead of rejecting', async () => {
    const env = makeEnv(10);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      stubOllama((ids) => ({
        messages: ids.map((id) => ({
          message_id: id, valence: 0.2, warmth: 1, tension: 0, note: 'y'.repeat(200),
          tone_flags: ['affectionate', 'hostile', 'made_up'], // only 'affectionate' is in the enum
        })),
        window: { summary: 'x'.repeat(400), notes: [] }, // 400-char summary would fail Zod .max(300)
      }));
      await drain({ airlockDir: env.airlock, engine: 'ollama' });
      const res = readResult(env);
      expect(res.status).toBe('done');
      expect(res.result.window.summary.length).toBe(300);
      expect(res.result.messages[0].note.length).toBe(140);
      expect(res.result.messages[0].tone_flags).toEqual(['affectionate']); // off-enum flags dropped
    } finally { env.close(); }
  });
});

// ── T2.12 Batch API adapter — estimate, request shape, pending filter (no live API) ────────────
describe('T2.12 batch adapter (pure/file logic)', () => {
  it('estimates cost/tokens, builds a valid request per job, and filters pending local jobs', async () => {
    const { estimateBatch, pendingBatchJobs, buildBatchRequest, DEFAULT_BATCH_MODEL } =
      await import('../src/airlock/batch');
    const env = makeEnv(60);
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const jobCount = jobFiles(env.airlock).length;

      const pending = pendingBatchJobs(env.airlock, 'local');
      expect(pending.length).toBe(jobCount);
      expect(pending.every((j) => j.engine_hint === 'local')).toBe(true);

      const est = estimateBatch(pending);
      expect(est.count).toBe(jobCount);
      expect(est.inTokens).toBeGreaterThan(0);
      expect(est.outTokens).toBeGreaterThan(0);
      expect(est.model).toBe(DEFAULT_BATCH_MODEL);
      expect(est.costBatchUsd).toBeCloseTo(est.costStandardUsd * 0.5, 6); // Batch API = 50% off

      const req = buildBatchRequest(pending[0]);
      expect(req.custom_id).toBe(pending[0].job_id);           // custom_id maps result → job
      expect(req.params.model).toBe(DEFAULT_BATCH_MODEL);
      expect(req.params.max_tokens).toBeGreaterThan(0);
      expect(req.params.system).toContain(pending[0].instructions.slice(0, 24));
      expect(req.params.messages[0].content).toContain(pending[0].chunk.transcript.slice(0, 24));

      // A written result excludes that job from the pending set (resubmit safety).
      const firstName = jobFiles(env.airlock)[0];
      writeJsonAtomic(join(airlockPaths(env.airlock).resultsDir, firstName), {
        job_id: 'x', input_hash: 'x', status: 'done',
      });
      expect(pendingBatchJobs(env.airlock, 'local').length).toBe(jobCount - 1);
    } finally { env.close(); }
  });
});
