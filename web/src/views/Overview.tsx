// Between — the deterministic Overview (Phase 1 hero surface). Fetches the
// cached Tier-1 metrics for a thread and composes, top to bottom: the Sentiment
// River, a Report-Card row of StatCards, the Emotional-Weather calendar, the
// weekday×hour rhythm grid, and the Moments shelf. Zero LLM involvement — every
// number is counted, not interpreted. Coverage honesty rides on top (§2.1a).
//
// Voice: facts are stated plainly; feelings are offered gently and never as
// pass/fail (Addendum A.6). No red/green anywhere — amber↔slate only.
import { useCallback, useEffect, useState } from 'react';
import type { DailyPoint, DrainStatus, EmotionSeries, MetricsBundle } from '../lib/api';
import { getMetrics, getEmotionSeries, getDrainStatus } from '../lib/api';
import { formatCount } from '../lib/format';
import { VOICE_INTERIM } from '../lib/voice';
import { Monogram } from '../components/Monogram';
import { CoverageNotice } from '../components/Coverage';
import { MomentsShelf } from '../components/MomentsShelf';
import { StatCard } from '../components/StatCard';
import { SentimentRiver } from '../components/SentimentRiver';
import { riverSource, readState } from '../lib/riverSource';
import { CalendarHeatmap } from '../components/CalendarHeatmap';
import { HourDayHeatmap } from '../components/HourDayHeatmap';
import { AnalyzePanel } from '../components/AnalyzePanel';
import { DrainProgress } from '../components/DrainProgress';
import type { ThreadSummary } from '../lib/api';

// Interim, in-register copy (VOICE §6 has no metrics-load strings yet).
const LOADING = 'Reading the shape of these years…';
const LOAD_ERROR =
  'The numbers did not come through. The conversation is still here — try again in a moment.';

interface OverviewProps {
  thread: ThreadSummary;
  /** Drill from an L1 window/receipt to the transcript at a message id. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

// Overlay the L1 emotion read onto the deterministic daily series — but ONLY when the model has
// actually read enough of the thread to be the reading (riverSource, P1-7). Before v0.3.0 any L1
// result at all promoted the model layer, so a thread read 60% through drew as a complete close
// reading: the unscored days simply carried lexicon values, and the chart gave no sign which was
// which. Below the floor the deterministic layer stands on its own and the caption says so.
function mergeEmotion(daily: DailyPoint[], emotion: EmotionSeries | null): {
  daily: DailyPoint[]; sentimentAvailable: boolean; coverageNote: string | null;
} {
  const source = emotion ? riverSource(emotion) : { layer: 'deterministic' as const, note: null };
  if (source.layer !== 'model' || !emotion || !Array.isArray(emotion.daily) || emotion.daily.length === 0) {
    return { daily, sentimentAvailable: false, coverageNote: source.note };
  }
  const byDate = new Map(emotion.daily.map((d) => [d.date, d]));
  const merged = daily.map((d) => {
    const e = byDate.get(d.date);
    if (!e) return d;
    return { ...d, warmth: e.warmth, tension: e.tension, sentiment: e.valence };
  });
  return { daily: merged, sentimentAvailable: true, coverageNote: source.note };
}

// ── plain-language formatters ────────────────────────────────────────────────

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Latency in human units — minutes, hours, or a day (Addendum §5.2). */
function humanDuration(minutes: number | null): string {
  if (minutes == null) return '—';
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return hours < 2 ? `${hours.toFixed(1)} hr` : `${Math.round(hours)} hr`;
  const days = hours / 24;
  return days < 2 ? 'about a day' : `${Math.round(days)} days`;
}

/** A gentle warmth phrase from the amber/slate balance. Never a grade. */
function warmthPhrase(avgWarmth: number, avgTension: number): string {
  const total = avgWarmth + avgTension;
  if (total <= 1e-6) return 'even weather';
  const r = avgWarmth / total;
  if (r > 0.62) return 'mostly warm';
  if (r > 0.54) return 'warm, with weather';
  if (r > 0.46) return 'even weather';
  if (r > 0.38) return 'more slate than amber';
  return 'a cooler stretch';
}

/** Steadiness from day-to-day sentiment movement (mean absolute change). */
function steadinessPhrase(daily: MetricsBundle['daily']): string {
  const vals: number[] = [];
  for (const d of daily) if (d.sentiment != null && d.count > 0) vals.push(d.sentiment);
  if (vals.length < 5) return 'too little to say';
  let sum = 0;
  for (let i = 1; i < vals.length; i++) sum += Math.abs(vals[i] - vals[i - 1]);
  const vol = sum / (vals.length - 1);
  if (vol < 0.18) return 'steady';
  if (vol < 0.34) return 'gentle swings';
  return 'changeable';
}

function avgOf(daily: MetricsBundle['daily'], key: 'warmth' | 'tension'): number {
  let sum = 0;
  let n = 0;
  for (const d of daily) {
    if (d.count > 0) { sum += d[key]; n++; }
  }
  return n > 0 ? sum / n : 0;
}

// ── the view ─────────────────────────────────────────────────────────────────

export function Overview({ thread }: OverviewProps) {
  const [bundle, setBundle] = useState<MetricsBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emotion, setEmotion] = useState<EmotionSeries | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [run, setRun] = useState<DrainStatus | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setBundle(null);
    getMetrics(thread.id, ctrl.signal)
      .then((b) => setBundle(b))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  // The L1 emotion read (feeds the river) + resume any in-flight drain. Both are
  // best-effort: their absence just means "not read yet", never an error.
  const loadEmotion = useCallback((signal?: AbortSignal) => {
    getEmotionSeries(thread.id, signal).then(setEmotion).catch(() => { /* not read yet */ });
  }, [thread.id]);

