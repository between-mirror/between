// Between — typed browser API client for Phase 0 (browse / search).
//
// The DTO shapes below MIRROR server/src/types.ts (the single source of truth).
// They are re-declared here rather than imported because `web` is a separate
// package with its own tsconfig `include: ["src"]`; reaching across the package
// boundary into server source would drag server-only code into the web program.
// If a server DTO changes, mirror the change here. (Verify phase: watch this.)

// ── unions (mirror of types.ts) ─────────────────────────────────────────────
export type Direction = 'incoming' | 'outgoing' | 'draft' | 'other';
export type MsgKind = 'sms' | 'mms';
export type ReactionKind =
  | 'liked' | 'loved' | 'emphasized' | 'laughed' | 'disliked' | 'questioned';

// ── read-side DTOs (mirror of types.ts §"API DTOs") ─────────────────────────
export interface ThreadSummary {
  id: number;
  title: string | null;
  isGroup: boolean;
  displayName: string;
  messageCount: number;
  firstMs: number | null;
  lastMs: number | null;
  coverageConfidence: number;
  coverageNote: string | null;
  sentCount: number;
  receivedCount: number;
}

export interface MessageDTO {
  id: number;
  direction: Direction;
  kind: MsgKind;
  sentAtMs: number;
  bodyText: string | null;
  isReaction: boolean;
  reactionKind: ReactionKind | null;
  senderName: string | null;
  attachmentCount: number;
}

export interface SearchHit {
  messageId: number;
  threadId: number;
  threadName: string;
  sentAtMs: number;
  direction: Direction;
  snippet: string;
}

export interface MomentDTO {
  key: string;
  label: string;
  value: string;
  messageIds: number[];
}

// ── onboarding meta (NOT in types.ts — served by GET /api/meta/onboarding) ──
// The archive-scale numbers for the awe-before-paperwork threshold. The web
// client is tolerant about field names so it survives small server variations.
export interface OnboardingMeta {
  onboarded: boolean;
  contactCount: number;
  messageCount: number;
  firstMs: number | null;
  lastMs: number | null;
}

// ── error type ──────────────────────────────────────────────────────────────
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API_BASE = '/api';

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, `Network error reaching ${path}`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText} — ${path}`);
  }
  return (await res.json()) as T;
}

async function postJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, `Network error reaching ${path}`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText} — ${path}`);
  }
  return (await res.json()) as T;
}

