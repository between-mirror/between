// Between — a tasteful, HONEST placeholder for the Sentiment River (Phase 1+).
// It deliberately shows NO invented sentiment shape (that would be a claim without
// receipts). Just the river's frame — a calm neutral baseline, warmth above / slate
// below as faint gradient bands — with the verbatim "await analysis" caption.
// Token colors are applied via `style` (CSS), because var() does not resolve in
// SVG presentation attributes.
import { VOICE } from '../lib/voice';

export function RiverPlaceholder() {
  return (
    <div className="river-placeholder" role="note" aria-label="Sentiment view, awaiting analysis">
      <svg className="river-frame" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="riverWarm" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--warmth)', stopOpacity: 0.14 }} />
            <stop offset="100%" style={{ stopColor: 'var(--warmth)', stopOpacity: 0 }} />
          </linearGradient>
          <linearGradient id="riverCool" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--tension)', stopOpacity: 0 }} />
            <stop offset="100%" style={{ stopColor: 'var(--tension)', stopOpacity: 0.12 }} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="100" height="20" fill="url(#riverWarm)" />
        <rect x="0" y="20" width="100" height="20" fill="url(#riverCool)" />
        <line
          x1="0" y1="20" x2="100" y2="20"
          style={{ stroke: 'var(--line-2)' }}
          strokeWidth="0.4"
          strokeDasharray="1.4 1.4"
        />
      </svg>
      <p className="river-caption">{VOICE.awaitFirstAnalysis}</p>
    </div>
  );
}
