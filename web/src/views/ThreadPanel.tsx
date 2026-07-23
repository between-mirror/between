// Between Mirror — the per-thread panel: five surfaces, each answering a question someone actually
// arrives with, with a subnav where one surface holds several views. The shape lives in lib/nav.ts
// (pure, tested); this file renders it and owns the anchors.
//
// Back-to-list lives in the surface bar, so each view keeps its own identity header without doubling
// up. A search hit (an incoming `anchor`) and a receipt drill-through both snap the panel to
// Messages so the words can be shown in place — that path is the whole discipline, and it is the one
// thing this collapse was not allowed to break.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadSummary } from '../lib/api';
import { Overview } from './Overview';
import { Session } from './Session';
import { TranscriptReader } from './TranscriptReader';
import { Trajectory } from './Trajectory';
import { Episodes } from './Episodes';
import { Eras } from './Eras';
import { ShapeOfIt } from './ShapeOfIt';
import { ArchiveHealth } from './ArchiveHealth';
import { Readings } from './Readings';
import { Findings } from './Findings';
import { Ask } from './Ask';
import type { TranscriptAnchor } from './TranscriptReader';
import { ChevronLeftIcon } from '../components/icons';
import {
  SURFACES, surfaceFor, defaultViewFor, viewsFor, stepSurface, stepView,
  type SurfaceId, type ViewId,
} from '../lib/nav';

interface ThreadPanelProps {
  thread: ThreadSummary;
  anchor: TranscriptAnchor | null;
  onClearAnchor: () => void;
  /** Provided on narrow layouts to return to the conversation list. */
  onBack?: () => void;
  /** Open Settings at the calibration section — the invite is contextual, the flow lives there. */
  onOpenCalibration?: () => void;
}

export function ThreadPanel({ thread, anchor, onClearAnchor, onBack, onOpenCalibration }: ThreadPanelProps) {
  const [view, setView] = useState<ViewId>(anchor ? 'transcript' : 'overview');
  const surface: SurfaceId = surfaceFor(view);
  const surfaceViews = viewsFor(surface);

  const surfaceBarRef = useRef<HTMLDivElement>(null);
  const subnavRef = useRef<HTMLDivElement>(null);

  // A receipt drilled from anywhere opens the transcript in place. This local anchor coexists with
  // the search `anchor` prop; the newer wins.
  const [receiptAnchor, setReceiptAnchor] = useState<TranscriptAnchor | null>(null);

  // A search result arriving mid-thread should reveal it in the transcript, and supersede any
  // receipt anchor from a reflection.
  useEffect(() => {
    if (anchor) { setReceiptAnchor(null); setView('transcript'); }
  }, [anchor?.messageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openReceipt = useCallback((messageId: number, sentAtMs: number) => {
    setReceiptAnchor({ messageId, sentAtMs });
    setView('transcript');
  }, []);

  const clearAnchors = useCallback(() => {
    setReceiptAnchor(null);
    onClearAnchor();
  }, [onClearAnchor]);

  const effectiveAnchor = receiptAnchor ?? anchor;

  function focusIn(ref: React.RefObject<HTMLDivElement>, id: string) {
    ref.current?.querySelector<HTMLButtonElement>(`[data-nav="${id}"]`)?.focus();
  }

  function onSurfaceKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = stepSurface(surface, e.key === 'ArrowRight' ? 1 : -1);
    setView(defaultViewFor(next));
    focusIn(surfaceBarRef, next);
  }

  function onSubnavKey(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = stepView(surface, view, e.key === 'ArrowRight' ? 1 : -1);
    setView(next);
    focusIn(subnavRef, next);
  }

  function openSurface(id: SurfaceId) {
    // Returning to a surface you are already on should not silently reset which view you were
    // reading — only a move to a different surface picks that surface's default.
    if (id !== surface) setView(defaultViewFor(id));
  }

  return (
    <section className="thread-panel" aria-label={`${thread.displayName} — the years, the words, and what has been read`}>
      <div className="panel-tabs">
        {onBack && (
          <button
            type="button"
            className="icon-btn back-btn"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            <ChevronLeftIcon />
          </button>
        )}
        <div
          className="tab-switch"
          role="tablist"
          aria-label="Sections"
          ref={surfaceBarRef}
          onKeyDown={onSurfaceKey}
        >
          {SURFACES.map((s) => {
            const selected = s.id === surface;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                data-nav={s.id}
                data-tab={s.id}
                id={`tab-${s.id}`}
                aria-selected={selected}
                aria-controls={`panel-${s.id}`}
                tabIndex={selected ? 0 : -1}
                className={`tab-btn${selected ? ' is-on' : ''}`}
                onClick={() => openSurface(s.id)}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {surfaceViews.length > 1 && (
        <div
          className="tab-subnav"
          role="tablist"
          aria-label={`${SURFACES.find((s) => s.id === surface)!.label} views`}
          ref={subnavRef}
          onKeyDown={onSubnavKey}
        >
          {surfaceViews.map((v) => {
            const selected = v.id === view;
            return (
              <button
                key={v.id}
                type="button"
                role="tab"
                data-nav={v.id}
                data-view={v.id}
                id={`subtab-${v.id}`}
                aria-selected={selected}
                aria-controls={`panel-${surface}`}
                tabIndex={selected ? 0 : -1}
                className={`subtab-btn${selected ? ' is-on' : ''}`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      )}

      <div
        className="panel-body"
        role="tabpanel"
        id={`panel-${surface}`}
        aria-labelledby={surfaceViews.length > 1 ? `subtab-${view}` : `tab-${surface}`}
      >
        {view === 'overview' ? <Overview thread={thread} onOpenReceipt={openReceipt} onOpenHealth={() => setView('health')} />
          : view === 'trajectory' ? <Trajectory thread={thread} onOpenReceipt={openReceipt} />
          : view === 'episodes' ? <Episodes thread={thread} onOpenReceipt={openReceipt} />
          : view === 'eras' ? <Eras thread={thread} onOpenReceipt={openReceipt} />
          : view === 'findings' ? <Findings thread={thread} onOpenReceipt={openReceipt} />
          : view === 'readings' ? <Readings thread={thread} onOpenReceipt={openReceipt} onCalibrate={onOpenCalibration} />
          : view === 'ask' ? <Ask thread={thread} onOpenReceipt={openReceipt} />
          : view === 'shape' ? <ShapeOfIt thread={thread} onOpenReceipt={openReceipt} />
          : view === 'health' ? <ArchiveHealth thread={thread} />
          : view === 'session' ? <Session thread={thread} onOpenReceipt={openReceipt} onCalibrate={onOpenCalibration} />
          : (
            <TranscriptReader
              thread={thread}
              anchor={effectiveAnchor}
              onClearAnchor={clearAnchors}
            />
          )}
      </div>
    </section>
  );
}
