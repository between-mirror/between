// Between — Calibrate (P2): the owner tunes the tool to themselves by labeling a blind hold-out of
// their own thread, both sides. The model's tension is never sent to the browser, so the owner labels
// without anchoring; the server rejoins the score and measures whether they were gentler on their own
// hard messages than the partner's (the self-report-bias defence). Honesty is load-bearing — the intro
// imperative is verbatim VOICE, not paraphrased. Until this is done, every directional read is provisional.
import { useCallback, useEffect, useState } from 'react';
import type { ThreadSummary, HoldoutItem, OwnerLabel, OwnerMark, CalibrationResult, CalibrationStatus } from '../lib/api';
import { getCalibrationStatus, getCalibrationSample, submitCalibration } from '../lib/api';
import { VOICE } from '../lib/voice';

const LOADING = 'Drawing a fair sample of your own words…';
const LOAD_ERROR = 'The sample did not come through. The conversation is still here — try again in a moment.';

const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = (ms: number) => dayLabel.format(new Date(ms));

// Escalating options. benign/joke read as ordinary; mild→cruel climb amber→clay. Never red.
const OPTIONS: { label: OwnerLabel; key: string; caption: string }[] = [
  { label: 'benign', key: '1', caption: 'ordinary' },
  { label: 'joke', key: '2', caption: 'playful' },
  { label: 'mild', key: '3', caption: 'a little sharp' },
  { label: 'harsh', key: '4', caption: 'genuinely harsh' },
  { label: 'cruel', key: '5', caption: 'meant to wound' },
];

interface CalibrateProps { thread: ThreadSummary }

export function Calibrate({ thread }: CalibrateProps) {
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [phase, setPhase] = useState<'intro' | 'labeling' | 'done'>('intro');
  const [items, setItems] = useState<HoldoutItem[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [marks, setMarks] = useState<OwnerMark[]>([]);
  const [result, setResult] = useState<CalibrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    getCalibrationStatus(thread.id, ctrl.signal).then(setStatus).catch(() => { /* non-fatal */ });
    return () => ctrl.abort();
  }, [thread.id]);

  const begin = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const sample = await getCalibrationSample(thread.id, 40);
      setItems(sample); setIdx(0); setMarks([]); setResult(null); setPhase('labeling');
    } catch (e) { setError(e instanceof Error ? e.message : LOAD_ERROR); }
    finally { setBusy(false); }
  }, [thread.id]);

  const finish = useCallback(async (all: OwnerMark[]) => {
    setBusy(true); setError(null); setPhase('done');
    try {
      const res = await submitCalibration(thread.id, all);
      setResult(res);
      getCalibrationStatus(thread.id).then(setStatus).catch(() => { /* ignore */ });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your calibration. Try again.'); setPhase('labeling'); }
    finally { setBusy(false); }
  }, [thread.id]);

  const mark = useCallback((label: OwnerLabel) => {
    if (!items || busy) return;
    const next = [...marks, { id: items[idx].id, label }];
    setMarks(next);
    if (idx + 1 >= items.length) void finish(next);
    else setIdx(idx + 1);
  }, [items, idx, marks, busy, finish]);

  // keyboard: 1–5 label, s/0 skip, ← back
  useEffect(() => {
    if (phase !== 'labeling') return;
    const onKey = (e: KeyboardEvent) => {
      const opt = OPTIONS.find((o) => o.key === e.key);
      if (opt) { e.preventDefault(); mark(opt.label); }
      else if (e.key === 's' || e.key === '0') { e.preventDefault(); mark('skip'); }
      else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); setMarks(marks.slice(0, -1)); setIdx(idx - 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, mark, idx, marks]);

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {phase === 'intro' ? <Intro status={status} busy={busy} error={error} onBegin={begin} />
          : phase === 'labeling' && items ? (
            <Labeling item={items[idx]} idx={idx} total={items.length} onMark={mark}
              onBack={idx > 0 ? () => { setMarks(marks.slice(0, -1)); setIdx(idx - 1); } : undefined} />
          )
          : <Done result={result} busy={busy} error={error} status={status} onRedo={() => setPhase('intro')} />}
      </div>
    </div>
  );
}

