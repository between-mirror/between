// Between — Readings: the letter reader. A quiet shelf of the frozen reflections
// this thread has earned (a first reading, the letter, the weather from the other side,
// your own line), newest first. Selecting one opens it as readable prose — serif,
// measured, dated, and never editable. These are letters, not dashboards: the
// numbers step back and the words are given room. No LLM here; everything is
// already written and frozen on the server. Amber↔slate only — no red/green.
import { useEffect, useState } from 'react';
import type { ReflectionSummary, ReflectionDTO, ThreadSummary } from '../lib/api';
import { getAllReflections, getReflection } from '../lib/api';
import { StatCard } from '../components/StatCard';
import { CalibrateInvite } from '../components/CalibrateInvite';

// Interim, in-register copy — plain sentences, no spinners (matches Overview).
const LIST_LOADING = 'Gathering what has been read so far…';
const LIST_ERROR =
  'The readings did not come through. The conversation is still here — try again in a moment.';
const ONE_LOADING = 'Opening the letter…';
const ONE_ERROR =
  'This reading could not be opened just now. It is still safe — try again in a moment.';

interface ReadingsProps {
  thread: ThreadSummary;
  /** Drill from a receipted claim to the transcript at a message id. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
  /** Open Settings at calibration. The invite is contextual; the flow lives there. */
  onCalibrate?: () => void;
}

// ── lens vocabulary ──────────────────────────────────────────────────────────
// Friendly, human titles per lens. The server's `lens` is a plain string, so we
// fall back gracefully to any title it provides, then to a neutral label.
type Lens = 'first_reflection' | 'letter' | 'herside_reading' | 'growth_note' | 'findings_reading';

const LENS_TITLE: Record<Lens, string> = {
  first_reflection: 'A first reading',
  letter: 'The letter',
  herside_reading: 'The weather from the other side',
  growth_note: 'Your own line',
  findings_reading: 'The findings',
};

const LENS_BLURB: Record<Lens, string> = {
  first_reflection: 'An opening read of the whole thread.',
  letter: 'A letter drawn from what was said.',
  herside_reading: 'The same weather, seen from the other side.',
  growth_note: 'A quiet note to your future self.',
  findings_reading: 'The last five questions, answered.',
};

function isLens(x: string): x is Lens {
  return x === 'first_reflection' || x === 'letter'
    || x === 'herside_reading' || x === 'growth_note' || x === 'findings_reading';
}

function lensTitle(r: ReflectionSummary): string {
  if (isLens(r.lens)) return LENS_TITLE[r.lens];
  if (r.title && r.title.trim()) return r.title.trim();
  return 'A reading';
}

function lensBlurb(r: ReflectionSummary): string | null {
  if (isLens(r.lens)) return LENS_BLURB[r.lens];
  return null;
}

// The soft token accent: warmth for the owner-facing readings, slate for the
// view-from-her-side. Never a status color.
function lensTone(lens: string): 'warmth' | 'tension' | 'neutral' {
  if (lens === 'herside_reading') return 'tension';
  if (lens === 'first_reflection' || lens === 'letter' || lens === 'growth_note' || lens === 'findings_reading') return 'warmth';
  return 'neutral';
}

// ── date formatting ──────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── minimal markdown → paragraphs ────────────────────────────────────────────
// The frozen prose is light markdown. We only do what the reader needs: strip a
// single leading "# " title marker per block, and split blank-line-separated
// blocks into paragraphs. Everything else is rendered as plain text — no HTML is
// interpreted, so the letter can never inject markup.
function toParagraphs(md: string): string[] {
  return md
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#\s+/, '').trim())
    .filter((block) => block.length > 0);
}

// ── the view ─────────────────────────────────────────────────────────────────

