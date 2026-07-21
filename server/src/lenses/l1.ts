// Between — L1 emotion aggregation (prompts/l1-emotion.md §"Aggregation"). After L1 map results
// land in analysis_results, this rolls per-message warmth/tension/valence up into a per-day series
// and caches it under metrics_key='emotion_daily'. The Overview river PREFERS this L1 emotion over
// the Phase-1 VADER lexicon warmth/tension when it is present (see getEmotionDaily). Overlapping
// windows are de-duplicated by averaging a message's scores across the windows that scored it.
//
// This module is additive: it does NOT modify server/src/metrics. It only writes a new metrics row
// (the app is the sole SQLite writer) and exposes getters. Reactions never enter this lens.
import type { BetweenDB } from '../store/db';
import { createAirlockStore } from '../airlock/store';
import { makeLocalizer, getTimezone } from '../lib/localtime';
import type { L1Result } from '../airlock/schemas';

const METRIC_KEY = 'emotion_daily';
const PERIOD = 'all';
const PERIOD_START_MS = 0;

export interface EmotionParty {
  count: number;
  warmth: number;   // mean 0–3
  tension: number;  // mean 0–3
  valence: number;  // mean -1..1
}

export interface EmotionDailyPoint {
  date: string;         // YYYY-MM-DD (UTC)
  count: number;        // scored messages that day
  warmth: number;       // mean 0–3
  tension: number;      // mean 0–3
  valence: number;      // mean -1..1
  warmth01: number;     // warmth / 3 → river fill scale (0..1)
  tension01: number;    // tension / 3 → river fill scale (0..1)
  me: EmotionParty;
  them: EmotionParty;
}

interface MsgScore { valence: number; warmth: number; tension: number; n: number }

/** Message-id → averaged emotion across all windows that scored it (overlap de-dup). */
export function emotionByMessage(db: BetweenDB, threadId: number): Map<number, MsgScore> {
  const store = createAirlockStore(db);
  const byId = new Map<number, MsgScore>();
  for (const r of store.resultsForThreadLens(threadId, 'l1_emotion')) {
    const res = r.result as L1Result;
    for (const m of res.messages ?? []) {
      const idNum = Number(m.message_id.slice(1));
      if (!Number.isFinite(idNum)) continue;
      const cur = byId.get(idNum) ?? { valence: 0, warmth: 0, tension: 0, n: 0 };
      cur.valence += m.valence;
      cur.warmth += m.warmth;
      cur.tension += m.tension;
      cur.n += 1;
      byId.set(idNum, cur);
    }
  }
  for (const s of byId.values()) {
    s.valence /= s.n; s.warmth /= s.n; s.tension /= s.n; s.n = 1;
  }
  return byId;
}

function emptyParty(): { count: number; w: number; t: number; v: number } {
  return { count: 0, w: 0, t: 0, v: 0 };
}