function Intro({ status, busy, error, onBegin }: { status: CalibrationStatus | null; busy: boolean; error: string | null; onBegin: () => void }) {
  const done = status?.calibrated;
  return (
    <div className="overview-inner cal2">
      <section className="ov-section">
        <div className="ov-head">
          <h2 className="ov-title">Calibrate the reading to you</h2>
          <p className="ov-sub">{done ? 'Already tuned to you. You can run it again any time.' : 'One honest half-hour that everything directional depends on.'}</p>
        </div>
        <p className="cal2-imperative">{VOICE.calibrationIntro}</p>
        {done && status && <p className="cal2-status">{status.note}</p>}
        {error && <p className="overview-status overview-status--error">{error}</p>}
        <button type="button" className="cal2-primary" onClick={onBegin} disabled={busy}>
          {busy ? 'Drawing your sample…' : done ? 'Re-calibrate' : 'Begin'}
        </button>
        <p className="cal2-fine">About 40 messages, both sides. You'll never see the tool's own score — that's the point. It takes a few minutes.</p>
      </section>
    </div>
  );
}

function Labeling({ item, idx, total, onMark, onBack }: {
  item: HoldoutItem; idx: number; total: number; onMark: (l: OwnerLabel) => void; onBack?: () => void;
}) {
  const who = item.dir === 'ME' ? 'You' : 'Them';
  return (
    <div className="overview-inner cal2">
      <section className="ov-section">
        <div className="cal2-progress" aria-label={`Message ${idx + 1} of ${total}`}>
          <span className="cal2-progress-fill" style={{ width: `${((idx) / total) * 100}%` }} aria-hidden />
        </div>
        <p className="cal2-count tnum">{idx + 1} / {total}</p>
        <div className={`cal2-card cal2-card--${item.dir === 'ME' ? 'me' : 'them'}`}>
          <span className="cal2-who">{who} · {fmtDay(item.ms)}</span>
          <p className="cal2-text">{item.text}</p>
        </div>
        <p className="cal2-hint">{VOICE.calibrationItemHint}</p>
        <div className="cal2-options">
          {OPTIONS.map((o) => (
            <button key={o.label} type="button" className={`cal2-opt cal2-opt--${o.label}`} onClick={() => onMark(o.label)}>
              <span className="cal2-opt-key">{o.key}</span>
              <span className="cal2-opt-label">{o.label}</span>
              <span className="cal2-opt-cap">{o.caption}</span>
            </button>
          ))}
        </div>
        <div className="cal2-row">
          <button type="button" className="cal2-skip" onClick={() => onMark('skip')}>Skip (s)</button>
          {onBack && <button type="button" className="cal2-skip" onClick={onBack}>← Back</button>}
        </div>
      </section>
    </div>
  );
}

function Done({ result, busy, error, status, onRedo }: {
  result: CalibrationResult | null; busy: boolean; error: string | null; status: CalibrationStatus | null; onRedo: () => void;
}) {
  return (
    <div className="overview-inner cal2">
      <section className="ov-section">
        <div className="ov-head"><h2 className="ov-title">Calibrated</h2></div>
        {busy && <p className="overview-status">Measuring how you weighed both sides…</p>}
        {error && <p className="overview-status overview-status--error">{error}</p>}
        {result && (
          <>
            <p className={`cal2-verdict cal2-verdict--${result.bias.verdict}`}>
              {result.bias.verdict === 'self_lenient' ? VOICE.calibrationBiasLenient
                : result.bias.verdict === 'self_critical' ? VOICE.calibrationBiasSelfCritical
                : result.bias.verdict === 'insufficient' ? VOICE.calibrationBiasInsufficient
                : VOICE.calibrationBiasClean}
            </p>
            <p className="cal2-status">
              Your thresholds are set (hostile ≥ {result.thresholds.hostile_tension}, severe ≥ {result.thresholds.severe_tension}).
              {result.bias.verdict === 'self_lenient' || result.bias.verdict === 'insufficient'
                ? ' The power-balance gate now needs more one-directional evidence before it will take a side.'
                : ' The gate reads your calibration at face value.'}
            </p>
            {status && <p className="cal2-fine">{status.note}</p>}
            <button type="button" className="cal2-primary" onClick={onRedo}>Run it again</button>
          </>
        )}
      </section>
    </div>
  );
}
