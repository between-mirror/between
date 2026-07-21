// Between — Tier-1 deterministic metrics (GAMEPLAN §3 ⭐ core set). One streaming pass over a
// thread's non-reaction messages produces the whole MetricsBundle the Overview reads. No model:
// counting, gap-segmentation, cross-party latency, English-gated VADER lexicon sentiment.
//
// English gating (GAMEPLAN §2.2a): a message is English-eligible when lang === 'en' OR lang IS
// NULL — tinyld is unreliable on short SMS, so an unlabelled message defaults to English rather
// than being dropped from sentiment. Non-English messages are excluded from lexicon sentiment.
//
// Performance: a ~170k-message thread must finish in a few seconds. Single prepared statement,
// row iterator (flat memory), one Date per row, and a body→compound cache so repeated short texts
// ("ok", "love you") are scored once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SentimentIntensityAnalyzer } from 'vader-sentiment';
import type { BetweenDB } from '../store/db';
import { makeLocalizer, getTimezone } from '../lib/localtime';
import type {
  MetricsBundle, MetricsSummary, DailyPoint, HeatCell, LatencyStat,
} from './contract';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const DEFAULT_SESSION_GAP_MINUTES = 60;
const SENTIMENT_MIN_ENGLISH_SHARE = 0.5; // sentimentAvailable when overall English share exceeds this
const MAX_TOP_EMOJI = 8;

// Emoji fingerprint. No emoji-regex dep (not in the allowed set) — Unicode property escapes:
// regional-indicator pairs (flags), or a pictographic base plus its modifiers — skin tone
// (U+1F3FB–U+1F3FF), VS16 (U+FE0F), keycap combiner (U+20E3) — and ZWJ (U+200D) joined
// pictographic sequences (families, professions) collapsed to one grapheme. Keycap digit
// sequences (1-with-keycap) are intentionally not captured (digits aren't pictographic).
const EMOJI_RE =
  /\p{Regional_Indicator}\p{Regional_Indicator}|\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}\uFE0F\u20E3]|\u200D\p{Extended_Pictographic})*/gu;

// Pronoun token sets for the we-ratio (GAMEPLAN §3 "pronoun ratios I/you/we"). Lower-cased,
// apostrophes preserved by the tokenizer below.
const I_TOKENS = new Set(['i', "i'm", "i've", "i'll", "i'd", 'im', 'ive', 'me', 'my', 'mine', 'myself']);
const YOU_TOKENS = new Set(['you', "you're", "you've", "you'll", "you'd", 'your', 'yours', 'yourself', 'yourselves', 'u', 'ya']);
const WE_TOKENS = new Set(['we', "we're", "we've", "we'll", "we'd", 'us', 'our', 'ours', 'ourselves']);

export interface ComputeMetricsOptions {
  /** Gap (minutes) that segments the message stream into sessions. Defaults to config, then 60. */
  sessionGapMinutes?: number;
}

interface MsgRow {
  direction: string;
  t: number;
  body: string | null;
  lang: string | null;
}

interface DayAgg {
  count: number;
  outCount: number;
  inCount: number;
  englishEligible: number; // messages classified English-eligible (for englishShare)
  scored: number;          // English-eligible messages with body, actually VADER-scored
  sentSum: number;
  warmthSum: number;
  tensionSum: number;
}

/** Read ingest.sessionGapMinutes from the tracked between.config.json; fall back to 60. */
function readSessionGapMinutes(): number {
  try {
    const path = fileURLToPath(new URL('../../../between.config.json', import.meta.url));
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { ingest?: { sessionGapMinutes?: unknown } };
    const v = Number(cfg?.ingest?.sessionGapMinutes);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    // missing/malformed config → default
  }
  return DEFAULT_SESSION_GAP_MINUTES;
}

