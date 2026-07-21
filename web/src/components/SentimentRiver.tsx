// Between — the Sentiment River (the Phase 1 hero). HAND-BUILT, never a charting
// library (GAMEPLAN Addendum A.7). Warmth (amber, --warmth) fills ABOVE a
// centerline; tension (slate, --tension) fills BELOW. Band thickness scales with
// daily message volume, so quiet stretches visibly narrow. The daily series is
// densified to a continuous day grid and smoothed with a centered rolling mean —
// honest about shape, never inventing sentiment.
//
// Marks that make it a designed composition, not a default: a diverging vertical
// gradient per pole, a coverage HATCH over long silences on low-coverage threads
// (§2.1a), an "early read" label (Phase-1 sentiment is lexicon-based word choice,
// not a close reading), and a hoverable / keyboard-navigable read-out. When
// `sentimentAvailable` is false it degrades to a neutral VOLUME stream with a
// caveat rather than faking sentiment.
//
// Canvas draws the fills (fast, gradient, DPR-aware, theme-aware); a thin DOM
// overlay carries the hairline, tooltip, and year axis (crisp text, easy hit-
// testing). Under reduced motion the river draws statically — no reveal.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DailyPoint } from '../lib/api';
import { formatFullDate } from '../lib/format';
import { usePrefersReducedMotion } from '../lib/hooks';

const DAY_MS = 86_400_000;

// Interim, in-register copy. VOICE §6 has no purpose-built string for these yet;
// authored calm and hedge-light per Addendum A.6, to be handed to Fable / voice.ts.
const EARLY_READ = 'early read — from word choice, not yet a close reading';
const VOLUME_ONLY =
  "Not enough English here for an early sentiment read — this shows how often you talked, not how it felt.";

interface SentimentRiverProps {
  daily: DailyPoint[];
  sentimentAvailable: boolean;
  coverageConfidence: number;
}

interface DenseDay {
  ms: number;
  count: number;
  warmth: number;
  tension: number;
  sentiment: number | null;
}

interface RiverModel {
  n: number;
  startMs: number;
  endMs: number;
  days: DenseDay[];
  above: Float64Array;   // warmth band height, 0..peak
  below: Float64Array;   // tension band height, 0..peak
  peak: number;
  gaps: Array<{ i0: number; i1: number }>;
  years: Array<{ frac: number; label: number }>;
}

/** Centered rolling mean over a numeric series. */
function smooth(src: number[], half: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  // prefix sums for an O(n) centered window
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

function buildModel(daily: DailyPoint[], sentimentAvailable: boolean): RiverModel | null {
  if (daily.length === 0) return null;
  const byDay = new Map<number, DailyPoint>();
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const d of daily) {
    const ms = Date.parse(`${d.date}T00:00:00Z`);
    if (!Number.isFinite(ms)) continue;
    byDay.set(ms, d);
    if (ms < startMs) startMs = ms;
    if (ms > endMs) endMs = ms;
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const n = Math.max(1, Math.round((endMs - startMs) / DAY_MS) + 1);
  const days: DenseDay[] = new Array(n);
  const counts: number[] = new Array(n);
  const warmths: number[] = new Array(n);
  const tensions: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const ms = startMs + i * DAY_MS;
    const d = byDay.get(ms);
    days[i] = {
      ms,
      count: d ? d.count : 0,
      warmth: d ? d.warmth : 0,
      tension: d ? d.tension : 0,
      sentiment: d && d.count > 0 ? d.sentiment : null,
    };
    counts[i] = days[i].count;
    warmths[i] = days[i].warmth;
    tensions[i] = days[i].tension;
  }

  // Adaptive smoothing window: gentle on short threads, steadier on long ones.
  const totalDays = n;
  const half = Math.round(Math.min(45, Math.max(7, totalDays / 70)) / 2);
  const wS = smooth(warmths, half);
  const tS = smooth(tensions, half);
  const cS = smooth(counts, half);

  // Volume → thickness. Normalize smoothed volume by its 95th pct so one loud
  // day can't flatten the rest; clamp to [0,1]. Quiet stretches stay thin.
  const volRef = Math.max(1e-6, percentile(cS, 0.95));
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i++) vol[i] = Math.min(1, cS[i] / volRef);

  const above = new Float64Array(n);
  const below = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    if (sentimentAvailable) {
      above[i] = wS[i] * vol[i];
      below[i] = tS[i] * vol[i];
    } else {
      // neutral volume stream: symmetric thickness from volume alone
      above[i] = vol[i];
      below[i] = vol[i];
    }
    if (above[i] > peak) peak = above[i];
    if (below[i] > peak) peak = below[i];
  }
  if (peak <= 0) peak = 1;

  // Gap runs (extended silence) — hatched only when coverage is uncertain.
  const gapMin = Math.max(14, half * 2);
  const gaps: Array<{ i0: number; i1: number }> = [];
  let run = -1;
  for (let i = 0; i < n; i++) {
    if (counts[i] === 0) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= gapMin) gaps.push({ i0: run, i1: i - 1 });
      run = -1;
    }
  }
  if (run >= 0 && n - run >= gapMin) gaps.push({ i0: run, i1: n - 1 });

  // Year boundaries for the axis.
  const years: Array<{ frac: number; label: number }> = [];
  const span = Math.max(1, endMs - startMs);
  const firstYear = new Date(startMs).getUTCFullYear();
  const lastYear = new Date(endMs).getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    const ms = Date.parse(`${y}-01-01T00:00:00Z`);
    const frac = (ms - startMs) / span;
    if (frac >= -0.001 && frac <= 1.001) years.push({ frac: Math.min(1, Math.max(0, frac)), label: y });
  }

  return { n, startMs, endMs, days, above, below, peak, gaps, years };
}

