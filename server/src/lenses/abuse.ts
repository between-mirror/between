// Between — L4 abuse-pattern lens + the power-balance gate. Two stages:
//   Stage 1 (deterministic, elsewhere): episodes ARE the prefilter (hold-out-calibrated hostile bar).
//   Stage 2 (worthwhile tier, one l4 job per episode): identify hostility PATTERNS per side.
// This module owns: building the per-episode l4 jobs, reading their results, aggregating patterns to a
// per-ERA directional picture, and the GATE — a deterministic, recency-weighted judgement of whether
// abuse crosses a review threshold in ONE direction (→ VOICE support frame) or runs both ways (→ the
// two-readings frame). The gate changes VOICE only; both sides' patterns are always computed and stored.
//
// HARD STOP (guardrail 8): the full stage-2 drain runs only AFTER a sample-and-agree pass over ~10
// episodes confirms the thresholds with the owner — exactly the original abuse-detector rule.
import type { BetweenDB } from '../store/db';
import { getEpisodes, type EpisodeRow } from './episodes';
import { getEras, type Era } from './eras';
import { createAirlockStore } from '../airlock/store';
import { materializeCustomJob } from '../airlock/plan';
import type { L4Result } from '../airlock/schemas';
import { calibrationStatus } from './calibration';
import { experimentalLensesEnabled } from './experimental';

/** The coercive-control markers the gate weighs (distinct from ordinary heat). */
export const COERCIVE_KINDS = new Set(['threat', 'monitoring', 'coercive_demand']);

export interface SideCount { me: number; them: number }

/** Count coercive-marker patterns by side, IGNORING anything flagged repair_context (the calibrated
 *  false-positive mode: apology / withdrawal-then-repair must never read as coercion). */
export function countCoercive(patterns: L4Result['patterns']): SideCount {
  const out: SideCount = { me: 0, them: 0 };
  for (const p of patterns) {
    if (p.repair_context === true) continue;
    if (!COERCIVE_KINDS.has(p.kind)) continue;
    if (p.side === 'me') out.me++; else out.them++;
  }
  return out;
}

/** Read stored l4 results keyed by their episode's start_msg_id. An l4 job covers exactly one episode,
 *  so its chunk member_ids contain that episode's start_msg_id (the first hostile message) — we match on
 *  membership, NOT on chunk.start_msg_id (which is the min numeric id and real archives aren't id-ordered). */
export function getL4ByEpisode(db: BetweenDB, threadId: number): Map<number, L4Result> {
  const rows = db.raw
    .prepare(
      `SELECT j.chunk_ref AS chunkRef, r.result_json AS resultJson
         FROM analysis_results r JOIN analysis_jobs j ON j.id = r.job_id
        WHERE r.lens = 'l4_episode_patterns'`,
    )
    .all() as { chunkRef: string; resultJson: string }[];
  const startIds = new Set(getEpisodes(db, threadId).map((e) => e.startMsgId));
  const out = new Map<number, L4Result>();
  for (const row of rows) {
    try {
      const chunk = JSON.parse(row.chunkRef) as { thread_id: number; member_ids?: number[] };
      if (chunk.thread_id !== threadId) continue;
      const startId = (chunk.member_ids ?? []).find((id) => startIds.has(id));
      if (startId != null) out.set(startId, JSON.parse(row.resultJson) as L4Result);
    } catch { /* skip */ }
  }
  return out;
}

export interface EraAgg {
  startMs: number;
  endMs: number;
  episodes: number;
  severeMe: number; severeThem: number;   // severe messages by side (from episodes)
  initMe: number; initThem: number;        // episode initiations by side
  coerciveMe: number; coerciveThem: number;// coercive markers by side (from l4 results; 0 until drained)
}

/** Aggregate episodes (+ any l4 results) into per-era directional counts. */
export function buildEraAggregates(db: BetweenDB, threadId: number): EraAgg[] {
  const eras = getEras(db, threadId);
  const episodes = getEpisodes(db, threadId);
  const l4 = getL4ByEpisode(db, threadId);
  return eras.map((era) => {
    const agg: EraAgg = { startMs: era.startMs, endMs: era.endMs, episodes: 0, severeMe: 0, severeThem: 0, initMe: 0, initThem: 0, coerciveMe: 0, coerciveThem: 0 };
    for (const e of episodes) {
      if (e.startMs < era.startMs || e.startMs > era.endMs) continue;
      agg.episodes++;
      agg.severeMe += e.severeMe; agg.severeThem += e.severeThem;
      if (e.initiator === 'me') agg.initMe++; else agg.initThem++;
      const res = l4.get(e.startMsgId);
      if (res) { const c = countCoercive(res.patterns); agg.coerciveMe += c.me; agg.coerciveThem += c.them; }
    }
    return agg;
  });
}

