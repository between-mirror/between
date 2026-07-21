// Between — the planner (docs/SPECS/airlock.md §"plan.ts"). Given {threadId, lens, range}: load the
// thread's non-reaction messages, window them turn-aligned (~40–60 msgs / ~6–8k token budget, 2–3
// turn overlap), build a self-contained job per window, reuse cached results by input_hash (no new
// job), and — unless dry-run — write airlock/jobs/<id>.json (atomic) + jobs/_manifest.json and
// insert the pending job rows. Returns a capacity estimate BEFORE materializing (T2.9).
import type { BetweenDB } from '../store/db';
import type {
  LensId, PlannedJob, PlanOutcome, ChunkFile, ChunkRef, JobFile,
} from './types';
import type { AirlockStore } from './store';
import { createAirlockStore } from './store';
import { promptFor } from './prompts';
import { computeHash } from './hash';
import { buildEstimate } from './estimate';
import {
  ensureAirlock, writeJsonAtomic, listJobFiles, readJson, existsSync, join,
} from './paths';

// ── windowing knobs ───────────────────────────────────────────────────────────
const TARGET_MAX_MSGS = 55;   // close a window's own span at/after this many messages
const TOKEN_BUDGET = 7000;    // ~6–8k tokens per window
const CHARS_PER_TOKEN = 4;    // crude token estimate
const OVERLAP_TURNS = 3;      // 2–3 trailing turns carried as context
const MAX_PREFIX_MSGS = 12;   // cap on overlap-prefix size

export interface LoadedMsg {
  id: number;
  dir: string;
  ms: number;
  body: string;
}

export interface Window {
  ownMsgs: LoadedMsg[];
  prefixMsgs: LoadedMsg[];
  transcript: string;
  chunkFile: ChunkFile;
  chunkRef: ChunkRef;
}