function cssVar(el: Element, name: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** #rgb / #rrggbb → rgba(...) at alpha `a`. Falls back to the raw string. */
function withAlpha(color: string, a: number): string {
  let hex = color.trim();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return color;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Read the band heights at a fractional x (linear-interpolated, so the curve
 *  stays smooth regardless of pixel density). */
function sampleAt(arr: Float64Array, frac: number): number {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const t = Math.min(1, Math.max(0, frac)) * (n - 1);
  const i = Math.floor(t);
  const f = t - i;
  return i + 1 < n ? arr[i] * (1 - f) + arr[i + 1] * f : arr[i];
}

function drawRiver(
  canvas: HTMLCanvasElement,
  model: RiverModel,
  sentimentAvailable: boolean,
  coverageConfidence: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const root = document.documentElement;
  const warm = cssVar(root, '--warmth') || '#B87A2B';
  const tension = cssVar(root, '--tension') || '#43587B';
  const faint = cssVar(root, '--ink-faint') || '#7C8494';

  const mid = h * 0.5;
  const halfAmp = mid * 0.9;
  const scale = halfAmp / model.peak;
  const step = Math.max(1, Math.floor(w / 480)); // pixel stride for the outline

  const poleAbove = sentimentAvailable ? warm : faint;
  const poleBelow = sentimentAvailable ? tension : faint;
  const topA = sentimentAvailable ? 0.5 : 0.22;
  const edgeA = sentimentAvailable ? 0.03 : 0.02;

  // warmth (above)
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let x = 0; x <= w; x += step) {
    const y = mid - sampleAt(model.above, x / w) * scale;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, mid);
  ctx.closePath();
  const gA = ctx.createLinearGradient(0, mid - halfAmp, 0, mid);
  gA.addColorStop(0, withAlpha(poleAbove, edgeA));
  gA.addColorStop(1, withAlpha(poleAbove, topA));
  ctx.fillStyle = gA;
  ctx.fill();

  // tension (below)
  ctx.beginPath();
  ctx.moveTo(0, mid);
  for (let x = 0; x <= w; x += step) {
    const y = mid + sampleAt(model.below, x / w) * scale;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, mid);
  ctx.closePath();
  const gB = ctx.createLinearGradient(0, mid, 0, mid + halfAmp);
  gB.addColorStop(0, withAlpha(poleBelow, topA));
  gB.addColorStop(1, withAlpha(poleBelow, edgeA));
  ctx.fillStyle = gB;
  ctx.fill();

  // coverage hatch over long silences (only where we don't trust the silence)
  if (coverageConfidence < 1 && model.gaps.length > 0 && model.n > 1) {
    const hatch = document.createElement('canvas');
    hatch.width = 7;
    hatch.height = 7;
    const hctx = hatch.getContext('2d');
    if (hctx) {
      hctx.strokeStyle = withAlpha(faint, 0.5);
      hctx.lineWidth = 1;
      hctx.beginPath();
      hctx.moveTo(-1, 8);
      hctx.lineTo(8, -1);
      hctx.moveTo(3, 8);
      hctx.lineTo(8, 3);
      hctx.stroke();
      const pattern = ctx.createPattern(hatch, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
        for (const g of model.gaps) {
          const x0 = (g.i0 / (model.n - 1)) * w;
          const x1 = (g.i1 / (model.n - 1)) * w;
          ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
        }
      }
    }
  }

  // year gridlines
  ctx.strokeStyle = withAlpha(faint, 0.16);
  ctx.lineWidth = 1;
  for (const yr of model.years) {
    if (yr.frac <= 0 || yr.frac >= 1) continue;
    const x = Math.round(yr.frac * w) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 6);
    ctx.lineTo(x, h - 6);
    ctx.stroke();
  }

  // baseline
  ctx.strokeStyle = withAlpha(tension, sentimentAvailable ? 0.24 : 0.16);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid + 0.5);
  ctx.lineTo(w, mid + 0.5);
  ctx.stroke();
}