async function putJSON<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'PUT',
      signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, `Network error reaching ${path}`);
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText} — ${path}`);
  return (await res.json()) as T;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Accepts a few plausible field aliases so the threshold still gets real
// numbers regardless of the exact server payload shape.
function normalizeOnboarding(raw: unknown): OnboardingMeta {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = num(r[k]);
      if (v != null) return v;
    }
    return null;
  };
  return {
    onboarded: Boolean(r.onboarded ?? r.isOnboarded ?? r.complete ?? false),
    contactCount: pick('contactCount', 'contacts', 'peopleCount', 'people') ?? 0,
    messageCount: pick('messageCount', 'messages', 'totalMessages') ?? 0,
    firstMs: pick('firstMs', 'spanStartMs', 'startMs', 'minMs'),
    lastMs: pick('lastMs', 'spanEndMs', 'endMs', 'maxMs'),
  };
}

// ── endpoints ────────────────────────────────────────────────────────────────
export function getOnboarding(signal?: AbortSignal): Promise<OnboardingMeta> {
  return getJSON<unknown>('/meta/onboarding', signal).then(normalizeOnboarding);
}

export function getThreads(signal?: AbortSignal): Promise<ThreadSummary[]> {
  return getJSON<ThreadSummary[]>('/threads', signal);
}

export interface GetMessagesParams {
  /** Load messages strictly older than this epoch-ms cursor (pagination). */
  before?: number;
  limit?: number;
}

export function getMessages(
  threadId: number,
  params: GetMessagesParams = {},
  signal?: AbortSignal,
): Promise<MessageDTO[]> {
  const q = new URLSearchParams();
  if (params.before != null) q.set('before', String(params.before));
  q.set('limit', String(params.limit ?? 150));
  const qs = q.toString();
  return getJSON<MessageDTO[]>(`/threads/${threadId}/messages?${qs}`, signal);
}

export function getMoments(threadId: number, signal?: AbortSignal): Promise<MomentDTO[]> {
  return getJSON<MomentDTO[]>(`/threads/${threadId}/moments`, signal);
}

export interface SearchParams {
  /** When set, scope search to a single thread; omit for everyone. */
  threadId?: number;
  limit?: number;
}

export function search(
  q: string,
  params: SearchParams = {},
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const query = new URLSearchParams();
  query.set('q', q);
  if (params.threadId != null) query.set('threadId', String(params.threadId));
  if (params.limit != null) query.set('limit', String(params.limit));
  return getJSON<SearchHit[]>(`/search?${query.toString()}`, signal);
}

// ── Phase 1 metrics (mirror of server/src/metrics/contract.ts) ───────────────
// Deterministic Tier-1 metrics + the daily series that feeds the Sentiment River.
// Mirrored here (not imported) for the same package-boundary reason as the DTOs
// above. If server/src/metrics/contract.ts changes, mirror it here. "you" = the
// owner (outgoing); "them" = the counterpart (incoming).

export interface DailyPoint {
  date: string;         // YYYY-MM-DD (UTC)
  count: number;        // non-reaction messages that day
  outCount: number;
  inCount: number;
  sentiment: number | null; // mean VADER compound over the day's English messages; null if none
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
  sessions: number;         // gap-segmented conversations
  avgSessionMessages: number;
  initiations: { you: number; them: number };
  replyLatency: { you: LatencyStat; them: LatencyStat };
  avgWordsPerMessage: { you: number; them: number };
  lateNightShare: number;   // 0..1 of messages sent 00:00–04:59 (UTC)
  weRatio: number | null;   // we / (i + you + we) over English messages
  questionShare: { you: number; them: number };
  topEmoji: { emoji: string; count: number }[];
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

export function getMetrics(threadId: number, signal?: AbortSignal): Promise<MetricsBundle> {
  return getJSON<MetricsBundle>(`/threads/${threadId}/metrics`, signal);
}

// Fallback when /api/meta/onboarding is unavailable: derive scale from threads.
export function deriveOnboardingFromThreads(threads: ThreadSummary[]): OnboardingMeta {
  let messageCount = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const t of threads) {
    messageCount += t.messageCount ?? 0;
    if (t.firstMs != null) firstMs = firstMs == null ? t.firstMs : Math.min(firstMs, t.firstMs);
    if (t.lastMs != null) lastMs = lastMs == null ? t.lastMs : Math.max(lastMs, t.lastMs);
  }
  return {
    onboarded: false,
    contactCount: threads.length,
    messageCount,
    firstMs,
    lastMs,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 2 — the airlock (on-demand analysis), the L1 emotion lens, reflections.
//
// CROSS-MODULE CONTRACT (Verify: confirm against server/src/api routes):
// The app is the SOLE SQLite writer and NEVER auto-drains (SPECS/airlock.md,
// invariant 2). This client only: (1) asks the planner for a capacity estimate,
// (2) commits a run (the app plans jobs into airlock/jobs/), (3) reads honest
// drain status, (4) ingests results on an EXPLICIT, awaited call — the user's
// action, standing in for "awaited subprocess completion", never a file watcher,
// never a poll that mutates. Reflections are frozen + dated; regeneration is a
// new row (never a mutation).
//
// Endpoints assumed (flag to Verify if the server names differ):
//   GET  /threads/:id/emotion                 → EmotionSeries (L1, feeds river)
//   POST /threads/:id/analysis/plan           → AnalysisPlan  (estimate only)
//   POST /threads/:id/analysis/run            → DrainStatus   (commits jobs)
//   GET  /threads/:id/analysis/status?lens=   → DrainStatus
//   POST /threads/:id/analysis/ingest         → IngestOutcome (awaited ingest)
//   GET  /threads/:id/reflections             → ReflectionSummary[]
//   POST /threads/:id/reflections/plan        → AnalysisPlan  (estimate + gates)
//   POST /threads/:id/reflections/run         → DrainStatus   (reduce+render jobs)
//   GET  /reflections/:id                     → ReflectionDTO
//   GET  /messages?ids=1,2,3                  → MessageDTO[]   (receipt resolve)
//   POST /overrides                           → { ok: true }   ("that's not right")
// ════════════════════════════════════════════════════════════════════════════

export type AnalysisLens = 'l1_emotion' | 'first_reflection';

/** Per-day L1 emotion aggregate that supersedes the lexicon river when present. */
export interface EmotionDay {
  date: string;          // YYYY-MM-DD (UTC)
  count: number;         // substantive, scored messages that day
  warmth: number;        // 0..1 — river fill above the baseline
  tension: number;       // 0..1 — river fill below the baseline
  valence: number | null; // -1..1 overall tone, null if nothing scored
}

export interface EmotionSeries {
  threadId: number;
  available: boolean;      // false when no L1 results exist yet (ask-to-read)
  scoredWindows: number;
  totalWindows: number;
  refusedWindows: number;  // surfaced honestly, never a silent gap
  erroredWindows: number;  // same

  // ── thread-level model coverage (P1-7) ────────────────────────────────────
  // These gate the chart, they do not merely annotate it. An unscored message reads as neutral, so a
  // partly-read thread looks calm rather than thin; see lib/riverSource.ts for the one decision that
  // consumes them.
  eligibleMessages: number;  // substantive (non-reaction, non-empty) messages in the thread
  scoredMessages: number;    // how many of those carry a model score
  coveragePct: number;       // 0..100, rounded — for display only
  modelComplete: boolean;    // scoredMessages/eligibleMessages >= 0.95, from the exact ratio

  daily: EmotionDay[];
  generatedAt: string | null;
}

export interface AnalysisPlanParams {
  rangeStartMs?: number;
  rangeEndMs?: number;
}

export type EngineMode = 'local-only' | 'subscription' | 'api-key';

/** The dollars + engine-mode read shown before any paid work (P3, the "$30→$44 lesson"). */
export interface ReadCost {
  engineMode: EngineMode;
  model: string;
  spends: boolean;          // true only when this run would actually bill an API key
  usdLow: number | null;
  usdHigh: number | null;
  measured: boolean;        // estimate used the owner's recorded token priors
  note: string;
}

/** The capacity estimate shown BEFORE any run (invariant 6). No work is done. */
export interface AnalysisPlan {
  lens: AnalysisLens;
  threadId: number;
  rangeStartMs: number | null;
  rangeEndMs: number | null;
  substantiveCount: number; // messages in range that actually count
  windowCount: number;      // stretches the range needs read
  newCount: number;         // windows with no cached result
  cachedCount: number;      // windows already read — never read twice
  drainCount: number;       // estimated drain sittings for the new work
  timeEstimateText: string; // human "roughly …" phrase (server-authored)
  belowFloor: boolean;      // too little for an honest reading (§6 decline)
  griefMode: boolean;       // contact marked deceased — reflection suppressed
  cost: ReadCost;           // dollars + engine mode for this run
}

export interface EngineModeState { mode: EngineMode; paidBatchAllowed: boolean }
export function getEngineMode(signal?: AbortSignal): Promise<EngineModeState> {
  return getJSON<EngineModeState>('/engine-mode', signal);
}
export function setEngineMode(mode: EngineMode, signal?: AbortSignal): Promise<EngineModeState> {
  return putJSON<EngineModeState>('/engine-mode', { mode }, signal);
}

/** Honest, resumable drain state. Counts, never a mood-spinner. */
export interface DrainStatus {
  threadId: number;
  lens: AnalysisLens;
  total: number;       // jobs in this run
  done: number;        // freshly read this run
  cached: number;      // resolved from cache (no work)
  remaining: number;   // still needing a drain pass
  errored: number;
  refused: number;     // "couldn't score this stretch"
  etaSeconds: number | null;
  drainsRemaining: number | null;
  updatedAt: string | null;
}

export interface IngestOutcome {
  status: DrainStatus;
  newCount: number;    // freshly ingested on this awaited check
  cachedCount: number; // remembered from before
}

export interface ReflectionClaim {
  id: string;                 // stable ref for overrides (server-provided hash)
  fragment: string;           // the letter sentence-fragment this grounds
  evidenceIds: number[];      // numeric message ids — every one must resolve
  confidence: 'surer' | 'less_sure' | null;
}

export interface ReflectionSummary {
  id: number;
  threadId: number;
  lens: string;               // 'first_reflection' | 'letter' | ...
  rangeStartMs: number;
  rangeEndMs: number;
  generatedAt: string;        // ISO — the letter is dated and frozen
  promptVersion: number;
  title: string | null;
}

export interface ReflectionDTO extends ReflectionSummary {
  contentMd: string;          // the frozen prose (markdown)
  claims: ReflectionClaim[];  // claim → receipts map
  modelNote: string | null;
}

// ── normalizers (tolerant of small server-shape variation) ───────────────────
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function intIds(v: unknown): number[] {
  return arr<unknown>(v)
    .map((x) => {
      if (typeof x === 'number' && Number.isInteger(x)) return x;
      if (typeof x === 'string') {
        const m = /(\d+)/.exec(x); // tolerate "mNNNN" or "NNNN"
        if (m) return Number(m[1]);
      }
      return null;
    })
    .filter((n): n is number => n != null);
}

function normalizeDrainStatus(raw: unknown, threadId: number, lens: AnalysisLens): DrainStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    threadId,
    lens,
    total: numOr(r.total, 0),
    done: numOr(r.done, 0),
    cached: numOr(r.cached, 0),
    remaining: numOr(r.remaining, 0),
    errored: numOr(r.errored, 0),
    refused: numOr(r.refused, 0),
    etaSeconds: num(r.etaSeconds),
    drainsRemaining: num(r.drainsRemaining),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
  };
}

function normalizeReflection(raw: unknown): ReflectionDTO {
  const r = (raw ?? {}) as Record<string, unknown>;
  const claims = arr<Record<string, unknown>>(r.claims).map((c, i): ReflectionClaim => {
    const conf = c.confidence;
    return {
      id: typeof c.id === 'string' ? c.id : `claim-${i}`,
      fragment: typeof c.fragment === 'string' ? c.fragment : '',
      evidenceIds: intIds(c.evidenceIds),
      confidence: conf === 'surer' || conf === 'less_sure' ? conf : null,
    };
  });
  return {
    id: numOr(r.id, 0),
    threadId: numOr(r.threadId, 0),
    lens: typeof r.lens === 'string' ? r.lens : 'first_reflection',
    rangeStartMs: numOr(r.rangeStartMs, 0),
    rangeEndMs: numOr(r.rangeEndMs, 0),
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : '',
    promptVersion: numOr(r.promptVersion, 1),
    title: typeof r.title === 'string' ? r.title : null,
    contentMd: typeof r.contentMd === 'string' ? r.contentMd : '',
    modelNote: typeof r.modelNote === 'string' ? r.modelNote : null,
    // only claims whose receipts resolve are actionable; keep the rest for count
    claims,
  };
}

// ── endpoints ────────────────────────────────────────────────────────────────

/** L1 emotion series for the river; `available:false` until a drain has run. */
export function getEmotionSeries(threadId: number, signal?: AbortSignal): Promise<EmotionSeries> {
  return getJSON<EmotionSeries>(`/threads/${threadId}/emotion`, signal);
}

/** Capacity estimate for the L1 emotion read over an (optional) range. No work. */
export function planAnalysis(
  threadId: number,
  params: AnalysisPlanParams = {},
  signal?: AbortSignal,
): Promise<AnalysisPlan> {
  return postJSON<AnalysisPlan>(`/threads/${threadId}/analysis/plan`, params, signal);
}

/** Commit the run: the app plans jobs into airlock/jobs/. Returns initial status. */
export function beginAnalysis(
  threadId: number,
  params: AnalysisPlanParams = {},
  signal?: AbortSignal,
): Promise<DrainStatus> {
  return postJSON<unknown>(`/threads/${threadId}/analysis/run`, params, signal)
    .then((raw) => normalizeDrainStatus(raw, threadId, 'l1_emotion'));
}

export function getDrainStatus(
  threadId: number,
  lens: AnalysisLens = 'l1_emotion',
  signal?: AbortSignal,
): Promise<DrainStatus> {
  return getJSON<unknown>(`/threads/${threadId}/analysis/status?lens=${lens}`, signal)
    .then((raw) => normalizeDrainStatus(raw, threadId, lens));
}

/**
 * Ingest whatever the drain has written, on an explicit awaited call (invariant 2).
 * This stands in for "awaited subprocess completion" — the app is the sole writer.
 */
export function ingestResults(
  threadId: number,
  lens: AnalysisLens = 'l1_emotion',
  signal?: AbortSignal,
): Promise<IngestOutcome> {
  return postJSON<unknown>(`/threads/${threadId}/analysis/ingest`, { lens }, signal)
    .then((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        status: normalizeDrainStatus(r.status, threadId, lens),
        newCount: numOr(r.newCount, 0),
        cachedCount: numOr(r.cachedCount, 0),
      };
    });
}

// ── reflections (First Reflection: reduce → render → frozen row) ─────────────

export function getReflections(threadId: number, signal?: AbortSignal): Promise<ReflectionSummary[]> {
  return getJSON<ReflectionSummary[]>(`/threads/${threadId}/reflections`, signal);
}

export function getReflection(id: number, signal?: AbortSignal): Promise<ReflectionDTO> {
  return getJSON<unknown>(`/reflections/${id}`, signal).then(normalizeReflection);
}

/** Estimate + gate check for a first reading (floor, grief) before any jobs. */
export function planReflection(
  threadId: number,
  params: AnalysisPlanParams = {},
  signal?: AbortSignal,
): Promise<AnalysisPlan> {
  return postJSON<AnalysisPlan>(`/threads/${threadId}/reflections/plan`, params, signal);
}

/** Commit the reduce+render jobs for a first reading. */
export function beginReflection(
  threadId: number,
  params: AnalysisPlanParams = {},
  signal?: AbortSignal,
): Promise<DrainStatus> {
  return postJSON<unknown>(`/threads/${threadId}/reflections/run`, params, signal)
    .then((raw) => normalizeDrainStatus(raw, threadId, 'first_reflection'));
}

/** Resolve receipt message ids to their real rows (invariant 1 — receipts drill). */
export function getMessagesByIds(ids: number[], signal?: AbortSignal): Promise<MessageDTO[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return getJSON<MessageDTO[]>(`/messages?ids=${ids.join(',')}`, signal);
}

export interface OverrideInput {
  targetKind: 'claim' | 'message' | 'merge';
  targetRef: string;
  action: 'suppress' | 'correct';
  note?: string;
}

/** "That's not right" — suppress a claim; future readings will know (§5.3). */
export function postOverride(input: OverrideInput, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return postJSON<{ ok: boolean }>(`/overrides`, input, signal);
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 — trajectory, ambient, episodes, ask, all-reflections. DTOs mirror the
// server lenses (trajectory.ts / ambient.ts / episodes.ts / ask.ts). "me" = owner.
// ════════════════════════════════════════════════════════════════════════════

export interface Era { startMs: number; endMs: number; months: number; stats: Record<string, number>; name: string | null; summary: string | null }

export interface TrajectoryMonth {
  ym: string; startMs: number; endMs: number;
  volMe: number; volThem: number;
  hostileMe: number; hostileThem: number; severeMe: number; severeThem: number;
  warmMe: number; warmThem: number;
  recip: number; soft: number; withdrew: number; recipDenom: number;
}
export interface DelugeDay { date: string; herHostile: number; herTotal: number }
export interface Trajectory { threadId: number; months: TrajectoryMonth[]; eras: Era[]; delugeDays: DelugeDay[]; delugeMin: number }

export function getTrajectory(threadId: number, signal?: AbortSignal): Promise<Trajectory> {
  return getJSON<Trajectory>(`/threads/${threadId}/trajectory`, signal);
}

export interface SideN { me: number; them: number }
export interface AmbientStats {
  threadId: number; tzOffsetHours: number;
  volume: { total: number; me: number; them: number; activeDays: number; firstMs: number; lastMs: number; byYear: { year: number; me: number; them: number }[] };
  rhythm: { hourOfDay: { hour: number; me: number; them: number }[]; dayOfWeek: { dow: number; me: number; them: number }[]; busiestDay: { date: string; count: number }; longestStreakDays: number; longestSilenceDays: number };
  cadence: { medianReplyMinMe: number; medianReplyMinThem: number; firstOfDay: SideN };
  language: { topWordsMe: { w: string; n: number }[]; topWordsThem: { w: string; n: number }[]; topEmoji: { e: string; n: number }[]; avgWordsMe: number; avgWordsThem: number; questionRateMe: number; questionRateThem: number; iLoveYou: SideN };
  monthlyVolume: { ym: string; me: number; them: number }[];
  extras: { endearments: SideN; goodnight: SideN; goodmorning: SideN; apologies: SideN; doubleTextRate: SideN; lastOfDay: SideN; longestMessages: { dir: 'me' | 'them'; words: number; preview: string }[]; busiestMonths: { ym: string; count: number }[] };
}
export function getAmbient(threadId: number, tzOffsetHours?: number, signal?: AbortSignal): Promise<AmbientStats> {
  const qs = tzOffsetHours != null ? `?tz=${tzOffsetHours}` : '';
  return getJSON<AmbientStats>(`/threads/${threadId}/ambient${qs}`, signal);
}

// ── the final insight layer (A–E) ─────────────────────────────────────────────
export type Exit = 'met' | 'softened' | 'withdraw_notice' | 'withdraw_silent' | 'block_threat';
export interface LedgerEntry { id: number; ms: number; date: string; dir: 'me' | 'them'; category: 'physical' | 'death_wish'; text: string }
export interface WearSide { n: number; words: number; warmthRate: number; ilyRate: number; playfulRate: number }
export interface Findings {
  threadId: number;
  ledger: { entries: LedgerEntry[]; byDir: { physical: { me: number; them: number }; death_wish: { me: number; them: number } } };
  kidsFraming: {
    total: { myMe: number; ourMe: number; myThem: number; ourThem: number };
    byYear: { year: number; myMe: number; ourMe: number; myThem: number; ourThem: number }[];
  };
  apology: {
    firstRepairAfterPeak: { me: number; them: number; none: number };
    metWithFire: { me: { total: number; rejected: number; rate: number }; them: { total: number; rejected: number; rate: number } };
  };
  exitSignature: {
    overall: Record<Exit, number>;
    byEra: { name: string | null; startMs: number; total: number; counts: Record<Exit, number> }[];
  };
  wearingDown: { quarters: { quarter: string; startMs: number; me: WearSide; them: WearSide }[] };
}
export function getFindings(threadId: number, signal?: AbortSignal): Promise<Findings> {
  return getJSON<Findings>(`/threads/${threadId}/findings`, signal);
}

// ── calibration (P2): the owner tunes the tool to themselves, honestly ────────
export interface CalibrationStatus { calibrated: boolean; hasThresholds: boolean; hasBias: boolean; note: string }
export interface HoldoutItem { id: number; dir: 'ME' | 'THEM'; text: string; ms: number }
export type OwnerLabel = 'benign' | 'joke' | 'mild' | 'harsh' | 'cruel' | 'skip';
export interface OwnerMark { id: number; label: OwnerLabel }
export interface SelfReportBias {
  n: number; verdict: 'self_lenient' | 'balanced' | 'self_critical' | 'insufficient'; leniencyBias: number;
  ownMeanSeverity: number; otherMeanSeverity: number; gateThresholdBump: number; note: string;
}
export interface CalibrationResult { bias: SelfReportBias; thresholds: { hostile_tension: number; severe_tension: number } }

export function getCalibrationStatus(threadId: number, signal?: AbortSignal): Promise<CalibrationStatus> {
  return getJSON<CalibrationStatus>(`/threads/${threadId}/calibration`, signal);
}
export function getCalibrationSample(threadId: number, n = 40, signal?: AbortSignal): Promise<HoldoutItem[]> {
  return getJSON<HoldoutItem[]>(`/threads/${threadId}/calibration/sample?n=${n}`, signal);
}
export function submitCalibration(threadId: number, marks: OwnerMark[], signal?: AbortSignal): Promise<CalibrationResult> {
  return postJSON<CalibrationResult>(`/threads/${threadId}/calibrate`, { marks }, signal);
}

export interface EpisodeRow {
  id: number; threadId: number; startMsgId: number; endMsgId: number; startMs: number; endMs: number;
  msgCount: number; hostileMe: number; hostileThem: number; severeMe: number; severeThem: number;
  initiator: 'me' | 'them'; lastHostile: 'me' | 'them'; peakTension: number; kidNamed: boolean;
  repairedAtMs: number | null; repairedBy: 'me' | 'them' | null;
  narrative: { title?: string; note?: string } | null;
}
export function getEpisodesList(threadId: number, signal?: AbortSignal): Promise<EpisodeRow[]> {
  return getJSON<EpisodeRow[]>(`/threads/${threadId}/episodes`, signal);
}
export function getEpisode(episodeId: number, signal?: AbortSignal): Promise<{ episode: EpisodeRow; messages: MessageDTO[] }> {
  return getJSON<{ episode: EpisodeRow; messages: MessageDTO[] }>(`/episodes/${episodeId}`, signal);
}

export interface AskReceipt { id: number; ms: number; dir: 'me' | 'them'; tension: number; warmth: number; text: string }
export interface AskFilters { fromMs?: number; toMs?: number; direction?: 'me' | 'them'; minTension?: number; maxTension?: number; minWarmth?: number; kidOnly?: boolean; limit?: number }
export interface AskPlan { query: string; filters: AskFilters; count: number; receipts: AskReceipt[]; sufficient: boolean }
export function askPlan(threadId: number, query: string, filters: AskFilters = {}, signal?: AbortSignal): Promise<AskPlan> {
  return postJSON<AskPlan>(`/threads/${threadId}/ask/plan`, { query, filters }, signal);
}

/** All frozen reflections for a thread (first reading, letter, other-side, growth). */
export function getAllReflections(threadId: number, signal?: AbortSignal): Promise<ReflectionSummary[]> {
  return getJSON<ReflectionSummary[]>(`/threads/${threadId}/reflections?lens=all`, signal);
}

// ── "Your data" — the lifecycle panel (Era 1) ────────────────────────────────
// Every path here is server-derived. None of these calls names a location: this is a fixed set of
// operations on Between's own folders, never a remote file manager.

export interface DataSourceInfo {
  path: string;
  importedAt: string;
  recordCount: number | null;
  present: boolean;
  sizeBytes: number;
}

export interface DataActionLogEntry { at: string; message: string }

export interface DataOverview {
  dbPath: string;
  dbSizeBytes: number;
  dataDir: string;
  exportsDir: string;
  backupsDir: string;
  airlockDir: string;
  sources: DataSourceInfo[];
  messageCount: number;
  exportCount: number;
  transportFiles: number;
  log: DataActionLogEntry[];
}

export function getDataOverview(signal?: AbortSignal): Promise<DataOverview> {
  return getJSON<DataOverview>('/data/overview', signal);
}
export function postDataIntegrity(): Promise<{ ok: boolean; detail: string; message: string }> {
  return postJSON('/data/integrity', {});
}
export function postDataBackup(): Promise<{ path: string; sizeBytes: number; message: string }> {
  return postJSON('/data/backup', {});
}
export function postDeleteSources(): Promise<{ deleted: number; message: string }> {
  return postJSON('/data/sources/delete', {});
}
export function postPurgeTransport(): Promise<{ removed: number; message: string }> {
  return postJSON('/data/transport/purge', {});
}
export function postOpenDataFolder(): Promise<{ ok: boolean; message: string }> {
  return postJSON('/data/open-folder', {});
}
/** The typed word is checked here AND on the server — a confirmation that lives only in the client
 *  is a speed bump in someone else's browser, not a confirmation. */
export function postDeleteAll(confirmation: string): Promise<{ ok: boolean; message: string }> {
  return postJSON('/data/delete-all', { confirmation });
}
