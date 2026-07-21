// Between — the First Reflection (prompts/first-reflection.md, VOICE §4). Two airlock jobs then a
// freeze:
//   gate (planner-side, BEFORE any job) → reduce (L1 window JSON + T1 stats → grounded material)
//   → render (material + VOICE §7 render_spec with the §4 exemplar embedded) → post-validate
//   (every rendered sentence must map to a surviving, evidence-backed claim; an ID-less sentence is
//   REMOVED, invariant 1 / T2.7) → store frozen + dated in `reflections` (regeneration = new row).
//
// Gates (invariant 5): ≥150 substantive messages in range, and grief mode OFF. Below the floor →
// the VOICE §6 decline copy, no jobs. Grief-marked contact → suppressed.
import type { BetweenDB } from '../store/db';
import type { EngineName, ChunkRef } from '../airlock/types';
import { createAirlockStore } from '../airlock/store';
import { materializeCustomJob } from '../airlock/plan';
import { drain } from '../airlock/engine';
import { ingestResults, getValidatedResult } from '../airlock/ingestResults';
import { computeMetrics } from '../metrics/index';
import { composeBlocks } from './render';
import {
  FIRST_REFLECTION_EXEMPLAR, FIRST_REFLECTION_FOOTER, DECLINE_BELOW_FLOOR, DECLINE_NO_ENGINE, griefBanner,
} from '../airlock/voice';
import type { L1Result, FrReduceResult, FrRenderResult } from '../airlock/schemas';

export const EVIDENCE_FLOOR = 150;
/** The blocks contract (P0-3) is prompt_version 2 — legacy prose reflections stay at 1, untouched. */
const PROMPT_VERSION = 2;

export interface FirstReflectionParams {
  threadId: number;
  fromMs?: number | null;
  toMs?: number | null;
  airlockDir: string;
  engine?: EngineName;
}

export type GateResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'below_floor'; count: number }
  | { ok: false; reason: 'grief'; count: number; griefName: string };

export type ReflectionOutcome =
  | { status: 'declined'; reason: 'below_floor'; copy: string }
  | { status: 'declined'; reason: 'grief'; copy: string; griefName: string }
  | { status: 'declined'; reason: 'no_l1'; copy: string }
  | { status: 'declined'; reason: 'no_engine'; copy: string }
  | {
      status: 'created';
      reflectionId: number;
      title: string;
      contentMd: string;
      evidence: Record<string, string[]>;
      droppedSentences: number;
      generatedAt: string;
    };

function bindRange(fromMs: number | null, toMs: number | null): {
  clause: string; params: { threadId: number; fromMs: number | null; toMs: number | null };
} {
  const clauses = ['thread_id = @threadId', 'is_reaction = 0', "trim(coalesce(body_text,'')) != ''"];
  if (fromMs != null) clauses.push('sent_at_ms >= @fromMs');
  if (toMs != null) clauses.push('sent_at_ms <= @toMs');
  return { clause: clauses.join(' AND '), params: { threadId: 0, fromMs, toMs } };
}

/** Count substantive messages + check the grief gate. */
export function gateFirstReflection(
  db: BetweenDB,
  threadId: number,
  fromMs: number | null = null,
  toMs: number | null = null,
): GateResult {
  const { clause, params } = bindRange(fromMs, toMs);
  const count = (db.raw
    .prepare(`SELECT count(*) AS n FROM messages WHERE ${clause}`)
    .get({ ...params, threadId }) as { n: number }).n;

  const grief = db.raw
    .prepare(
      `SELECT c.display_name AS name FROM thread_participants tp
         JOIN contacts c ON c.id = tp.contact_id
        WHERE tp.thread_id = ? AND tp.role != 'owner' AND c.is_deceased = 1
        LIMIT 1`,
    )
    .get(threadId) as { name: string | null } | undefined;
  if (grief) return { ok: false, reason: 'grief', count, griefName: grief.name ?? 'them' };

  if (count < EVIDENCE_FLOOR) return { ok: false, reason: 'below_floor', count };
  return { ok: true, count };
}

/** All substantive message ids in range (member set for evidence resolution). */
function rangeMessageIds(
  db: BetweenDB, threadId: number, fromMs: number | null, toMs: number | null,
): number[] {
  const { clause, params } = bindRange(fromMs, toMs);
  const rows = db.raw
    .prepare(`SELECT id FROM messages WHERE ${clause} ORDER BY sent_at_ms ASC, id ASC`)
    .all({ ...params, threadId }) as { id: number }[];
  return rows.map((r) => r.id);
}

