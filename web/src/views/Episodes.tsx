// Between — the Episode Explorer. Every "hard stretch" the deterministic pass
// found is a bounded episode: who was hostile, how severe it got, whether kids
// were named nearby, and whether anyone circled back to repair it. This view is
// a sortable ledger of those stretches — plainly stated, never graded. No red,
// no green: hostility from you rides amber, from her rides slate, and the worst
// of it borrows the clay accent. Clicking a stretch opens its receipt.
//
// Voice: facts stated plainly, feelings offered gently. A count is a count; a
// repair is a small kindness noted, not a score.
import { useEffect, useState } from 'react';
import type { EpisodeRow, ThreadSummary } from '../lib/api';
import { getEpisodesList } from '../lib/api';
import { StatCard } from '../components/StatCard';

const LOADING = 'Gathering the hard stretches…';
const LOAD_ERROR =
  'The stretches did not come through. The conversation is still here — try again in a moment.';

type SortMode = 'severity' | 'recent';

// ── self-contained formatters (no external deps) ─────────────────────────────

const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDay(ms: number): string {
  return dayFmt.format(new Date(ms));
}

function count(n: number): string {
  return n.toLocaleString();
}

/** Combined severity used for the default sort and the header total. */
function severityOf(e: EpisodeRow): number {
  return e.severeMe + e.severeThem;
}

// ── the view ─────────────────────────────────────────────────────────────────

interface EpisodesProps {
  thread: ThreadSummary;
  /** Drill from an episode to the transcript at its opening message. */
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

export function Episodes({ thread, onOpenReceipt }: EpisodesProps) {
  const [rows, setRows] = useState<EpisodeRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('severity');

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setRows(null);
    getEpisodesList(thread.id, ctrl.signal)
      .then((list) => setRows(list))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(LOAD_ERROR);
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [thread.id]);

  const her = thread.displayName.split(/\s+/)[0] || 'Them';

  return (
    <div className="overview" tabIndex={-1}>
      <div className="overview-scroll" tabIndex={0}>
        {loading ? (
          <p className="overview-status">{LOADING}</p>
        ) : error ? (
          <p className="overview-status overview-status--error">{error}</p>
        ) : rows ? (
          <EpisodesBody
            rows={rows}
            her={her}
            sort={sort}
            onSort={setSort}
            onOpenReceipt={onOpenReceipt}
          />
        ) : null}
      </div>
    </div>
  );
}

interface EpisodesBodyProps {
  rows: EpisodeRow[];
  her: string;
  sort: SortMode;
  onSort: (mode: SortMode) => void;
  onOpenReceipt?: (messageId: number, sentAtMs: number) => void;
}

