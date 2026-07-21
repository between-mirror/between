// Between — a single Report-Card stat. Plain-language, tabular-nums, tappable
// *feel* (hover lift) but never actually pass/fail — no red/green, no verdict.
// Purely presentational: the Overview computes every string and hands it down.
import type { ReactNode } from 'react';

type Tone = 'warmth' | 'tension' | 'neutral';

interface StatCardProps {
  /** Small uppercase eyebrow, e.g. "Reply time". */
  label: string;
  /** The headline value (numbers rendered tabular). */
  value: ReactNode;
  /** A quiet second line for context. */
  detail?: ReactNode;
  /** A soft token accent on the rule above the card. Never a status color. */
  tone?: Tone;
  /** Native hover title (extra plain-language context). */
  title?: string;
}

export function StatCard({ label, value, detail, tone = 'neutral', title }: StatCardProps) {
  return (
    <div className="statcard" data-tone={tone} title={title}>
      <span className="statcard-label">{label}</span>
      <span className="statcard-value tnum">{value}</span>
      {detail != null && <span className="statcard-detail">{detail}</span>}
    </div>
  );
}
