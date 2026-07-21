// Between — the drain engine (docs/SPECS/airlock.md §"Engine contract"). Reads pending job files,
// produces results, and writes airlock/results/<id>.json ONLY. It NEVER opens, reads, or writes the
// SQLite DB and never modifies jobs/ (TEST T2.8, build-blocking). To keep that guarantee obvious and
// mechanical, this module imports NOTHING from ../store and NOTHING from ./store — only the pure
// filesystem helpers in ./paths. The app ingests results separately, on awaited completion.
//
//   engine="mock"   → deterministic, schema-valid results (tests + evidence-plumbing)
//   engine="claude" → spawn `claude` /drain-jobs via execa (awaited; app then ingests)
//   engine="ollama" → POST each job to http://127.0.0.1:11434 (graceful if absent)
import type { JobFile, ResultFile, DrainSummary, EngineName } from './types';
import {
  airlockPaths, ensureAirlock, listJobFiles, readJson, writeJsonAtomic, existsSync, join,
} from './paths';
import { DRAIN_BATCH } from './estimate';
// Pure Zod validators (no DB / store import — the sole-writer guarantee, T2.8, is preserved).
import { validateLensResult, TONE_FLAGS } from './schemas';

const ALLOWED_TONE = new Set<string>(TONE_FLAGS);

export interface DrainOptions {
  airlockDir: string;
  engine: EngineName;
  /** Restrict to jobs with this engine_hint (e.g. 'local' = grunt only, so the worthwhile
   *  reduce/render jobs are never clobbered by the local model). */
  only?: string;
  batchSize?: number;
  repoRoot?: string;
  ollamaModel?: string;
  ollamaUrl?: string;
  /** Ollama context window (num_ctx). Must be large enough to hold the window transcript PLUS one
   *  JSON entry per message, or dense windows are silently truncated (messages go unscored). */
  ollamaNumCtx?: number;
}

/** engine_hint → engine. Grunt ('local') = Ollama; worthwhile ('claude'/'render') = Claude/Fable. */
export type EngineHintMap = Record<string, EngineName>;
export const DEFAULT_ENGINE_MAP: EngineHintMap = { local: 'ollama', claude: 'claude', render: 'claude' };
export function engineForHint(hint: string, map: EngineHintMap = DEFAULT_ENGINE_MAP): EngineName {
  const e = map[hint];
  return e === 'ollama' || e === 'claude' || e === 'mock' ? e : 'mock';
}

type ResultFileStatus = ResultFile['status'];

interface PendingJob {
  name: string;      // <id>.json
  jobPath: string;
  resultPath: string;
  job: JobFile;
}

/** Job files with no result file yet (a written result = drained, awaiting app ingest). */
function pendingJobs(airlockDir: string): PendingJob[] {
  const p = airlockPaths(airlockDir);
  const out: PendingJob[] = [];
  for (const name of listJobFiles(p.jobsDir)) {
    const resultPath = join(p.resultsDir, name);
    if (existsSync(resultPath)) continue;
    try {
      const job = readJson<JobFile>(join(p.jobsDir, name));
      out.push({ name, jobPath: join(p.jobsDir, name), resultPath, job });
    } catch { /* skip unreadable job file */ }
  }
  return out;
}

