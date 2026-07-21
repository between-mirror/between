// Between — Batch API adapter: an ALTERNATIVE grunt engine for L1.
//
// Submits pending L1 job files to Anthropic's Message Batches API (Haiku by default), polls to
// completion, and writes results/<id>.json in the SAME shape the app ingests — so a batch run is
// interchangeable with an Ollama drain at the airlock contract. It reuses `evaluateResponse` from
// the Ollama engine, so every engine normalizes results identically (parse → clamp → Zod-validate).
//
// Engine-tier note (docs/DEPLOY.md): this processes the 'local'-hint L1 grunt via the PAID API
// instead of the local model — a deliberate, opt-in re-tier that spends money to trade weeks of local
// compute for ~1 hour. The worthwhile reduce/render ('claude'/'render') are NEVER submitted here.
// Privacy note: this sends the window transcripts (message text) to the Anthropic API — the same
// disclosed posture as the reflection tier, but at archive scale. Media is never sent. Store-free:
// writes result files only; the app ingests separately (sole-writer, T2.8).
import { readdirSync } from 'node:fs';
import { evaluateResponse } from './engine';
import { airlockPaths, listJobFiles, readJson, writeJsonAtomic, existsSync, join } from './paths';
import type { JobFile, ResultFile } from './types';
import type { BetweenDB } from '../store/db';
import { recordUsage } from '../lenses/tokenPriors';
import { rateFor } from '../pricing';

/** L1 classification is grunt work — the cheap, fast tier, never Opus/Fable. */
export const DEFAULT_BATCH_MODEL = 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 8192; // avg L1 output ≈ 3.7k; headroom for dense windows. Only actual output bills.
const BATCH_DISCOUNT = 0.5; // the Anthropic Batch API is 50% off. Per-model rates live in ../pricing (dated).

export interface BatchEstimate {
  model: string;
  count: number;
  inTokens: number;
  outTokens: number;
  costStandardUsd: number;
  costBatchUsd: number;
}

/** Rough token/cost estimate straight from the materialized job files — chars/4 for input, ~50 tok
 *  per scored message + ~400 per window for output. Good to ±20% for a go/no-go cost decision. */
export function estimateBatch(jobs: JobFile[], model = DEFAULT_BATCH_MODEL): BatchEstimate {
  let inChars = 0;
  let msgs = 0;
  for (const j of jobs) {
    const t = j.chunk.transcript ?? '';
    inChars += t.length + JSON.stringify(j.output_schema).length + (j.instructions ?? '').length + (j.rules ?? []).join('').length;
    msgs += (t.match(/\[m\d+\]/g) ?? []).length;
  }
  const inTokens = Math.round(inChars / 4);
  const outTokens = Math.round(msgs * 50 + jobs.length * 400);
  const rate = rateFor(model);
  const std = (inTokens / 1e6) * rate.input + (outTokens / 1e6) * rate.output;
  return { model, count: jobs.length, inTokens, outTokens, costStandardUsd: std, costBatchUsd: std * BATCH_DISCOUNT };
}

/** Pending jobs (a job file with no result yet), optionally filtered to one engine_hint tier. */
export function pendingBatchJobs(airlockDir: string, only?: string): JobFile[] {
  const p = airlockPaths(airlockDir);
  const out: JobFile[] = [];
  for (const name of listJobFiles(p.jobsDir)) {
    if (existsSync(join(p.resultsDir, name))) continue;
    try {
      const job = readJson<JobFile>(join(p.jobsDir, name));
      if (only && job.engine_hint !== only) continue;
      out.push(job);
    } catch { /* skip unreadable job file */ }
  }
  return out;
}

/** One Batch API request line for a job. custom_id = job_id (fits the ^[a-zA-Z0-9_-]{1,64}$ rule). */
export function buildBatchRequest(job: JobFile, model = DEFAULT_BATCH_MODEL, maxTokens = MAX_OUTPUT_TOKENS) {
  const system =
    `${job.instructions}\n\nOUTPUT SCHEMA:\n${JSON.stringify(job.output_schema)}\n\n` +
    `RULES:\n- ${job.rules.join('\n- ')}`;
  return {
    custom_id: job.job_id,
    params: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [
        {
          role: 'user' as const,
          content: `TRANSCRIPT:\n${job.chunk.transcript}\n\nReturn ONLY the JSON described by OUTPUT SCHEMA — no prose, no fences.`,
        },
      ],
    },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function makeClient(): Promise<any> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. The Batch engine bills the Anthropic API (not your Claude ' +
        'subscription) — set a Console API key: $env:ANTHROPIC_API_KEY="sk-ant-…"',
    );
  }
  // Dynamic import so the SDK only loads on this path — mock/ollama drains and tests never need it.
  const mod: any = await import('@anthropic-ai/sdk');
  const Anthropic = mod.default ?? mod;
  return new Anthropic();
}

