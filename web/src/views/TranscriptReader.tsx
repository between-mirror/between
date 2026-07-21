// Between — the transcript reader (screen 3). Virtualized (TanStack Virtual),
// reverse-paginated by a before-cursor. Real chat bubbles (ME right / THEM left),
// day dividers, subtle reaction rows, attachment placeholder chips, and a
// persistent coverage caveat when the thread's coverage is uncertain.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessageDTO, ThreadSummary } from '../lib/api';
import { getMessages } from '../lib/api';
import { dayKey, formatSpan } from '../lib/format';
import { Monogram } from '../components/Monogram';
import { CoverageNotice } from '../components/Coverage';
import { MomentsShelf } from '../components/MomentsShelf';
import { RiverPlaceholder } from '../components/RiverPlaceholder';
import { DayDivider, MessageBubble, ReactionRow } from '../components/MessageRow';
import { ArrowDownIcon, ChevronLeftIcon } from '../components/icons';

const PAGE = 150;

export interface TranscriptAnchor {
  messageId: number;
  sentAtMs: number;
}

interface TranscriptReaderProps {
  thread: ThreadSummary;
  anchor: TranscriptAnchor | null;
  onClearAnchor: () => void;
  onBack?: () => void;
}

type Row =
  | { type: 'top'; key: string }
  | { type: 'divider'; key: string; ms: number }
  | { type: 'message'; key: string; msg: MessageDTO }
  | { type: 'reaction'; key: string; msg: MessageDTO };

function buildRows(messages: MessageDTO[]): Row[] {
  const rows: Row[] = [{ type: 'top', key: 'top' }];
  let prevDay: string | null = null;
  for (const msg of messages) {
    const k = dayKey(msg.sentAtMs);
    if (k !== prevDay) {
      rows.push({ type: 'divider', key: `div-${k}`, ms: msg.sentAtMs });
      prevDay = k;
    }
    if (msg.isReaction) rows.push({ type: 'reaction', key: `r-${msg.id}`, msg });
    else rows.push({ type: 'message', key: `m-${msg.id}`, msg });
  }
  return rows;
}

/** Sort a page ascending by time (order-agnostic to what the server returns). */
function sortAsc(page: MessageDTO[]): MessageDTO[] {
  return [...page].sort((a, b) => a.sentAtMs - b.sentAtMs || a.id - b.id);
}

/** Merge older (asc) before existing (asc), de-duplicating by id. */
function mergeOlder(older: MessageDTO[], existing: MessageDTO[]): MessageDTO[] {
  if (existing.length === 0) return older;
  const seen = new Set(existing.map((m) => m.id));
  const dedupedOlder = older.filter((m) => !seen.has(m.id));
  return [...dedupedOlder, ...existing];
}

