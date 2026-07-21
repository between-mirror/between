// Between — app-side result ingest (docs/SPECS/airlock.md §"App-side ingest"). This is the ONLY
// place Phase-2 model output reaches the DB, and the app is the sole SQLite writer (invariant 2).
// It runs on AWAITED drain completion — never from a file watcher. On launch, the same routine
// reconciles any orphan results/*.json not yet in the DB (crash resume, TEST T2.6).
//
// Per result file:
//   1. Zod-validate the envelope + (for done) the lens payload — reject invalid (TEST T2.4).
//   2. Detect refusal → mark the job "refused" so the UI can say "couldn't score this stretch"
//      instead of showing a silent gap (TEST T2.5).
//   3. Evidence check: every evidence_ids entry must resolve to a REAL message row in the chunk;
//      a claim whose ids don't resolve is DROPPED and counted (invariant 1, TEST T2.7).
//   4. Upsert analysis_results (keyed by input_hash), flip the job status, move the pair to archive.
import type { BetweenDB } from '../store/db';
import type { LensId, IngestSummary, ChunkRef } from './types';
import { createAirlockStore } from './store';
import { resultEnvelopeSchema, validateLensResult } from './schemas';
import {
  airlockPaths, ensureAirlock, listJobFiles, readJson, moveToArchive, moveToQuarantine, existsSync, join,
} from './paths';

export interface IngestOptions {
  airlockDir: string;
}

/** Build the set of resolvable evidence ids ("m<id>") for a chunk from real DB rows. Batched so a
 *  large reduce/render member set stays under the SQLite variable limit. */
function validIdSet(db: BetweenDB, chunk: ChunkRef): Set<string> {
  const ids = chunk.member_ids ?? [];
  const out = new Set<string>();
  const BATCH = 800;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db.raw
      .prepare(
        `SELECT id FROM messages
          WHERE thread_id = ? AND is_reaction = 0 AND id IN (${placeholders})`,
      )
      .all(chunk.thread_id, ...slice) as { id: number }[];
    for (const r of rows) out.add(`m${r.id}`);
  }
  return out;
}

/**
 * Exact L1 coverage (P1-7). Every OWN message in the window (member_ids minus the overlap prefix) must
 * be scored exactly once; the returned ids must not duplicate and must not stray outside the window's
 * members. A partial or padded L1 result is rejected whole — a window with an unscored message would
 * silently read as neutral, which is a lie the river must never tell. Prefix messages MAY be scored
 * (they are in the transcript) but are not required.
 */
export function l1Coverage(payload: unknown, chunk: ChunkRef): { ok: true } | { ok: false; reason: string } {
  const messages = (payload as { messages?: { message_id?: string }[] }).messages ?? [];
  const returned = messages.map((m) => m?.message_id).filter((x): x is string => typeof x === 'string');
  const returnedSet = new Set(returned);
  if (returned.length !== returnedSet.size) return { ok: false, reason: 'duplicate' };
  const prefix = new Set(chunk.overlap_prefix_ids);
  const own = chunk.member_ids.filter((id) => !prefix.has(id)).map((id) => `m${id}`);
  const members = new Set(chunk.member_ids.map((id) => `m${id}`));
  for (const id of own) if (!returnedSet.has(id)) return { ok: false, reason: 'missing' };
  for (const id of returnedSet) if (!members.has(id)) return { ok: false, reason: 'extra' };
  return { ok: true };
}

interface Resolved { cleaned: unknown; dropped: number }