export interface EraGate {
  startMs: number;
  direction: 'them' | 'me' | null;   // the party the abuse points AT the owner from ('them') / from the owner ('me')
  tripped: boolean;
  frame: 'support' | 'two_readings';
  shares: { severe: number; init: number; coercive: number }; // each = THEM's share (0..1); 0.5 when no data
}

export interface GateResult {
  eras: EraGate[];
  stance: { direction: 'them' | 'me' | null; frame: 'support' | 'two_readings'; confidence: number; uncalibrated?: boolean; experimental?: boolean };
}

const share = (them: number, me: number): number => (them + me ? them / (them + me) : 0.5);

export interface GateOpts { threshold?: number; halfLifeMs?: number }

/**
 * The power-balance gate (pure). An era trips toward one side only when severe volume, initiation, AND
 * coercive markers all cross the review threshold in that direction — so it will NOT declare a support
 * frame on heat alone; it needs the coercive-marker evidence that only the stage-2 drain provides
 * (coercive share defaults to 0.5 with no l4 data, keeping an un-drained era in the two-readings frame).
 * The overall stance recency-weights each era by severe volume × exponential age decay.
 */
export function powerBalanceGate(aggs: EraAgg[], opts: GateOpts = {}): GateResult {
  const thr = opts.threshold ?? 0.66;
  const halfLife = opts.halfLifeMs ?? 365 * 24 * 3_600_000;
  const eras: EraGate[] = aggs.map((a) => {
    const sev = share(a.severeThem, a.severeMe);
    const init = share(a.initThem, a.initMe);
    const coe = share(a.coerciveThem, a.coerciveMe);
    let direction: 'them' | 'me' | null = null;
    if (sev >= thr && init >= thr && coe >= thr) direction = 'them';
    else if (sev <= 1 - thr && init <= 1 - thr && coe <= 1 - thr) direction = 'me';
    return { startMs: a.startMs, direction, tripped: direction != null, frame: direction ? 'support' : 'two_readings', shares: { severe: sev, init: init, coercive: coe } };
  });

  const latest = aggs.length ? Math.max(...aggs.map((a) => a.endMs)) : 0;
  let wThem = 0, wMe = 0;
  aggs.forEach((a, i) => {
    const vol = a.severeMe + a.severeThem;
    const w = vol * Math.pow(0.5, (latest - a.endMs) / halfLife);
    if (eras[i].direction === 'them') wThem += w;
    else if (eras[i].direction === 'me') wMe += w;
  });
  const total = wThem + wMe;
  const direction = total === 0 ? null : wThem >= wMe ? 'them' : 'me';
  const confidence = total === 0 ? 0 : Math.abs(wThem - wMe) / total;
  return { eras, stance: { direction, frame: direction ? 'support' : 'two_readings', confidence } };
}

/** Convenience: the gate for a thread from its stored episodes/eras/l4 results. Reads the owner's
 *  self-report-bias (app_meta 'self_report_bias') and RAISES the directional threshold when the owner
 *  labeled themselves leniently — so a self-lenient calibration needs more evidence to take a side.
 *
 *  RUNTIME HARD STOP (the honesty spine): a support frame is a directional verdict, and a directional
 *  verdict on an UNCALIBRATED archive — shipped defaults, no self-report honesty check — is exactly the
 *  "comforting lie with receipts" the method exists to prevent. So when the owner has not calibrated,
 *  this refuses to emit any support frame: every era and the overall stance fall back to two_readings and
 *  the result is flagged `uncalibrated`. The lean (direction) is kept for transparency; the verdict is not. */
export function gateFor(db: BetweenDB, threadId: number): GateResult {
  let threshold: number | undefined;
  const raw = db.getMeta('self_report_bias');
  if (raw) {
    try { const b = JSON.parse(raw) as { gateThresholdBump?: number }; if (typeof b.gateThresholdBump === 'number') threshold = 0.66 + b.gateThresholdBump; }
    catch { /* ignore */ }
  }
  const gate = powerBalanceGate(buildEraAggregates(db, threadId), threshold != null ? { threshold } : {});
  const experimental = experimentalLensesEnabled(db);
  const calibrated = calibrationStatus(db).calibrated;

  // EXPERIMENTAL GATE (P1-11): the support frame is a directional verdict from an unvalidated layer.
  // With the experimental layer OFF, no support frame ever escapes — every era and the overall stance
  // collapse to two_readings. The lean (direction) is kept for transparency; the verdict is not. The
  // runtime HARD STOP (uncalibrated → no support frame) still applies on top when the layer is ON.
  const neutralize = !experimental || !calibrated;
  if (neutralize) {
    return {
      eras: gate.eras.map((e) => ({ ...e, tripped: false, frame: 'two_readings' as const })),
      stance: {
        direction: gate.stance.direction, frame: 'two_readings', confidence: gate.stance.confidence,
        uncalibrated: !calibrated, experimental,
      },
    };
  }
  return { ...gate, stance: { ...gate.stance, uncalibrated: false, experimental: true } };
}

