// Between — Calibrate (P2): the owner tunes the tool to themselves by labeling a blind hold-out of
// their own thread, both sides. The model's tension is never sent to the browser, so the owner labels
// without anchoring; the server rejoins the score and measures whether they were gentler on their own
// hard messages than the partner's (the self-report-bias defence). Honesty is load-bearing — the intro
// imperative is verbatim VOICE, not paraphrased. Until this is done, every directional read is provisional.
//
// Rubric v2 changed two things about the shape of this flow.
//
// The QUESTION. v1 asked how bad each message was, on a benign→cruel ladder. That is a judgement of
// intent, which cannot be read off the text — and asking someone to judge the intent behind their own
// messages is precisely where a defensive answer has room to hide. v2 asks what is observable in the
// words: was someone named, was there a threat, were they brushed past, was there an attempt to
// repair. A stranger reading the same message could check the answer.
//
// The ENDING. v1 went from the last label straight to persisted thresholds, chosen by maximizing F1
// behind the owner's back. The disagreements between their reading and the model's — the single most
// informative thing the exercise produces — were computed and discarded. Now there is a review step:
// the disagreements are shown, and nothing is written until the owner confirms or goes back.
import { useCallback, useEffect, useState } from 'react';
import type {
  ThreadSummary, HoldoutItem, OwnerLabel, OwnerMark,
  CalibrationResult, CalibrationReview, CalibrationStatus,
} from '../lib/api';
import { getCalibrationStatus, getCalibrationSample, reviewCalibration, submitCalibration } from '../lib/api';
import { VOICE } from '../lib/voice';

const LOADING = 'Drawing a fair sample of your own words…';
const LOAD_ERROR = 'The sample did not come through. The conversation is still here — try again in a moment.';

const dayLabel = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = (ms: number) => dayLabel.format(new Date(ms));

// The five points of rubric v2 (VOICE §6, verbatim). Ordered by how hard the behaviour is, with the
// one positive second so the scale does not read as a severity ladder wearing new words.
const OPTIONS: { label: OwnerLabel; key: string; title: string; caption: string }[] = [
  { label: 'none', key: '1', title: 'Nothing of the kind', caption: 'ordinary talk' },
  { label: 'repair', key: '2', title: 'Reaching back', caption: 'an apology, a softening, an attempt to fix it' },
  { label: 'dismissal', key: '3', title: 'Brushed past', caption: "talked over, changed the subject, didn't engage" },
  { label: 'name_calling', key: '4', title: 'Named them', caption: 'said what they are, not what they did' },
  { label: 'threat', key: '5', title: 'A threat or an ultimatum', caption: "or else, or I'll, or we're done" },
];

type Phase = 'intro' | 'labeling' | 'review' | 'done';

interface CalibrateProps { thread: ThreadSummary }