export function Readings({ thread, onOpenReceipt, onCalibrate }: ReadingsProps) {
  const [list, setList] = useState<ReflectionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setList(null);
    setSelectedId(null);
    getAllReflections(thread.id, ctrl.signal)
      .then((rows) => {
        // Newest first — the letter is dated, so we can trust generatedAt.
        const sorted = [...rows].sort(
          (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
        );
        setList(sorted);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LIST_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  return (
    <div className="readings" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LIST_LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : list && list.length > 0 ? (
          <div className="overview-inner">
            <CalibrateInvite thread={thread} onCalibrate={onCalibrate} />
            <section className="ov-section">
              <div className="ov-head">
                <h2 className="ov-title">Readings</h2>
                <p className="ov-sub">
                  Letters drawn from these years — dated, frozen, and yours to reread.
                </p>
              </div>
              <div className="statcards">
                {list.map((r) => (
                  <StatCard
                    key={r.id}
                    label={formatDate(r.generatedAt)}
                    tone={lensTone(r.lens)}
                    value={
                      <button
                        type="button"
                        className="reading-open"
                        onClick={() => setSelectedId(r.id)}
                        style={{
                          font: 'inherit',
                          color: 'inherit',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          margin: 0,
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        {lensTitle(r)}
                      </button>
                    }
                    detail={lensBlurb(r) ?? undefined}
                    title={lensBlurb(r) ?? undefined}
                  />
                ))}
              </div>
            </section>
          </div>
        ) : (
          <div className="overview-inner">
            <section className="ov-section">
              <div className="ov-head">
                <h2 className="ov-title">Readings</h2>
                <p className="ov-sub">
                  No readings yet. When one is written, it will rest here — dated and unchanged.
                </p>
              </div>
            </section>
          </div>
        )}
      </div>

      {selectedId != null && (
        <ReadingReader
          id={selectedId}
          onClose={() => setSelectedId(null)}
          onOpenReceipt={onOpenReceipt}
        />
      )}
    </div>
  );
}

// ── the open letter ──────────────────────────────────────────────────────────

interface ReadingReaderProps {
  id: number;
  onClose: () => void;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

function ReadingReader({ id, onClose, onOpenReceipt }: ReadingReaderProps) {
  const [dto, setDto] = useState<ReflectionDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setDto(null);
    getReflection(id, ctrl.signal)
      .then((r) => setDto(r))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(ONE_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [id]);

  const paragraphs = dto ? toParagraphs(dto.contentMd) : [];
  // Count only claims that actually carry a receipt (at least one message id).
  const receiptedClaims = dto
    ? dto.claims.filter((c) => c.evidenceIds.length > 0)
    : [];
  const claimCount = receiptedClaims.length;
  // The first receipt we can offer as a gentle "read the receipts" affordance.
  const firstReceipt = receiptedClaims.find((c) => c.evidenceIds.length > 0);

  const heading = dto ? readingHeading(dto) : '';

  return (
    <div
      className="reading-sheet"
      style={{
        borderTop: '1px solid var(--line)',
        marginTop: 8,
      }}
    >
      <section className="ov-section">
        <div className="ov-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <h2 className="ov-title">{loading ? 'Reading' : heading || 'A reading'}</h2>
            <button
              type="button"
              className="reading-close"
              onClick={onClose}
              style={{
                font: 'inherit',
                color: 'var(--ink-faint)',
                background: 'none',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)',
                padding: '2px 10px',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
          {dto && (
            <p className="ov-sub tnum">{formatDate(dto.generatedAt)}</p>
          )}
        </div>

        {loading ? (
          <p className="overview-status">{ONE_LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : dto ? (
          <article
            style={{
              fontFamily: 'var(--serif)',
              maxWidth: 'var(--measure)',
              lineHeight: 'var(--leading-body)',
              color: 'var(--ink)',
            }}
          >
            {paragraphs.length > 0 ? (
              paragraphs.map((p, i) => (
                <p
                  key={i}
                  style={{
                    margin: i === 0 ? '0 0 1em' : '0 0 1em',
                    color: 'var(--ink)',
                  }}
                >
                  {p}
                </p>
              ))
            ) : (
              <p style={{ color: 'var(--ink-soft)' }}>This reading has no words yet.</p>
            )}

            {claimCount > 0 && (
              <p
                className="reading-claims tnum"
                style={{
                  marginTop: '1.5em',
                  paddingTop: '0.75em',
                  borderTop: '1px solid var(--line)',
                  fontFamily: 'var(--serif)',
                  fontSize: '0.9em',
                  color: 'var(--ink-faint)',
                }}
              >
                {onOpenReceipt && firstReceipt ? (
                  <button
                    type="button"
                    onClick={() => {
                      const mid = firstReceipt.evidenceIds[0];
                      if (mid != null) onOpenReceipt(mid, 0);
                    }}
                    style={{
                      font: 'inherit',
                      color: 'var(--tension-ink)',
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textUnderlineOffset: 2,
                    }}
                  >
                    {claimCount} receipted {claimCount === 1 ? 'claim' : 'claims'}
                  </button>
                ) : (
                  <span>
                    {claimCount} receipted {claimCount === 1 ? 'claim' : 'claims'}
                  </span>
                )}
              </p>
            )}
          </article>
        ) : null}
      </section>
    </div>
  );
}

// The reader's heading: the friendly lens title, falling back to any server
// title, then a neutral label. Kept separate so ReflectionDTO (which extends
// ReflectionSummary) reuses the same vocabulary as the shelf.
function readingHeading(dto: ReflectionDTO): string {
  if (isLens(dto.lens)) return LENS_TITLE[dto.lens];
  if (dto.title && dto.title.trim()) return dto.title.trim();
  return 'A reading';
}
