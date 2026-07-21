// Between — transcript row renderers: day dividers, chat bubbles, subtle
// reaction rows, attachment chips. Media is NEVER shown as content — only a
// "photo or media" placeholder chip (HANDOFF invariant 4).
import type { MessageDTO } from '../lib/api';
import {
  attachmentLabel, formatDayDivider, formatTime, reactionGlyph, reactionLabel,
} from '../lib/format';
import { PhotoIcon } from './icons';

export function DayDivider({ ms }: { ms: number }) {
  return (
    <div className="day-divider" role="separator" aria-label={formatDayDivider(ms)}>
      <span className="day-divider-line" aria-hidden />
      <span className="day-divider-label">{formatDayDivider(ms)}</span>
      <span className="day-divider-line" aria-hidden />
    </div>
  );
}

type Side = 'me' | 'them' | 'other';

function sideOf(direction: MessageDTO['direction']): Side {
  if (direction === 'outgoing' || direction === 'draft') return 'me';
  if (direction === 'incoming') return 'them';
  return 'other';
}

/** Subtle reaction (tapback) line — smaller and quieter than a bubble. */
export function ReactionRow({ msg, isGroup }: { msg: MessageDTO; isGroup: boolean }) {
  const side = sideOf(msg.direction);
  const text = msg.bodyText?.trim() || `${reactionLabel(msg.reactionKind)} a message`;
  const who = side === 'them' && isGroup && msg.senderName ? msg.senderName : null;
  return (
    <div className={`reaction-row side-${side}`}>
      <span className="reaction-pill" title={formatTime(msg.sentAtMs)}>
        <span className="reaction-glyph" aria-hidden>{reactionGlyph(msg.reactionKind)}</span>
        {who && <span className="reaction-who">{who}</span>}
        <span className="reaction-text">{text}</span>
      </span>
    </div>
  );
}

interface BubbleProps {
  msg: MessageDTO;
  isGroup: boolean;
  highlighted: boolean;
  registerEl?: (id: number, el: HTMLDivElement | null) => void;
}

export function MessageBubble({ msg, isGroup, highlighted, registerEl }: BubbleProps) {
  const side = sideOf(msg.direction);
  const showSender = side === 'them' && isGroup && !!msg.senderName;
  const hasText = !!msg.bodyText && msg.bodyText.trim().length > 0;
  const hasMedia = msg.attachmentCount > 0;

  return (
    <div className={`msg-row side-${side}`}>
      <div
        className={`bubble${highlighted ? ' is-anchored' : ''}`}
        ref={registerEl ? (el) => registerEl(msg.id, el) : undefined}
        data-mid={msg.id}
      >
        {showSender && <span className="bubble-sender">{msg.senderName}</span>}
        {msg.direction === 'draft' && <span className="bubble-flag">Draft</span>}
        {hasText && <p className="bubble-text">{msg.bodyText}</p>}
        {hasMedia && (
          <span className="attach-chip" title="Media is kept as metadata only, never shown">
            <PhotoIcon className="attach-icon" />
            {attachmentLabel(msg.attachmentCount)}
          </span>
        )}
        {!hasText && !hasMedia && <p className="bubble-text bubble-empty">—</p>}
        <time className="bubble-time" dateTime={new Date(msg.sentAtMs).toISOString()}>
          {formatTime(msg.sentAtMs)}
        </time>
      </div>
    </div>
  );
}