export function Calibrate({ thread }: CalibrateProps) {
  const [status, setStatus] = useState<CalibrationStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('intro');
  const [items, setItems] = useState<HoldoutItem[] | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [idx, setIdx] = useState(0);
  const [marks, setMarks] = useState<OwnerMark[]>([]);
  const [review, setReview] = useState<CalibrationReview | null>(null);
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
      const sample = await getCalibrationSample(thread.id, 42);
      setItems(sample.items); setSeed(sample.seed);
      setIdx(0); setMarks([]); setReview(null); setResult(null); setPhase('labeling');
    } catch (e) { setError(e instanceof Error ? e.message : LOAD_ERROR); }
    finally { setBusy(false); }
  }, [thread.id]);

  const commit = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      setResult(await submitCalibration(thread.id, marks, seed));
      setPhase('done');
      getCalibrationStatus(thread.id).then(setStatus).catch(() => { /* ignore */ });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save your calibration. Try again.'); }
    finally { setBusy(false); }
  }, [thread.id, marks, seed]);

  /** Change one label from the review screen, without redoing the whole pass. */
  const relabel = useCallback((id: number, label: OwnerLabel) => {
    setMarks((prev) => prev.map((m) => (m.id === id ? { ...m, label } : m)));
  }, []);

  // The proposal, recomputed from whatever the labels currently are.
  //
  // This is the ONLY path that fetches it, on entering the review and again after every edit. If the
  // screen kept showing the thresholds derived from the labels BEFORE an edit while the commit sent
  // the edited ones, the owner could read "hard reads at 2 and above", change three labels, and save
  // a 1 — a number about their own words changing between what they were shown and what was written.
  // That is a smaller version of exactly the thing this step exists to stop, and not less true for
  // being smaller. Nothing here writes: the review endpoint is read-only by construction.
  // While a refetch is in flight the numbers on screen belong to the PREVIOUS labels, so confirming
  // in that window would save one number having been shown another — the same divergence, just
  // inside a second rather than across an edit. Saving waits for the screen to catch up.
  const [restating, setRestating] = useState(false);
  useEffect(() => {
    if (phase !== 'review' || marks.length === 0) return;
    const ctrl = new AbortController();
    setError(null);
    setRestating(true);
    reviewCalibration(thread.id, marks, seed, ctrl.signal)
      .then((r) => { if (!ctrl.signal.aborted) { setReview(r); setRestating(false); } })
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setRestating(false);
        if (!review) setError(e instanceof Error ? e.message : 'Could not read your labels back.');
        // With a proposal already on screen, keep it: the commit recomputes server-side regardless.
      });
    return () => ctrl.abort();
  }, [marks, phase, thread.id, seed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Walk back through the pass KEEPING every label, including the edits just made on the review
  // screen. This used to call setMarks([]) — so a button reading "Let me change some" silently
  // destroyed all forty-two, with no confirmation and no undo, and sent the owner back to 1/42. The
  // intro sells this as an honest half-hour; `marks` is the only copy of it, because the review
  // endpoint deliberately persists nothing.
  const reconsider = useCallback(() => { setIdx(0); setPhase('labeling'); }, []);

  const mark = useCallback((label: OwnerLabel) => {
    if (!items || busy) return;
    // Written at the position, not appended: stepping back and forward overwrites rather than
    // duplicating, which is what lets `reconsider` keep the work.
    const id = items[idx].id;
    setMarks((prev) => (prev.some((m) => m.id === id)
      ? prev.map((m) => (m.id === id ? { ...m, label } : m))
      : [...prev, { id, label }]));
    // The last label proposes; it does not decide. The effect above fetches the proposal.
    if (idx + 1 >= items.length) setPhase('review');
    else setIdx(idx + 1);
  }, [items, idx, busy]);

  // keyboard: 1–5 label, s/0 skip, ← back
  useEffect(() => {
    if (phase !== 'labeling') return;
    const onKey = (e: KeyboardEvent) => {
      const opt = OPTIONS.find((o) => o.key === e.key);
      if (opt) { e.preventDefault(); mark(opt.label); }
      else if (e.key === 's' || e.key === '0') { e.preventDefault(); mark('skip'); }
      // Back keeps the label that was given; the next keypress overwrites it.
      else if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); setIdx(idx - 1); }
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
              onBack={idx > 0 ? () => setIdx(idx - 1) : undefined} />
          )
          : phase === 'review' ? (
            <Review review={review} marks={marks} busy={busy} restating={restating} error={error}
              onRelabel={relabel} onConfirm={commit} onReconsider={reconsider} />
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
        {/* The honesty imperative, unchanged across both rubrics. It was the part that worked. */}
        <p className="cal2-imperative">{VOICE.calibrationIntro}</p>
        {done && status && <p className="cal2-status">{status.note}</p>}
        {error && <p className="overview-status overview-status--error">{error}</p>}
        <button type="button" className="cal2-primary" onClick={onBegin} disabled={busy}>
          {busy ? LOADING : done ? 'Re-calibrate' : 'Begin'}
        </button>
        <p className="cal2-fine">
          About 40 messages, both sides — drawn across the whole range of how the tool reads them, not
          just the loud ones. You'll never see its score; that's the point. It takes a few minutes.
        </p>
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
        <p className="cal2-hint">{VOICE.calibrationItemHintV2}</p>
        <div className="cal2-options">
          {OPTIONS.map((o) => (
            <button key={o.label} type="button" className={`cal2-opt cal2-opt--${o.label}`} onClick={() => onMark(o.label)}>
              <span className="cal2-opt-key">{o.key}</span>
              <span className="cal2-opt-label">{o.title}</span>
              <span className="cal2-opt-cap">{o.caption}</span>
            </button>
          ))}
        </div>
        <div className="cal2-row">
          <button type="button" className="cal2-skip" onClick={() => onMark('skip')}>{VOICE.calibrationSkip}</button>
          {onBack && <button type="button" className="cal2-skip" onClick={onBack}>← Back</button>}
        </div>
      </section>
    </div>
  );
}