export interface SubmitResult { batchId: string; count: number }

/** Create ONE Message Batch from the pending jobs. Returns the batch id — persist it to collect. */
export async function submitBatch(jobs: JobFile[], model = DEFAULT_BATCH_MODEL): Promise<SubmitResult> {
  const client = await makeClient();
  const requests = jobs.map((j) => buildBatchRequest(j, model));
  const batch = await client.messages.batches.create({ requests });
  return { batchId: batch.id, count: requests.length };
}

export interface CollectSummary { batchId: string; done: number; errored: number; refused: number; written: number }

/** Poll a batch to completion, then map each result back to its job and write results/<id>.json in
 *  the ingestable ResultFile shape. Resumable: reads the still-pending job files to rebuild the
 *  custom_id → job map, so a killed poll can be resumed with the same batchId. */
export async function collectBatch(
  batchId: string,
  airlockDir: string,
  model = DEFAULT_BATCH_MODEL,
  opts: { pollMs?: number; onStatus?: (status: string, counts?: unknown) => void; db?: BetweenDB } = {},
): Promise<CollectSummary> {
  const client = await makeClient();
  const pollMs = opts.pollMs ?? 30000;
  const p = airlockPaths(airlockDir);

  // Map custom_id (job_id) → job for result normalization + input_hash. Include archived jobs so a
  // re-collect (after a prior collect already ingested + archived the pairs) still resolves them.
  const jobs = new Map<string, JobFile>();
  for (const name of listJobFiles(p.jobsDir)) {
    try { const j = readJson<JobFile>(join(p.jobsDir, name)); jobs.set(j.job_id, j); } catch { /* skip */ }
  }
  try {
    for (const f of readdirSync(p.archiveDir)) {
      if (!f.endsWith('.job.json')) continue;
      try { const j = readJson<JobFile>(join(p.archiveDir, f)); jobs.set(j.job_id, j); } catch { /* skip */ }
    }
  } catch { /* no archive dir yet */ }

  for (;;) {
    const b = await client.messages.batches.retrieve(batchId);
    opts.onStatus?.(b.processing_status, b.request_counts);
    if (b.processing_status === 'ended') break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  const sum: CollectSummary = { batchId, done: 0, errored: 0, refused: 0, written: 0 };
  for await (const entry of await client.messages.batches.results(batchId)) {
    const jobId: string = entry.custom_id;
    const job = jobs.get(jobId);
    if (!job) continue; // unknown / already collected

    let result: ResultFile;
    if (entry.result?.type === 'succeeded') {
      const content: any[] = entry.result.message?.content ?? [];
      const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('');
      // Feed the tokens the API actually billed back into the cost priors (self-improving estimate).
      // Best-effort: skip if no db handle in scope or usage is absent — never break the collect flow.
      const usage = entry.result.message?.usage;
      if (opts.db && usage) recordUsage(opts.db, job.lens, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      const evald = evaluateResponse(job, text);
      if (evald.status === 'done') sum.done++;
      else if (evald.status === 'refused') sum.refused++;
      else sum.errored++;
      result = {
        job_id: job.job_id,
        input_hash: job.input_hash,
        status: evald.status,
        validation: { schema_ok: evald.status === 'done', retries: 0 },
        refusal: { detected: evald.status === 'refused', reason: evald.status === 'refused' ? 'model refused' : null },
        model_note: `batch:${model}`,
        result: evald.status === 'done' ? evald.payload : undefined,
      };
    } else {
      sum.errored++;
      const reason = entry.result?.type === 'errored'
        ? (entry.result.error?.error?.type ?? entry.result.error?.type ?? 'errored')
        : (entry.result?.type ?? 'unknown');
      result = {
        job_id: job.job_id,
        input_hash: job.input_hash,
        status: 'error',
        validation: { schema_ok: false, retries: 0 },
        refusal: { detected: false, reason: null },
        model_note: `batch:${reason}`,
      };
    }
    writeJsonAtomic(join(p.resultsDir, `${jobId}.json`), result);
    sum.written++;
  }
  return sum;
}
