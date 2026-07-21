// Between — the Eras view. Fetches the thread's trajectory and renders its
// named seasons as a time-ordered stack of cards: the arc of the relationship,
// told in chapters. Each era carries a span, a month count, optional summary
// prose, and a small strip of counted stats (hostility shares, initiation,
// reciprocation, repair latency). No LLM at read time — the eras are computed;
// the summaries, where present, were written earlier and frozen.
//
// Voice: seasons are named, never graded. No red/green — amber for warmth and
// "you" (the owner), slate for tension and the other person, clay only at the
// far edge of severity. Empty or zero data is stated plainly, never invented.
import { useEffect, useState } from 'react';
import type { Era, ThreadSummary, Trajectory } from '../lib/api';
import { getTrajectory } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Tracing the arc of these years…';
const LOAD_ERROR =
  'The trajectory did not come through. The conversation is still here — try again in a moment.';
const EMPTY =
  'Not enough of a span yet to name its seasons. As the years accumulate, the arc will surface here.';

interface ErasProps {
  thread: ThreadSummary;
  /** Drill from an era to the transcript at a message id (unused here for now). */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

// ── formatters ───────────────────────────────────────────────────────────────

/** A UTC YYYY-MM label for an epoch-ms instant. */
function ym(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** The span as "YYYY-MM to YYYY-MM"; a single month collapses to one label. */
function spanLabel(startMs: number, endMs: number): string {
  const a = ym(startMs);
  const b = ym(endMs);
  return a === b ? a : `${a} to ${b}`;
}

/** A months count in plain words. */
function monthsLabel(months: number): string {
  const n = Math.max(0, Math.round(months));
  if (n <= 0) return 'under a month';
  if (n === 1) return '1 month';
  if (n < 12) return `${n} months`;
  const years = n / 12;
  const rounded = Math.round(years * 10) / 10;
  const yLabel = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${n} months · ~${yLabel} yr`;
}

/** A fallback era name from its span, when the season went unnamed. */
function fallbackName(startMs: number, endMs: number): string {
  return `The season of ${spanLabel(startMs, endMs)}`;
}

function pct(x: number | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—';
  return `${Math.round(x * 100)}%`;
}

/** Repair latency in hours, plainly. */
function hoursLabel(h: number | undefined): string {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h <= 0) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return h < 10 ? `${(Math.round(h * 10) / 10).toFixed(1)} hr` : `${Math.round(h)} hr`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The left-border tint for a card, from the other person's hostile share. Amber when they are
 * calm, sliding toward slate as tension rises, and to clay at the far edge.
 * Never red/green — this is emotional data, not pass/fail.
 */
function edgeTint(hostShareThem: number | undefined): string {
  const v = hostShareThem == null || !Number.isFinite(hostShareThem) ? 0 : hostShareThem;
  if (v >= 0.5) return 'var(--clay)';
  if (v >= 0.2) return 'var(--tension)';
  return 'var(--warmth)';
}

// ── the view ─────────────────────────────────────────────────────────────────

export function Eras({ thread, onOpenReceipt }: ErasProps) {
  void onOpenReceipt; // reserved: eras don't drill to a single receipt yet
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setTrajectory(null);
    getTrajectory(thread.id, ctrl.signal)
      .then((t) => setTrajectory(t))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  const them = thread.displayName.split(/\s+/)[0] || 'Them';
  const eras: Era[] = trajectory?.eras ?? [];
  // Time-ordered — earliest season first.
  const ordered = [...eras].sort((a, b) => a.startMs - b.startMs);

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : (
          <div className="overview-inner">
            <section className="ov-section">
              <div className="ov-head">
                <h2 className="ov-title">Eras</h2>
                <p className="ov-sub">
                  The arc of the relationship, told in its seasons — each a stretch of months
                  with its own weather.
                </p>
              </div>

              {ordered.length === 0 ? (
                <p className="overview-status">{EMPTY}</p>
              ) : (
                <div className="eras-stack">
                  {ordered.map((era, i) => (
                    <EraCard key={`${era.startMs}-${era.endMs}-${i}`} era={era} them={them} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

interface EraCardProps {
  era: Era;
  them: string;
}

function EraCard({ era, them }: EraCardProps) {
  const name = era.name && era.name.trim().length > 0
    ? era.name
    : fallbackName(era.startMs, era.endMs);
  const summary = era.summary && era.summary.trim().length > 0 ? era.summary : null;

  const s = era.stats ?? {};
  const hostShareThem = s.hostShareThem;
  const hostShareMe = s.hostShareMe;
  const themInitShare = s.themInitShare;
  const recipRate = s.recipRate;
  const repairLatencyH = s.repairLatencyH;

  return (
    <article
      className="era-card"
      style={{
        borderLeft: `3px solid ${edgeTint(hostShareThem)}`,
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderLeftWidth: '3px',
        borderLeftColor: edgeTint(hostShareThem),
        borderRadius: 'var(--radius)',
        padding: '1rem 1.1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
      }}
    >
      <header style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
        <h3
          style={{
            margin: 0,
            fontSize: '1.05rem',
            fontWeight: 600,
            color: 'var(--ink)',
            lineHeight: 1.25,
          }}
        >
          {name}
        </h3>
        <p
          className="tnum"
          style={{
            margin: 0,
            fontSize: '0.82rem',
            color: 'var(--ink-soft)',
          }}
        >
          <span>{spanLabel(era.startMs, era.endMs)}</span>
          <span style={{ color: 'var(--ink-faint)' }}> · </span>
          <span>{monthsLabel(era.months)}</span>
        </p>
      </header>

      {summary && (
        <p
          style={{
            margin: 0,
            fontSize: '0.92rem',
            lineHeight: 1.55,
            color: 'var(--ink-soft)',
          }}
        >
          {summary}
        </p>
      )}

      <div className="statcards">
        <StatCard
          label={`${them}'s hostile share`}
          value={<span className="tnum">{pct(hostShareThem)}</span>}
          tone="tension"
          title={`Share of ${them}'s messages in this season read as hostile.`}
        />
        <StatCard
          label="Your hostile share"
          value={<span className="tnum">{pct(hostShareMe)}</span>}
          tone="warmth"
          title="Share of your messages in this season read as hostile."
        />
        <StatCard
          label={`${them} initiates`}
          value={<span className="tnum">{pct(themInitShare)}</span>}
          tone="neutral"
          title={`Share of conversations in this season that ${them} opened.`}
        />
        <StatCard
          label="Your reciprocation"
          value={<span className="tnum">{pct(recipRate)}</span>}
          tone="neutral"
          title="How often you answered warmth with warmth (or heat with heat) in this season."
        />
        <StatCard
          label="Repair hrs"
          value={<span className="tnum">{hoursLabel(repairLatencyH)}</span>}
          detail="typical time to mend"
          tone="neutral"
          title="Typical hours between a rupture and its repair in this season."
        />
      </div>
    </article>
  );
}
