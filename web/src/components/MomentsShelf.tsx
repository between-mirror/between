// Between — the Moments shelf (screen 4, GAMEPLAN A.4): a small "Worth
// remembering" strip of T1-surfaced moments, each a door to its receipts.
import { useEffect, useState } from 'react';
import type { MomentDTO } from '../lib/api';
import { getMoments } from '../lib/api';
import { VOICE } from '../lib/voice';
import { SparkIcon } from './icons';

interface MomentsShelfProps {
  threadId: number;
  /** Called when a moment with a message anchor is chosen (drill to receipts). */
  onOpenMessage?: (messageId: number) => void;
}

export function MomentsShelf({ threadId, onOpenMessage }: MomentsShelfProps) {
  const [moments, setMoments] = useState<MomentDTO[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    setMoments([]);
    getMoments(threadId, ctrl.signal)
      .then(setMoments)
      .catch(() => { /* moments are a delight, never a blocker */ });
    return () => ctrl.abort();
  }, [threadId]);

  if (moments.length === 0) return null;

  return (
    <div className="moments-shelf">
      <div className="moments-head">
        <SparkIcon className="moments-spark" />
        <span className="moments-title">{VOICE.momentsHeader}</span>
      </div>
      <div className="moments-strip">
        {moments.map((m) => {
          const anchor = m.messageIds[0];
          const clickable = anchor != null && onOpenMessage != null;
          return (
            <button
              key={m.key}
              type="button"
              className="moment-card"
              data-clickable={clickable}
              onClick={clickable ? () => onOpenMessage!(anchor) : undefined}
              disabled={!clickable}
              title={clickable ? 'Open the messages behind this' : undefined}
            >
              <span className="moment-label">{m.label}</span>
              <span className="moment-value">{m.value}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