/** Drop every claim whose evidence_ids don't resolve to a real message row. */
function resolveEvidence(lens: LensId, payload: unknown, valid: Set<string>): Resolved {
  const p = structuredClone(payload) as any;
  const keep = (arr: unknown): string[] =>
    Array.isArray(arr) ? (arr as string[]).filter((id) => valid.has(id)) : [];
  let dropped = 0;

  if (lens === 'l1_emotion') {
    p.messages = Array.isArray(p.messages)
      ? p.messages.filter((m: any) => valid.has(m?.message_id))
      : [];
    const notes = Array.isArray(p.window?.notes) ? p.window.notes : [];
    const kept: any[] = [];
    for (const n of notes) {
      const ids = keep(n?.evidence_ids);
      if (ids.length) kept.push({ ...n, evidence_ids: ids });
      else dropped++;
    }
    if (p.window) p.window.notes = kept;
    return { cleaned: p, dropped };
  }

  if (lens === 'first_reflection_reduce') {
    const strengths: any[] = [];
    for (const s of Array.isArray(p.strengths) ? p.strengths : []) {
      const ids = keep(s?.evidence_ids);
      if (ids.length) strengths.push({ ...s, evidence_ids: ids });
      else dropped++;
    }
    p.strengths = strengths;
    if (p.observation) {
      const ids = keep(p.observation.evidence_ids);
      if (ids.length) p.observation.evidence_ids = ids;
      else { dropped++; p.observation = null; }
    }
    return { cleaned: p, dropped };
  }

  if (lens === 'l4_episode_patterns') {
    const kept: any[] = [];
    for (const pat of Array.isArray(p.patterns) ? p.patterns : []) {
      const ids = keep(pat?.evidence_ids);
      if (ids.length) kept.push({ ...pat, evidence_ids: ids });
      else dropped++;
    }
    p.patterns = kept;
    return { cleaned: p, dropped };
  }

  // render + ask lenses: evidence-bearing blocks (P0-3). Drop an observation/interpretation block
  // whose evidence doesn't resolve; question/bridge blocks carry no resolvable evidence and pass
  // through (the finalizer's composeBlocks enforces their caps + orphan rule).
  const blocks: any[] = [];
  for (const b of Array.isArray(p.blocks) ? p.blocks : []) {
    if (b?.kind === 'observation' || b?.kind === 'tentative_interpretation') {
      const ids = keep(b?.evidence_ids);
      if (ids.length) blocks.push({ ...b, evidence_ids: ids });
      else dropped++;
    } else {
      blocks.push(b);
    }
  }
  p.blocks = blocks;
  return { cleaned: p, dropped };
}

/**
 * Ingest all result files currently in airlock/results into the DB. Idempotent and resumable:
 * safe to call at launch (reconcile) or after an awaited drain.
 */
