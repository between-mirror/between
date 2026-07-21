// Between — the honest two-metric Trajectory. Two questions, drawn plainly over
// the months of a relationship: WHAT ARRIVES (how much hostility lands, and from
// whom) and HOW IT IS ANSWERED (when she is hostile, what does the owner do —
// meet it, soften, or withdraw). Zero interpretation: every bar is a count.
//
// Voice & palette (Addendum A.6 / tokens.css): amber is warmth / "you" / the
// owner; slate is tension / the other person; clay is max severity. Never a
// red, never a green — this is emotional data, not pass/fail. Calm and flat.
import { useEffect, useState } from 'react';
import type { ThreadSummary, Trajectory as TrajectoryData, TrajectoryMonth, Era, DelugeDay } from '../lib/api';
import { getTrajectory } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Tracing the shape of these years…';
const LOAD_ERROR =
  'The trajectory did not come through. The conversation is still here — try again in a moment.';
const EMPTY =
  'There is not yet enough of a read to draw a trajectory. Read more of the thread, then look again.';

interface TrajectoryProps {
  thread: ThreadSummary;
  /** Drill from a month/mark to the transcript at a message id. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

// ── small numeric helpers ─────────────────────────────────────────────────────

function n(x: number): string {
  return Math.round(x).toLocaleString();
}

/** Sum a numeric field across the months. */
function sumBy(months: TrajectoryMonth[], key: keyof TrajectoryMonth): number {
  let s = 0;
  for (const m of months) {
    const v = m[key];
    if (typeof v === 'number') s += v;
  }
  return s;
}

/** Parse a "YYYY-MM" month key into a UTC-ish timestamp (first of the month). */
function ymToMs(ym: string): number {
  const [y, mo] = ym.split('-').map((p) => Number.parseInt(p, 10));
  if (!Number.isFinite(y) || !Number.isFinite(mo)) return 0;
  return Date.UTC(y, Math.max(0, mo - 1), 1);
}

const yearFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

// ── chart geometry (shared) ───────────────────────────────────────────────────

const CHART_W = 960;
const PAD_L = 8;
const PAD_R = 8;
const PLOT_W = CHART_W - PAD_L - PAD_R;

/** x of the left edge of the i-th month column, and column width. */
function columns(count: number): { colW: number; x: (i: number) => number } {
  const colW = count > 0 ? PLOT_W / count : PLOT_W;
  return { colW, x: (i: number) => PAD_L + i * colW };
}

/** Map each month index → the era it falls in (by timestamp), for band drawing. */
function eraForMonth(m: TrajectoryMonth, eras: Era[]): Era | null {
  const t = m.startMs || ymToMs(m.ym);
  for (const e of eras) {
    if (t >= e.startMs && t <= e.endMs) return e;
  }
  return null;
}

/** Contiguous [startIdx, endIdx] spans of months sharing an era, for separators. */
interface EraSpan { era: Era; start: number; end: number }
function eraSpans(months: TrajectoryMonth[], eras: Era[]): EraSpan[] {
  const spans: EraSpan[] = [];
  let cur: EraSpan | null = null;
  months.forEach((m, i) => {
    const e = eraForMonth(m, eras);
    if (e && cur && cur.era === e) {
      cur.end = i;
    } else if (e) {
      cur = { era: e, start: i, end: i };
      spans.push(cur);
    } else {
      cur = null;
    }
  });
  return spans;
}

/** Year-boundary tick indices: the first month whose year differs from the prior. */
function yearTicks(months: TrajectoryMonth[]): { idx: number; label: string }[] {
  const ticks: { idx: number; label: string }[] = [];
  let prevYear: number | null = null;
  months.forEach((m, i) => {
    const t = m.startMs || ymToMs(m.ym);
    const yr = new Date(t).getUTCFullYear();
    if (yr !== prevYear) {
      ticks.push({ idx: i, label: yearFmt.format(new Date(t)) });
      prevYear = yr;
    }
  });
  return ticks;
}

// ── faint era-band separators + names, drawn beneath a chart's bars ────────────

function EraBands({ months, eras, height }: { months: TrajectoryMonth[]; eras: Era[]; height: number }) {
  if (eras.length === 0) return null;
  const { colW, x } = columns(months.length);
  const spans = eraSpans(months, eras);
  return (
    <g aria-hidden="true">
      {spans.map((s, i) => {
        const left = x(s.start);
        const right = x(s.end) + colW;
        const mid = (left + right) / 2;
        const showName = s.era.name != null && right - left > 56;
        return (
          <g key={`${s.era.startMs}-${i}`}>
            {/* left separator (skip the very first, it hugs the axis) */}
            {s.start > 0 && (
              <line
                x1={left} x2={left} y1={0} y2={height}
                stroke="var(--line-2)" strokeWidth={1} strokeDasharray="2 4"
              />
            )}
            {showName && (
              <text
                x={mid} y={11} textAnchor="middle"
                fontSize={10} fill="var(--ink-faint)"
                style={{ letterSpacing: '0.02em' }}
              >
                {s.era.name}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ── year ticks + gridline, shared axis chrome ─────────────────────────────────

function YearAxis({ months, height }: { months: TrajectoryMonth[]; height: number }) {
  const { x } = columns(months.length);
  const ticks = yearTicks(months);
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t.idx}>
          <line
            x1={x(t.idx)} x2={x(t.idx)} y1={height - 14} y2={height}
            stroke="var(--line)" strokeWidth={1}
          />
          <text
            x={x(t.idx) + 3} y={height - 3}
            fontSize={10} fill="var(--ink-faint)" className="tnum"
          >
            {t.label}
          </text>
        </g>
      ))}
    </g>
  );
}

// ── chart 1 — WHAT ARRIVES ─────────────────────────────────────────────────────
// Per month, two grouped columns: their hostile (slate) and your hostile (amber),
// each with the SEVERE portion overlaid in a darker clay-shifted tone. Honest
// stacking: severe ≤ hostile, so severe draws *within* the hostile bar's height.

const ARRIVES_H = 220;
const AXIS_H = 18;
const ARRIVES_PLOT_H = ARRIVES_H - AXIS_H - 4;

function WhatArrives({ months, eras }: { months: TrajectoryMonth[]; eras: Era[] }) {
  const { colW, x } = columns(months.length);
  let peak = 1;
  for (const m of months) peak = Math.max(peak, m.hostileThem, m.hostileMe);
  const scale = (v: number) => (v / peak) * ARRIVES_PLOT_H;

  // Within a month column: slate group (them) left, amber group (you) right.
  const gap = Math.min(2, colW * 0.08);
  const barW = Math.max(1.5, (colW - gap * 3) / 2);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${ARRIVES_H}`}
      width="100%" height={ARRIVES_H}
      preserveAspectRatio="none"
      role="img"
      aria-label="What arrives: monthly hostile messages, theirs in slate and yours in amber, with the severe share overlaid darker."
    >
      <EraBands months={months} eras={eras} height={ARRIVES_PLOT_H} />
      {months.map((m, i) => {
        const base = x(i) + gap;
        const themH = scale(m.hostileThem);
        const themSevH = scale(m.severeThem);
        const meH = scale(m.hostileMe);
        const meSevH = scale(m.severeMe);
        const y = (h: number) => ARRIVES_PLOT_H - h;
        return (
          <g key={m.ym}>
            {/* them (slate) */}
            {m.hostileThem > 0 && (
              <rect
                x={base} y={y(themH)} width={barW} height={themH}
                fill="var(--tension)" opacity={0.85}
              />
            )}
            {m.severeThem > 0 && (
              <rect
                x={base} y={y(themSevH)} width={barW} height={themSevH}
                fill="var(--clay)" opacity={0.9}
              />
            )}
            {/* you (amber) */}
            {m.hostileMe > 0 && (
              <rect
                x={base + barW + gap} y={y(meH)} width={barW} height={meH}
                fill="var(--warmth)" opacity={0.85}
              />
            )}
            {m.severeMe > 0 && (
              <rect
                x={base + barW + gap} y={y(meSevH)} width={barW} height={meSevH}
                fill="var(--clay)" opacity={0.72}
              />
            )}
          </g>
        );
      })}
      <YearAxis months={months} height={ARRIVES_H} />
    </svg>
  );
}

// ── chart 2 — HOW IT IS ANSWERED ───────────────────────────────────────────────
// When she is hostile, the owner's next move, split three ways and normalized by
// recipDenom (the count of her-hostile turns that got a read). A stacked column
// per month: withdrew (faintest slate) → soften (amber) → meet/recip (deep slate).
// Months with no denom draw nothing — honest absence, not a zero.

const ANSWER_H = 200;
const ANSWER_PLOT_H = ANSWER_H - AXIS_H - 4;

function HowAnswered({ months, eras }: { months: TrajectoryMonth[]; eras: Era[] }) {
  const { colW, x } = columns(months.length);
  const gap = Math.min(2, colW * 0.12);
  const barW = Math.max(1.5, colW - gap * 2);

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${ANSWER_H}`}
      width="100%" height={ANSWER_H}
      preserveAspectRatio="none"
      role="img"
      aria-label="How it is answered: when they are hostile, your reply split into meeting it, softening, or withdrawing, per month."
    >
      <EraBands months={months} eras={eras} height={ANSWER_PLOT_H} />
      {months.map((m, i) => {
        const denom = m.recipDenom;
        if (denom <= 0) return null;
        const recipF = m.recip / denom;
        const softF = m.soft / denom;
        const withF = m.withdrew / denom;
        const base = x(i) + gap;

        // stack bottom→top: recip (meet), soft, withdrew
        const hRecip = recipF * ANSWER_PLOT_H;
        const hSoft = softF * ANSWER_PLOT_H;
        const hWith = withF * ANSWER_PLOT_H;
        let cursor = ANSWER_PLOT_H;
        const yRecip = cursor - hRecip; cursor = yRecip;
        const ySoft = cursor - hSoft; cursor = ySoft;
        const yWith = cursor - hWith;

        return (
          <g key={m.ym}>
            {hRecip > 0 && (
              <rect x={base} y={yRecip} width={barW} height={hRecip}
                fill="var(--tension)" opacity={0.9} />
            )}
            {hSoft > 0 && (
              <rect x={base} y={ySoft} width={barW} height={hSoft}
                fill="var(--warmth)" opacity={0.85} />
            )}
            {hWith > 0 && (
              <rect x={base} y={yWith} width={barW} height={hWith}
                fill="var(--tension)" opacity={0.4} />
            )}
          </g>
        );
      })}
      <YearAxis months={months} height={ANSWER_H} />
    </svg>
  );
}

// ── the deluge strip ───────────────────────────────────────────────────────────
// One mark per deluge day (a day her hostility crossed delugeMin). Height by her
// hostile count that day; laid out chronologically edge-to-edge. Slate, of course.

const DELUGE_H = 64;

function DelugeStrip({ days, delugeMin }: { days: DelugeDay[]; delugeMin: number }) {
  if (days.length === 0) return null;
  let peak = delugeMin;
  for (const d of days) peak = Math.max(peak, d.herHostile);
  const { colW, x } = columns(days.length);
  const markW = Math.max(1.5, Math.min(6, colW * 0.7));
  const plotH = DELUGE_H - 4;
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${DELUGE_H}`}
      width="100%" height={DELUGE_H}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Deluge days: ${days.length} days where their hostility crossed the threshold.`}
    >
      <line
        x1={PAD_L} x2={CHART_W - PAD_R} y1={plotH} y2={plotH}
        stroke="var(--line)" strokeWidth={1}
      />
      {days.map((d, i) => {
        const h = (d.herHostile / peak) * plotH;
        return (
          <rect
            key={d.date}
            x={x(i) + (colW - markW) / 2}
            y={plotH - h}
            width={markW}
            height={Math.max(1, h)}
            fill="var(--tension)"
            opacity={0.8}
          >
            <title>{`${d.date} — ${d.herHostile} hostile of ${d.herTotal}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

// ── a compact legend row (token swatches, plain words) ─────────────────────────

function Swatch({ color, opacity = 1, label }: { color: string; opacity?: number; label: string }) {
  return (
    <span className="traj-legend-item">
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block', width: 10, height: 10, borderRadius: 3,
          background: color, opacity, marginRight: 6, verticalAlign: 'middle',
        }}
      />
      {label}
    </span>
  );
}

const legendRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 10,
  fontSize: 12, color: 'var(--ink-soft)',
};

// ── the view ─────────────────────────────────────────────────────────────────

export function Trajectory({ thread }: TrajectoryProps) {
  const [data, setData] = useState<TrajectoryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    getTrajectory(thread.id, ctrl.signal)
      .then((d) => setData(d))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  const them = thread.displayName.split(/\s+/)[0] || 'Them';

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : data && data.months.length > 0 ? (
          <TrajectoryBody data={data} them={them} />
        ) : (
          <p className="overview-status">{EMPTY}</p>
        )}
      </div>
    </div>
  );
}

interface TrajectoryBodyProps {
  data: TrajectoryData;
  them: string;
}

function TrajectoryBody({ data, them }: TrajectoryBodyProps) {
  const { months, eras, delugeDays, delugeMin } = data;

  const hostileThem = sumBy(months, 'hostileThem');
  const hostileMe = sumBy(months, 'hostileMe');
  const severeThem = sumBy(months, 'severeThem');
  const severeMe = sumBy(months, 'severeMe');

  const answeredMonths = months.filter((m) => m.recipDenom > 0).length;
  const span = months.length > 1
    ? `${monthFmt.format(new Date(months[0].startMs || ymToMs(months[0].ym)))} – ${monthFmt.format(new Date(months[months.length - 1].startMs || ymToMs(months[months.length - 1].ym)))}`
    : monthFmt.format(new Date(months[0].startMs || ymToMs(months[0].ym)));

  return (
    <div className="overview-inner">
      {/* headline totals */}
      <section className="ov-section" aria-label="Trajectory at a glance">
        <div className="ov-head">
          <h2 className="ov-title">The trajectory</h2>
          <p className="ov-sub">{span} · two honest questions, month by month.</p>
        </div>
        <div className="statcards">
          <StatCard
            label="Hostility that arrived"
            tone="tension"
            value={<><span className="tnum">{n(hostileThem)}</span> · <span className="tnum">{n(hostileMe)}</span></>}
            detail={`from ${them} · from you`}
            title="Total hostile messages counted across the thread, theirs then yours."
          />
          <StatCard
            label="Of those, severe"
            value={<><span className="tnum">{n(severeThem)}</span> · <span className="tnum">{n(severeMe)}</span></>}
            detail={`from ${them} · from you`}
            title="The severe subset of hostile messages (the darker overlay), theirs then yours."
          />
          <StatCard
            label="Deluge days"
            tone="tension"
            value={<span className="tnum">{n(delugeDays.length)}</span>}
            detail={delugeDays.length > 0
              ? `days ${them}'s hostility surged`
              : 'none crossed the line'}
            title="Days where their hostile count crossed the deluge threshold."
          />
          <StatCard
            label="Months with a read"
            value={<span className="tnum">{n(answeredMonths)}</span>}
            detail={`of ${n(months.length)} months`}
            title="Months where at least one of their hostile turns had a reply read, feeding the lower chart."
          />
        </div>
      </section>

      {/* chart 1 — what arrives */}
      <section className="ov-section" aria-label="What arrives">
        <div className="ov-head">
          <h2 className="ov-title">What arrives</h2>
          <p className="ov-sub">
            Hostile messages each month — {them} in slate, you in amber. The darker overlay is the severe share.
          </p>
        </div>
        <WhatArrives months={months} eras={eras} />
        <div style={legendRow}>
          <Swatch color="var(--tension)" opacity={0.85} label={`${them} — hostile`} />
          <Swatch color="var(--warmth)" opacity={0.85} label="You — hostile" />
          <Swatch color="var(--clay)" opacity={0.9} label="severe (overlaid)" />
        </div>
      </section>

      {/* chart 2 — how it is answered */}
      <section className="ov-section" aria-label="How it is answered">
        <div className="ov-head">
          <h2 className="ov-title">How it is answered</h2>
          <p className="ov-sub">
            When {them} is hostile, what you did next — meeting it, softening, or withdrawing — as a share of their read turns each month.
          </p>
        </div>
        {answeredMonths > 0 ? (
          <>
            <HowAnswered months={months} eras={eras} />
            <div style={legendRow}>
              <Swatch color="var(--tension)" opacity={0.9} label="You met it" />
              <Swatch color="var(--warmth)" opacity={0.85} label="You softened" />
              <Swatch color="var(--tension)" opacity={0.4} label="You withdrew" />
            </div>
          </>
        ) : (
          <p className="ov-sub" style={{ fontStyle: 'italic' }}>
            None of {them}'s hostile turns have been read closely yet, so there is nothing honest to split here.
          </p>
        )}
      </section>

      {/* the deluge strip */}
      {delugeDays.length > 0 && (
        <section className="ov-section" aria-label="Deluge days">
          <div className="ov-head">
            <h2 className="ov-title">The deluge days</h2>
            <p className="ov-sub">
              Each mark is a day {them}'s hostility crossed {n(delugeMin)} — taller means more that day.
            </p>
          </div>
          <DelugeStrip days={delugeDays} delugeMin={delugeMin} />
        </section>
      )}
    </div>
  );
}
