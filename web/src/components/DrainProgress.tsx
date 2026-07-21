// Between — DrainProgress: honest, persistent, resumable job progress for a
// reading in flight. NEVER a mood-spinner over emotional data — plain counts:
// done / remembered / remaining, an ETA, and the verbatim resume promise
// ("You can leave — this picks up where it stopped.", VOICE §6).
//
// Phase-2 local dev drains ON DEMAND (the user's /drain-jobs), never in the
// background (invariant 2). So this surface never claims to advance on its own:
// it reflects server state on mount, and a "Check for new readings" button runs
// an EXPLICIT, awaited ingest (the app is the sole writer). Refusals surface as
// "couldn't score this stretch" — never a silent gap.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisLens, DrainStatus } from '../lib/api';
import { getDrainStatus, ingestResults } from '../lib/api';
import { VOICE, VOICE_INTERIM, drainProgressLine, drainCompleteLine } from '../lib/voice';

interface DrainProgressProps {
  threadId: number;
  lens: AnalysisLens;
  /** Seed from the run commit, so the panel paints before the first fetch. */
  initialStatus?: DrainStatus | null;
  /** Fired once the run resolves (remaining === 0). */
  onComplete?: (status: DrainStatus) => void;
  /** Offered when the run is fully resolved, to tuck the panel away. */
  onDismiss?: () => void;
}

function resolvedOf(s: DrainStatus): number {
  return s.done + s.cached + s.errored + s.refused;
}

/** Whole-unit, unhurried duration for an ETA. Never false precision. */
function humanEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return 'under a minute or two';
  const minutes = seconds / 60;
  if (minutes < 60) return `about ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 2 ? 'about an hour' : `about ${Math.round(hours)} hours`;
}

export function DrainProgress({
  threadId, lens, initialStatus, onComplete, onDismiss,
}: DrainProgressProps) {
  const [status, setStatus] = useState<DrainStatus | null>(initialStatus ?? null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastIngest, setLastIngest] = useState<{ newCount: number; cachedCount: number } | null>(null);
  const completedRef = useRef(false);

  const maybeComplete = useCallback((s: DrainStatus) => {
    if (s.total > 0 && s.remaining <= 0 && !completedRef.current) {
      completedRef.current = true;
      onComplete?.(s);
    }
  }, [onComplete]);

  // Reflect server state on mount (resumability — the run outlives the tab).
  useEffect(() => {
    if (initialStatus) { maybeComplete(initialStatus); return; }
    const ctrl = new AbortController();
    getDrainStatus(threadId, lens, ctrl.signal)
      .then((s) => { setStatus(s); maybeComplete(s); })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // A missing status is not an error worth alarming over — just quiet.
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, lens]);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const outcome = await ingestResults(threadId, lens);
      setStatus(outcome.status);
      setLastIngest({ newCount: outcome.newCount, cachedCount: outcome.cachedCount });
      maybeComplete(outcome.status);
    } catch {
      setError(VOICE_INTERIM.estimateError);
    } finally {
      setChecking(false);
    }
  }, [threadId, lens, maybeComplete]);

  if (!status || status.total <= 0) return null;

  const resolved = resolvedOf(status);
  const isDone = status.remaining <= 0;
  const frac = status.total > 0 ? Math.min(1, Math.max(0, resolved / status.total)) : 0;
  const eta = humanEta(status.etaSeconds);

  const headline = isDone
    ? drainCompleteLine(lastIngest?.newCount ?? status.done, lastIngest?.cachedCount ?? status.cached)
    : drainProgressLine(resolved, status.total);

  return (
    <section
      className={`drain${isDone ? ' drain--done' : ''}`}
      aria-label="Reading progress"
      aria-live="polite"
    >
      <div className="drain-top">
        <p className="drain-headline">{headline}</p>
        {isDone && onDismiss && (
          <button type="button" className="drain-dismiss link-btn" onClick={onDismiss}>
            Tuck away
          </button>
        )}
      </div>

      <div
        className="drain-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={status.total}
        aria-valuenow={resolved}
        aria-valuetext={`${resolved} of ${status.total} stretches read`}
      >
        <span className="drain-bar-fill" style={{ width: `${frac * 100}%` }} />
      </div>

      <dl className="drain-counts tnum">
        <div className="drain-count">
          <dt>Read</dt><dd>{status.done.toLocaleString()}</dd>
        </div>
        <div className="drain-count">
          <dt>Remembered</dt><dd>{status.cached.toLocaleString()}</dd>
        </div>
        <div className="drain-count">
          <dt>Remaining</dt><dd>{status.remaining.toLocaleString()}</dd>
        </div>
        {status.refused > 0 && (
          <div className="drain-count drain-count--muted">
            <dt>Couldn’t score</dt><dd>{status.refused.toLocaleString()}</dd>
          </div>
        )}
      </dl>

      {status.refused > 0 && (
        <p className="drain-note">{VOICE.refusedWindow}</p>
      )}

      {!isDone && (
        // The verbatim headline already carries the resume promise ("You can
        // leave — this picks up where it stopped."). This adds only the honest,
        // interim note that the reading is on-demand plus a plain ETA.
        <p className="drain-ondemand">
          {VOICE_INTERIM.drainOnDemand}
          {eta ? ` Remaining work: roughly ${eta}.` : ''}
          {status.drainsRemaining != null && status.drainsRemaining > 0
            ? ` About ${status.drainsRemaining.toLocaleString()} sittings left.`
            : ''}
        </p>
      )}

      {error && <p className="drain-note drain-note--error">{error}</p>}

      {!isDone && (
        <div className="drain-actions">
          <button
            type="button"
            className="btn btn--soft"
            onClick={check}
            disabled={checking}
          >
            {checking ? 'Looking…' : VOICE_INTERIM.checkForReadings}
          </button>
        </div>
      )}
    </section>
  );
}