// ── mock engine ───────────────────────────────────────────────────────────────
function extractIds(job: JobFile): string[] {
  const text = job.chunk.transcript ?? '';
  const re = job.kind === 'map' ? /\[m(\d+)\]/g : /"m(\d+)"/g;
  const seen = new Set<string>();
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = `m${m[1]}`;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  // Fallback: scan the whole job payload for reduce/render if transcript had none.
  if (ids.length === 0 && job.kind !== 'map') {
    const whole = JSON.stringify(job);
    const re2 = /m(\d+)/g;
    while ((m = re2.exec(whole)) !== null) {
      const id = `m${m[1]}`;
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
  }
  return ids;
}

/** Deterministic, schema-valid result for a job (neutral emotion + one evidence-cited note). */
export function mockResult(job: JobFile): ResultFile {
  const ids = extractIds(job);
  const base = {
    job_id: job.job_id,
    input_hash: job.input_hash,
    status: 'done' as const,
    validation: { schema_ok: true, retries: 0 },
    refusal: { detected: false, reason: null },
    model_note: 'mock engine (deterministic)',
  };

  if (job.lens === 'l1_emotion') {
    return {
      ...base,
      result: {
        messages: ids.map((id) => ({ message_id: id, valence: 0, warmth: 0, tension: 0 })),
        window: {
          summary: 'Neutral logistics; no strong warmth or tension in this stretch.',
          notes: ids.length
            ? [{ claim: 'Even, matter-of-fact exchange.', evidence_ids: [ids[0]], confidence: 'surer' }]
            : [],
          worth_deeper_look: false,
        },
      },
    };
  }

  if (job.lens === 'first_reflection_reduce') {
    const a = ids[0] ?? 'm0';
    const b = ids[1] ?? ids[0] ?? 'm0';
    return {
      ...base,
      result: {
        strengths: [{ claim: 'You reliably reached first when a stretch went quiet.', evidence_ids: [a] }],
        observation: {
          pattern: 'In the busier stretches, your messages came in quick runs.',
          reading_a: 'One reading is that the pace was asking for reassurance.',
          reading_b: 'Another is that it was simply a loud season on both ends.',
          evidence_ids: [a, b],
        },
        question_seed: 'What would it be like to say the feeling once, then let the quiet answer?',
      },
    };
  }

  // first_reflection_render — the blocks contract (P0-3): typed evidence-bearing blocks, not prose.
  const a = ids[0] ?? 'm0';
  const b = ids[1] ?? ids[0] ?? 'm0';
  return {
    ...base,
    result: {
      title: 'A first reading',
      blocks: [
        // Propositions only, each with its receipts. The bridge between these and the closing question
        // are the app's to write (docs/VOICE.md §6b) — a mock that emitted them would be rehearsing a
        // payload the real contract rejects.
        { kind: 'observation', text: 'When a day went quiet, it was often you who broke the silence.', evidence_ids: [a] },
        { kind: 'tentative_interpretation', text: 'In the busier weeks your messages came in quick runs.', evidence_ids: [a, b] },
      ],
    },
  };
}

async function drainMock(pending: PendingJob[], batchSize: number): Promise<DrainSummary> {
  const batch = pending.slice(0, batchSize);
  for (const pj of batch) {
    writeJsonAtomic(pj.resultPath, mockResult(pj.job));
  }
  const remaining = pending.length - batch.length;
  return {
    engine: 'mock',
    processed: batch.length,
    errored: 0,
    refused: 0,
    skippedLocal: 0,
    remaining,
    estimatedFurtherSittings: Math.ceil(remaining / batchSize),
  };
}

// ── ollama engine (bulk local L1) ───────────────────────────────────────────────
function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : s).trim();
}

/** Enforce the L1 schema's SOFT constraints in place so an otherwise-good window isn't rejected
 *  wholesale over a rail overshoot or an over-length string:
 *   - numeric rails: valence ∈ [-1,1], warmth/tension integer ∈ [0,3] (models emit -1.2, floats);
 *   - string caps: note ≤140, window.summary ≤300, note.claim ≤200 (Haiku writes longer summaries);
 *   - min-items: drop window notes with no evidence_ids (ingest would drop them anyway; pre-dropping
 *     avoids a hard Zod failure on the whole window).
 *  Clamping/truncating is the correct projection onto the valid range — it salvages the per-message
 *  scores instead of discarding the window. Non-L1 payloads pass through untouched. */
function clampL1(payload: unknown): unknown {
  const p = payload as { messages?: unknown; window?: any };
  if (!p || typeof p !== 'object') return payload;
  if (Array.isArray(p.messages)) {
    for (const m of p.messages as Array<Record<string, unknown>>) {
      if (typeof m?.valence === 'number') m.valence = Math.max(-1, Math.min(1, m.valence));
      if (typeof m?.warmth === 'number') m.warmth = Math.max(0, Math.min(3, Math.round(m.warmth)));
      if (typeof m?.tension === 'number') m.tension = Math.max(0, Math.min(3, Math.round(m.tension)));
      if (typeof m?.note === 'string' && m.note.length > 140) m.note = (m.note as string).slice(0, 140);
      if (Array.isArray(m?.tone_flags)) {
        m.tone_flags = (m.tone_flags as unknown[]).filter((f) => typeof f === 'string' && ALLOWED_TONE.has(f));
      }
    }
  }
  const w = p.window;
  if (w && typeof w === 'object') {
    if (typeof w.summary === 'string' && w.summary.length > 300) w.summary = w.summary.slice(0, 300);
    if (Array.isArray(w.notes)) {
      w.notes = w.notes.filter((n: any) => Array.isArray(n?.evidence_ids) && n.evidence_ids.length >= 1);
      for (const n of w.notes) if (typeof n?.claim === 'string' && n.claim.length > 200) n.claim = n.claim.slice(0, 200);
    }
  }
  return p;
}

