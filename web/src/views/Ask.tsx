// Between — Ask Anything (v1). A receipts-first search over the archive: no model
// synthesis, no interpretation. You pose a question, narrow it with a few honest
// filters, and the archive answers only with its own words — each receipt shown
// with its date, its direction (you in amber / her in slate), and the plain text.
// If the words don't reach far enough to answer honestly, it says so and stops.
//
// Voice: facts are stated plainly; the archive never pretends to know more than it
// holds. No red/green anywhere — amber↔slate only (this is emotional data).
import { useEffect, useState } from 'react';
import type { ThreadSummary } from '../lib/api';
import type { AskFilters, AskPlan, AskReceipt } from '../lib/api';
import { askPlan } from '../lib/api';
import { askSuggestions } from '../lib/suggestions';
import { StatCard } from '../components/StatCard';

const PLACEHOLDER = 'Ask about the years — every answer shows its receipts.';
const LOADING = 'Reading the archive for what it actually holds…';
const LOAD_ERROR =
  'The archive did not answer just then. It is still here — try again in a moment.';
const NOT_ENOUGH = "The archive doesn't hold enough to answer that honestly.";

type DirectionChoice = 'any' | 'you' | 'her';

interface AskProps {
  thread: ThreadSummary;
  /** Drill from a receipt into the transcript at its message id. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

// A calm, absolute date — no relative "yesterday", the archive speaks in dates.
function formatReceiptDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Fold the UI direction toggle into the api's 'me' | 'them' (undefined = any).
function directionFilter(choice: DirectionChoice): AskFilters['direction'] {
  if (choice === 'you') return 'me';
  if (choice === 'her') return 'them';
  return undefined;
}

export function Ask({ thread, onOpenReceipt }: AskProps) {
  const herName = thread.displayName.split(/\s+/)[0] || 'Them';

  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState<DirectionChoice>('any');
  const [minTension, setMinTension] = useState(0);
  const [kidOnly, setKidOnly] = useState(false);

  // The submitted request: what we actually asked, so we can fetch on demand and
  // keep the live inputs free to change without re-firing.
  const [submitted, setSubmitted] = useState<{ query: string; filters: AskFilters } | null>(null);
  const [plan, setPlan] = useState<AskPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!submitted) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setPlan(null);
    askPlan(thread.id, submitted.query, submitted.filters, ctrl.signal)
      .then((p) => setPlan(p))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id, submitted]);

  // A fresh thread clears the conversation with the archive.
  useEffect(() => {
    setSubmitted(null);
    setPlan(null);
    setError(null);
    setLoading(false);
  }, [thread.id]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const q = query.trim();
    if (q.length === 0) return;
    const filters: AskFilters = {};
    const dir = directionFilter(direction);
    if (dir) filters.direction = dir;
    if (minTension > 0) filters.minTension = minTension;
    if (kidOnly) filters.kidOnly = true;
    // New object identity each submit so re-asking the same words still fires.
    setSubmitted({ query: q, filters });
  }

  /** Ask one of the offered questions with no filters — the demo holds one answer per question. */
  function askSuggested(q: string): void {
    setQuery(q);
    setSubmitted({ query: q, filters: {} });
  }

  // Empty in the installed application — nothing registers anything. Populated only by the browser
  // demo's entry point, where the archive holds prepared answers to exactly these questions.
  const suggested = askSuggestions();

  const answered = plan != null && !loading && !error;
  const sufficient = answered && plan.sufficient;

