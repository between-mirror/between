// Between Mirror — Settings: the things you set once, gathered in one place.
//
//  · Engine — the one preference that decides whether a reading can spend money or send text
//    off-device. Defaults to the safe 'local-only', honored by the paid Batch path (a local-only
//    owner can't accidentally bill), and surfaced in the estimate gate before any run. Choosing it
//    is a knowing act, not something discovered in a CLI flag.
//  · Calibration — moved here from the tab bar, where it read as a destination. It is a thing you
//    do once, in service of the readings; the *invite* now appears inline wherever a reading is
//    provisional without it (components/CalibrateInvite.tsx).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineMode, ThreadSummary } from '../lib/api';
import { getEngineMode, setEngineMode } from '../lib/api';
import { CloseIcon } from './icons';
import { Calibrate } from '../views/Calibrate';
import { DataPanel } from './DataPanel';

/** Which section to reveal on open. A contextual invite deep-opens the one it is about. */
export type SettingsSection = 'engine' | 'calibration' | 'data';

interface SettingsProps {
  onClose: () => void;
  /** The thread calibration would tune. Absent → the calibration section explains why it's inert. */
  thread?: ThreadSummary | null;
  initialSection?: SettingsSection;
}

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'engine', label: 'Engine' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'data', label: 'Your data' },
];

const OPTIONS: { mode: EngineMode; label: string; blurb: string }[] = [
  {
    mode: 'local-only',
    label: 'Local-only',
    blurb: 'Everything stays on this machine. The counting views are free and instant; the emotion pass runs on a local model (Ollama) if you have one; the literary readings wait until you connect a key. Nothing is billed, nothing is sent. The safe default.',
  },
  {
    mode: 'subscription',
    label: 'Claude subscription',
    blurb: 'The deep readings run through your own Claude session (the /drain-jobs command). No per-run charge, but it uses real capacity and time. Message text goes only to Anthropic, only when you run a reading.',
  },
  {
    mode: 'api-key',
    label: 'Anthropic API key',
    blurb: 'Between runs the readings for you, billed to your own API key. You always see a dollar estimate before any run. The one-time full emotion pass is roughly $30 for a large archive; everything after is pennies. Message text is sent to the Anthropic API when you run a reading.',
  },
];

export function Settings({ onClose, thread = null, initialSection = 'engine' }: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mode, setMode] = useState<EngineMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  // Last-write-wins: only the most recent selection's PUT is allowed to win; the debounce keeps a
  // keyboard user arrowing past 'subscription' to reach 'api-key' from persisting the one they passed.
  const wantRef = useRef<EngineMode | null>(null);
  const timerRef = useRef<number | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getEngineMode(ctrl.signal)
      .then((s) => { setMode(s.mode); wantRef.current = s.mode; })
      .catch((e) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not read settings.'); });
    return () => ctrl.abort();
  }, []);

  // Focus into the dialog so Escape/Tab are captured and focus can't escape behind the scrim.
  useEffect(() => { const t = window.setTimeout(() => doneRef.current?.focus(), 0); return () => window.clearTimeout(t); }, []);

  // Cancel any pending write and abort any in-flight one on unmount.
  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    ctrlRef.current?.abort();
  }, []);

  const choose = useCallback((next: EngineMode) => {
    setMode(next);            // optimistic — the UI reflects the choice immediately
    wantRef.current = next;
    setError(null);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const want = wantRef.current;
      if (want == null) return;
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setSaving(true);
      setEngineMode(want, ctrl.signal)
        .then((s) => { if (wantRef.current === s.mode) setMode(s.mode); })   // ignore stale wins
        .catch((e) => { if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Could not save that just now.'); })
        .finally(() => { if (ctrlRef.current === ctrl) setSaving(false); });
    }, 220);
  }, []);

  // Roving tabindex removes the unselected section buttons from the tab order, so without an arrow
  // handler they are unreachable by keyboard — and nothing else opens the 'data' section, which is
  // where backup and delete live. ThreadPanel implements this pattern twice; Settings did not.
  const sectionsRef = useRef<HTMLDivElement>(null);
  const onSectionKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = SECTIONS.findIndex((x) => x.id === section);
    const next = SECTIONS[(i + (e.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length];
    setSection(next.id);
    sectionsRef.current?.querySelector<HTMLButtonElement>(`[data-section="${next.id}"]`)?.focus();
  }, [section]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const f = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!f || f.length === 0) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 className="modal-title">Settings</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={18} />
          </button>
        </div>

        <div
          className="settings-sections"
          role="tablist"
          aria-label="Settings sections"
          ref={sectionsRef}
          onKeyDown={onSectionKey}
        >
          {SECTIONS.map((sec) => {
            const on = section === sec.id;
            return (
              <button
                key={sec.id}
                type="button"
                role="tab"
                data-section={sec.id}
                id={`settings-tab-${sec.id}`}
                aria-selected={on}
                aria-controls="settings-panel"
                tabIndex={on ? 0 : -1}
                className={`subtab-btn${on ? ' is-on' : ''}`}
                onClick={() => setSection(sec.id)}
              >
                {sec.label}
              </button>
            );
          })}
        </div>

        <div className="modal-body" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${section}`}>
        {section === 'data' ? (
          <DataPanel />
        ) : section === 'calibration' ? (
          <>
            <p className="settings-lede">
              Calibration tunes the reading to your judgement instead of the model&apos;s. Until it is
              done, every directional read is provisional — and says so.
            </p>
            {thread
              ? <Calibrate thread={thread} />
              : <p className="settings-lede">Open a conversation first — calibration is tuned per person.</p>}
          </>
        ) : (
        <>
          <p className="settings-lede">
            The charts, episodes, eras, and findings are always free and never leave this machine. This
            choice only affects the <em>emotion pass</em> and the <em>written readings</em> — the parts that
            can cost time or money. You can change it any time.
          </p>
          {error && <p className="analyze-status analyze-status--error">{error}</p>}
          <fieldset className="settings-modes" disabled={mode == null}>
            {OPTIONS.map((o) => {
              const on = mode === o.mode;
              return (
                <label key={o.mode} className={`settings-mode${on ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name="engine-mode"
                    checked={on}
                    onChange={() => choose(o.mode)}
                  />
                  <span className="settings-mode-body">
                    <span className="settings-mode-label">
                      {o.label}
                      {o.mode === 'local-only' && <span className="settings-mode-tag">default</span>}
                      {on && saving && <span className="settings-mode-tag">saving…</span>}
                    </span>
                    <span className="settings-mode-blurb">{o.blurb}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>
        </>
        )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn--primary" onClick={onClose} ref={doneRef}>Done</button>
        </div>
      </div>
    </div>
  );
}