function speaker(dir: string): 'ME' | 'THEM' {
  return dir === 'outgoing' || dir === 'draft' ? 'ME' : 'THEM';
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** One transcript line: `[m<id>] <YYYY-MM-DD HH:MM> <ME|THEM>: <text>` (newlines flattened). */
function line(m: LoadedMsg): string {
  const text = m.body.replace(/\s*\n\s*/g, ' ').trim();
  return `[m${m.id}] ${fmtTime(m.ms)} ${speaker(m.dir)}: ${text}`;
}

function estTokens(m: LoadedMsg): number {
  return Math.ceil((m.body.length + 24) / CHARS_PER_TOKEN);
}

/** Maximal runs of same-speaker messages. */
function buildTurns(msgs: LoadedMsg[]): LoadedMsg[][] {
  const turns: LoadedMsg[][] = [];
  let cur: LoadedMsg[] = [];
  for (const m of msgs) {
    if (cur.length && speaker(cur[0].dir) !== speaker(m.dir)) {
      turns.push(cur);
      cur = [];
    }
    cur.push(m);
  }
  if (cur.length) turns.push(cur);
  return turns;
}

/**
 * Turn-aligned windowing. Own spans TILE the turns without overlap (so a reduce dedups cleanly);
 * each window (after the first) additionally carries the previous span's last 2–3 turns as an
 * overlap prefix for context. Windows always align to message boundaries.
 */
export function buildWindows(threadId: number, msgs: LoadedMsg[]): Window[] {
  const turns = buildTurns(msgs);
  if (turns.length === 0) return [];

  // Tile turns into own-spans by message/token budget.
  const spans: { start: number; end: number }[] = [];
  let i = 0;
  while (i < turns.length) {
    let count = 0;
    let toks = 0;
    let j = i;
    while (j < turns.length) {
      const turn = turns[j];
      count += turn.length;
      for (const m of turn) toks += estTokens(m);
      j++;
      if (count >= TARGET_MAX_MSGS || toks >= TOKEN_BUDGET) break;
    }
    spans.push({ start: i, end: j - 1 });
    i = j;
  }

  return spans.map((span, k) => {
    const ownMsgs = turns.slice(span.start, span.end + 1).flat();
    let prefixMsgs: LoadedMsg[] = [];
    if (k > 0) {
      const prev = spans[k - 1];
      const prevTurns = turns.slice(prev.start, prev.end + 1);
      prefixMsgs = prevTurns.slice(Math.max(0, prevTurns.length - OVERLAP_TURNS)).flat();
      if (prefixMsgs.length > MAX_PREFIX_MSGS) {
        prefixMsgs = prefixMsgs.slice(prefixMsgs.length - MAX_PREFIX_MSGS);
      }
    }
    const transcript = [...prefixMsgs, ...ownMsgs].map(line).join('\n');
    const memberIds = [...prefixMsgs, ...ownMsgs].map((m) => m.id);
    const chunkFile: ChunkFile = {
      thread_id: threadId,
      start_msg_id: ownMsgs[0].id,
      end_msg_id: ownMsgs[ownMsgs.length - 1].id,
      overlap_prefix_ids: prefixMsgs.map((m) => m.id),
      transcript,
    };
    const chunkRef: ChunkRef = {
      thread_id: threadId,
      start_msg_id: chunkFile.start_msg_id,
      end_msg_id: chunkFile.end_msg_id,
      overlap_prefix_ids: chunkFile.overlap_prefix_ids,
      member_ids: memberIds,
    };
    return { ownMsgs, prefixMsgs, transcript, chunkFile, chunkRef };
  });
}

/** Load a thread's substantive (non-reaction, non-empty) messages in the range, ascending. */
export function loadRangeMessages(
  db: BetweenDB,
  threadId: number,
  fromMs: number | null,
  toMs: number | null,
): LoadedMsg[] {
  const clauses = ['thread_id = @threadId', 'is_reaction = 0', "trim(coalesce(body_text,'')) != ''"];
  if (fromMs != null) clauses.push('sent_at_ms >= @fromMs');
  if (toMs != null) clauses.push('sent_at_ms <= @toMs');
  const rows = db.raw
    .prepare(
      `SELECT id, direction AS dir, sent_at_ms AS ms, body_text AS body
         FROM messages WHERE ${clauses.join(' AND ')}
        ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all({ threadId, fromMs, toMs }) as LoadedMsg[];
  return rows;
}

/** Build the job file + DB chunk_ref for one window under a lens. */
export function plannedJobForWindow(lens: LensId, win: Window): PlannedJob {
  const p = promptFor(lens);
  const { inputHash, jobId } = computeHash({
    promptId: p.promptId,
    promptVersion: p.version,
    params: {},
    chunkText: win.transcript,
    outputSchema: p.outputSchema,
  });
  const jobFile: JobFile = {
    job_id: jobId,
    input_hash: inputHash,
    lens,
    kind: p.kind,
    engine_hint: p.engineHint,
    prompt_id: p.promptId,
    prompt_version: p.version,
    instructions: p.instructions,
    chunk: win.chunkFile,
    output_schema: p.outputSchema,
    rules: p.rules,
  };
  return { jobFile, chunkRef: win.chunkRef, priority: 0 };
}

export interface PlanParams {
  threadId: number;
  lens: LensId;
  fromMs?: number | null;
  toMs?: number | null;
  dryRun?: boolean;
  airlockDir: string;
}

/** Rebuild jobs/_manifest.json from the job files currently on disk (app-written inventory). */
export function rebuildManifest(airlockDir: string): void {
  const p = ensureAirlock(airlockDir);
  const jobs: { job_id: string; lens: string; kind: string; engine_hint: string; priority: number }[] = [];
  for (const f of listJobFiles(p.jobsDir)) {
    try {
      const jf = readJson<JobFile>(join(p.jobsDir, f));
      jobs.push({
        job_id: jf.job_id, lens: jf.lens, kind: jf.kind, engine_hint: jf.engine_hint,
        priority: jf.sample_count ? 1 : 0,
      });
    } catch { /* skip unreadable */ }
  }
  writeJsonAtomic(p.manifestPath, {
    generated_at: new Date().toISOString(),
    count: jobs.length,
    jobs,
  });
}

export interface CustomJobParams {
  lens: LensId;
  threadId: number;
  transcript: string;   // self-contained material (reduce: L1 JSON+stats; render: reduce JSON+spec)
  memberIds: number[];  // real message ids the result may cite (for evidence resolution)
  airlockDir: string;
}

/**
 * Materialize a single non-windowed job (reduce/render) from arbitrary self-contained material.
 * Returns the job id + input_hash, and whether a cached result already covers it (no new job).
 */
export function materializeCustomJob(db: BetweenDB, params: CustomJobParams): {
  jobId: string; inputHash: string; cached: boolean;
} {
  const store = createAirlockStore(db);
  const p = promptFor(params.lens);
  const sortedIds = [...params.memberIds].sort((a, b) => a - b);
  const startId = sortedIds[0] ?? 0;
  const endId = sortedIds[sortedIds.length - 1] ?? 0;
  const { inputHash, jobId } = computeHash({
    promptId: p.promptId,
    promptVersion: p.version,
    params: {},
    chunkText: params.transcript,
    outputSchema: p.outputSchema,
  });
  if (store.resultExists(inputHash)) return { jobId, inputHash, cached: true };

  const chunkFile: ChunkFile = {
    thread_id: params.threadId,
    start_msg_id: startId,
    end_msg_id: endId,
    overlap_prefix_ids: [],
    transcript: params.transcript,
  };
  const chunkRef: ChunkRef = {
    thread_id: params.threadId,
    start_msg_id: startId,
    end_msg_id: endId,
    overlap_prefix_ids: [],
    member_ids: sortedIds,
  };
  const jobFile: JobFile = {
    job_id: jobId,
    input_hash: inputHash,
    lens: params.lens,
    kind: p.kind,
    engine_hint: p.engineHint,
    prompt_id: p.promptId,
    prompt_version: p.version,
    instructions: p.instructions,
    chunk: chunkFile,
    output_schema: p.outputSchema,
    rules: p.rules,
  };
  store.insertJob({
    id: jobId, inputHash, lens: params.lens, kind: p.kind, engineHint: p.engineHint,
    priority: 0, chunkRef, promptId: p.promptId, promptVersion: p.version,
  });
  const paths = ensureAirlock(params.airlockDir);
  const filePath = join(paths.jobsDir, `${jobId}.json`);
  if (!existsSync(filePath)) writeJsonAtomic(filePath, jobFile);
  rebuildManifest(params.airlockDir);
  return { jobId, inputHash, cached: false };
}

/**
 * Plan an analysis. Always computes the estimate; materializes job files + rows unless dryRun.
 * Cached windows (result already in DB by input_hash) create no new job (TEST T2.2).
 */
export function planAnalysis(db: BetweenDB, params: PlanParams): PlanOutcome {
  const { threadId, lens } = params;
  const fromMs = params.fromMs ?? null;
  const toMs = params.toMs ?? null;
  const store: AirlockStore = createAirlockStore(db);

  const msgs = loadRangeMessages(db, threadId, fromMs, toMs);
  const windows = buildWindows(threadId, msgs);

  const planned = windows.map((w) => ({ win: w, job: plannedJobForWindow(lens, w) }));

  let cached = 0;
  const toRunJobs: typeof planned = [];
  for (const pj of planned) {
    if (store.resultExists(pj.job.jobFile.input_hash)) cached++;
    else toRunJobs.push(pj);
  }

  const estimate = buildEstimate({
    windowCount: windows.length,
    cached,
    toRun: toRunJobs.length,
    skipped: 0,
  });

  const jobIds: string[] = [];
  let materialized = false;
  if (!params.dryRun && toRunJobs.length > 0) {
    const p = ensureAirlock(params.airlockDir);
    for (const pj of toRunJobs) {
      const { jobFile, chunkRef } = pj.job;
      store.insertJob({
        id: jobFile.job_id,
        inputHash: jobFile.input_hash,
        lens: jobFile.lens,
        kind: jobFile.kind,
        engineHint: jobFile.engine_hint,
        priority: pj.job.priority,
        chunkRef,
        promptId: jobFile.prompt_id,
        promptVersion: jobFile.prompt_version,
      });
      const filePath = join(p.jobsDir, `${jobFile.job_id}.json`);
      if (!existsSync(filePath)) writeJsonAtomic(filePath, jobFile);
      jobIds.push(jobFile.job_id);
    }
    rebuildManifest(params.airlockDir);
    materialized = true;
  }

  return { threadId, lens, fromMs, toMs, estimate, materialized, jobIds };
}