/** Fetch (id → {ms, direction}) for a set of ids, batched under the SQLite variable limit. */
function messageMeta(db: BetweenDB, ids: number[]): Map<number, { ms: number; dir: string }> {
  const out = new Map<number, { ms: number; dir: string }>();
  const BATCH = 800;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const ph = slice.map(() => '?').join(',');
    const rows = db.raw
      .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir FROM messages WHERE id IN (${ph})`)
      .all(...slice) as { id: number; ms: number; dir: string }[];
    for (const r of rows) out.set(r.id, { ms: r.ms, dir: r.dir });
  }
  return out;
}

/** Compute the per-day L1 emotion series for a thread (pure; no writes). */
export function computeEmotionDaily(db: BetweenDB, threadId: number): EmotionDailyPoint[] {
  const scores = emotionByMessage(db, threadId);
  if (scores.size === 0) return [];
  const meta = messageMeta(db, [...scores.keys()]);
  const loc = makeLocalizer(getTimezone(db)); // day buckets follow the owner's lived clock (P2-14)

  interface DayAgg {
    count: number; w: number; t: number; v: number;
    me: ReturnType<typeof emptyParty>; them: ReturnType<typeof emptyParty>;
  }
  const days = new Map<string, DayAgg>();

  for (const [id, s] of scores) {
    const m = meta.get(id);
    if (!m) continue; // message no longer present → drop (receipts-or-nothing)
    const date = loc.dayKey(m.ms);
    let d = days.get(date);
    if (!d) {
      d = { count: 0, w: 0, t: 0, v: 0, me: emptyParty(), them: emptyParty() };
      days.set(date, d);
    }
    d.count++; d.w += s.warmth; d.t += s.tension; d.v += s.valence;
    const party = m.dir === 'outgoing' || m.dir === 'draft' ? d.me : d.them;
    party.count++; party.w += s.warmth; party.t += s.tension; party.v += s.valence;
  }

  const party = (p: ReturnType<typeof emptyParty>): EmotionParty => ({
    count: p.count,
    warmth: p.count ? p.w / p.count : 0,
    tension: p.count ? p.t / p.count : 0,
    valence: p.count ? p.v / p.count : 0,
  });

  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, d]) => ({
      date,
      count: d.count,
      warmth: d.count ? d.w / d.count : 0,
      tension: d.count ? d.t / d.count : 0,
      valence: d.count ? d.v / d.count : 0,
      warmth01: d.count ? d.w / d.count / 3 : 0,
      tension01: d.count ? d.t / d.count / 3 : 0,
      me: party(d.me),
      them: party(d.them),
    }));
}

/** Compute + cache the L1 emotion series into the metrics table (app is sole writer). */
export function refreshEmotionDaily(db: BetweenDB, threadId: number): EmotionDailyPoint[] {
  const series = computeEmotionDaily(db, threadId);
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(threadId, METRIC_KEY, PERIOD, PERIOD_START_MS, JSON.stringify(series));
  return series;
}

/** Read the cached L1 emotion series (empty array if none — river then falls back to VADER). */
export function getEmotionDaily(db: BetweenDB, threadId: number): EmotionDailyPoint[] {
  const row = db.raw
    .prepare(
      `SELECT value_json AS v FROM metrics
        WHERE thread_id = ? AND metric_key = ? AND period = ? AND period_start_ms = ?`,
    )
    .get(threadId, METRIC_KEY, PERIOD, PERIOD_START_MS) as { v: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.v) as EmotionDailyPoint[]; } catch { return []; }
}

/** True when L1 emotion exists for this thread (river should prefer it over VADER). */
export function hasEmotionDaily(db: BetweenDB, threadId: number): boolean {
  return getEmotionDaily(db, threadId).length > 0;
}

/** Below this model-scored coverage, the L1 river is not trustworthy and the UI falls back to the
 *  deterministic (VADER) layer — an unscored message reads as neutral, so a thinly-drained thread
 *  must not be shown as if the model saw all of it (P1-7). */
export const L1_COVERAGE_FLOOR = 0.95;

/** The coverage contract every river/trajectory surface reads. Field names are deliberately the ones
 *  that go over the wire — one vocabulary from the query to the chart, so no layer can quietly mean
 *  something slightly different by the same word. */
export interface EmotionCoverage {
  /** Substantive (non-reaction, non-empty) messages in the thread — the denominator. */
  eligibleMessages: number;
  /** How many of those carry a model L1 score. */
  scoredMessages: number;
  /** scoredMessages / eligibleMessages, 0..1. Zero for an empty thread (never NaN). */
  coverage: number;
  /** The same, 0..100 and rounded — what a surface prints. Never what a gate reads. */
  coveragePct: number;
  /** Windows the engine declined. A refusal is a reason coverage is short, not a silent gap. */
  refusedWindows: number;
  /** Windows that failed. Same principle. */
  erroredWindows: number;
  /** coverage ≥ L1_COVERAGE_FLOOR. The ONLY condition under which a surface may present the model
   *  layer as the reading. Computed from the exact ratio so a rounding artifact can never promote a
   *  thin drain to "complete". */
  modelComplete: boolean;
}

/** Exact model-scored coverage for the river/trajectory views (P1-7). Surfaced so the UI can show
 *  "model-scored coverage: N%" — and, since v0.3.0, *gate* on it: an unscored message reads as
 *  neutral, so a thinly-drained thread doesn't look thin, it looks calm. Reporting the number without
 *  gating on it left the most misleading possible chart one honest caption away from correct. */
export function emotionCoverage(db: BetweenDB, threadId: number): EmotionCoverage {
  const scoredMessages = emotionByMessage(db, threadId).size;
  const eligibleMessages = (db.raw
    .prepare("SELECT count(*) AS n FROM messages WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''")
    .get(threadId) as { n: number }).n;
  const coverage = eligibleMessages ? scoredMessages / eligibleMessages : 0;

  const counts = createAirlockStore(db).jobStatusCountsForThread(threadId, 'l1_emotion') ?? {};
  return {
    eligibleMessages,
    scoredMessages,
    coverage,
    coveragePct: Math.round(coverage * 100),
    refusedWindows: counts.refused ?? 0,
    erroredWindows: counts.error ?? 0,
    modelComplete: coverage >= L1_COVERAGE_FLOOR,
  };
}
