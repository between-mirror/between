// Between — Zod schemas at the LLM boundary (HANDOFF: "Zod at every LLM boundary"). These are the
// belt over the engine's braces (docs/SPECS/airlock.md §"App-side ingest"): even though the engine
// self-validates against the embedded JSON Schema, the app re-validates every result before it is
// allowed near the DB. A result that is valid-but-schema-violating (wrong enum, missing
// evidence_ids) is rejected here (TEST T2.4).
import { z } from 'zod';
import type { LensId } from './types';

// ── L1 emotion result ─────────────────────────────────────────────────────────
/** The closed tone-flag vocabulary. Exported so engines can drop off-list flags (models routinely
 *  invent richer words like "hostile"/"caring") before validation instead of failing the window. */
export const TONE_FLAGS = [
  'sarcasm', 'passive_aggressive', 'contempt', 'anxious', 'defensive',
  'playful', 'affectionate', 'apologetic', 'withdrawn', 'pressuring',
] as const;
const toneFlag = z.enum(TONE_FLAGS);

export const l1MessageSchema = z.object({
  message_id: z.string().regex(/^m[0-9]+$/),
  valence: z.number().min(-1).max(1),
  warmth: z.number().int().min(0).max(3),
  tension: z.number().int().min(0).max(3),
  tone_flags: z.array(toneFlag).optional(),
  note: z.string().max(140).optional(),
});

export const l1WindowNoteSchema = z.object({
  claim: z.string().max(200),
  evidence_ids: z.array(z.string()).min(1),
  confidence: z.enum(['surer', 'less_sure']).optional(),
});

export const l1ResultSchema = z.object({
  messages: z.array(l1MessageSchema),
  window: z.object({
    summary: z.string().max(300),
    notes: z.array(l1WindowNoteSchema),
    worth_deeper_look: z.boolean().optional(),
  }),
});
export type L1Result = z.infer<typeof l1ResultSchema>;

// ── First Reflection reduce result ────────────────────────────────────────────
export const frReduceResultSchema = z.object({
  strengths: z
    .array(z.object({ claim: z.string(), evidence_ids: z.array(z.string()).min(1) }))
    .min(1)
    .max(2),
  observation: z.object({
    pattern: z.string(),
    reading_a: z.string(),
    reading_b: z.string(),
    evidence_ids: z.array(z.string()).min(2),
  }),
  question_seed: z.string(),
});
export type FrReduceResult = z.infer<typeof frReduceResultSchema>;

// ── Evidence-bearing blocks — the render contract (P0-3, tightened for receipts absolutism) ────
// The model no longer returns free prose. It returns typed BLOCKS, and the app composes body_md from
// the ones that survive evidence resolution. So no rendered sentence can exist without its receipts in
// the same object.
//
// Since v0.3.0 the model may emit ONLY the evidence-bearing kinds. Bridges and the closing question
// carry no evidence *by design*, which made them the one sentence per reading that escaped the
// evidence chain — so the app now composes them itself from the authored template sets in
// docs/VOICE.md §6b (see lenses/voiceTemplates.ts). A payload containing one is rejected whole.
//
//   observation | tentative_interpretation — a claim; REQUIRES ≥1 evidence id (schema-enforced), and
//     at finalize each id must RESOLVE to a real message or the whole block is dropped.
/** What an engine is allowed to author. Both kinds are propositions, so both require receipts. */
export const MODEL_BLOCK_KINDS = ['observation', 'tentative_interpretation'] as const;
/** What the app composes for itself — connective tissue only; never accepted from an engine. */
export const APP_BLOCK_KINDS = ['bridge', 'question'] as const;
/** The full internal vocabulary of a composed reading. */
export const BLOCK_KINDS = [...MODEL_BLOCK_KINDS, ...APP_BLOCK_KINDS] as const;
export type ModelBlockKind = (typeof MODEL_BLOCK_KINDS)[number];
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const renderBlockSchema = z.object({
  text: z.string().min(1).max(400),
  kind: z.enum(MODEL_BLOCK_KINDS),
  // Absolute: no emittable kind exists that may arrive without a receipt.
  evidence_ids: z.array(z.string()).min(1),
});
/** A block as an engine may hand it over: always a proposition, always with receipts. */
export type ModelRenderBlock = z.infer<typeof renderBlockSchema>;
/** A block in a composed reading — model propositions plus the app's own connective tissue. */
export interface RenderBlock {
  text: string;
  kind: BlockKind;
  evidence_ids: string[];
}

