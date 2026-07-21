// Between — render finalize + block composition, shared by every prose lens (episode note, era
// summary, growth note, other-side, letter, findings reading). Under the P0-3 contract the model no
// longer returns free prose: it returns typed evidence-bearing BLOCKS, and the app composes body_md
// from the ones that survive evidence resolution. A block whose evidence doesn't resolve is dropped,
// so no rendered sentence can exist without its receipts (invariant 1). postValidateProse is retired.
import type { BetweenDB } from '../store/db';
import type { BlocksResult, RenderBlock, ModelRenderBlock } from '../airlock/schemas';
import { BRIDGES, CLOSING_QUESTIONS, pickTemplate } from './voiceTemplates';
import { getEpisodeById, setEpisodeNarrative } from './episodes';
import { episodeTranscript } from './abuse';
import { setEraNameSummary, type Era } from './eras';
import { getGrowth } from './growth';
import { materializeCustomJob } from '../airlock/plan';
import { experimentalLensesEnabled, EXPERIMENTAL_DECLINE } from './experimental';

/** Which connective tissue this artifact takes. VOICE's forms differ: the First Reflection (§4) and
 *  the letter (§5) close on a question; an episode note (§4b, ≤90 words) and an era summary (§4c,
 *  ≤120 words) are single-paragraph forms whose own exemplars do neither. Applying one rule to all of
 *  them would have been a register regression dressed as consistency. */
export interface ComposeOptions {
  /** Insert up to two bridges between surviving observations. Default true. */
  bridges?: boolean;
  /** Close on exactly one template question. Default true. */
  closingQuestion?: boolean;
}

/** VOICE's short forms: an episode note (§4b) and an era summary (§4c) are one paragraph each, and
 *  their exemplars carry neither a bridge nor a closing question. */
const SHORT_FORM: ComposeOptions = { bridges: false, closingQuestion: false };

export interface ComposedBlocks {
  /** The prose the app assembled from the surviving blocks (paragraph per block). */
  body: string;
  /** Surviving evidence blocks → their resolving receipt ids (frozen as evidence_json). */
  evidence: Record<string, string[]>;
  /** How many blocks were dropped (unresolvable evidence, over-cap, or orphaned bridge). */
  dropped: number;
  /** The blocks that survived, with evidence_ids narrowed to the resolving ones. */
  blocks: RenderBlock[];
}

/** Valid receipt ids ('m<id>') for a thread's messages within [fromMs, toMs]. */
export function validReceiptSet(db: BetweenDB, threadId: number, fromMs: number, toMs: number): Set<string> {
  const rows = db.raw
    .prepare('SELECT id FROM messages WHERE thread_id = ? AND is_reaction = 0 AND sent_at_ms >= ? AND sent_at_ms <= ?')
    .all(threadId, fromMs, toMs) as { id: number }[];
  return new Set(rows.map((r) => `m${r.id}`));
}

/**
 * Compose prose from evidence-bearing blocks (P0-3, tightened for receipts absolutism). The single
 * enforcement point for every render lens.
 *
 * The model's half — propositions only, each standing or falling on its receipts:
 *  - observation / tentative_interpretation: kept only if ≥1 evidence id RESOLVES to a real message;
 *    otherwise the whole block is dropped (an ID-less or fabricated-receipt claim does not exist).
 *  - anything else arriving from the engine is dropped on sight. The schema already rejects such a
 *    payload whole (schemas.ts), so this is the belt to that brace: a stale cached result from before
 *    the contract tightened, or an engine that ignores it, must not reach prose through the composer.
 *
 * The app's half — connective tissue, authored from docs/VOICE.md §6b and incapable of carrying a
 * fact. Composed *after* the drop pass, over the survivors only:
 *  - up to 2 bridges, placed between surviving observations (never adjacent to a dropped one — with
 *    insertion happening after the drop pass, the old orphaned-bridge rule is now structurally
 *    impossible rather than merely enforced);
 *  - exactly one closing question (VOICE §2 rule 4), and only when something survived to close.
 *
 * Selection is keyed on a hash of the surviving text: no RNG, so a reading regenerated from the same
 * evidence composes the same prose.
 */