/**
 * The step v1 did not have. The thresholds that follow this owner through every later reading used
 * to be picked by an optimizer over disagreements nobody was shown.
 */
function Review({ review, marks, busy, restating, error, onRelabel, onConfirm, onReconsider }: {
  review: CalibrationReview | null; marks: OwnerMark[]; busy: boolean; restating: boolean;
  error: string | null;
  onRelabel: (id: number, label: OwnerLabel) => void;
  onConfirm: () => void; onReconsider: () => void;
}) {
  const current = (id: number): OwnerLabel => marks.find((m) => m.id === id)?.label ?? 'none';
  return (
    <div className="overview-inner cal2">
      <section className="ov-section">
        <div className="ov-head">
          <h2 className="ov-title">{VOICE.calibrationReviewHeader}</h2>
        </div>
        {busy && !review && <p className="overview-status">Comparing your labels with the tool's reading…</p>}
        {error && <p className="overview-status overview-status--error">{error}</p>}

        {review && review.disagreements.length === 0 && (
          <p className="cal2-status">{VOICE.calibrationReviewNone}</p>
        )}

        {review && review.disagreements.length > 0 && (
          <>
            <p className="cal2-imperative">{VOICE.calibrationReviewIntro}</p>
            <ul className="cal2-disagreements">
              {review.disagreements.map((d) => (
                <li key={d.id} className={`cal2-disagreement cal2-disagreement--${d.kind}`}>
                  <p className="cal2-disagreement-why">
                    {d.kind === 'model_harder'
                      ? VOICE.calibrationReviewModelHarder
                      : VOICE.calibrationReviewOwnerHarder}
                  </p>
                  <div className={`cal2-card cal2-card--${d.dir === 'ME' ? 'me' : 'them'}`}>
                    <span className="cal2-who">{d.dir === 'ME' ? 'You' : 'Them'} · {fmtDay(d.ms)}</span>
                    <p className="cal2-text">{d.text}</p>
                  </div>
                  <label className="cal2-relabel">
                    <span className="cal2-relabel-label">You said: </span>
                    <select
                      value={current(d.id)}
                      onChange={(e) => onRelabel(d.id, e.target.value as OwnerLabel)}
                    >
                      {OPTIONS.map((o) => (
                        <option key={o.label} value={o.label}>{o.title}</option>
                      ))}
                      <option value="skip">Can't tell</option>
                    </select>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        {review && (
          <>
            <p className="cal2-status">
              With these labels, hard reads at {review.thresholds.hostile_tension} and above, severe at{' '}
              {review.thresholds.severe_tension}. Nothing is saved yet.
            </p>
            <div className="cal2-row">
              <button type="button" className="cal2-primary" onClick={onConfirm}
                disabled={busy || restating}>
                {busy ? 'Saving…' : restating ? 'Reading your change back…' : VOICE.calibrationReviewConfirm}
              </button>
              <button type="button" className="cal2-skip" onClick={onReconsider} disabled={busy}>
                {VOICE.calibrationReviewAdjust}
              </button>
            </div>
          </>
        )}
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
