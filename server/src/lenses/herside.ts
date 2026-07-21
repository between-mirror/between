// Between — L8 "the weather from the other side": one careful reading of THEM's patterns, offered so
// the owner understands what they were living with — NOT a diagnosis. Opus assembles the material from
// the OTHER-side-initiated episodes (their notes + stats) + eras; the render (Fable) gives two readings
// for anything interpretive, never asserts motive, uses no diagnosis nouns, and carries receipts. The
// finalized reading is frozen as a reflections row (lens='herside_reading').
import type { BetweenDB } from '../store/db';
import type { BlocksResult } from '../airlock/schemas';
import { getEpisodes, type EpisodeRow } from './episodes';
import { getEras } from './eras';
import { materializeCustomJob } from '../airlock/plan';
import { composeBlocks, freezeReflection } from './render';
import { experimentalLensesEnabled, EXPERIMENTAL_DECLINE } from './experimental';

export interface HersideMaterial {
  threadId: number;
  span: { startMs: number; endMs: number };
  themInitiated: { startMs: number; severeThem: number; hostileThem: number; kidNamed: boolean; note: string | null }[];
  eras: { name: string | null; summary: string | null; startMs: number }[];
  receiptIds: number[];
}

function episodeMemberIds(db: BetweenDB, e: EpisodeRow): number[] {
  return (db.raw
    .prepare("SELECT id FROM messages WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != '' AND sent_at_ms >= ? AND sent_at_ms <= ?")
    .all(e.threadId, e.startMs, e.endMs) as { id: number }[]).map((r) => r.id);
}

export function buildHersideMaterial(db: BetweenDB, threadId: number): HersideMaterial {
  const eps = getEpisodes(db, threadId);
  const themInit = eps.filter((e) => e.initiator === 'them').sort((a, b) => b.severeThem - a.severeThem).slice(0, 12);
  const receiptIds = [...new Set(themInit.flatMap((e) => episodeMemberIds(db, e)))].sort((a, b) => a - b);
  const all = eps.length ? { startMs: eps[0].startMs, endMs: eps[eps.length - 1].endMs } : { startMs: 0, endMs: 0 };
  return {
    threadId, span: all,
    themInitiated: themInit.map((e) => ({
      startMs: e.startMs, severeThem: e.severeThem, hostileThem: e.hostileThem, kidNamed: e.kidNamed,
      note: e.narrative && typeof e.narrative === 'object' ? ((e.narrative as { note?: string }).note ?? null) : null,
    })),
    eras: getEras(db, threadId).map((e) => ({ name: e.name, summary: e.summary, startMs: e.startMs })),
    receiptIds,
  };
}

export function materializeHersideJob(db: BetweenDB, threadId: number, airlockDir: string): { jobId: string; material: HersideMaterial } {
  const material = buildHersideMaterial(db, threadId);
  const { jobId } = materializeCustomJob(db, { lens: 'herside_reading', threadId, transcript: JSON.stringify(material), memberIds: material.receiptIds, airlockDir });
  return { jobId, material };
}

export function finalizeHerside(db: BetweenDB, threadId: number, render: BlocksResult, receiptIds: number[], span: { startMs: number; endMs: number }, generatedAt: string): number {
  // EXPERIMENTAL GATE (P1-11): the other-side reading is interpretive guesswork about a person's interior;
  // off by default → freeze an honest decline instead.
  if (!experimentalLensesEnabled(db)) {
    const md = `# The weather from the other side\n\n${EXPERIMENTAL_DECLINE}\n`;
    return freezeReflection(db, threadId, 'herside_reading', md, {}, span.startMs, span.endMs, 'experimental_off', generatedAt);
  }
  const valid = new Set(receiptIds.map((id) => `m${id}`));
  const { body, evidence } = composeBlocks(render.blocks, valid);
  const md = `# The weather from the other side\n\n${body}\n`;
  return freezeReflection(db, threadId, 'herside_reading', md, evidence, span.startMs, span.endMs, 'fable herside_reading', generatedAt);
}
