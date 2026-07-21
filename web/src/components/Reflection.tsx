// Between — Reflection: one frozen, dated first reading, rendered as
// correspondence (VOICE §4 register). The letter is immutable; regeneration is a
// new dated row, never a correction. Every claim that grounds a line links to
// its receipts — "The words underneath" (VOICE §6) — which resolve to the real
// messages and open the transcript at those ids (invariant 1). Disagreement
// ("That's not right") suppresses a claim and is acknowledged in the voice.
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import type { MessageDTO, ReflectionClaim, ReflectionDTO } from '../lib/api';
import { getMessagesByIds, postOverride } from '../lib/api';
import { VOICE, VOICE_INTERIM } from '../lib/voice';
import { formatFullDate, formatTime } from '../lib/format';

interface ReflectionProps {
  reflection: ReflectionDTO;
  displayName: string;
  /** Drill to receipts: open the transcript at a message id. */
  onOpenReceipt: (messageId: number, sentAtMs: number) => void;
}

// ── a tiny, safe inline renderer (no markdown dep) ───────────────────────────
// Handles *emphasis* / _emphasis_ only; everything else is plain text nodes, so
// nothing from the model's prose can inject markup.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /([*_])(.+?)\1/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<em key={`${keyBase}-em-${i++}`}>{m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderBody(md: string): ReactNode[] {
  return md
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para, i) => <p key={`p-${i}`} className="reflection-para">{renderInline(para, `p-${i}`)}</p>);
}

function generatedDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatFullDate(ms) : iso;
}

// ── one claim's receipts, lazily loaded on first open ────────────────────────
function ReceiptDrawer({
  claim, displayName, onOpenReceipt,
}: {
  claim: ReflectionClaim;
  displayName: string;
  onOpenReceipt: (id: number, ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<MessageDTO[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [suppressed, setSuppressed] = useState(false);
  const [disagreed, setDisagreed] = useState(false);

  const them = displayName.split(/\s+/)[0] || 'Them';

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (next && messages == null && !loading) {
      setLoading(true);
      setFailed(false);
      try {
        setMessages(await getMessagesByIds(claim.evidenceIds));
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }, [open, messages, loading, claim.evidenceIds]);

  const disagree = useCallback(async () => {
    setSuppressed(true);
    setDisagreed(true);
    try {
      await postOverride({ targetKind: 'claim', targetRef: claim.id, action: 'suppress' });
    } catch {
      // The acknowledgement stands locally; the write is best-effort here.
    }
  }, [claim.id]);

  const conf = claim.confidence === 'surer'
    ? VOICE.confidenceSurer
    : claim.confidence === 'less_sure'
      ? VOICE.confidenceLessSure
      : null;

  return (
    <li className={`receipt${suppressed ? ' receipt--suppressed' : ''}`}>
      <div className="receipt-head">
        <button
          type="button"
          className="receipt-claim"
          aria-expanded={open}
          onClick={toggle}
          disabled={suppressed}
        >
          <span className="receipt-fragment">“{claim.fragment}”</span>
          <span className="receipt-open">
            {open ? VOICE_INTERIM.hideReceipts : VOICE_INTERIM.showReceipts}
          </span>
        </button>
        {conf && <span className={`receipt-conf receipt-conf--${claim.confidence}`}>{conf}</span>}
      </div>

      {open && !suppressed && (
        <div className="receipt-body">
          {loading && <p className="receipt-status">Opening the words…</p>}
          {failed && <p className="receipt-status">{VOICE.refusedWindow}</p>}
          {messages && messages.length === 0 && !loading && (
            <p className="receipt-status">These messages aren’t in the archive.</p>
          )}
          {messages && messages.length > 0 && (
            <ul className="receipt-messages">
              {messages.map((msg) => {
                const mine = msg.direction === 'outgoing';
                return (
                  <li key={msg.id} className={`receipt-msg${mine ? ' receipt-msg--me' : ''}`}>
                    <button
                      type="button"
                      className="receipt-msg-btn"
                      onClick={() => onOpenReceipt(msg.id, msg.sentAtMs)}
                      title={VOICE_INTERIM.openInTranscript}
                    >
                      <span className="receipt-msg-meta tnum">
                        <span className="receipt-msg-who">{mine ? 'You' : them}</span>
                        {' · '}
                        {formatFullDate(msg.sentAtMs)} · {formatTime(msg.sentAtMs)}
                      </span>
                      <span className="receipt-msg-text">
                        {msg.bodyText?.trim() || (msg.attachmentCount > 0 ? 'Photo or media' : '—')}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="receipt-foot">
            <button type="button" className="link-btn receipt-disagree" onClick={disagree}>
              {VOICE.disagree}
            </button>
          </div>
        </div>
      )}

      {disagreed && <p className="receipt-ack" role="status">{VOICE.disagreeAck}</p>}
    </li>
  );
}

export function Reflection({ reflection, displayName, onOpenReceipt }: ReflectionProps) {
  // Only claims whose receipts resolve are worth drilling (invariant 1).
  const claims = reflection.claims.filter((c) => c.evidenceIds.length > 0);
  const title = reflection.title?.trim() || 'A first reading';

  return (
    <article className="reflection" aria-label="A first reading">
      <header className="reflection-head">
        <h2 className="reflection-title">{title}</h2>
        <p className="reflection-dateline">
          {VOICE_INTERIM.oneReadingDatedTemplate.replace('{date}', generatedDate(reflection.generatedAt))}
          {' · '}{displayName}
        </p>
      </header>

      <div className="reflection-body">
        {renderBody(reflection.contentMd)}
      </div>

      <p className="reflection-footer">{VOICE.firstReadingFooter}</p>

      {claims.length > 0 && (
        <section className="reflection-receipts" aria-label="The words underneath">
          <h3 className="reflection-receipts-title">{VOICE.evidencePanelHeader}</h3>
          <p className="reflection-receipts-sub">
            Every line above stands on real messages. Open any to read them yourself.
          </p>
          <ul className="receipt-list">
            {claims.map((claim) => (
              <ReceiptDrawer
                key={claim.id}
                claim={claim}
                displayName={displayName}
                onOpenReceipt={onOpenReceipt}
              />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