export function composeBlocks(
  blocks: ModelRenderBlock[] | RenderBlock[] | undefined,
  validIds: Set<string>,
  opts: ComposeOptions = {},
): ComposedBlocks {
  const wantBridges = opts.bridges ?? true;
  const wantClosing = opts.closingQuestion ?? true;
  const incoming = (blocks ?? []) as RenderBlock[];

  const kept: RenderBlock[] = [];
  const evidence: Record<string, string[]> = {};
  let dropped = 0;

  for (const b of incoming) {
    if (b.kind !== 'observation' && b.kind !== 'tentative_interpretation') {
      dropped++;                       // connective tissue is not the engine's to write
      continue;
    }
    const ids = (b.evidence_ids ?? []).filter((id) => validIds.has(id));
    if (ids.length === 0) { dropped++; continue; }
    kept.push({ ...b, evidence_ids: ids });
    evidence[b.text] = ids;
  }

  // Nothing survived: there is nothing to bridge and nothing to ask about. A closing question over an
  // empty reading would be prose with no reading underneath it.
  if (kept.length === 0) return { body: '', evidence: {}, dropped, blocks: [] };

  // The hash key is the surviving evidence prose — the reading's own content, and nothing else.
  const key = kept.map((b) => b.text.trim()).join('\n');

  // Bridges between survivors: one after the first, a second after the third if the piece is long
  // enough to have earned it. Cap 2, per VOICE.
  const bridgeAfter = new Map<number, string>();
  if (wantBridges && kept.length >= 2) bridgeAfter.set(0, pickTemplate(BRIDGES, key, 0));
  if (wantBridges && kept.length >= 4) bridgeAfter.set(2, pickTemplate(BRIDGES, key, 1));

  const composed: RenderBlock[] = [];
  kept.forEach((b, i) => {
    composed.push(b);
    const bridge = bridgeAfter.get(i);
    if (bridge) composed.push({ text: bridge, kind: 'bridge', evidence_ids: [] });
  });
  if (wantClosing) composed.push({ text: pickTemplate(CLOSING_QUESTIONS, key), kind: 'question', evidence_ids: [] });

  const body = composed.map((b) => b.text.trim()).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { body, evidence, dropped, blocks: composed };
}

/** A headline over real content only: the model's title is used only when the composed body is
 *  non-empty, so an evocative/accusatory title can never render as a standalone headline over an
 *  all-dropped (evidence-free) reading. Otherwise the neutral fallback. */
export function headline(title: string | undefined, fallback: string, body: string): string {
  return body.trim() && title ? title : fallback;
}

export interface FinalizedNote { episodeId: number; dropped: number; evidence: Record<string, string[]> }

/** Post-validate a rendered episode note against its own messages and store it in narrative_json. */
export function finalizeEpisodeNote(db: BetweenDB, episodeId: number, render: BlocksResult): FinalizedNote {
  const e = getEpisodeById(db, episodeId);
  if (!e) throw new Error(`episode ${episodeId} not found`);
  const valid = validReceiptSet(db, e.threadId, e.startMs, e.endMs);
  const { body, evidence, dropped } = composeBlocks(render.blocks, valid, SHORT_FORM);
  setEpisodeNarrative(db, episodeId, { title: body.trim() ? (render.title ?? null) : null, note: body, evidence });
  return { episodeId, dropped, evidence };
}

/** Materialize the episode_note render job (for the worthwhile-tier drain). Returns the job id. */
export function materializeEpisodeNoteJob(db: BetweenDB, episodeId: number, airlockDir: string): string {
  const e = getEpisodeById(db, episodeId);
  if (!e) throw new Error(`episode ${episodeId} not found`);
  const { transcript, memberIds } = episodeTranscript(db, e);
  const { jobId } = materializeCustomJob(db, { lens: 'episode_note', threadId: e.threadId, transcript, memberIds, airlockDir });
  return jobId;
}

/** Freeze a rendered prose lens as an immutable reflections row (letter / other-side / growth note). */
export function freezeReflection(
  db: BetweenDB, threadId: number, lens: string, contentMd: string,
  evidence: Record<string, string[]>, rangeStartMs: number, rangeEndMs: number, modelNote: string, generatedAt: string,
): number {
  const info = db.raw
    .prepare(`INSERT INTO reflections (thread_id, lens, range_start_ms, range_end_ms, content_md, evidence_json, prompt_version, model_note, generated_at)
              VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)`)
    .run(threadId, lens, rangeStartMs, rangeEndMs, contentMd, JSON.stringify(evidence), modelNote, generatedAt);
  return Number(info.lastInsertRowid);
}

