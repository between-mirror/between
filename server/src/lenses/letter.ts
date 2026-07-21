// Between — S4 letter, the Opus half: assemble the grounded MATERIAL for the capstone letter from every
// derived layer (eras + summaries, the trajectory headline, the growth trend, the top episodes, and the
// power-balance gate stance that decides §5 vs §5b framing). The render itself is a Fable session over
// this material; nothing here writes prose. Receipts carried verbatim so the render can cite them.
import type { BetweenDB } from '../store/db';
import { getEras } from './eras';
import { getEpisodes, type EpisodeRow } from './episodes';
import { getGrowth } from './growth';
import { computeTrajectory } from './trajectory';
import { gateFor } from './abuse';
import { materializeCustomJob } from '../airlock/plan';

export interface LetterEpisode {
  startMs: number; endMs: number; severeThem: number; severeMe: number;
  initiator: 'me' | 'them'; kidNamed: boolean; note: string | null;
}

export interface LetterMaterial {
  threadId: number;
  span: { startMs: number; endMs: number };
  gate: { frame: 'support' | 'two_readings'; direction: 'them' | 'me' | null; confidence: number };
  headline: { hostileMe: number; hostileThem: number; severeMe: number; severeThem: number };
  growthTrend: { firstRecipRate: number | null; lastRecipRate: number | null; quarters: number };
  eras: { name: string | null; summary: string | null; startMs: number; endMs: number; stats: Record<string, number> }[];
  topEpisodes: LetterEpisode[];
  receiptIds: number[];
}

function episodeMemberIds(db: BetweenDB, e: EpisodeRow): number[] {
  return (db.raw
    .prepare("SELECT id FROM messages WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != '' AND sent_at_ms >= ? AND sent_at_ms <= ?")
    .all(e.threadId, e.startMs, e.endMs) as { id: number }[]).map((r) => r.id);
}

export function buildLetterMaterial(db: BetweenDB, threadId: number): LetterMaterial {
  const traj = computeTrajectory(db, threadId);
  const eras = getEras(db, threadId);
  const episodes = getEpisodes(db, threadId);
  const growth = getGrowth(db, threadId);
  const gate = gateFor(db, threadId).stance;

  const headline = traj.months.reduce(
    (s, m) => ({ hostileMe: s.hostileMe + m.hostileMe, hostileThem: s.hostileThem + m.hostileThem, severeMe: s.severeMe + m.severeMe, severeThem: s.severeThem + m.severeThem }),
    { hostileMe: 0, hostileThem: 0, severeMe: 0, severeThem: 0 },
  );

  const bySeverity = [...episodes].sort((a, b) => (b.severeMe + b.severeThem) - (a.severeMe + a.severeThem));
  const top = bySeverity.slice(0, 6);
  const topEpisodes: LetterEpisode[] = top.map((e) => ({
    startMs: e.startMs, endMs: e.endMs, severeThem: e.severeThem, severeMe: e.severeMe,
    initiator: e.initiator, kidNamed: e.kidNamed,
    note: e.narrative && typeof e.narrative === 'object' ? ((e.narrative as { note?: string }).note ?? null) : null,
  }));
  const receiptIds = [...new Set(top.flatMap((e) => episodeMemberIds(db, e)))].sort((a, b) => a - b);

  const startMs = episodes[0]?.startMs ?? traj.months[0]?.startMs ?? 0;
  const endMs = traj.months.length ? traj.months[traj.months.length - 1].endMs : (episodes[episodes.length - 1]?.endMs ?? 0);

  return {
    threadId,
    span: { startMs, endMs },
    gate,
    headline,
    growthTrend: {
      firstRecipRate: growth.length ? growth[0].recipRate : null,
      lastRecipRate: growth.length ? growth[growth.length - 1].recipRate : null,
      quarters: growth.length,
    },
    eras: eras.map((e) => ({ name: e.name, summary: e.summary, startMs: e.startMs, endMs: e.endMs, stats: e.stats })),
    topEpisodes,
    receiptIds,
  };
}

/** Materialize the letter render job from assembled material (drained by Fable, sample-and-agree). */
export function materializeLetterJob(db: BetweenDB, threadId: number, airlockDir: string): { jobId: string; material: LetterMaterial } {
  const material = buildLetterMaterial(db, threadId);
  const { jobId } = materializeCustomJob(db, {
    lens: 'letter', threadId,
    transcript: JSON.stringify(material),
    memberIds: material.receiptIds,
    airlockDir,
  });
  return { jobId, material };
}