export const blocksResultSchema = z.object({
  // The title is a short LABEL, not evidence-bearing prose. It bypasses composeBlocks, so it is capped
  // here to bound the blast radius of a misbehaving engine (an unreceipted title can never be a
  // paragraph); finalizers additionally refuse to render a model title over an empty (all-dropped) body.
  title: z.string().max(120).optional(),
  blocks: z.array(renderBlockSchema),
});
export type BlocksResult = z.infer<typeof blocksResultSchema>;

// ── First Reflection render result — now the blocks contract ──────────────────
export const frRenderResultSchema = blocksResultSchema;
export type FrRenderResult = BlocksResult;

// ── L4 abuse-pattern result (per episode) ─────────────────────────────────────
/** Behavioural pattern vocabulary — the words, never a diagnosis (VOICE ban list). coercive_demand,
 *  threat, monitoring are the "coercive markers" the power-balance gate weighs. */
export const L4_PATTERN_KINDS = [
  'contempt', 'humiliation', 'coercive_demand', 'threat', 'monitoring', 'stonewalling',
  'gaslighting_denial', 'reactive_escalation', 'self_defense', 'repair_attempt', 'apology',
] as const;

export const l4PatternSchema = z.object({
  side: z.enum(['me', 'them']),
  kind: z.enum(L4_PATTERN_KINDS),
  evidence_ids: z.array(z.string()).min(1),
  severity: z.number().int().min(1).max(3),
  // an apparently hostile line that is actually apology/withdrawal-then-repair (the calibrated FP mode)
  repair_context: z.boolean().optional(),
});

export const l4ResultSchema = z.object({ patterns: z.array(l4PatternSchema) });
export type L4Result = z.infer<typeof l4ResultSchema>;

// ── Ask-anything synthesis result — the same blocks contract ──────────────────
export const askAnswerResultSchema = blocksResultSchema;
export type AskAnswerResult = BlocksResult;

// ── Generic render result (episode note / era summary / growth note / other-side / letter) ──
// The blocks contract: the model returns typed evidence-bearing blocks, the app composes the prose
// from the survivors. No sentence exists without its receipts in the same object (invariant 1 / P0-3).
export const renderResultSchema = blocksResultSchema;
export type RenderResult = BlocksResult;

// ── envelope (the result FILE) ────────────────────────────────────────────────
export const resultEnvelopeSchema = z.object({
  job_id: z.string(),
  input_hash: z.string(),
  status: z.enum(['done', 'error', 'refused']),
  validation: z.object({ schema_ok: z.boolean(), retries: z.number() }).nullish(),
  refusal: z.object({ detected: z.boolean(), reason: z.string().nullable() }).nullish(),
  model_note: z.string().nullish(),
  result: z.unknown().optional(),
  samples: z.array(z.unknown()).optional(),
});
export type ResultEnvelope = z.infer<typeof resultEnvelopeSchema>;

/** Registry: which payload schema validates each lens. */
export const LENS_RESULT_SCHEMAS: Record<LensId, z.ZodTypeAny> = {
  l1_emotion: l1ResultSchema,
  first_reflection_reduce: frReduceResultSchema,
  first_reflection_render: frRenderResultSchema,
  l4_episode_patterns: l4ResultSchema,
  ask_answer: askAnswerResultSchema,
  episode_note: renderResultSchema,
  era_summary: renderResultSchema,
  growth_note: renderResultSchema,
  herside_reading: renderResultSchema,
  letter: renderResultSchema,
};

export function validateLensResult(
  lens: LensId,
  payload: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = LENS_RESULT_SCHEMAS[lens];
  if (!schema) return { ok: false, error: `unknown lens: ${lens}` };
  const parsed = schema.safeParse(payload);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}
