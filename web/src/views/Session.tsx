// Between — Session: the First Reflection reader (the "Session" tab). It reads
// the frozen, dated readings for a thread and renders the latest as
// correspondence (VOICE §4), with earlier readings kept and switchable (frozen
// versioning — regeneration is a new row, never a mutation). When none exists,
// it invites one; asking shows the estimate FIRST (AnalyzePanel) and then the
// honest, on-demand drain progress. Below the evidence floor / in grief mode the
// AnalyzePanel declines gracefully — no reading is stretched from thin evidence.
import { useCallback, useEffect, useState } from 'react';
import type { DrainStatus, ReflectionDTO, ReflectionSummary, ThreadSummary } from '../lib/api';
import { getReflections, getReflection } from '../lib/api';
import { VOICE_INTERIM } from '../lib/voice';
import { formatFullDate } from '../lib/format';
import { AnalyzePanel } from '../components/AnalyzePanel';
import { DrainProgress } from '../components/DrainProgress';
import { Reflection } from '../components/Reflection';
import { CalibrateInvite } from '../components/CalibrateInvite';

interface SessionProps {
  thread: ThreadSummary;
  /** Drill from a receipt to the transcript at a message id. */
  onOpenReceipt: (messageId: number, sentAtMs: number) => void;
  /** Open Settings at calibration. The invite is contextual; the flow lives there. */
  onCalibrate?: () => void;
}

function byNewest(a: ReflectionSummary, b: ReflectionSummary): number {
  return Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || b.id - a.id;
}

export function Session({ thread, onOpenReceipt, onCalibrate }: SessionProps) {
  const [list, setList] = useState<ReflectionSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reflection, setReflection] = useState<ReflectionDTO | null>(null);
  const [reflLoading, setReflLoading] = useState(false);
  const [reflError, setReflError] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [run, setRun] = useState<DrainStatus | null>(null);

  const loadList = useCallback((signal?: AbortSignal, keepSelection = false) => {
    setListLoading(true);
    setListError(false);
    getReflections(thread.id, signal)
      .then((rows) => {
        const sorted = [...rows].sort(byNewest);
        setList(sorted);
        if (!keepSelection) setSelectedId(sorted[0]?.id ?? null);
        else if (sorted.length > 0) setSelectedId((cur) => cur ?? sorted[0].id);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setListError(true);
      })
      .finally(() => setListLoading(false));
  }, [thread.id]);

  // Load the reading list when the thread changes.
  useEffect(() => {
    const ctrl = new AbortController();
    setReflection(null);
    setRun(null);
    setAnalyzing(false);
    loadList(ctrl.signal);
    return () => ctrl.abort();
  }, [thread.id, loadList]);

  // Load the selected frozen reading.
  useEffect(() => {
    if (selectedId == null) { setReflection(null); return; }
    const ctrl = new AbortController();
    setReflLoading(true);
    setReflError(false);
    getReflection(selectedId, ctrl.signal)
      .then(setReflection)
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setReflError(true);
      })
      .finally(() => setReflLoading(false));
    return () => ctrl.abort();
  }, [selectedId]);

  const onBegan = useCallback((status: DrainStatus) => {
    setAnalyzing(false);
    setRun(status);
  }, []);

  const onRunComplete = useCallback(() => {
    // A new frozen reading may have landed — pick it up as the newest.
    setSelectedId(null);
    loadList(undefined, false);
  }, [loadList]);

  const hasReadings = list.length > 0;

  return (
    <div className="session" tabIndex={-1}>
      <div className="session-scroll" tabIndex={0}>
        <div className="session-inner">
          <CalibrateInvite thread={thread} onCalibrate={onCalibrate} />
          {run && (
            <DrainProgress
              threadId={thread.id}
              lens="first_reflection"
              initialStatus={run}
              onComplete={onRunComplete}
              onDismiss={() => setRun(null)}
            />
          )}

          {listLoading ? (
            <p className="session-status">Looking for earlier readings…</p>
          ) : listError ? (
            <p className="session-status session-status--error">{VOICE_INTERIM.reflectionLoadError}</p>
          ) : !hasReadings ? (
            <div className="session-empty">
              <h2 className="session-empty-title">{VOICE_INTERIM.reflectionEmptyTitle}</h2>
              <p className="session-empty-body">{VOICE_INTERIM.reflectionEmptyBody}</p>
              {!run && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setAnalyzing(true)}
                >
                  {VOICE_INTERIM.askForReading}
                </button>
              )}
            </div>
          ) : (
            <>
              {list.length > 1 && (
                <nav className="session-versions" aria-label="Earlier readings">
                  {list.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`session-version${r.id === selectedId ? ' is-on' : ''}`}
                      aria-current={r.id === selectedId}
                      onClick={() => setSelectedId(r.id)}
                    >
                      {formatFullDate(Date.parse(r.generatedAt) || 0)}
                    </button>
                  ))}
                </nav>
              )}

              {reflLoading ? (
                <p className="session-status">Opening the reading…</p>
              ) : reflError ? (
                <p className="session-status session-status--error">{VOICE_INTERIM.reflectionLoadError}</p>
              ) : reflection ? (
                <Reflection
                  reflection={reflection}
                  displayName={thread.displayName}
                  onOpenReceipt={onOpenReceipt}
                />
              ) : null}

              {!run && (
                <div className="session-again">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setAnalyzing(true)}
                  >
                    Write a new reading
                  </button>
                  <span className="session-again-note">A new reading is dated and kept beside this one — never a rewrite.</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {analyzing && (
        <AnalyzePanel
          threadId={thread.id}
          mode="reflection"
          displayName={thread.displayName}
          onClose={() => setAnalyzing(false)}
          onBegan={onBegan}
        />
      )}
    </div>
  );
}
