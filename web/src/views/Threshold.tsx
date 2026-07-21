// Between — the Threshold (screen 1): awe before paperwork (GAMEPLAN A.3).
// The archive's scale is revealed quietly, then the mandatory disclosures arrive
// as captions within the same scene — never as a modal form in front of it.
import { useEffect } from 'react';
import type { OnboardingMeta } from '../lib/api';
import { spanYears } from '../lib/format';
import { useCountUp } from '../lib/hooks';
import { VOICE } from '../lib/voice';

interface ThresholdProps {
  meta: OnboardingMeta;
  onContinue: () => void;
}

export function Threshold({ meta, onContinue }: ThresholdProps) {
  const years = spanYears(meta.firstMs, meta.lastMs);
  const yearsN = useCountUp(years, true, 1100);
  const msgsN = useCountUp(meta.messageCount, true, 1600);
  const peopleN = useCountUp(meta.contactCount, true, 1300);

  // Enter anywhere crosses the threshold — a calm, keyboard-first affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onContinue();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onContinue]);

  return (
    <main className="threshold">
      <div className="threshold-inner">
        <p className="threshold-quiet threshold-fade" style={{ animationDelay: '120ms' }}>
          {VOICE.parsingLine}
        </p>

        <h1 className="threshold-reveal threshold-fade" style={{ animationDelay: '420ms' }}>
          <span className="reveal-seg">
            <span className="reveal-n tnum">{yearsN}</span> years.
          </span>{' '}
          <span className="reveal-seg">
            <span className="reveal-n tnum">{msgsN.toLocaleString()}</span> messages.
          </span>{' '}
          <span className="reveal-seg">
            <span className="reveal-n tnum">{peopleN.toLocaleString()}</span> people.
          </span>
        </h1>

        <div className="threshold-disclosures">
          {VOICE.disclosures.map((line, i) => (
            <p
              key={i}
              className="disclosure threshold-fade"
              style={{ animationDelay: `${1400 + i * 700}ms` }}
            >
              {line}
            </p>
          ))}
        </div>

        <ul className="principles threshold-fade" style={{ animationDelay: '3700ms' }} aria-label="First-run principles">
          {VOICE.firstRunPrinciples.map((p) => (
            <li key={p} className="principle">{p}</li>
          ))}
        </ul>

        <button
          type="button"
          className="threshold-continue threshold-fade"
          style={{ animationDelay: '4000ms' }}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </main>
  );
}
