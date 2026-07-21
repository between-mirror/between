// Between — full-text search (screen 5). Debounced. Scope toggle (this thread /
// everyone). Results show a highlighted snippet, the thread, and the date;
// clicking one opens that thread anchored to the message.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '../lib/api';
import { search } from '../lib/api';
import { useDebouncedValue } from '../lib/hooks';
import { formatFullDate } from '../lib/format';
import { CloseIcon, GlobeIcon, PersonIcon, SearchIcon } from './icons';

type Scope = 'thread' | 'all';

interface SearchPanelProps {
  open: boolean;
  onClose: () => void;
  activeThreadId: number | null;
  activeThreadName: string | null;
  onOpenResult: (hit: SearchHit) => void;
}

/** Render an FTS snippet, wrapping [bracketed] matches in <mark>. */
function Snippet({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(\[[^\]]*\])/g), [text]);
  return (
    <span className="snippet">
      {parts.map((part, i) => {
        if (part.length >= 2 && part.startsWith('[') && part.endsWith(']')) {
          return <mark key={i}>{part.slice(1, -1)}</mark>;
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </span>
  );
}

export function SearchPanel({
  open, onClose, activeThreadId, activeThreadName, onOpenResult,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebouncedValue(query.trim(), 250);

  // default scope to the open thread when there is one
  useEffect(() => {
    if (open) setScope(activeThreadId != null ? 'thread' : 'all');
  }, [open, activeThreadId]);

  // focus the field when the panel opens; reset when it closes
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery('');
      setResults([]);
      setError(null);
      setTouched(false);
    }
  }, [open]);

  // Escape closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // run the (debounced) search
  useEffect(() => {
    if (!open) return;
    if (debounced.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setTouched(true);
    const scopeThread = scope === 'thread' && activeThreadId != null ? activeThreadId : undefined;
    search(debounced, { threadId: scopeThread, limit: 80 }, ctrl.signal)
      .then((hits) => setResults(hits))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError('Search did not run. Try again in a moment.');
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [debounced, scope, activeThreadId, open]);

  if (!open) return null;

  const canScopeThread = activeThreadId != null;

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div
        className="search-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search messages"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="search-input-row">
          <SearchIcon size={19} className="search-input-icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search the words themselves…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search query"
          />
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
            <CloseIcon />
          </button>
        </div>

        <div className="scope-toggle" role="tablist" aria-label="Search scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'thread'}
            className={`scope-btn${scope === 'thread' ? ' is-on' : ''}`}
            disabled={!canScopeThread}
            onClick={() => setScope('thread')}
            title={canScopeThread ? undefined : 'Open a conversation to search within it'}
          >
            <PersonIcon size={15} />
            {canScopeThread && activeThreadName ? activeThreadName : 'This conversation'}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'all'}
            className={`scope-btn${scope === 'all' ? ' is-on' : ''}`}
            onClick={() => setScope('all')}
          >
            <GlobeIcon size={15} />
            Everyone
          </button>
        </div>

        <div className="search-results" role="listbox" aria-label="Search results">
          {loading && <p className="search-status">Looking…</p>}
          {!loading && error && <p className="search-status search-error">{error}</p>}
          {!loading && !error && touched && debounced.length >= 2 && results.length === 0 && (
            <p className="search-status">Nothing matches that yet.</p>
          )}
          {!loading && !error && debounced.length < 2 && (
            <p className="search-status search-hint">Type a word or two to search the archive.</p>
          )}
          {!loading && !error && results.map((hit) => (
            <button
              key={hit.messageId}
              type="button"
              role="option"
              aria-selected={false}
              className="search-result"
              onClick={() => onOpenResult(hit)}
            >
              <span className="search-result-head">
                <span className="search-result-thread">{hit.threadName}</span>
                <span className="search-result-date tnum">{formatFullDate(hit.sentAtMs)}</span>
              </span>
              <Snippet text={hit.snippet} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
