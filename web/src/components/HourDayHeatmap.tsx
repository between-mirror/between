// Between — the 24×7 rhythm grid. A single-hue warmth ramp over message VOLUME
// by weekday × hour, with a plain-language "you're most in touch at…" caption.
// This is a utility view (volume only), so a simple SVG grid is right; the hero
// river stays the hand-made centerpiece. Times are UTC (the archive's day
// boundary), noted quietly so the caption never over-claims a local hour.
import { useMemo } from 'react';
import type { HeatCell } from '../lib/api';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const CELL = 15;
const GAP = 2;
const LEFT = 34;
const TOP = 16;

interface HourDayHeatmapProps {
  hourDay: HeatCell[];
}

/** "3 pm", "12 am", "9 am" — a soft human hour label (UTC). */
function hourLabel(h: number): string {
  const period = h < 12 ? 'am' : 'pm';
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${period}`;
}

export function HourDayHeatmap({ hourDay }: HourDayHeatmapProps) {
  const { grid, max, peak, total } = useMemo(() => {
    const g: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    let mx = 0;
    let pk: { dow: number; hour: number; count: number } | null = null;
    let tot = 0;
    for (const c of hourDay) {
      if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue;
      g[c.dow][c.hour] = c.count;
      tot += c.count;
      if (c.count > mx) mx = c.count;
      if (!pk || c.count > pk.count) pk = { dow: c.dow, hour: c.hour, count: c.count };
    }
    return { grid: g, max: mx, peak: pk, total: tot };
  }, [hourDay]);

  if (total === 0) return null;

  const width = LEFT + 24 * CELL + GAP;
  const height = TOP + 7 * CELL + 2;

  const caption = peak
    ? `You're most in touch on ${DOW_LONG[peak.dow]} around ${hourLabel(peak.hour)}.`
    : null;

  return (
    <div className="hourday">
      {caption && <p className="hd-caption">{caption} <span className="hd-utc">· times in UTC</span></p>}
      <div className="hd-scroll">
        <svg
          className="hd-grid"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="How often you talk, by weekday and hour of day"
        >
          {DOW.map((d, row) => (
            <text
              key={d}
              className="hd-dow"
              x={LEFT - 8}
              y={TOP + row * CELL + CELL * 0.62}
              textAnchor="end"
              style={{ fill: 'var(--ink-faint)' }}
            >
              {d}
            </text>
          ))}
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <text
              key={h}
              className="hd-hour"
              x={LEFT + h * CELL}
              y={11}
              style={{ fill: 'var(--ink-faint)' }}
            >
              {hourLabel(h)}
            </text>
          ))}
          {grid.map((rowArr, row) =>
            rowArr.map((count, hour) => {
              const t = max > 0 ? count / max : 0;
              const mag = count === 0 ? 0 : Math.round(10 + 68 * Math.sqrt(t));
              const fill = count === 0
                ? 'var(--cal-empty)'
                : `color-mix(in srgb, var(--warmth) ${mag}%, var(--cal-base))`;
              return (
                <rect
                  key={`${row}-${hour}`}
                  x={LEFT + hour * CELL}
                  y={TOP + row * CELL}
                  width={CELL - GAP}
                  height={CELL - GAP}
                  rx="2.5"
                  style={{ fill, stroke: 'var(--cal-stroke)' }}
                  strokeWidth="0.5"
                >
                  <title>{`${DOW_LONG[row]} · ${hourLabel(hour)} · ${count} ${count === 1 ? 'message' : 'messages'}`}</title>
                </rect>
              );
            }),
          )}
        </svg>
      </div>
    </div>
  );
}
