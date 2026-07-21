// Between — the conversation list (screen 2). Calm cards: monogram, name,
// message count, date span, and a coverage indicator when confidence < 1.
// Sorted by recency. Keyboard navigable (up/down/enter).
import { useMemo, useRef, useState } from 'react';
import type { ThreadSummary } from '../lib/api';
import { formatCount, formatSpan } from '../lib/format';
import { Monogram } from '../components/Monogram';
import { CoverageBadge } from '../components/Coverage';
import { SearchIcon } from '../components/icons';
import { FirstRunEmpty } from './FirstRunEmpty';
import { VOICE_INTERIM } from '../lib/voice';

interface ConversationListProps {
  threads: ThreadSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

export function ConversationList({ threads, selectedId, onSelect }: ConversationListProps) {
  const [filter, setFilter] = useState('');
  const listRef = useRef<HTMLUListElement>(null);

  const sorted = useMemo(() => {
    // server already sorts by last_ms desc; re-sort defensively
    return [...threads].sort((a, b) => (b.lastMs ?? 0) - (a.lastMs ?? 0));
  }, [threads]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((t) => t.displayName.toLowerCase().includes(q));
  }, [sorted, filter]);

  function onKeyNav(e: React.KeyboardEvent<HTMLUListElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = visible.findIndex((t) => t.id === selectedId);
    const nextIdx = e.key === 'ArrowDown'
      ? Math.min(visible.length - 1, idx + 1)
      : Math.max(0, idx < 0 ? 0 : idx - 1);
    const next = visible[nextIdx];
    if (next) {
      onSelect(next.id);
      const el = listRef.current?.querySelector<HTMLButtonElement>(`[data-tid="${next.id}"]`);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    }
  }

  // First run: the store holds no threads because nothing has been imported yet.
  // This is a different situation from a filter matching nobody — it gets the
  // dedicated panel (with the import command), not "No one by that name."
  if (threads.length === 0) {
    return (
      <div className="sidebar sidebar--firstrun">
        <FirstRunEmpty />
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Conversations</h2>
        <div className="filter-field">
          <SearchIcon size={15} className="filter-icon" />
          <input
            type="text"
            className="filter-input"
            placeholder="Filter people"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter conversations by name"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="sidebar-empty">{VOICE_INTERIM.noOneByThatName}</p>
      ) : (
        <ul
          className="thread-list"
          ref={listRef}
          onKeyDown={onKeyNav}
          role="listbox"
          aria-label="Conversations"
        >
          {visible.map((t) => {
            const active = t.id === selectedId;
            return (
              <li key={t.id} role="presentation">
                <button
                  type="button"
                  id={`thread-opt-${t.id}`}
                  data-tid={t.id}
                  role="option"
                  aria-selected={active}
                  className={`thread-card${active ? ' is-active' : ''}`}
                  onClick={() => onSelect(t.id)}
                  tabIndex={active || (selectedId == null && t.id === visible[0].id) ? 0 : -1}
                >
                  <Monogram name={t.displayName} />
                  <span className="thread-main">
                    <span className="thread-name">{t.displayName}</span>
                    <span className="thread-span">{formatSpan(t.firstMs, t.lastMs)}</span>
                  </span>
                  <span className="thread-meta">
                    <span className="thread-count tnum">{formatCount(t.messageCount)}</span>
                    <span className="thread-count-label">messages</span>
                    <CoverageBadge confidence={t.coverageConfidence} note={t.coverageNote} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