export function ingestResults(db: BetweenDB, opts: IngestOptions): IngestSummary {
  const paths = ensureAirlock(opts.airlockDir);
  const store = createAirlockStore(db);
  const summary: IngestSummary = { ingested: 0, refused: 0, errored: 0, claimsDropped: 0, unknown: 0, quarantined: 0 };

  for (const name of listJobFiles(paths.resultsDir)) {
    const resultPath = join(paths.resultsDir, name);
    const jobArchiveName = name.replace(/\.json$/, '.job.json');
    let envUnknown: unknown;
    try {
      envUnknown = readJson(resultPath);
    } catch {
      summary.unknown++;
      moveToArchive(resultPath, paths.archiveDir, name);
      continue;
    }

    const parsed = resultEnvelopeSchema.safeParse(envUnknown);
    if (!parsed.success) {
      summary.unknown++;
      moveToArchive(resultPath, paths.archiveDir, name);
      continue;
    }
    const env = parsed.data;

    const job = store.getJob(env.job_id);
    if (!job) {
      // Orphan result (unknown job / different DB) — clear it so reconcile terminates.
      summary.unknown++;
      moveToArchive(resultPath, paths.archiveDir, name);
      continue;
    }
    const lens = job.lens;
    const jobPath = join(paths.jobsDir, name);
    const archivePair = () => {
      moveToArchive(resultPath, paths.archiveDir, name);
      if (existsSync(jobPath)) moveToArchive(jobPath, paths.archiveDir, jobArchiveName);
    };

    // ── envelope verification (P0-4): the file must belong to THIS job, byte-for-byte ──
    // Filename, job_id, and input_hash must ALL agree with the job row before any status is trusted.
    // A mismatch means a stray, renamed, or tampered result file (a foreign result dropped under a
    // real job's name; a payload re-pointed at a different hash) — quarantine it, error the job, and
    // never let it near the cache. This gates every downstream path (refused/error/done) equally.
    if (name !== `${env.job_id}.json` || env.job_id !== job.id || env.input_hash !== job.input_hash) {
      store.setJobStatus(job.id, 'error', 'envelope_mismatch');
      moveToQuarantine(resultPath, paths.quarantineDir, name);
      if (existsSync(jobPath)) moveToQuarantine(jobPath, paths.quarantineDir, jobArchiveName);
      summary.quarantined++;
      continue;
    }

    // ── refusal (T2.5): honest gap, never silent ──
    const refused = env.status === 'refused'
      || env.refusal?.detected === true
      || (env.result != null && typeof env.result === 'object'
        && (env.result as { refused?: unknown }).refused === true);
    if (refused) {
      store.setJobStatus(job.id, 'refused', env.refusal?.reason ?? 'refused');
      store.upsertResult({
        inputHash: env.input_hash, jobId: job.id, lens,
        result: {}, validation: env.validation ?? null,
        refusal: env.refusal ?? { detected: true, reason: 'refused' },
        modelNote: env.model_note ?? null, sampleCount: 1,
      });
      summary.refused++;
      archivePair();
      continue;
    }

    if (env.status === 'error') {
      store.setJobStatus(job.id, 'error', 'engine reported error');
      summary.errored++;
      archivePair();
      continue;
    }

    // ── done: Zod-validate the payload (belt over the engine's braces, T2.4) ──
    const payload = env.result ?? (Array.isArray(env.samples) ? env.samples[0] : undefined);
    const check = validateLensResult(lens, payload);
    if (!check.ok) {
      store.setJobStatus(job.id, 'error', `schema: ${check.error}`);
      summary.errored++;
      archivePair();
      continue;
    }

    // ── exact L1 coverage (P1-7): every own message scored once, nothing partial cached ──
    if (lens === 'l1_emotion') {
      const cov = l1Coverage(check.value, job.chunk_ref);
      if (!cov.ok) {
        store.setJobStatus(job.id, 'error', `coverage_mismatch (${cov.reason})`);
        summary.errored++;
        archivePair();
        continue;
      }
    }

    // ── evidence resolution: drop ID-less / unresolvable claims (invariant 1, T2.7) ──
    const valid = validIdSet(db, job.chunk_ref);
    const { cleaned, dropped } = resolveEvidence(lens, check.value, valid);
    summary.claimsDropped += dropped;

    // ── re-validate AFTER filtering (P1-8): dropping fabricated receipts can push a payload below
    // its own schema (e.g. a reduce observation whose only evidence_ids were invented, or a
    // strengths list emptied whole). A cleaned payload that no longer satisfies the lens contract is
    // rejected — never a half-grounded result silently cached. ──
    const recheck = validateLensResult(lens, cleaned);
    if (!recheck.ok) {
      store.setJobStatus(job.id, 'error', 'post_filter_invalid');
      summary.errored++;
      archivePair();
      continue;
    }

    store.upsertResult({
      inputHash: env.input_hash, jobId: job.id, lens,
      result: cleaned, validation: env.validation ?? { schema_ok: true, retries: 0 },
      refusal: env.refusal ?? { detected: false, reason: null },
      modelNote: env.model_note ?? null,
      sampleCount: Array.isArray(env.samples) ? env.samples.length : 1,
    });
    store.setJobStatus(job.id, 'done');
    summary.ingested++;
    archivePair();
  }

  return summary;
}

/** Launch-time reconcile: re-ingest any orphan results not yet in the DB (T2.6). */
export function reconcile(db: BetweenDB, opts: IngestOptions): IngestSummary {
  return ingestResults(db, opts);
}

export type ValidatedResult =
  | { ok: true; payload: unknown; modelNote: string | null }
  | { ok: false; reason: 'missing' | 'not_done' | 'refused' | 'invalid' };

/**
 * The ONLY sanctioned way a synthesis/finalize path reads a Phase-2 result payload (P0-2). It reads
 * the CLEANED payload the app stored at ingest — NEVER a raw `results/*.json` file — after asserting
 * the owning job actually reached 'done' (a refused / errored / missing job is an honest decline, not
 * a frozen artifact). It then re-validates the stored payload against the lens schema, a belt over
 * ingest's own post-filter check (P1-8): a result that no longer satisfies its schema after evidence
 * filtering can never render. Every finalizer routes through this — raw model output has no other door.
 */
export function getValidatedResult(db: BetweenDB, inputHash: string, lens: LensId): ValidatedResult {
  const store = createAirlockStore(db);
  const row = store.getResult(inputHash);
  if (!row) return { ok: false, reason: 'missing' };
  const job = store.getJob(row.job_id as string);
  if (job) {
    if (job.status === 'refused') return { ok: false, reason: 'refused' };
    if (job.status !== 'done') return { ok: false, reason: 'not_done' };
  }
  let payload: unknown;
  try { payload = JSON.parse(row.result_json as string); } catch { return { ok: false, reason: 'invalid' }; }
  const check = validateLensResult(lens, payload);
  if (!check.ok) return { ok: false, reason: 'invalid' };
  return { ok: true, payload: check.value, modelNote: (row.model_note as string) ?? null };
}
