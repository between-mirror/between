// Between — airlock shared types. Data shapes for the job/result protocol (docs/SPECS/airlock.md).
// No personal data ever appears here; transcripts are built at runtime from the local DB.

export type LensId =
  | 'l1_emotion'
  | 'first_reflection_reduce'
  | 'first_reflection_render'
  | 'l4_episode_patterns'
  | 'ask_answer'
  | 'episode_note'
  | 'era_summary'
  | 'growth_note'
  | 'herside_reading'
  | 'letter';

export type JobKind = 'map' | 'reduce' | 'single' | 'render';
export type EngineHint = 'local' | 'claude' | 'render';
export type EngineName = 'mock' | 'claude' | 'ollama' | 'batch';

export type ResultStatus = 'done' | 'error' | 'refused';

/** The chunk as it appears in a job FILE (self-contained, sent to the engine). */
export interface ChunkFile {
  thread_id: number;
  start_msg_id: number;
  end_msg_id: number;
  overlap_prefix_ids: number[];
  transcript: string;
}

/**
 * The chunk_ref persisted in analysis_jobs (DB-internal). Superset of the file chunk:
 * carries member_ids so evidence resolution never depends on rowid ordering (real archives
 * are not inserted in time order). The transcript is NOT stored in the DB.
 */
export interface ChunkRef {
  thread_id: number;
  start_msg_id: number;
  end_msg_id: number;
  overlap_prefix_ids: number[];
  member_ids: number[];
}

/** A fully materialized job (file shape). */
export interface JobFile {
  job_id: string;
  input_hash: string;
  lens: LensId;
  kind: JobKind;
  engine_hint: EngineHint;
  prompt_id: string;
  prompt_version: number;
  instructions: string;
  chunk: ChunkFile;
  output_schema: unknown;
  rules: string[];
  sample_count?: number;
}

/** A planned job before it is written to disk (carries the DB chunk_ref). */
export interface PlannedJob {
  jobFile: JobFile;
  chunkRef: ChunkRef;
  priority: number;
}

/** The result FILE shape written by an engine. */
export interface ResultFile {
  job_id: string;
  input_hash: string;
  status: ResultStatus;
  validation?: { schema_ok: boolean; retries: number } | null;
  refusal?: { detected: boolean; reason: string | null } | null;
  model_note?: string | null;
  result?: unknown;
  samples?: unknown[];
}

export interface Estimate {
  windowCount: number;
  cached: number;
  toRun: number;
  skipped: number;
  drains: number;
  timeEstimate: string;
  /** VOICE §6 estimate microcopy, ready to show. */
  copy: string;
}

export interface PlanOutcome {
  threadId: number;
  lens: LensId;
  fromMs: number | null;
  toMs: number | null;
  estimate: Estimate;
  /** true when jobs were written to disk + DB (non-dry-run). */
  materialized: boolean;
  jobIds: string[];
}

export interface DrainSummary {
  engine: EngineName;
  processed: number;
  errored: number;
  refused: number;
  skippedLocal: number;
  remaining: number;
  estimatedFurtherSittings: number;
}

export interface IngestSummary {
  ingested: number;
  refused: number;
  errored: number;
  claimsDropped: number;
  unknown: number;
  /** Result files whose envelope (job_id / input_hash / filename) did not match the job row (P0-4).
   *  Moved to airlock/quarantine/, the job errored, and never inserted into the cache. */
  quarantined: number;
}