// ── era summary ───────────────────────────────────────────────────────────────
export function materializeEraSummaryJob(db: BetweenDB, threadId: number, era: Era, airlockDir: string): string {
  const transcript = JSON.stringify({ span: { startMs: era.startMs, endMs: era.endMs }, months: era.months, stats: era.stats });
  const { jobId } = materializeCustomJob(db, { lens: 'era_summary', threadId, transcript, memberIds: [], airlockDir });
  return jobId;
}

/** Post-validate an era summary against its own messages, then store the name + summary on the era. */
export function finalizeEraSummary(db: BetweenDB, threadId: number, era: Era, render: BlocksResult): { dropped: number } {
  const valid = validReceiptSet(db, threadId, era.startMs, era.endMs);
  const { body, dropped } = composeBlocks(render.blocks, valid, SHORT_FORM);
  setEraNameSummary(db, threadId, era.startMs, headline(render.title, '', body), body);
  return { dropped };
}

// ── growth note ───────────────────────────────────────────────────────────────
export function materializeGrowthNoteJob(db: BetweenDB, threadId: number, airlockDir: string): string {
  const transcript = JSON.stringify({ quarters: getGrowth(db, threadId) });
  const { jobId } = materializeCustomJob(db, { lens: 'growth_note', threadId, transcript, memberIds: [], airlockDir });
  return jobId;
}

const WHOLE = validReceiptSet;
export function finalizeGrowthNote(db: BetweenDB, threadId: number, render: BlocksResult, generatedAt: string): number {
  const valid = WHOLE(db, threadId, 0, Number.MAX_SAFE_INTEGER);
  const { body, evidence } = composeBlocks(render.blocks, valid);
  const md = `# ${headline(render.title, 'Your own line', body)}\n\n${body}\n`;
  return freezeReflection(db, threadId, 'growth_note', md, evidence, 0, 0, 'fable growth_note', generatedAt);
}

// ── letter (S4) ───────────────────────────────────────────────────────────────
export function finalizeLetter(db: BetweenDB, threadId: number, render: BlocksResult, receiptIds: number[], span: { startMs: number; endMs: number }, generatedAt: string): number {
  const valid = new Set(receiptIds.map((id) => `m${id}`));
  const { body, evidence } = composeBlocks(render.blocks, valid);
  const md = `# ${headline(render.title, 'A long look', body)}\n\n${body}\n`;
  return freezeReflection(db, threadId, 'letter', md, evidence, span.startMs, span.endMs, 'fable letter', generatedAt);
}

// ── findings reading (the A–E capstone) ───────────────────────────────────────
// Same receipt-scoped composition as the letter: only the curated ledger receipts resolve, so a
// block that cites an unbanked message is dropped rather than shown. Frozen as its own reflection
// lens so it sits beside the letter without touching it.
export function finalizeFindingsReading(db: BetweenDB, threadId: number, render: BlocksResult, receiptIds: number[], span: { startMs: number; endMs: number }, generatedAt: string): { reflectionId: number; dropped: number } {
  // EXPERIMENTAL GATE (P1-11): the findings READING is the interpretive layer. Off by default → freeze
  // an honest decline instead of a directional reading. (The deterministic A–E counts stay available.)
  if (!experimentalLensesEnabled(db)) {
    const md = `# The findings\n\n${EXPERIMENTAL_DECLINE}\n`;
    const reflectionId = freezeReflection(db, threadId, 'findings_reading', md, {}, span.startMs, span.endMs, 'experimental_off', generatedAt);
    return { reflectionId, dropped: 0 };
  }
  const valid = new Set(receiptIds.map((id) => `m${id}`));
  const { body, evidence, dropped } = composeBlocks(render.blocks, valid);
  const md = `# ${headline(render.title, 'The findings', body)}\n\n${body}\n`;
  const reflectionId = freezeReflection(db, threadId, 'findings_reading', md, evidence, span.startMs, span.endMs, 'fable findings_reading', generatedAt);
  return { reflectionId, dropped };
}
