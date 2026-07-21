// Between — airlock DB access (analysis_jobs / analysis_results / prefilter / reflections).
// The APP is the sole SQLite writer (HANDOFF invariant 2): every write in Phase 2 flows through
// here (planner inserts jobs; ingestResults upserts results + flips job status; firstReflection
// inserts frozen prose). The engine never touches this module.
import type { BetweenDB } from '../store/db';
import type { ChunkRef, JobKind, EngineHint, LensId, ResultStatus } from './types';

export interface JobRow {
  id: string;
  input_hash: string;
  lens: LensId;
  kind: JobKind;
  engine_hint: EngineHint;
  status: string;
  priority: number;
  chunk_ref: ChunkRef;
  prompt_id: string;
  prompt_version: number;
  attempts: number;
  error: string | null;
}

export interface InsertJobInput {
  id: string;
  inputHash: string;
  lens: LensId;
  kind: JobKind;
  engineHint: EngineHint;
  priority: number;
  chunkRef: ChunkRef;
  promptId: string;
  promptVersion: number;
}

export interface UpsertResultInput {
  inputHash: string;
  jobId: string;
  lens: LensId;
  result: unknown;
  validation: unknown;
  refusal: unknown;
  modelNote: string | null;
  sampleCount: number;
}

export interface ReflectionRow {
  id: number;
  thread_id: number;
  lens: string;
  range_start_ms: number;
  range_end_ms: number;
  content_md: string;
  evidence_json: string;
  prompt_version: number;
  model_note: string | null;
  generated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createAirlockStore(db: BetweenDB) {
  const raw = db.raw;

  const insJob = raw.prepare(
    `INSERT OR IGNORE INTO analysis_jobs
       (id, input_hash, lens, kind, engine_hint, status, priority, chunk_ref,
        prompt_id, prompt_version, attempts, created_at, updated_at)
     VALUES (@id, @inputHash, @lens, @kind, @engineHint, 'pending', @priority, @chunkRef,
        @promptId, @promptVersion, 0, @now, @now)`,
  );
  const qJob = raw.prepare(`SELECT * FROM analysis_jobs WHERE id = ?`);
  const qJobExists = raw.prepare(`SELECT 1 FROM analysis_jobs WHERE id = ?`);
  const qAllJobs = raw.prepare(
    `SELECT id, status, lens, chunk_ref FROM analysis_jobs`,
  );
  const setStatus = raw.prepare(
    `UPDATE analysis_jobs SET status = @status, error = @error, updated_at = @now WHERE id = @id`,
  );

  const qResult = raw.prepare(`SELECT * FROM analysis_results WHERE input_hash = ?`);
  const qResultExists = raw.prepare(`SELECT 1 FROM analysis_results WHERE input_hash = ?`);
  const upResult = raw.prepare(
    `INSERT INTO analysis_results
       (input_hash, job_id, lens, result_json, validation_json, refusal_json, model_note, sample_count, created_at)
     VALUES (@inputHash, @jobId, @lens, @resultJson, @validationJson, @refusalJson, @modelNote, @sampleCount, @now)
     ON CONFLICT(input_hash) DO UPDATE SET
       job_id = excluded.job_id, lens = excluded.lens, result_json = excluded.result_json,
       validation_json = excluded.validation_json, refusal_json = excluded.refusal_json,
       model_note = excluded.model_note, sample_count = excluded.sample_count, created_at = excluded.created_at`,
  );
  const qResultsJoined = raw.prepare(
    `SELECT r.input_hash, r.lens, r.result_json, j.chunk_ref
       FROM analysis_results r JOIN analysis_jobs j ON j.id = r.job_id
      WHERE r.lens = ?`,
  );

  const qPrefilter = raw.prepare(`SELECT scores_json, worth_llm FROM prefilter WHERE chunk_hash = ?`);
  const upPrefilter = raw.prepare(
    `INSERT INTO prefilter (chunk_hash, thread_id, scores_json, worth_llm)
     VALUES (@chunkHash, @threadId, @scoresJson, @worthLlm)
     ON CONFLICT(chunk_hash) DO UPDATE SET
       thread_id = excluded.thread_id, scores_json = excluded.scores_json, worth_llm = excluded.worth_llm`,
  );

  const insReflection = raw.prepare(
    `INSERT INTO reflections
       (thread_id, lens, range_start_ms, range_end_ms, content_md, evidence_json,
        prompt_version, model_note, generated_at)
     VALUES (@threadId, @lens, @rangeStartMs, @rangeEndMs, @contentMd, @evidenceJson,
        @promptVersion, @modelNote, @generatedAt)`,
  );
  const qReflections = raw.prepare(
    `SELECT * FROM reflections WHERE thread_id = ? ORDER BY generated_at DESC, id DESC`,
  );

  const parseChunk = (s: string): ChunkRef => JSON.parse(s) as ChunkRef;

  return {
    // ── jobs ──
    insertJob(input: InsertJobInput): boolean {
      const info = insJob.run({
        id: input.id,
        inputHash: input.inputHash,
        lens: input.lens,
        kind: input.kind,
        engineHint: input.engineHint,
        priority: input.priority,
        chunkRef: JSON.stringify(input.chunkRef),
        promptId: input.promptId,
        promptVersion: input.promptVersion,
        now: nowIso(),
      });
      return info.changes === 1;
    },
    jobExists(id: string): boolean {
      return qJobExists.get(id) !== undefined;
    },
    getJob(id: string): JobRow | undefined {
      const r = qJob.get(id) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      return { ...(r as any), chunk_ref: parseChunk(r.chunk_ref as string) } as JobRow;
    },
    setJobStatus(id: string, status: ResultStatus | 'skipped' | 'pending', error: string | null = null): void {
      setStatus.run({ id, status, error, now: nowIso() });
    },
    /** Status counts across all jobs for a thread (parsed from chunk_ref.thread_id). */
    /** Job statuses for a thread. Pass `lens` to count one lens only — the L1 coverage surface says
     *  "N stretches were declined" about the EMOTION pass, and without the filter a refused
     *  episode-patterns or render job made that sentence appear beside 100% emotion coverage. */
    jobStatusCountsForThread(threadId: number, lens?: LensId): Record<string, number> {
      const counts: Record<string, number> = {};
      for (const r of qAllJobs.all() as { status: string; lens: string; chunk_ref: string }[]) {
        if (lens && r.lens !== lens) continue;
        let tid: number | undefined;
        try { tid = (JSON.parse(r.chunk_ref) as ChunkRef).thread_id; } catch { /* skip */ }
        if (tid !== threadId) continue;
        counts[r.status] = (counts[r.status] ?? 0) + 1;
      }
      return counts;
    },

    // ── results ──
    resultExists(inputHash: string): boolean {
      return qResultExists.get(inputHash) !== undefined;
    },
    getResult(inputHash: string): Record<string, unknown> | undefined {
      return qResult.get(inputHash) as Record<string, unknown> | undefined;
    },
    upsertResult(input: UpsertResultInput): void {
      upResult.run({
        inputHash: input.inputHash,
        jobId: input.jobId,
        lens: input.lens,
        resultJson: JSON.stringify(input.result),
        validationJson: input.validation == null ? null : JSON.stringify(input.validation),
        refusalJson: input.refusal == null ? null : JSON.stringify(input.refusal),
        modelNote: input.modelNote,
        sampleCount: input.sampleCount,
        now: nowIso(),
      });
    },
    /** All results for a lens whose owning job is in `threadId`, with the parsed chunk_ref. */
    resultsForThreadLens(threadId: number, lens: LensId): { inputHash: string; result: unknown; chunk: ChunkRef }[] {
      const out: { inputHash: string; result: unknown; chunk: ChunkRef }[] = [];
      for (const r of qResultsJoined.all(lens) as { input_hash: string; result_json: string; chunk_ref: string }[]) {
        const chunk = parseChunk(r.chunk_ref);
        if (chunk.thread_id !== threadId) continue;
        out.push({ inputHash: r.input_hash, result: JSON.parse(r.result_json), chunk });
      }
      return out;
    },

    // ── prefilter ──
    getPrefilter(chunkHash: string): { scores: unknown; worthLlm: boolean } | undefined {
      const r = qPrefilter.get(chunkHash) as { scores_json: string; worth_llm: number } | undefined;
      if (!r) return undefined;
      return { scores: JSON.parse(r.scores_json), worthLlm: !!r.worth_llm };
    },
    putPrefilter(chunkHash: string, threadId: number, scores: unknown, worthLlm: boolean): void {
      upPrefilter.run({
        chunkHash, threadId, scoresJson: JSON.stringify(scores), worthLlm: worthLlm ? 1 : 0,
      });
    },

    // ── reflections ──
    insertReflection(input: {
      threadId: number; lens: string; rangeStartMs: number; rangeEndMs: number;
      contentMd: string; evidence: unknown; promptVersion: number; modelNote: string | null;
      generatedAt: string;
    }): number {
      const info = insReflection.run({
        threadId: input.threadId, lens: input.lens, rangeStartMs: input.rangeStartMs,
        rangeEndMs: input.rangeEndMs, contentMd: input.contentMd,
        evidenceJson: JSON.stringify(input.evidence), promptVersion: input.promptVersion,
        modelNote: input.modelNote, generatedAt: input.generatedAt,
      });
      return Number(info.lastInsertRowid);
    },
    listReflections(threadId: number, lens?: string): ReflectionRow[] {
      const rows = qReflections.all(threadId) as ReflectionRow[];
      return lens ? rows.filter((r) => r.lens === lens) : rows;
    },
  };
}

export type AirlockStore = ReturnType<typeof createAirlockStore>;