  useEffect(() => {
    const ctrl = new AbortController();
    setEmotion(null);
    setRun(null);
    setAnalyzing(false);
    loadEmotion(ctrl.signal);
    getDrainStatus(thread.id, 'l1_emotion', ctrl.signal)
      .then((s) => { if (s.total > 0 && s.remaining > 0) setRun(s); })
      .catch(() => { /* no run in flight */ });
    return () => ctrl.abort();
  }, [thread.id, loadEmotion]);

  return (
    <div className="overview" tabIndex={-1}>
      <header className="thread-header">
        <Monogram name={thread.displayName} size={40} />
        <div className="thread-header-text">
          <h1 className="thread-header-name">{thread.displayName}</h1>
          <p className="thread-header-sub tnum">
            {formatCount(thread.messageCount)} messages
          </p>
        </div>
      </header>

      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : bundle ? (
          <OverviewBody
            thread={thread}
            bundle={bundle}
            emotion={emotion}
            run={run}
            onAnalyze={() => setAnalyzing(true)}
            onRunComplete={() => loadEmotion()}
            onDismissRun={() => setRun(null)}
          />
        ) : null}
      </div>

      {analyzing && (
        <AnalyzePanel
          threadId={thread.id}
          mode="emotion"
          displayName={thread.displayName}
          onClose={() => setAnalyzing(false)}
          onBegan={(status) => { setAnalyzing(false); setRun(status); }}
        />
      )}
    </div>
  );
}

interface OverviewBodyProps {
  thread: ThreadSummary;
  bundle: MetricsBundle;
  emotion: EmotionSeries | null;
  run: DrainStatus | null;
  onAnalyze: () => void;
  onRunComplete: () => void;
  onDismissRun: () => void;
}