// ── L4 stage-2 hard stop: no full drain until the owner has done sample-and-agree (guardrail 8) ──
const L4_CONFIRM_KEY = 'l4_sample_confirmed';
export interface L4SampleConfirmation { confirmedAt: string; n: number; agree: number }

export function isL4SampleConfirmed(db: BetweenDB, threadId: number): boolean {
  const raw = db.getMeta(`${L4_CONFIRM_KEY}:${threadId}`);
  if (!raw) return false;
  try { const c = JSON.parse(raw) as { n?: number }; return typeof c.n === 'number' && c.n > 0; } catch { return false; }
}

/** Record the owner's sample-and-agree pass over the top-N severe episodes. `grades` is the owner's
 *  verdict per sampled episode: 'fair' | 'overstated' | 'understated'. Persisted per thread. */
export function recordL4SampleConfirmed(db: BetweenDB, threadId: number, grades: string[], generatedAt: string): L4SampleConfirmation {
  const agree = grades.filter((g) => g === 'fair').length;
  const conf: L4SampleConfirmation = { confirmedAt: generatedAt, n: grades.length, agree };
  db.setMeta(`${L4_CONFIRM_KEY}:${threadId}`, JSON.stringify(conf));
  return conf;
}

// ── stage-2 job materialization + sample-and-agree selection ──────────────────

function speaker(dir: string): 'ME' | 'THEM' { return dir === 'outgoing' || dir === 'draft' ? 'ME' : 'THEM'; }

/** Build a self-contained transcript for one episode's message span. */
export function episodeTranscript(db: BetweenDB, e: EpisodeRow): { transcript: string; memberIds: number[] } {
  const rows = db.raw
    .prepare(
      `SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages
        WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
          AND sent_at_ms >= ? AND sent_at_ms <= ? ORDER BY sent_at_ms ASC, id ASC`,
    )
    .all(e.threadId, e.startMs, e.endMs) as { id: number; ms: number; dir: string; body: string }[];
  const line = (r: { id: number; ms: number; dir: string; body: string }) => {
    const d = new Date(r.ms);
    const p = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    return `[m${r.id}] ${ts} ${speaker(r.dir)}: ${r.body.replace(/\s*\n\s*/g, ' ').trim()}`;
  };
  return { transcript: rows.map(line).join('\n'), memberIds: rows.map((r) => r.id) };
}

/** Materialize one l4 job per episode. Returns the job ids. Does NOT drain.
 *  HARD STOP: materializing the FULL episode set (no `episodes` subset) is the full stage-2 drain, which
 *  must not run until the owner has done the sample-and-agree pass — otherwise the gate could speak a
 *  support frame the owner never checked. A subset (the sample itself, or a targeted re-run) is allowed. */
export function materializeL4Jobs(db: BetweenDB, threadId: number, airlockDir: string, episodes?: EpisodeRow[]): string[] {
  // RESEARCH GATE (P1-11): stage-2 abuse-pattern detection is part of the interpretive layer. It does
  // not run at all unless research mode is switched on out of band AND this archive has been
  // acknowledged — no sample, no full drain.
  if (!experimentalLensesEnabled(db)) {
    throw new Error(
      `L4 stage-2 is off: the abuse-pattern layer is a research preview (text-only, not externally `
      + `validated), disabled in ordinary builds. There is no setting for it — activation is `
      + `documented for evaluators in docs/STATUS.md.`,
    );
  }
  if (episodes === undefined && !isL4SampleConfirmed(db, threadId)) {
    throw new Error(
      `L4 full drain blocked for thread ${threadId}: the owner has not completed the sample-and-agree pass. ` +
      `Materialize the sample (selectSampleEpisodes) for review and call recordL4SampleConfirmed first.`,
    );
  }
  const eps = episodes ?? getEpisodes(db, threadId);
  const ids: string[] = [];
  for (const e of eps) {
    const { transcript, memberIds } = episodeTranscript(db, e);
    if (!memberIds.length) continue;
    const { jobId } = materializeCustomJob(db, { lens: 'l4_episode_patterns', threadId, transcript, memberIds, airlockDir });
    ids.push(jobId);
  }
  return ids;
}

/** Pick the ~N most severe episodes for the owner sample-and-agree pass (the hard-stop checkpoint). */
export function selectSampleEpisodes(db: BetweenDB, threadId: number, n = 10): EpisodeRow[] {
  return [...getEpisodes(db, threadId)]
    .sort((a, b) => (b.severeMe + b.severeThem) - (a.severeMe + a.severeThem) || b.peakTension - a.peakTension)
    .slice(0, n);
}