export interface Evaluated { status: ResultFileStatus; payload?: unknown; error?: string }

/** Parse → (L1) clamp → self-validate against the embedded schema using the SAME Zod validator the
 *  app re-checks at ingest. Shared by the Ollama adapter and the Batch API adapter (batch.ts) so
 *  every engine normalizes results identically. status 'error' with an `error` string is retryable. */
export function evaluateResponse(job: JobFile, raw: string): Evaluated {
  let payload: unknown;
  try {
    payload = JSON.parse(stripFences(raw));
  } catch {
    return { status: 'error', error: 'response was not valid JSON' };
  }
  if (payload && typeof payload === 'object' && (payload as { refused?: unknown }).refused === true) {
    return { status: 'refused' };
  }
  if (job.lens === 'l1_emotion') payload = clampL1(payload);
  const check = validateLensResult(job.lens, payload);
  if (!check.ok) return { status: 'error', payload, error: check.error };
  return { status: 'done', payload: check.value };
}

async function askOllama(url: string, model: string, prompt: string, numCtx?: number): Promise<string> {
  const body: Record<string, unknown> = { model, prompt, stream: true, format: 'json' };
  // num_ctx must fit transcript + one JSON entry per message; the default (4096) truncates dense
  // windows so the model silently scores only ~30–70% of them. Set it generously.
  if (numCtx && numCtx > 0) body.options = { num_ctx: numCtx };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // stream:true so Ollama emits tokens as they generate. With stream:false the server sends NO
    // bytes until the whole generation finishes, which trips undici's ~300s headers/body timeout on
    // slow generations (a 14B model over a dense window) — the drain then mistakes a busy model for
    // an absent one and bails. Streaming keeps bytes flowing, so only a real failure throws.
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`ollama HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  const take = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    const obj = JSON.parse(t) as { response?: string; error?: string };
    if (obj.error) throw new Error(`ollama: ${obj.error}`);
    if (typeof obj.response === 'string') out += obj.response;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      take(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  take(buf); // trailing line without a final newline
  return out;
}

async function drainOllama(pending: PendingJob[], opts: DrainOptions): Promise<DrainSummary> {
  const batchSize = opts.batchSize ?? DRAIN_BATCH;
  const url = (opts.ollamaUrl ?? 'http://127.0.0.1:11434') + '/api/generate';
  const model = opts.ollamaModel ?? 'llama3.1';
  const numCtx = opts.ollamaNumCtx;
  const batch = pending.slice(0, batchSize);
  let processed = 0, errored = 0, refused = 0;

  for (const pj of batch) {
    const basePrompt =
      `${pj.job.instructions}\n\nOUTPUT SCHEMA:\n${JSON.stringify(pj.job.output_schema)}\n\n` +
      `RULES:\n- ${pj.job.rules.join('\n- ')}\n\nTRANSCRIPT:\n${pj.job.chunk.transcript}\n\nJSON:`;
    try {
      let evald = evaluateResponse(pj.job, await askOllama(url, model, basePrompt, numCtx));
      let retries = 0;
      // Engine contract (docs/SPECS/airlock.md §"Engine contract", step 3): on a schema mismatch,
      // retry ONCE with the validation error fed back, then accept the failure. Refusals are honest
      // and never retried. Clamping (above) already fixes bare rail overshoots without a round-trip.
      if (evald.status === 'error' && evald.error) {
        retries = 1;
        const correction =
          `\n\nYour previous JSON did not satisfy the schema: ${evald.error}. ` +
          `Return ONLY corrected JSON with EXACTLY this shape (no extra or renamed keys):\n` +
          `{"messages":[{"message_id":"m<id>","valence":<number -1..1>,"warmth":<int 0..3>,"tension":<int 0..3>}],` +
          `"window":{"summary":"<string>","notes":[{"claim":"<string>","evidence_ids":["m<id>"]}]}}\n` +
          `The top-level "window" object is REQUIRED and its summary must be nested inside it (not at the top ` +
          `level); every note needs both a "claim" string and a non-empty "evidence_ids" array; score every ` +
          `message in the transcript.`;
        evald = evaluateResponse(pj.job, await askOllama(url, model, basePrompt + correction, numCtx));
      }
      const status = evald.status;
      if (status === 'done') processed++;
      else if (status === 'refused') refused++;
      else errored++;
      const result: ResultFile = {
        job_id: pj.job.job_id,
        input_hash: pj.job.input_hash,
        status,
        validation: { schema_ok: status === 'done', retries },
        refusal: { detected: status === 'refused', reason: status === 'refused' ? 'model refused' : null },
        model_note: `ollama:${model}`,
        result: status === 'done' ? evald.payload : undefined,
      };
      writeJsonAtomic(pj.resultPath, result);
    } catch (e) {
      // Ollama absent / unreachable → graceful degradation: stop, leave remaining jobs pending (T2.11).
      return {
        engine: 'ollama',
        processed, errored, refused, skippedLocal: 0,
        remaining: pending.length - processed - errored - refused,
        estimatedFurtherSittings: Math.ceil((pending.length - processed) / batchSize),
      };
    }
  }
  const remaining = pending.length - batch.length;
  return {
    engine: 'ollama', processed, errored, refused, skippedLocal: 0,
    remaining, estimatedFurtherSittings: Math.ceil(remaining / batchSize),
  };
}

// ── claude engine (sandboxed /drain-jobs, P0-1) ───────────────────────────────
// The subscription drain runs an AGENTIC model over untrusted archive text, so it is contained: it
// runs in a staged temp dir with ONLY the pending job files (no DB, no archive, no repo, no home),
// MCP off, hooks off, and the toolset restricted to Read/Write/Glob. See airlock/drainSandbox.ts.
async function drainClaude(airlockDir: string, opts: DrainOptions): Promise<DrainSummary> {
  const before = new Set(listJobFiles(airlockPaths(airlockDir).resultsDir));
  // Dynamic import so `execa` (and the sandbox module) only load on this path — mock/ollama never do.
  const { drainSandbox } = await import('./drainSandbox');
  await drainSandbox(airlockDir);
  const after = listJobFiles(airlockPaths(airlockDir).resultsDir);
  const processed = after.filter((n) => !before.has(n)).length;
  const pendingAfter = pendingJobs(airlockDir).length;
  return {
    engine: 'claude', processed, errored: 0, refused: 0, skippedLocal: 0,
    remaining: pendingAfter,
    estimatedFurtherSittings: Math.ceil(pendingAfter / (opts.batchSize ?? DRAIN_BATCH)),
  };
}

/**
 * Drain pending jobs with the chosen engine. Writes results/*.json only; never touches the DB.
 * Returns a summary the CLI/route prints. Callers ingest results separately (awaited).
 */
export async function drain(opts: DrainOptions): Promise<DrainSummary> {
  ensureAirlock(opts.airlockDir);
  // The mock engine is test-only (P0-5). It can only run when the harness opts in via
  // BETWEEN_ALLOW_MOCK=1 — never in a packaged/production build, even via a direct call.
  if (opts.engine === 'mock' && process.env.BETWEEN_ALLOW_MOCK !== '1') {
    throw new Error('mock engine is disabled outside tests (set BETWEEN_ALLOW_MOCK=1 to enable)');
  }
  const batchSize = opts.batchSize ?? DRAIN_BATCH;
  if (opts.engine === 'claude') return drainClaude(opts.airlockDir, opts);
  let pending = pendingJobs(opts.airlockDir);
  // Tier guard: when asked, only read jobs of one engine_hint. The drain CLI sets this to
  // 'local' for Ollama so the local model does the grunt classification and never the
  // worthwhile reduce/render prose (that stays for Claude/Fable).
  if (opts.only) pending = pending.filter((pj) => pj.job.engine_hint === opts.only);
  if (opts.engine === 'ollama') return drainOllama(pending, opts);
  if (opts.engine === 'mock') return drainMock(pending, batchSize);
  // No silent fallback: an unhandled engine (e.g. 'batch', which is CLI-only via runBatch) throws
  // rather than quietly running the test mock (P0-5, defense in depth over the route-level gate).
  throw new Error(`drain: unsupported engine '${opts.engine}'`);
}
