// Between — Phase 1 metrics (Tier 1) contract. Shared shape for the metrics API and the
// Overview UI (the web client mirrors these types, per its own tsconfig boundary).
// "you" = the owner (outgoing); "them" = the counterpart (incoming). All lexicon sentiment
// is English-gated (GAMEPLAN §2.2a): non-English messages are excluded from sentiment.

export interface DailyPoint {
  date: string;         // YYYY-MM-DD (UTC)
  count: number;        // non-reaction messages that day
  outCount: number;
  inCount: number;
  sentiment: number | null; // mean VADER compound over that day's English messages; null if none
  warmth: number;       // 0..1 positive mass — river fill above the baseline
  tension: number;      // 0..1 negative mass — river fill below the baseline
  englishShare: number; // 0..1 of that day's messages classified English
}

export interface HeatCell {
  dow: number;  // 0=Sunday .. 6=Saturday (UTC)
  hour: number; // 0..23 (UTC)
  count: number;
}

export interface LatencyStat {
  medianMinutes: number | null;
  p90Minutes: number | null;
}

export interface MetricsSummary {
  totalMessages: number;
  outCount: number;
  inCount: number;
  sentShare: number;        // outCount / totalMessages
  activeDays: number;
  firstMs: number | null;
  lastMs: number | null;
  sessions: number;         // gap-segmented conversations (config sessionGapMinutes)
  avgSessionMessages: number;
  initiations: { you: number; them: number };      // who sends the first message of a session
  replyLatency: { you: LatencyStat; them: LatencyStat }; // cross-party turn latency
  avgWordsPerMessage: { you: number; them: number };
  lateNightShare: number;   // 0..1 of messages sent 00:00–04:59 (UTC)
  weRatio: number | null;   // we / (i + you + we) over English messages
  questionShare: { you: number; them: number };    // fraction of messages containing '?'
  topEmoji: { emoji: string; count: number }[];    // up to 8
  longestStreakDays: number;
  longestSilenceDays: number;
}

export interface MetricsBundle {
  threadId: number;
  generatedAt: string;      // ISO
  coverageConfidence: number;
  coverageNote: string | null;
  sentimentAvailable: boolean; // false when English share is too low to trust lexicon sentiment
  daily: DailyPoint[];
  hourDay: HeatCell[];
  summary: MetricsSummary;
}