/**
 * Compose + freeze (invariant 1 / P0-3). The render returns evidence-bearing BLOCKS; the app composes
 * the body from the ones whose evidence resolves to real message rows — an unresolvable block is
 * dropped, never shown. The row is frozen + dated at prompt_version 2 (the blocks contract);
 * regeneration inserts a new row (never a mutation).
 */
export function finalizeReflection(
  db: BetweenDB,
  params: {
    threadId: number; fromMs: number | null; toMs: number | null;
    renderPayload: FrRenderResult; modelNote: string | null; promptVersion?: number;
  },
): { reflectionId: number; title: string; contentMd: string; evidence: Record<string, string[]>; droppedSentences: number; generatedAt: string } {
  const store = createAirlockStore(db);
  const ids = rangeMessageIds(db, params.threadId, params.fromMs, params.toMs);
  const valid = new Set(ids.map((id) => `m${id}`));

  const composed = composeBlocks(params.renderPayload?.blocks, valid);

  const generatedAt = new Date().toISOString();
  const dateStr = generatedAt.slice(0, 10);
  // Use the model's title only over a real body — never an evocative headline over an all-dropped reading.
  const title = composed.body.trim() ? (params.renderPayload?.title ?? 'A first reading') : 'A first reading';
  const contentMd = `# ${title}\n\n${composed.body}\n\n*${FIRST_REFLECTION_FOOTER}*\n*Generated ${dateStr}.*`;

  const reflectionId = store.insertReflection({
    threadId: params.threadId,
    lens: 'first_reflection',
    rangeStartMs: params.fromMs ?? 0,
    rangeEndMs: params.toMs ?? 0,
    contentMd,
    evidence: composed.evidence,
    promptVersion: params.promptVersion ?? PROMPT_VERSION,
    modelNote: params.modelNote,
    generatedAt,
  });

  return { reflectionId, title, contentMd, evidence: composed.evidence, droppedSentences: composed.dropped, generatedAt };
}

/**
 * The L1 windows that belong to a reflection's [fromMs, toMs] range. Own-spans TILE the thread
 * without overlap (plan.ts §buildWindows), so a window is in-range exactly when one of its OWN
 * messages (member_ids minus the overlap prefix) falls inside the range. Two consequences: a
 * boundary window that merely carries an in-range overlap *prefix* — its own content out of range —
 * is excluded, and every in-range message still maps to exactly one selected window. Bounds are
 * matched against sent_at_ms (not rowid), because real archives are not inserted in time order.
 * A null bound is open; both bounds null → the whole thread (all windows), the prior behavior.
 *
 * Without this scoping, a fully-drained thread's ~3k windows (~1.65M tokens) would all be pulled
 * into a single-shot reduce and blow the model context window (T2.10 range reflections).
 */
export function reduceWindowsInRange(
  db: BetweenDB,
  threadId: number,
  fromMs: number | null,
  toMs: number | null,
): { inputHash: string; result: unknown; chunk: ChunkRef }[] {
  const all = createAirlockStore(db).resultsForThreadLens(threadId, 'l1_emotion');
  if (fromMs == null && toMs == null) return all;
  const inRange = new Set(rangeMessageIds(db, threadId, fromMs, toMs));
  return all.filter((r) => {
    const prefix = new Set(r.chunk.overlap_prefix_ids);
    return r.chunk.member_ids.some((id) => !prefix.has(id) && inRange.has(id));
  });
}

/** Assemble the reduce material: validated L1 window outputs (JSON) + T1 summary stats. The windows
 *  are scoped to [fromMs, toMs] so a range reflection never pulls the whole (fully-drained) thread.
 *
 *  P1-9: the window `summary` is deliberately EXCLUDED. It is unreceipted free text (no evidence_ids),
 *  so feeding it to the reduce would let ungrounded model prose become the seed of a frozen reading.
 *  The reduce sees only evidence-bearing material: the per-message scores (each keyed to its own
 *  message_id, a receipt) and the window notes (which carry evidence_ids). Summaries may still be
 *  shown in the UI, clearly labelled as unreceipted context — they just never ground a synthesis. */
export function buildReduceMaterial(
  db: BetweenDB, threadId: number, fromMs: number | null, toMs: number | null,
): { material: string; windowCount: number } {
  const windows = reduceWindowsInRange(db, threadId, fromMs, toMs).map((r) => {
    const res = r.result as L1Result;
    const scores = Array.isArray(res.messages)
      ? res.messages.map((m) => ({ id: m.message_id, valence: m.valence, warmth: m.warmth, tension: m.tension }))
      : [];
    return { scores, notes: res.window?.notes ?? [] };
  });
  const stats = computeMetrics(db, threadId).summary;
  const material = JSON.stringify({ stats, windows }, null, 2);
  return { material, windowCount: windows.length };
}