function countWords(body: string | null): number {
  if (!body) return 0;
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Percentile with linear interpolation over a value array already sorted ascending. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (rank - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

/** Median + p90 of a latency sample (ms in), returned in minutes; nulls on an empty sample. */
function latencyStat(samplesMs: number[]): LatencyStat {
  if (samplesMs.length === 0) return { medianMinutes: null, p90Minutes: null };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    medianMinutes: percentile(sorted, 0.5) / MS_PER_MINUTE,
    p90Minutes: percentile(sorted, 0.9) / MS_PER_MINUTE,
  };
}

/**
 * Compute the Tier-1 MetricsBundle for one thread. Excludes reactions (is_reaction=1). `db` is the
 * BetweenDB; SQL runs against db.raw. Deterministic and side-effect free (the cache lives in index.ts).
 */
export function computeMetrics(
  db: BetweenDB,
  threadId: number,
  opts?: ComputeMetricsOptions,
): MetricsBundle {
  const gapMs = (opts?.sessionGapMinutes ?? readSessionGapMinutes()) * MS_PER_MINUTE;
  const loc = makeLocalizer(getTimezone(db)); // day/hour/dow buckets in the owner's lived clock (P2-14)

  // Coverage travels with the thread row (GAMEPLAN §2.1a); default to full coverage if absent.
  const threadRow = db.raw
    .prepare('SELECT coverage_confidence AS cc, coverage_note AS cn FROM threads WHERE id = ?')
    .get(threadId) as { cc: number; cn: string | null } | undefined;

  const rows = db.raw
    .prepare(
      `SELECT direction, sent_at_ms AS t, body_text AS body, lang
         FROM messages
        WHERE thread_id = ? AND is_reaction = 0
        ORDER BY sent_at_ms ASC`,
    )
    .iterate(threadId) as IterableIterator<MsgRow>;

  const daily = new Map<string, DayAgg>();
  const heat = new Int32Array(7 * 24); // index = dow*24 + hour
  const activeDayNums = new Set<number>();
  const emojiCounts = new Map<string, number>();
  const vaderCache = new Map<string, number>();

  let total = 0;
  let outCount = 0;
  let inCount = 0;
  let englishEligibleTotal = 0;
  let lateNight = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;

  // Per-party linguistics.
  let youMsgs = 0, themMsgs = 0;
  let youWords = 0, themWords = 0;
  let youQuestions = 0, themQuestions = 0;

  // Pronoun tallies (English-eligible messages only).
  let pI = 0, pYou = 0, pWe = 0;

  // Sessions + initiations.
  let sessions = 0;
  let initYou = 0, initThem = 0;
  let prevT: number | null = null;

  // Cross-party reply latency (incoming/outgoing turns only).
  let prevCrossDir: string | null = null;
  let prevCrossT = 0;
  const youLatency: number[] = [];
  const themLatency: number[] = [];

  const compoundOf = (text: string): number => {
    const cached = vaderCache.get(text);
    if (cached !== undefined) return cached;
    const c = SentimentIntensityAnalyzer.polarity_scores(text).compound;
    vaderCache.set(text, c);
    return c;
  };

  for (const r of rows) {
    const { direction, t, body, lang } = r;
    total++;
    if (firstMs === null) firstMs = t;
    lastMs = t;

    const dow = loc.dow(t);             // 0=Sun..6=Sat, lived clock
    const hour = loc.hour(t);           // 0..23, lived clock
    const dateStr = loc.dayKey(t);      // YYYY-MM-DD, lived clock
    const dayNum = Math.floor(t / MS_PER_DAY);

    heat[dow * 24 + hour]++;
    activeDayNums.add(dayNum);
    if (hour < 5) lateNight++;

    let day = daily.get(dateStr);
    if (day === undefined) {
      day = { count: 0, outCount: 0, inCount: 0, englishEligible: 0, scored: 0, sentSum: 0, warmthSum: 0, tensionSum: 0 };
      daily.set(dateStr, day);
    }
    day.count++;

    const isOut = direction === 'outgoing';
    const isIn = direction === 'incoming';
    if (isOut) { outCount++; day.outCount++; }
    else if (isIn) { inCount++; day.inCount++; }

    const words = countWords(body);
    const hasQuestion = body != null && body.includes('?');
    if (isOut) { youMsgs++; youWords += words; if (hasQuestion) youQuestions++; }
    else if (isIn) { themMsgs++; themWords += words; if (hasQuestion) themQuestions++; }

    // Sessions (gap-segmented) + who opened each.
    if (prevT === null || t - prevT > gapMs) {
      sessions++;
      if (isOut) initYou++;
      else if (isIn) initThem++;
    }
    prevT = t;

    // Cross-party latency: only on a direction flip between sent/received turns.
    if (isOut || isIn) {
      if (prevCrossDir !== null && direction !== prevCrossDir) {
        const dt = t - prevCrossT;
        if (isOut) youLatency.push(dt);
        else themLatency.push(dt);
      }
      prevCrossDir = direction;
      prevCrossT = t;
    }

    // Emoji fingerprint (all messages with a body).
    if (body) {
      const found = body.match(EMOJI_RE);
      if (found) for (const e of found) emojiCounts.set(e, (emojiCounts.get(e) ?? 0) + 1);
    }

    // English gating for sentiment + pronouns.
    const englishEligible = lang === 'en' || lang == null;
    if (englishEligible) {
      englishEligibleTotal++;
      day.englishEligible++;

      if (body) {
        const lowerTokens = body.toLowerCase().match(/[a-z][a-z']*/g);
        if (lowerTokens) {
          for (const tk of lowerTokens) {
            if (WE_TOKENS.has(tk)) pWe++;
            else if (I_TOKENS.has(tk)) pI++;
            else if (YOU_TOKENS.has(tk)) pYou++;
          }
        }

        if (body.trim().length > 0) {
          const compound = compoundOf(body);
          day.scored++;
          day.sentSum += compound;
          day.warmthSum += Math.max(0, compound);
          day.tensionSum += Math.max(0, -compound);
        }
      }
    }
  }

  // ── Daily series (ascending by date). ──
  const dailyArr: DailyPoint[] = [...daily.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, a]) => ({
      date,
      count: a.count,
      outCount: a.outCount,
      inCount: a.inCount,
      sentiment: a.scored > 0 ? a.sentSum / a.scored : null,
      warmth: a.scored > 0 ? a.warmthSum / a.scored : 0,
      tension: a.scored > 0 ? a.tensionSum / a.scored : 0,
      englishShare: a.count > 0 ? a.englishEligible / a.count : 0,
    }));

  // ── Heatmap (full 7×24 grid, zeros included). ──
  const hourDay: HeatCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      hourDay.push({ dow, hour, count: heat[dow * 24 + hour] });
    }
  }

  // ── Streak / silence over active days. ──
  const days = [...activeDayNums].sort((a, b) => a - b);
  let longestStreakDays = days.length ? 1 : 0;
  let currentStreak = days.length ? 1 : 0;
  let longestSilenceDays = 0;
  for (let i = 1; i < days.length; i++) {
    const diff = days[i] - days[i - 1];
    if (diff === 1) {
      currentStreak++;
      if (currentStreak > longestStreakDays) longestStreakDays = currentStreak;
    } else {
      currentStreak = 1;
      const silence = diff - 1; // fully silent calendar days between two active days
      if (silence > longestSilenceDays) longestSilenceDays = silence;
    }
  }

  // ── Top emoji (count desc, then codepoint asc for determinism). ──
  const topEmoji = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_TOP_EMOJI)
    .map(([emoji, count]) => ({ emoji, count }));

  const pronounDenom = pI + pYou + pWe;

  const summary: MetricsSummary = {
    totalMessages: total,
    outCount,
    inCount,
    sentShare: total > 0 ? outCount / total : 0,
    activeDays: days.length,
    firstMs,
    lastMs,
    sessions,
    avgSessionMessages: sessions > 0 ? total / sessions : 0,
    initiations: { you: initYou, them: initThem },
    replyLatency: { you: latencyStat(youLatency), them: latencyStat(themLatency) },
    avgWordsPerMessage: {
      you: youMsgs > 0 ? youWords / youMsgs : 0,
      them: themMsgs > 0 ? themWords / themMsgs : 0,
    },
    lateNightShare: total > 0 ? lateNight / total : 0,
    weRatio: pronounDenom > 0 ? pWe / pronounDenom : null,
    questionShare: {
      you: youMsgs > 0 ? youQuestions / youMsgs : 0,
      them: themMsgs > 0 ? themQuestions / themMsgs : 0,
    },
    topEmoji,
    longestStreakDays,
    longestSilenceDays,
  };

  return {
    threadId,
    generatedAt: new Date().toISOString(),
    coverageConfidence: threadRow?.cc ?? 1,
    coverageNote: threadRow?.cn ?? null,
    sentimentAvailable: total > 0 && englishEligibleTotal / total > SENTIMENT_MIN_ENGLISH_SHARE,
    daily: dailyArr,
    hourDay,
    summary,
  };
}
