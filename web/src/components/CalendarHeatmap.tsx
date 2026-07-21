// Between — Emotional Weather. A year-by-year day grid (GitHub-calendar shape),
// each cell colored on the diverging amber(warmth) ↔ slate(tension) sentiment
// scale — NEVER red/green (GAMEPLAN §5.5). Days with messages but no readable
// sentiment are neutral AND hatched ("we have the words, not a reading"); days
// with no activity are left faint. Hover a cell for its date + count.
//
// Drawn on canvas (one per year), not ~3k SVG rects: far lighter to paint on an
// 8-year thread, DPR- and theme-aware. Tokens are resolved to concrete RGB and
// interpolated in JS (canvas has no color-mix); it redraws on a theme flip.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyPoint } from '../lib/api';
import { formatFullDate } from '../lib/format';

const DAY_MS = 86_400_000;
const CELL = 12;      // cell pitch (px)
const GAP = 2;        // inner gap
const R = CELL - GAP; // drawn size
const TOP = 16;       // room for month labels
const LEFT = 30;      // room for the year label

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type RGB = [number, number, number];

interface CalendarHeatmapProps {
  daily: DailyPoint[];
  sentimentAvailable: boolean;
}

interface Cell {
  x: number;
  y: number;
  ms: number;
  count: number;
  sentiment: number | null;
  hatched: boolean;
}

interface YearGrid {
  year: number;
  cols: number;
  cells: Cell[];
  months: Array<{ col: number; label: string }>;
}

interface Hover { ms: number; count: number; left: number; top: number; }

function utcDay(ms: number): number {
  return new Date(ms).getUTCDay(); // 0=Sun
}

function buildYear(year: number, byDay: Map<number, DailyPoint>): YearGrid {
  const jan1 = Date.parse(`${year}-01-01T00:00:00Z`);
  const dec31 = Date.parse(`${year}-12-31T00:00:00Z`);
  const gridStart = jan1 - utcDay(jan1) * DAY_MS; // back to the week's Sunday
  const cells: Cell[] = [];
  const months: Array<{ col: number; label: string }> = [];
  let seenMonth = -1;
  let maxCol = 0;

  for (let ms = jan1; ms <= dec31; ms += DAY_MS) {
    const col = Math.floor((ms - gridStart) / (7 * DAY_MS));
    const row = utcDay(ms);
    if (col > maxCol) maxCol = col;
    const d = byDay.get(ms);
    const count = d ? d.count : 0;
    const sentiment = d && d.count > 0 ? d.sentiment : null;
    cells.push({ x: col, y: row, ms, count, sentiment, hatched: count > 0 && sentiment == null });
    const month = new Date(ms).getUTCMonth();
    if (month !== seenMonth) { months.push({ col, label: MONTHS[month] }); seenMonth = month; }
  }
  return { year, cols: maxCol + 1, cells, months };
}

