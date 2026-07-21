// Between Mirror — the contextual calibration invite.
//
// Calibrate used to be one of eleven peer tabs, which was wrong in both directions: a stranger read
// it as a destination (it isn't — it is a thing you do once, in service of something else), and the
// readings that actually depend on it gave no sign that they did. So the flow moved to Settings, and
// the *invite* appears here, inline, exactly where a reading is provisional without it.
//
// Register: this is an offer, never a nag. It states what is true — the reading is leaning on the
// model's own eyes rather than yours — and stays out of the way. It never blocks anything, because a
// reading you have not calibrated is still a reading; it is just holding its frame more neutral.
import { useEffect, useState } from 'react';
import type { ThreadSummary } from '../lib/api';
import { getCalibrationStatus } from '../lib/api';

interface CalibrateInviteProps {
  thread: ThreadSummary;
  /** Opens Settings at the calibration section. Absent → the invite explains where to find it. */
  onCalibrate?: () => void;
}

export function CalibrateInvite({ thread, onCalibrate }: CalibrateInviteProps) {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setNeeded(false);
    getCalibrationStatus(thread.id, ctrl.signal)
      .then((s) => setNeeded(!s.calibrated))
      .catch(() => { /* status unavailable — say nothing rather than guess */ });
    return () => ctrl.abort();
  }, [thread.id]);

  if (!needed) return null;

  return (
    <div className="calibrate-invite" role="note">
      <p className="calibrate-invite-text">
        This reading hasn’t been tuned to you yet, so it leans on the model’s own eyes rather than
        your judgement. Twenty minutes of labelling your own words — both sides — changes that.
      </p>
      {onCalibrate ? (
        <button type="button" className="btn btn--quiet" onClick={onCalibrate}>
          Tune it to me
        </button>
      ) : (
        <p className="calibrate-invite-where">Settings → Calibration.</p>
      )}
    </div>
  );
}