function EpisodesBody({ rows, her, sort, onSort, onOpenReceipt }: EpisodesBodyProps) {
  if (rows.length === 0) {
    return (
      <div className="overview-inner">
        <section className="ov-section">
          <div className="ov-head">
            <h2 className="ov-title">No hard stretches</h2>
            <p className="ov-sub">
              The deterministic pass did not mark any episodes in this thread. That may mean the
              weather stayed even — or that these years are still waiting to be read.
            </p>
          </div>
        </section>
      </div>
    );
  }

  // Sort a copy — never mutate the fetched array. Ties fall back to recency so
  // the order is stable and never arbitrary.
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'recent') return b.startMs - a.startMs;
    const d = severityOf(b) - severityOf(a);
    return d !== 0 ? d : b.startMs - a.startMs;
  });

  // Header totals — all counted, none interpreted.
  const totalSevere = rows.reduce((s, e) => s + severityOf(e), 0);
  const repaired = rows.reduce((s, e) => s + (e.repairedBy != null ? 1 : 0), 0);
  const withKids = rows.reduce((s, e) => s + (e.kidNamed ? 1 : 0), 0);
  const sheStarted = rows.reduce((s, e) => s + (e.initiator === 'them' ? 1 : 0), 0);
  const youStarted = rows.length - sheStarted;

  // A shared max so every bar reads on the same scale across the whole list.
  const maxHostile = Math.max(
    1,
    ...rows.map((e) => e.hostileMe + e.hostileThem),
  );

  return (
    <div className="overview-inner">
      <section className="ov-section">
        <div className="ov-head">
          <h2 className="ov-title tnum">{count(rows.length)} hard stretches</h2>
          <p className="ov-sub">
            Bounded episodes the deterministic pass marked as tense. Each row is a stretch — its
            date, who carried the heat, how severe it got, and whether anyone circled back.
          </p>
        </div>

        <div className="statcards">
          <StatCard
            label="Hard stretches"
            value={count(rows.length)}
            detail="episodes marked tense"
            title="Total bounded episodes flagged by the deterministic pass."
          />
          <StatCard
            label="Severe moments"
            tone="tension"
            value={count(totalSevere)}
            detail="within these stretches"
            title="Sum of severe-hostility messages across all episodes, both directions."
          />
          <StatCard
            label="Who started"
            value={
              <>
                You {count(youStarted)} · {her} {count(sheStarted)}
              </>
            }
            detail="opened the stretch"
            title="Who sent the first message of each tense episode."
          />
          <StatCard
            label="Circled back"
            tone="warmth"
            value={count(repaired)}
            detail={`${count(rows.length - repaired)} left unrepaired`}
            title="Episodes where someone returned with a repairing message afterward."
          />
          <StatCard
            label="Kids nearby"
            value={count(withKids)}
            detail="a child was named"
            title="Episodes where a child's name appeared in or around the stretch."
          />
        </div>
      </section>

      <section className="ov-section">
        <div className="ep-sort" role="group" aria-label="Sort stretches" style={epSortStyle}>
          <span className="ep-sort-label" style={{ color: 'var(--ink-faint)', fontSize: '0.8rem' }}>
            Sorted by
          </span>
          <button
            type="button"
            className="ep-sort-btn"
            data-active={sort === 'severity'}
            aria-pressed={sort === 'severity'}
            onClick={() => onSort('severity')}
            style={sortBtnStyle(sort === 'severity')}
          >
            Most severe
          </button>
          <button
            type="button"
            className="ep-sort-btn"
            data-active={sort === 'recent'}
            aria-pressed={sort === 'recent'}
            onClick={() => onSort('recent')}
            style={sortBtnStyle(sort === 'recent')}
          >
            Most recent
          </button>
        </div>

        <ul className="ep-list" style={epListStyle}>
          {sorted.map((e) => (
            <EpisodeItem key={e.id} ep={e} her={her} maxHostile={maxHostile} onOpen={onOpenReceipt} />
          ))}
        </ul>
      </section>
    </div>
  );
}

// ── a single stretch ─────────────────────────────────────────────────────────

interface EpisodeItemProps {
  ep: EpisodeRow;
  her: string;
  maxHostile: number;
  onOpen?: (messageId: number, sentAtMs: number) => void;
}