// ── color helpers (canvas needs concrete colors, not CSS var() / color-mix) ──
function parseRGB(s: string, fallback: RGB): RGB {
  const t = s.trim();
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return fallback;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return [r, g, b].some(Number.isNaN) ? fallback : [r, g, b];
  }
  const m = t.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
  return fallback;
}
const rgb = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const mix = (a: RGB, b: RGB, t: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ${Math.round(a[2] + (b[2] - a[2]) * t)})`;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function YearCanvas({
  grid, sentimentAvailable, themeKey, onHover,
}: {
  grid: YearGrid;
  sentimentAvailable: boolean;
  themeKey: number;
  onHover: (h: Hover | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = LEFT + grid.cols * CELL + GAP;
  const height = TOP + 7 * CELL;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string, fb: RGB) => parseRGB(cs.getPropertyValue(n), fb);
    const warm = v('--warmth', [184, 122, 43]);
    const tension = v('--tension', [67, 88, 123]);
    const base = v('--cal-base', v('--surface', [247, 245, 239]));
    const empty = v('--cal-empty', v('--line', [232, 229, 221]));
    const neutral = v('--cal-neutral', [214, 209, 197]);
    const faint = v('--ink-faint', [124, 132, 148]);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = rgb(faint);
    ctx.font = '9px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(grid.year), 0, TOP + 10);
    for (const m of grid.months) ctx.fillText(m.label, LEFT + m.col * CELL, 11);

    for (const c of grid.cells) {
      const x = LEFT + c.x * CELL;
      const y = TOP + c.y * CELL;
      let fill: string;
      if (c.count === 0) fill = rgb(empty);
      else if (!sentimentAvailable || c.sentiment == null) fill = rgb(neutral);
      else {
        const s = Math.max(-1, Math.min(1, c.sentiment));
        const mag = (14 + 62 * Math.abs(s)) / 100;
        fill = mix(base, s >= 0 ? warm : tension, mag);
      }
      roundRectPath(ctx, x, y, R, R, 2.5);
      ctx.fillStyle = fill;
      ctx.fill();
      if (c.hatched) {
        ctx.save();
        roundRectPath(ctx, x, y, R, R, 2.5);
        ctx.clip();
        ctx.strokeStyle = `rgba(${faint[0]}, ${faint[1]}, ${faint[2]}, 0.5)`;
        ctx.lineWidth = 1;
        for (let o = -R; o < R; o += 3) {
          ctx.beginPath();
          ctx.moveTo(x + o, y + R);
          ctx.lineTo(x + o + R, y);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }, [grid, sentimentAvailable, themeKey, width, height]);

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = ref.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left - LEFT) / CELL);
    const row = Math.floor((e.clientY - rect.top - TOP) / CELL);
    const c = grid.cells.find((cc) => cc.x === col && cc.y === row);
    onHover(c ? { ms: c.ms, count: c.count, left: e.clientX, top: e.clientY } : null);
  };

  return (
    <canvas
      ref={ref}
      className="cal-year-canvas"
      style={{ display: 'block', width, height, marginBottom: 10 }}
      role="img"
      aria-label={`Daily message weather for ${grid.year}`}
      onMouseMove={onMove}
      onMouseLeave={() => onHover(null)}
    />
  );
}

export function CalendarHeatmap({ daily, sentimentAvailable }: CalendarHeatmapProps) {
  const [themeKey, setThemeKey] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);

  const years = useMemo(() => {
    if (daily.length === 0) return [];
    const byDay = new Map<number, DailyPoint>();
    let minY = Infinity, maxY = -Infinity;
    for (const d of daily) {
      const ms = Date.parse(`${d.date}T00:00:00Z`);
      if (!Number.isFinite(ms)) continue;
      byDay.set(ms, d);
      const y = new Date(ms).getUTCFullYear();
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minY)) return [];
    const out: YearGrid[] = [];
    for (let y = minY; y <= maxY; y++) out.push(buildYear(y, byDay));
    return out;
  }, [daily]);

  // redraw the canvases when the viewer flips theme (tokens change)
  useEffect(() => {
    const bump = () => setThemeKey((t) => t + 1);
    const mo = new MutationObserver(bump);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', bump);
    return () => { mo.disconnect(); mq.removeEventListener('change', bump); };
  }, []);

  if (years.length === 0) return null;

  return (
    <div className="calendar">
      <div className="cal-scroll">
        {years.map((yg) => (
          <YearCanvas key={yg.year} grid={yg} sentimentAvailable={sentimentAvailable} themeKey={themeKey} onHover={setHover} />
        ))}
      </div>

      {hover && (
        <div
          className="cal-tip"
          role="status"
          style={{ position: 'fixed', left: hover.left + 12, top: hover.top + 12, zIndex: 40, pointerEvents: 'none' }}
        >
          <span className="cal-tip-date">{formatFullDate(hover.ms)}</span>
          <span className="cal-tip-count tnum">{hover.count} {hover.count === 1 ? 'message' : 'messages'}</span>
        </div>
      )}

      <div className="cal-legend" aria-hidden>
        <span className="cal-legend-end">tension</span>
        <span className="cal-legend-ramp cal-legend-ramp--tension" />
        <span className="cal-legend-swatch cal-legend-swatch--neutral" />
        <span className="cal-legend-ramp cal-legend-ramp--warm" />
        <span className="cal-legend-end">warmth</span>
        <span className="cal-legend-gap">
          <span className="cal-legend-swatch cal-legend-swatch--hatch" /> not readable
        </span>
      </div>
    </div>
  );
}