function OverviewBody({
  thread, bundle, emotion, run, onAnalyze, onRunComplete, onDismissRun,
}: OverviewBodyProps) {
  const { summary, daily: rawDaily, hourDay, coverageConfidence, coverageNote } = bundle;
  const them = thread.displayName.split(/\s+/)[0] || 'Them';

  // The river prefers the L1 close reading when it exists; else the lexicon read.
  const { daily, sentimentAvailable: emotionSentiment, coverageNote: modelCoverageNote } = mergeEmotion(rawDaily, emotion);
  const sentimentAvailable = emotionSentiment || bundle.sentimentAvailable;
  // The SAME decision the chart makes. These were allowed to disagree: the invite claimed a close
  // reading whenever a single window had been drained, directly above a chart the gate had demoted to
  // the deterministic layer and captioned as such.
  const read = readState(emotion);

  const avgWarmth = avgOf(daily, 'warmth');
  const avgTension = avgOf(daily, 'tension');
  const initTotal = summary.initiations.you + summary.initiations.them;
  const topEmoji = summary.topEmoji[0] ?? null;
  const hasHourDay = hourDay.some((c) => c.count > 0);

  return (
    <div className="overview-inner">
      <CoverageNotice confidence={coverageConfidence} note={coverageNote} />

      {/* a reading in flight — honest, resumable progress rides above the hero */}
      {run && (
        <DrainProgress
          threadId={thread.id}
          lens="l1_emotion"
          initialStatus={run}
          onComplete={onRunComplete}
          onDismiss={onDismissRun}
        />
      )}

      {/* the on-demand-read invite — estimate FIRST (opens AnalyzePanel) */}
      {!run && (
        <div className={`read-invite${read === 'read' ? ' read-invite--done' : ''}`}>
          <div className="read-invite-text">
            <p className="read-invite-title">{VOICE_INTERIM.analyzeInvite}</p>
            <p className="read-invite-sub">
              {read === 'read'
                ? 'This river is drawn from a close reading. You can read more, or read it again.'
                : read === 'partial'
                  ? 'Part of this thread has been read closely — not enough of it yet for the river to lean on. Reading more would change what you see above.'
                  : VOICE_INTERIM.analyzeInviteSub}
            </p>
          </div>
          <button type="button" className="btn btn--primary" onClick={onAnalyze}>
            {read === 'unread' ? VOICE_INTERIM.analyzeInvite : 'Read more'}
          </button>
        </div>
      )}

      {/* 1 — the hero */}
      <section className="ov-section ov-section--river" aria-label="Sentiment river">
        <SentimentRiver
          daily={daily}
          sentimentAvailable={sentimentAvailable}
          coverageConfidence={coverageConfidence}
        />
        {/* Which layer you are looking at, said quietly and in both directions — a river drawn from a
            partial reading must never be indistinguishable from one drawn from a complete one. */}
        {modelCoverageNote && <p className="river-coverage-note">{modelCoverageNote}</p>}
      </section>

      {/* 2 — the report card */}
      <section className="ov-section" aria-label="Report card">
        <div className="statcards">
          <StatCard
            label="The feel"
            tone="warmth"
            value={sentimentAvailable ? warmthPhrase(avgWarmth, avgTension) : 'volume only'}
            detail={sentimentAvailable ? steadinessPhrase(daily) : 'not enough English to read'}
            title="A gentle read of the amber/slate balance across the whole thread."
          />
          <StatCard
            label="Who reaches first"
            value={initTotal > 0
              ? <>You {pct(summary.initiations.you / initTotal)} · {them} {pct(summary.initiations.them / initTotal)}</>
              : '—'}
            detail={`${formatCount(summary.sessions)} conversations opened`}
            title="Who sends the first message when a new conversation begins."
          />
          <StatCard
            label="Reply time"
            value={<>You {humanDuration(summary.replyLatency.you.medianMinutes)} · {them} {humanDuration(summary.replyLatency.them.medianMinutes)}</>}
            detail="a typical reply"
            tone="tension"
            title="Median time to reply across turns. Coverage-gated — SMS/MMS only."
          />
          <StatCard
            label="Sent & received"
            value={<>{formatCount(summary.outCount)} · {formatCount(summary.inCount)}</>}
            detail={`${pct(summary.sentShare)} of it from you`}
            title="Outgoing and incoming messages, reactions excluded."
          />
          <StatCard
            label="Conversations"
            value={formatCount(summary.sessions)}
            detail={`~${formatCount(Math.round(summary.avgSessionMessages))} messages each`}
            title="Gap-segmented conversation sessions."
          />
          <StatCard
            label="Late-night"
            value={pct(summary.lateNightShare)}
            detail="sent after midnight"
            tone="tension"
            title="Share of messages sent between midnight and 5am (UTC)."
          />
          <StatCard
            label="Words per message"
            value={<>You {formatCount(Math.round(summary.avgWordsPerMessage.you))} · {them} {formatCount(Math.round(summary.avgWordsPerMessage.them))}</>}
            detail="on average"
            title="Mean words per message, each direction."
          />
          <StatCard
            label="Most-used emoji"
            tone="warmth"
            value={topEmoji ? <span className="statcard-emoji">{topEmoji.emoji}</span> : '—'}
            detail={topEmoji ? `${formatCount(topEmoji.count)} times` : 'none found'}
            title="The single most-sent emoji across the thread."
          />
          <StatCard
            label="Rhythm"
            value={<>{formatCount(summary.longestStreakDays)}-day streak</>}
            detail={coverageConfidence < 1
              ? 'longest run of days in a row'
              : `longest quiet: ${formatCount(summary.longestSilenceDays)} days`}
            title="Longest unbroken run of days with messages (and the longest gap)."
          />
        </div>
      </section>

      {/* 3 — emotional weather */}
      {daily.length > 0 && (
        <section className="ov-section" aria-label="Emotional weather calendar">
          <div className="ov-head">
            <h2 className="ov-title">Emotional weather</h2>
            <p className="ov-sub">Each day, colored by its words — amber for warmth, slate for tension.</p>
          </div>
          <CalendarHeatmap daily={daily} sentimentAvailable={sentimentAvailable} />
        </section>
      )}

      {/* 4 — rhythm */}
      {hasHourDay && (
        <section className="ov-section" aria-label="When you talk">
          <div className="ov-head">
            <h2 className="ov-title">When you two talk</h2>
            <p className="ov-sub">How often, by day of the week and hour.</p>
          </div>
          <HourDayHeatmap hourDay={hourDay} />
        </section>
      )}

      {/* 5 — moments */}
      <section className="ov-section ov-section--moments" aria-label="Moments worth remembering">
        <MomentsShelf threadId={thread.id} />
      </section>
    </div>
  );
}