  return (
    <div className="ask" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        <div className="overview-inner">
          <section className="ov-section" aria-label="Ask anything">
            <div className="ov-head">
              <h2 className="ov-title">Ask anything</h2>
              <p className="ov-sub">
                Receipts first — every answer is drawn straight from the words, never invented.
              </p>
            </div>

            <form className="ask-form" onSubmit={handleSubmit}>
              {suggested.length > 0 ? (
                // Offered questions instead of a text box. Only reachable in the browser demo, which
                // holds answers to exactly these and nothing else — so a text box here would accept
                // anything and refuse almost everything, which is a worse lie than saying so.
                <div className="ask-suggestions" role="group" aria-label="Questions you can ask here">
                  {suggested.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="ask-suggestion"
                      onClick={() => askSuggested(q)}
                    >
                      {q}
                    </button>
                  ))}
                  <p className="ask-suggestion-note">
                    These are prepared answers. Asking your own question needs a language model reading
                    your own archive — that is the installed application, on your machine.
                  </p>
                </div>
              ) : (
                <input
                  type="text"
                  className="ask-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={PLACEHOLDER}
                  aria-label="Ask about the years"
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '0.7rem 0.85rem',
                    fontSize: '1rem',
                    color: 'var(--ink)',
                    background: 'var(--surface)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 'var(--radius)',
                    outline: 'none',
                  }}
                />
              )}

              <div
                className="ask-filters"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '1rem',
                  marginTop: '0.75rem',
                }}
              >
                {/* direction — any / you (amber) / her (slate) */}
                <div
                  className="ask-filter"
                  role="group"
                  aria-label="Direction"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <span
                    style={{
                      fontSize: '0.7rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--ink-faint)',
                    }}
                  >
                    From
                  </span>
                  {(
                    [
                      ['any', 'Anyone', 'var(--ink-soft)'],
                      ['you', 'You', 'var(--warmth)'],
                      ['her', herName, 'var(--tension)'],
                    ] as ReadonlyArray<readonly [DirectionChoice, string, string]>
                  ).map(([value, text, accent]) => {
                    const active = direction === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setDirection(value)}
                        aria-pressed={active}
                        style={{
                          padding: '0.3rem 0.6rem',
                          fontSize: '0.85rem',
                          cursor: 'pointer',
                          color: active ? 'var(--ink)' : 'var(--ink-soft)',
                          background: active ? 'var(--raised)' : 'transparent',
                          border: `1px solid ${active ? accent : 'var(--line)'}`,
                          borderRadius: 'var(--radius)',
                        }}
                      >
                        {text}
                      </button>
                    );
                  })}
                </div>

                {/* minimum tension — 0 through 3 */}
                <label
                  className="ask-filter"
                  style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                >
                  <span
                    style={{
                      fontSize: '0.7rem',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: 'var(--ink-faint)',
                    }}
                  >
                    Min tension
                  </span>
                  <select
                    value={minTension}
                    onChange={(e) => setMinTension(Number(e.target.value))}
                    aria-label="Minimum tension"
                    style={{
                      padding: '0.3rem 0.5rem',
                      fontSize: '0.85rem',
                      color: 'var(--ink)',
                      background: 'var(--surface)',
                      border: '1px solid var(--line-2)',
                      borderRadius: 'var(--radius)',
                    }}
                  >
                    <option value={0}>Any</option>
                    <option value={1}>1+</option>
                    <option value={2}>2+</option>
                    <option value={3}>3</option>
                  </select>
                </label>

                {/* kid-only */}
                <label
                  className="ask-filter"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontSize: '0.85rem',
                    color: 'var(--ink-soft)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={kidOnly}
                    onChange={(e) => setKidOnly(e.target.checked)}
                  />
                  About the kids
                </label>

                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={query.trim().length === 0 || loading}
                  style={{ marginLeft: 'auto' }}
                >
                  Ask
                </button>
              </div>
            </form>
          </section>

          {/* the archive's answer */}
          {loading && <p className="overview-status">{LOADING}</p>}
          {error && !loading && (
            <p className="overview-status overview-status--error">{error}</p>
          )}

          {answered && !sufficient && (
            <section className="ov-section" aria-label="Not enough held">
              <p
                className="overview-status"
                style={{ color: 'var(--ink-soft)' }}
              >
                {NOT_ENOUGH}
              </p>
            </section>
          )}

          {answered && sufficient && (
            <AskAnswer
              plan={plan}
              herName={herName}
              onOpenReceipt={onOpenReceipt}
              formatDate={formatReceiptDate}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface AskAnswerProps {
  plan: AskPlan;
  herName: string;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
  formatDate: (ms: number) => string;
}

function AskAnswer({ plan, herName, onOpenReceipt, formatDate }: AskAnswerProps) {
  const { count, receipts } = plan;
  const shown = receipts.length;

  return (
    <section className="ov-section" aria-label="What the words show">
      <div className="ov-head">
        <h2 className="ov-title">What the words show</h2>
        <p className="ov-sub">
          Drawn straight from the archive — nothing here is paraphrased.
        </p>
      </div>

      <div className="statcards">
        <StatCard
          label="Matches"
          value={<span className="tnum">{count}</span>}
          detail={
            count === 1 ? 'message in the archive' : 'messages in the archive'
          }
          title="How many messages in the archive match this question and its filters."
        />
        <StatCard
          label="Shown here"
          value={<span className="tnum">{shown}</span>}
          detail={shown < count ? 'a first handful' : 'all of them'}
          title="The receipts listed below. Every one links back to the transcript."
        />
      </div>

      {shown === 0 ? (
        <p className="overview-status" style={{ color: 'var(--ink-soft)' }}>
          The count is here, but no lines came back to show. Try widening the filters.
        </p>
      ) : (
        <ul
          className="ask-receipts"
          style={{ listStyle: 'none', margin: '1rem 0 0', padding: 0 }}
        >
          {receipts.map((r) => (
            <ReceiptRow
              key={r.id}
              receipt={r}
              herName={herName}
              onOpenReceipt={onOpenReceipt}
              formatDate={formatDate}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ReceiptRowProps {
  receipt: AskReceipt;
  herName: string;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
  formatDate: (ms: number) => string;
}

function ReceiptRow({ receipt, herName, onOpenReceipt, formatDate }: ReceiptRowProps) {
  const isMe = receipt.dir === 'me';
  const accent = isMe ? 'var(--warmth)' : 'var(--tension)';
  const who = isMe ? 'ME' : 'THEM';
  const clickable = onOpenReceipt != null;

  function open(): void {
    if (onOpenReceipt) onOpenReceipt(receipt.id, receipt.ms);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLLIElement>): void {
    if (!clickable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  }

  return (
    <li
      className="ask-receipt"
      onClick={clickable ? open : undefined}
      onKeyDown={onKeyDown}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={clickable ? 'Open this in the transcript' : undefined}
      aria-label={`${isMe ? 'You' : herName}, ${formatDate(receipt.ms)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '0.75rem',
        padding: '0.7rem 0.85rem',
        marginTop: '0.5rem',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
        borderLeft: `3px solid ${accent}`,
        borderRadius: 'var(--radius)',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.15rem',
          minWidth: '4.5rem',
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '0.06em',
            color: accent,
          }}
        >
          {who}
        </span>
        <span
          className="tnum"
          style={{ fontSize: '0.75rem', color: 'var(--ink-faint)' }}
        >
          {formatDate(receipt.ms)}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          color: 'var(--ink)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {receipt.text}
      </p>
    </li>
  );
}