function EpisodeItem({ ep, her, maxHostile, onOpen }: EpisodeItemProps) {
  const [open, setOpen] = useState(false);
  const severe = ep.severeMe + ep.severeThem;
  const note = ep.narrative?.note;
  const title = ep.narrative?.title;
  const hasNote = typeof note === 'string' && note.trim().length > 0;

  const openReceipt = () => {
    if (onOpen) onOpen(ep.startMsgId, ep.startMs);
  };

  // Keyboard access mirrors the click affordance without swallowing the note toggle.
  const onKey = (evt: React.KeyboardEvent<HTMLDivElement>) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      openReceipt();
    }
  };

  return (
    <li className="ep-item" style={epItemStyle}>
      <div
        className="ep-row"
        role="button"
        tabIndex={0}
        onClick={openReceipt}
        onKeyDown={onKey}
        title="Open this stretch in the transcript"
        style={epRowStyle}
      >
        <div className="ep-row-top" style={epRowTopStyle}>
          <span className="ep-date tnum" style={{ color: 'var(--ink)', fontWeight: 600 }}>
            {formatDay(ep.startMs)}
          </span>
          <span
            className="ep-msgcount tnum"
            style={{ color: 'var(--ink-faint)', fontSize: '0.8rem' }}
          >
            {count(ep.msgCount)} messages
          </span>
        </div>

        <HostilityBar hostileMe={ep.hostileMe} hostileThem={ep.hostileThem} max={maxHostile} her={her} />

        <div className="ep-badges" style={epBadgesStyle}>
          <Badge
            text={ep.initiator === 'them' ? `${her} started` : 'You started'}
            tone={ep.initiator === 'them' ? 'tension' : 'warmth'}
          />
          {severe > 0 && (
            <Badge text={`${count(severe)} severe`} tone="clay" title="Severe-hostility messages in this stretch." />
          )}
          {ep.kidNamed && <Badge text="kids nearby" tone="neutral" title="A child was named in or around this stretch." />}
          <Badge
            text={
              ep.repairedBy === 'me'
                ? 'you repaired'
                : ep.repairedBy === 'them'
                  ? `${her} repaired`
                  : 'no repair'
            }
            tone={ep.repairedBy != null ? 'warmth' : 'muted'}
            title={
              ep.repairedBy != null
                ? 'Someone returned with a repairing message afterward.'
                : 'No repairing message followed this stretch.'
            }
          />
        </div>
      </div>

      {hasNote && (
        <div className="ep-note-wrap" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="ep-note-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            style={noteToggleStyle}
          >
            <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
              ▸
            </span>
            <span>{title && title.trim().length > 0 ? title : 'A note on this stretch'}</span>
          </button>
          {open && (
            <p className="ep-note" style={noteBodyStyle}>
              {note}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ── the hostility bar (slate = her, amber = you) ─────────────────────────────

interface HostilityBarProps {
  hostileMe: number;
  hostileThem: number;
  max: number;
  her: string;
}

function HostilityBar({ hostileMe, hostileThem, max, her }: HostilityBarProps) {
  const total = hostileMe + hostileThem;
  const W = 240;
  const H = 10;
  const scale = max > 0 ? W / max : 0;
  const themW = hostileThem * scale;
  const meW = hostileMe * scale;

  const label =
    total === 0
      ? 'No hostile messages counted in this stretch.'
      : `${her}: ${hostileThem} hostile · You: ${hostileMe} hostile`;

  return (
    <div className="ep-bar" style={{ margin: '2px 0 4px' }} title={label}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ display: 'block', maxWidth: '100%' }}>
        {/* the track */}
        <rect x={0} y={0} width={W} height={H} rx={H / 2} fill="var(--raised)" stroke="var(--line)" />
        {/* her share — slate, from the left */}
        {themW > 0 && <rect x={0} y={0} width={Math.max(themW, 2)} height={H} rx={H / 2} fill="var(--tension)" />}
        {/* your share — amber, stacked after hers */}
        {meW > 0 && (
          <rect
            x={themW}
            y={0}
            width={Math.max(meW, 2)}
            height={H}
            rx={H / 2}
            fill="var(--warmth)"
          />
        )}
      </svg>
      <div className="ep-bar-legend tnum" style={barLegendStyle}>
        <span style={{ color: 'var(--tension)' }}>{her} {count(hostileThem)}</span>
        <span style={{ color: 'var(--ink-faint)' }}>·</span>
        <span style={{ color: 'var(--warmth)' }}>You {count(hostileMe)}</span>
      </div>
    </div>
  );
}

// ── a small badge ─────────────────────────────────────────────────────────────

type BadgeTone = 'warmth' | 'tension' | 'clay' | 'neutral' | 'muted';

interface BadgeProps {
  text: string;
  tone: BadgeTone;
  title?: string;
}

function Badge({ text, tone, title }: BadgeProps) {
  const color =
    tone === 'warmth'
      ? 'var(--warmth)'
      : tone === 'tension'
        ? 'var(--tension)'
        : tone === 'clay'
          ? 'var(--clay)'
          : tone === 'muted'
            ? 'var(--ink-faint)'
            : 'var(--ink-soft)';
  return (
    <span
      className="ep-badge"
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: '0.72rem',
        lineHeight: 1,
        padding: '4px 8px',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

// ── inline token styles ────────────────────────────────────────────────────────

const epListStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const epItemStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  background: 'var(--surface)',
  padding: 12,
};

const epRowStyle: React.CSSProperties = {
  cursor: 'pointer',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const epRowTopStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 12,
};

const epBadgesStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 2,
};

const barLegendStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  fontSize: '0.72rem',
  marginTop: 3,
};

const noteToggleStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: 'var(--ink-soft)',
  fontSize: '0.82rem',
  fontWeight: 600,
};

const noteBodyStyle: React.CSSProperties = {
  margin: '6px 0 0',
  paddingLeft: 18,
  color: 'var(--ink-soft)',
  fontSize: '0.88rem',
  lineHeight: 1.5,
};

function sortBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 11px',
    borderRadius: 'var(--radius)',
    border: `1px solid ${active ? 'var(--line-2)' : 'var(--line)'}`,
    background: active ? 'var(--raised)' : 'var(--surface)',
    color: active ? 'var(--ink)' : 'var(--ink-soft)',
    fontSize: '0.8rem',
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
  };
}

const epSortStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 12,
};