export function SentimentRiver({ daily, sentimentAvailable, coverageConfidence }: SentimentRiverProps) {
  const reduced = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [themeTick, setThemeTick] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  const model = useMemo(() => buildModel(daily, sentimentAvailable), [daily, sentimentAvailable]);

  // size tracking
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // redraw on theme flip so the fills track tokens
  useEffect(() => {
    const bump = () => setThemeTick((t) => t + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', bump);
    };
  }, []);

  // draw
  useEffect(() => {
    if (!canvasRef.current || !model || box.w <= 0) return;
    drawRiver(canvasRef.current, model, sentimentAvailable, coverageConfidence);
  }, [model, box, themeTick, sentimentAvailable, coverageConfidence]);

  const idxFromClientX = useCallback((clientX: number): number | null => {
    const el = wrapRef.current;
    if (!el || !model) return null;
    const rect = el.getBoundingClientRect();
    const frac = (clientX - rect.left) / Math.max(1, rect.width);
    return Math.min(model.n - 1, Math.max(0, Math.round(frac * (model.n - 1))));
  }, [model]);

  const onMove = useCallback((e: React.MouseEvent) => {
    setActive(idxFromClientX(e.clientX));
  }, [idxFromClientX]);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (!model) return;
    const last = model.n - 1;
    const stepBig = Math.max(1, Math.round(model.n / 40));
    let next = active ?? Math.round(last / 2);
    switch (e.key) {
      case 'ArrowRight': next = Math.min(last, next + stepBig); break;
      case 'ArrowLeft': next = Math.max(0, next - stepBig); break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      case 'Escape': setActive(null); return;
      default: return;
    }
    e.preventDefault();
    setActive(next);
  }, [active, model]);

  if (!model) {
    return (
      <div className="river-empty" role="note">
        <p>{VOLUME_ONLY}</p>
      </div>
    );
  }

  const startYear = new Date(model.startMs).getUTCFullYear();
  const endYear = new Date(model.endMs).getUTCFullYear();
  const summary = sentimentAvailable
    ? `Sentiment river from ${startYear} to ${endYear}. Warmth above the line, tension below; band thickness follows how much was said.`
    : `Volume river from ${startYear} to ${endYear}. Band thickness follows how much was said; sentiment is not shown.`;

  const activeDay = active != null ? model.days[active] : null;
  const activeFrac = active != null && model.n > 1 ? active / (model.n - 1) : 0;
  const aAbove = active != null ? model.above[active] : 0;
  const aBelow = active != null ? model.below[active] : 0;
  const tipMax = Math.max(aAbove, aBelow, 1e-6);

  return (
    <figure className="river">
      <div
        className="river-stage"
        ref={wrapRef}
        role="img"
        tabIndex={0}
        aria-label={summary}
        onMouseMove={onMove}
        onMouseLeave={() => setActive(null)}
        onKeyDown={onKey}
      >
        <canvas className={`river-canvas${reduced ? '' : ' river-canvas--reveal'}`} ref={canvasRef} aria-hidden />

        <span className="river-pole river-pole--warm" aria-hidden>warmth</span>
        <span className="river-pole river-pole--tension" aria-hidden>tension</span>

        {sentimentAvailable ? (
          <span className="river-tag" aria-hidden>{EARLY_READ}</span>
        ) : (
          <span className="river-tag river-tag--caveat" aria-hidden>{VOLUME_ONLY}</span>
        )}

        {activeDay && (
          <>
            <span className="river-hair" style={{ left: `${activeFrac * 100}%` }} aria-hidden />
            <div
              className="river-tip"
              style={{ left: `${activeFrac * 100}%` }}
              data-side={activeFrac > 0.6 ? 'left' : 'right'}
              role="status"
            >
              <span className="river-tip-date">{formatFullDate(activeDay.ms)}</span>
              <span className="river-tip-count tnum">
                {activeDay.count.toLocaleString()} {activeDay.count === 1 ? 'message' : 'messages'}
              </span>
              {sentimentAvailable && (
                activeDay.count > 0 ? (
                  <span className="river-tip-bars" aria-hidden>
                    <span className="river-tip-bar">
                      <i className="river-tip-fill river-tip-fill--warm" style={{ width: `${(aAbove / tipMax) * 100}%` }} />
                    </span>
                    <span className="river-tip-bar">
                      <i className="river-tip-fill river-tip-fill--tension" style={{ width: `${(aBelow / tipMax) * 100}%` }} />
                    </span>
                  </span>
                ) : (
                  <span className="river-tip-quiet">a quiet day</span>
                )
              )}
            </div>
          </>
        )}
      </div>

      <div className="river-axis" aria-hidden>
        {model.years.map((yr) => (
          <span key={yr.label} className="river-year tnum" style={{ left: `${yr.frac * 100}%` }}>
            {yr.label}
          </span>
        ))}
      </div>

      <figcaption className="river-legend">
        <span className="river-legend-item">
          <i className="river-swatch river-swatch--warm" aria-hidden /> warmth
        </span>
        <span className="river-legend-item">
          <i className="river-swatch river-swatch--tension" aria-hidden /> tension
        </span>
        {coverageConfidence < 1 && (
          <span className="river-legend-item">
            <i className="river-swatch river-swatch--hatch" aria-hidden /> may be missing messages
          </span>
        )}
        <span className="river-legend-note">thickness = how much was said</span>
      </figcaption>
    </figure>
  );
}
