// Between — AnalyzePanel: the estimate-FIRST gate before any reading runs
// (invariant 6). It opens, asks the planner for a capacity estimate, and shows
// the verbatim VOICE §6 line — "This will read {n} stretches … about {drains}
// sittings, roughly {time}. Nothing is ever read twice." — with "Begin the
// reading" / "Not now". Below the evidence floor, or in grief mode, it declines
// gracefully with the authored copy and never offers to score.
//
// Two modes share the panel: 'emotion' (the L1 read that feeds the river) and
// 'reflection' (the first reading). Committing plans jobs into airlock/jobs/;
// the drain itself is the user's on-demand /drain-jobs, never automatic.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { AnalysisLens, AnalysisPlan, DrainStatus, ReadCost } from '../lib/api';
import { planAnalysis, planReflection, beginAnalysis, beginReflection } from '../lib/api';
import { VOICE, VOICE_INTERIM, estimateLine, griefBannerLine } from '../lib/voice';
import { CloseIcon } from './icons';

export type AnalyzeMode = 'emotion' | 'reflection';

const MODE_LABEL: Record<ReadCost['engineMode'], string> = {
  'local-only': 'Local-only',
  subscription: 'Subscription',
  'api-key': 'API key',
};

/** The dollars-and-engine line, shown before "Begin the reading". When a run would actually bill an
 * API key, the price is stated plainly and prominently — consent is seeing the number you click past. */
function CostBlock({ cost }: { cost: ReadCost }) {
  const usd = (n: number | null) => (n == null ? '' : `$${n.toFixed(2)}`);
  return (
    <div className={`analyze-cost${cost.spends ? ' analyze-cost--spends' : ''}`}>
      {cost.spends ? (
        <p className="analyze-cost-price">
          About <b>{usd(cost.usdLow)}–{usd(cost.usdHigh)}</b> on your API key
          {cost.measured ? ' (from your measured usage so far)' : ''}. {cost.note}
        </p>
      ) : (
        <p className="analyze-cost-price">{cost.note}</p>
      )}
      <p className="analyze-sub analyze-sub--faint">
        Engine mode: <span className="analyze-mode">{MODE_LABEL[cost.engineMode]}</span> — change it in Settings.
      </p>
    </div>
  );
}

interface AnalyzePanelProps {
  threadId: number;
  mode: AnalyzeMode;
  /** Contact display name — for the grief banner and dialog context. */
  displayName: string;
  onClose: () => void;
  /** Fired after the run is committed; hands back the initial drain status. */
  onBegan: (status: DrainStatus, lens: AnalysisLens) => void;
}

type Phase =
  | { s: 'loading' }
  | { s: 'error' }
  | { s: 'ready'; plan: AnalysisPlan }
  | { s: 'committing'; plan: AnalysisPlan };

const LENS: Record<AnalyzeMode, AnalysisLens> = {
  emotion: 'l1_emotion',
  reflection: 'first_reflection',
};

export function AnalyzePanel({ threadId, mode, displayName, onClose, onBegan }: AnalyzePanelProps) {
  const [phase, setPhase] = useState<Phase>({ s: 'loading' });
  const dialogRef = useRef<HTMLDivElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();

  // Fetch the estimate on open. No work is done server-side by planning.
  useEffect(() => {
    const ctrl = new AbortController();
    setPhase({ s: 'loading' });
    const planner = mode === 'reflection' ? planReflection : planAnalysis;
    planner(threadId, {}, ctrl.signal)
      .then((plan) => setPhase({ s: 'ready', plan }))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPhase({ s: 'error' });
      });
    return () => ctrl.abort();
  }, [threadId, mode]);

  // Focus the safe default (decline) when the dialog settles.
  useEffect(() => {
    const t = window.setTimeout(() => declineRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [phase.s]);

  // Escape closes; Tab is trapped within the dialog.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  const commit = useCallback(async (plan: AnalysisPlan) => {
    setPhase({ s: 'committing', plan });
    try {
      const begin = mode === 'reflection' ? beginReflection : beginAnalysis;
      const status = await begin(threadId, {});
      onBegan(status, LENS[mode]);
    } catch {
      setPhase({ s: 'ready', plan }); // let them try again; nothing was lost
    }
  }, [mode, threadId, onBegan]);

  const heading = mode === 'reflection'
    ? VOICE_INTERIM.reflectionEstimateTitle
    : VOICE_INTERIM.estimateTitle;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal analyze"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 className="modal-title" id={titleId}>{heading}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </div>

        <div className="modal-body" id={bodyId}>
          {phase.s === 'loading' && (
            <p className="analyze-status">{VOICE_INTERIM.estimateLoading}</p>
          )}
          {phase.s === 'error' && (
            <p className="analyze-status analyze-status--error">{VOICE_INTERIM.estimateError}</p>
          )}

          {(phase.s === 'ready' || phase.s === 'committing') && (
            phase.plan.griefMode ? (
              <p className="analyze-decline">{griefBannerLine(displayName)}</p>
            ) : phase.plan.belowFloor ? (
              <p className="analyze-decline">{VOICE.belowEvidenceFloor}</p>
            ) : (
              <>
                <p className="analyze-estimate">
                  {estimateLine(
                    phase.plan.newCount || phase.plan.windowCount,
                    phase.plan.drainCount,
                    phase.plan.timeEstimateText || 'a little while',
                  )}
                </p>
                {phase.plan.cachedCount > 0 && (
                  <p className="analyze-sub">
                    {phase.plan.cachedCount.toLocaleString()} of{' '}
                    {phase.plan.windowCount.toLocaleString()} stretches are already read — those are remembered.
                  </p>
                )}
                {mode === 'emotion' && (
                  <p className="analyze-sub analyze-sub--faint">
                    This is the close reading that gives the river its warmth and tension.
                  </p>
                )}
                <CostBlock cost={phase.plan.cost} />
                <p className="analyze-sub analyze-sub--faint">{VOICE_INTERIM.drainOnDemand}</p>
              </>
            )
          )}
        </div>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onClose}
            ref={declineRef}
          >
            {VOICE.decline}
          </button>
          {(phase.s === 'ready' || phase.s === 'committing') &&
            !phase.plan.griefMode && !phase.plan.belowFloor && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => commit(phase.plan)}
                disabled={phase.s === 'committing'}
              >
                {phase.s === 'committing' ? 'Beginning…' : VOICE.begin}
              </button>
            )}
        </div>
      </div>
    </div>
  );
}