export function TranscriptReader({ thread, anchor, onClearAnchor, onBack }: TranscriptReaderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const restoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const initialScrollDone = useRef(false);
  const highlightTimer = useRef<number | null>(null);
  const anchored = anchor != null;

  const rows = useMemo(() => buildRows(messages), [messages]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 68,
    overscan: 10,
    getItemKey: (i) => rows[i].key,
  });

  // ── initial / anchored load ────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    initialScrollDone.current = false;
    setLoadingInitial(true);
    setError(null);
    setMessages([]);
    setHasMoreOlder(false);
    const params = anchor
      ? { before: anchor.sentAtMs + 1, limit: PAGE }
      : { limit: PAGE };
    getMessages(thread.id, params, ctrl.signal)
      .then((page) => {
        setMessages(sortAsc(page));
        setHasMoreOlder(page.length >= PAGE);
        if (anchor) setHighlightId(anchor.messageId);
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError('These messages did not load. The thread is still here — try again.');
      })
      .finally(() => setLoadingInitial(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id, anchor?.messageId]);

  // ── initial scroll placement (bottom, or the anchored message) ─────────────
  // In both plain and anchored modes the target sits at the bottom of the loaded
  // batch, so scrolling to the last row lands correctly. Two passes because
  // dynamic row measurement settles a frame after the first paint.
  useLayoutEffect(() => {
    if (loadingInitial || rows.length === 0 || initialScrollDone.current) return;
    const last = rows.length - 1;
    rowVirtualizer.scrollToIndex(last, { align: 'end' });
    requestAnimationFrame(() => rowVirtualizer.scrollToIndex(last, { align: 'end' }));
    initialScrollDone.current = true;
  }, [loadingInitial, rows.length, rowVirtualizer]);

  // ── restore scroll position after prepending older messages ────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && restoreRef.current) {
      const { prevHeight, prevTop } = restoreRef.current;
      el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      restoreRef.current = null;
    }
  });

  // clear a pending highlight fade timer on unmount
  useEffect(() => () => {
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current);
  }, []);

  const loadOlder = useCallback(async () => {
    const el = scrollRef.current;
    if (!el || loadingOlder || !hasMoreOlder || messages.length === 0) return;
    setLoadingOlder(true);
    restoreRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
    try {
      const page = await getMessages(thread.id, {
        before: messages[0].sentAtMs,
        limit: PAGE,
      });
      const asc = sortAsc(page);
      setHasMoreOlder(page.length >= PAGE);
      setMessages((prev) => mergeOlder(asc, prev));
    } catch {
      restoreRef.current = null;
    } finally {
      setLoadingOlder(false);
    }
  }, [thread.id, messages, loadingOlder, hasMoreOlder]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
    if (el.scrollTop < 260 && hasMoreOlder && !loadingOlder) void loadOlder();
  }, [hasMoreOlder, loadingOlder, loadOlder]);

  const flashHighlight = useCallback((id: number) => {
    setHighlightId(id);
    if (highlightTimer.current != null) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 2600);
  }, []);

  // best-effort: scroll to a message already within the loaded window
  const scrollToMessageId = useCallback((id: number) => {
    const idx = rows.findIndex((r) =>
      (r.type === 'message' || r.type === 'reaction') && r.msg.id === id);
    if (idx >= 0) rowVirtualizer.scrollToIndex(idx, { align: 'center' });
    flashHighlight(id);
  }, [rows, rowVirtualizer, flashHighlight]);

  const jumpToLatest = useCallback(() => {
    if (anchored) {
      onClearAnchor(); // reload the newest tail
      return;
    }
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [anchored, onClearAnchor]);

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <section className="transcript-pane" aria-label={`Conversation with ${thread.displayName}`}>
      <header className="thread-header">
        {onBack && (
          <button type="button" className="icon-btn back-btn" onClick={onBack} aria-label="Back to conversations">
            <ChevronLeftIcon />
          </button>
        )}
        <Monogram name={thread.displayName} size={40} />
        <div className="thread-header-text">
          <h1 className="thread-header-name">{thread.displayName}</h1>
          <p className="thread-header-sub tnum">
            {formatSpan(thread.firstMs, thread.lastMs)}
            {' · '}
            {thread.messageCount.toLocaleString()} messages
          </p>
        </div>
      </header>

      <RiverPlaceholder />
      <MomentsShelf threadId={thread.id} onOpenMessage={scrollToMessageId} />
      <CoverageNotice confidence={thread.coverageConfidence} note={thread.coverageNote} />

      <div className="transcript-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0}>
        {loadingInitial ? (
          <div className="transcript-loading">Opening the years…</div>
        ) : error ? (
          <div className="transcript-error">{error}</div>
        ) : (
          <div
            className="transcript-inner"
            style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualItems.map((vItem) => {
              const row = rows[vItem.index];
              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={rowVirtualizer.measureElement}
                  className="v-row"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {row.type === 'top' ? (
                    <div className="transcript-top">
                      {loadingOlder
                        ? <span className="transcript-top-note">Reaching back…</span>
                        : !hasMoreOlder
                          ? <span className="transcript-top-note">The beginning of this conversation</span>
                          : null}
                    </div>
                  ) : row.type === 'divider' ? (
                    <DayDivider ms={row.ms} />
                  ) : row.type === 'reaction' ? (
                    <ReactionRow msg={row.msg} isGroup={thread.isGroup} />
                  ) : (
                    <MessageBubble
                      msg={row.msg}
                      isGroup={thread.isGroup}
                      highlighted={highlightId === row.msg.id}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(anchored || !atBottom) && !loadingInitial && !error && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDownIcon size={15} />
          Latest
        </button>
      )}
    </section>
  );
}
