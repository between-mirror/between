// Between — coverage-confidence honesty surfaces (GAMEPLAN §2.1a).
// Calm, never alarming: a hatched dash, not a warning. Renders nothing at full
// coverage. Prefers the server-authored coverageNote; falls back to the verbatim
// VOICE incompleteness caption.
import { VOICE } from '../lib/voice';

interface CoverageProps {
  confidence: number;
  note: string | null;
}

/** Small inline chip for conversation cards. */
export function CoverageBadge({ confidence, note }: CoverageProps) {
  if (confidence >= 1) return null;
  const caption = note ?? VOICE.coverageCaption;
  return (
    <span className="coverage-badge" title={caption}>
      <span className="coverage-hatch" aria-hidden />
      {VOICE.coverageLabel}
    </span>
  );
}

/** Persistent, always-visible caveat bar shown atop an affected transcript. */
export function CoverageNotice({ confidence, note }: CoverageProps) {
  if (confidence >= 1) return null;
  const caption = note ?? VOICE.coverageCaption;
  return (
    <div className="coverage-notice" role="note">
      <span className="coverage-hatch coverage-hatch--lg" aria-hidden />
      <p>{caption}</p>
    </div>
  );
}