function buildRenderMaterial(reduce: FrReduceResult): string {
  const renderSpec = {
    artifact: 'first_reflection',
    register: 'voice_v1',
    max_words: 250,
    gates: { power_balance_tripped: false, grief_mode: false },
    exemplar: FIRST_REFLECTION_EXEMPLAR,
    footer_required: 'one-reading + date',
  };
  return JSON.stringify({ material: reduce, render_spec: renderSpec }, null, 2);
}

/**
 * End-to-end orchestrator (used by the route + tests). Gates, then reduce → drain → render → drain
 * → finalize, using the given engine (mock in tests). Requires L1 results to already exist for the
 * range (run analyze:l1 + drain first). Returns a decline outcome when a gate closes.
 */
export async function runFirstReflection(
  db: BetweenDB,
  params: FirstReflectionParams,
): Promise<ReflectionOutcome> {
  const fromMs = params.fromMs ?? null;
  const toMs = params.toMs ?? null;
  const engine: EngineName = params.engine ?? 'mock';
  const airlockDir = params.airlockDir;

  const gate = gateFirstReflection(db, params.threadId, fromMs, toMs);
  if (!gate.ok) {
    if (gate.reason === 'grief') {
      return { status: 'declined', reason: 'grief', copy: griefBanner(gate.griefName), griefName: gate.griefName };
    }
    return { status: 'declined', reason: 'below_floor', copy: DECLINE_BELOW_FLOOR };
  }

  const memberIds = rangeMessageIds(db, params.threadId, fromMs, toMs);

  // ── reduce ──
  const { material, windowCount } = buildReduceMaterial(db, params.threadId, fromMs, toMs);
  if (windowCount === 0) {
    return { status: 'declined', reason: 'no_l1', copy: DECLINE_BELOW_FLOOR };
  }
  const reduceJob = materializeCustomJob(db, {
    lens: 'first_reflection_reduce', threadId: params.threadId, transcript: material, memberIds, airlockDir,
  });
  // The flow is drain → ingest → read the CLEANED, validated payload from the DB (P0-2). Raw result
  // files are transport only; they never feed synthesis. A payload that failed Zod at ingest, dropped
  // its evidence below the schema floor (P1-8), or was refused leaves no `done` result — so
  // getValidatedResult declines rather than freezing an ungrounded reading.
  if (!reduceJob.cached) {
    await drain({ airlockDir, engine });
    ingestResults(db, { airlockDir });
  }
  const reduceValidated = getValidatedResult(db, reduceJob.inputHash, 'first_reflection_reduce');
  // A declined read after the drain means the writing engine produced nothing usable (no key/
  // subscription/local model, a refusal, or a schema-invalid result) — NOT that the relationship
  // lacks evidence. Say the true thing.
  if (!reduceValidated.ok) return { status: 'declined', reason: 'no_engine', copy: DECLINE_NO_ENGINE };
  const reducePayload = reduceValidated.payload as FrReduceResult;

  // ── render ──
  const renderMaterial = buildRenderMaterial(reducePayload);
  const renderJob = materializeCustomJob(db, {
    lens: 'first_reflection_render', threadId: params.threadId, transcript: renderMaterial, memberIds, airlockDir,
  });
  if (!renderJob.cached) {
    await drain({ airlockDir, engine });
    ingestResults(db, { airlockDir });
  }
  const renderValidated = getValidatedResult(db, renderJob.inputHash, 'first_reflection_render');
  if (!renderValidated.ok) return { status: 'declined', reason: 'no_engine', copy: DECLINE_NO_ENGINE };
  const renderPayload = renderValidated.payload as FrRenderResult;
  const modelNote = renderValidated.modelNote ?? `${engine} engine`;

  // ── post-validate + freeze ──
  const finalized = finalizeReflection(db, {
    threadId: params.threadId, fromMs, toMs, renderPayload, modelNote,
  });
  return {
    status: 'created',
    reflectionId: finalized.reflectionId,
    title: finalized.title,
    contentMd: finalized.contentMd,
    evidence: finalized.evidence,
    droppedSentences: finalized.droppedSentences,
    generatedAt: finalized.generatedAt,
  };
}
