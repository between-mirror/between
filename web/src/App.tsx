// Between — Phase 0 root. Orchestrates the threshold (onboarding awe sequence),
// the conversation list, the transcript reader, the moments shelf, and search.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OnboardingMeta, SearchHit, ThreadSummary } from './lib/api';
import {
  deriveOnboardingFromThreads, getOnboarding, getThreads,
} from './lib/api';
import { initThemeSync, useMediaQuery } from './lib/hooks';
import { VOICE } from './lib/voice';
import { ThemeToggle } from './components/ThemeToggle';
import { SearchPanel } from './components/SearchPanel';
import { Settings, type SettingsSection } from './components/Settings';
import { SearchIcon, SlidersIcon } from './components/icons';
import { ConversationList } from './views/ConversationList';
import { Threshold } from './views/Threshold';
import { ThreadPanel } from './views/ThreadPanel';
import type { TranscriptAnchor } from './views/TranscriptReader';
import './styles.css';

// Stamp the persisted theme before first paint to avoid a flash.
initThemeSync();

const ONBOARDED_KEY = 'between:onboarded';
type Status = 'loading' | 'threshold' | 'app';

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [meta, setMeta] = useState<OnboardingMeta | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<TranscriptAnchor | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which section Settings opens on. A contextual calibration invite deep-opens the one it is about,
  // so the offer and the flow are one click apart rather than a hunt through a modal.
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('engine');
  const [mobileView, setMobileView] = useState<'list' | 'thread'>('list');

  const isNarrow = useMediaQuery('(max-width: 820px)');

  // ── initial load: threads + onboarding meta ────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      let threadList: ThreadSummary[] = [];
      try {
        threadList = await getThreads(ctrl.signal);
        setThreads(threadList);
      } catch (err) {
        if (isAbort(err)) return;
        setThreadsError('The conversations did not load. Is the local server running?');
      }

      let m: OnboardingMeta;
      try {
        m = await getOnboarding(ctrl.signal);
        if (m.messageCount === 0 && threadList.length > 0) {
          m = { ...deriveOnboardingFromThreads(threadList), onboarded: m.onboarded };
        }
      } catch (err) {
        if (isAbort(err)) return;
        m = deriveOnboardingFromThreads(threadList);
      }
      setMeta(m);

      let seen = false;
      try {
        seen = localStorage.getItem(ONBOARDED_KEY) === '1';
      } catch { /* ignore */ }
      const skipThreshold = seen || m.onboarded || m.messageCount === 0;
      setStatus(skipThreshold ? 'app' : 'threshold');
    })();
    return () => ctrl.abort();
  }, []);

  const onContinue = useCallback(() => {
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch { /* ignore */ }
    setStatus('app');
  }, []);

  const onSelectThread = useCallback((id: number) => {
    setSelectedId(id);
    setAnchor(null);
    setMobileView('thread');
  }, []);

  const onOpenResult = useCallback((hit: SearchHit) => {
    setSelectedId(hit.threadId);
    setAnchor({ messageId: hit.messageId, sentAtMs: hit.sentAtMs });
    setSearchOpen(false);
    setMobileView('thread');
  }, []);

  const onClearAnchor = useCallback(() => setAnchor(null), []);

  // global shortcuts: Cmd/Ctrl+K or "/" opens search
  useEffect(() => {
    if (status !== 'app') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === '/' && !typing && !searchOpen) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, searchOpen]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedId) ?? null,
    [threads, selectedId],
  );

  if (status === 'loading') {
    return (
      <div className="boot">
        <span className="boot-mark">Between Mirror</span>
      </div>
    );
  }

  if (status === 'threshold' && meta) {
    return <Threshold meta={meta} onContinue={onContinue} />;
  }

  const showList = !isNarrow || mobileView === 'list';
  const showThread = !isNarrow || mobileView === 'thread';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-word">Between Mirror</span>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
            aria-label="Search messages"
          >
            <SearchIcon size={16} />
            <span className="search-trigger-label">Search</span>
            <kbd className="search-kbd">/</kbd>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => { setSettingsSection('engine'); setSettingsOpen(true); }}
            aria-label="Settings"
            title="Settings — how Between Mirror does the heavy reading"
          >
            <SlidersIcon size={16} />
          </button>
          <ThemeToggle />
        </div>
      </header>

      <div className="app-body">
        {showList && (
          <>
            {threadsError ? (
              <div className="sidebar sidebar--error">
                <p className="sidebar-empty">{threadsError}</p>
              </div>
            ) : (
              <ConversationList
                threads={threads}
                selectedId={selectedId}
                onSelect={onSelectThread}
              />
            )}
          </>
        )}

        {showThread && (
          <main className="main-pane">
            {selectedThread ? (
              <ThreadPanel
                key={selectedThread.id}
                thread={selectedThread}
                anchor={anchor}
                onClearAnchor={onClearAnchor}
                onBack={isNarrow ? () => setMobileView('list') : undefined}
                onOpenCalibration={() => { setSettingsSection('calibration'); setSettingsOpen(true); }}
              />
            ) : (
              <div className="empty-state">
                <p className="empty-line">{VOICE.noThreadSelected}</p>
              </div>
            )}
          </main>
        )}
      </div>

      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        activeThreadId={selectedThread?.id ?? null}
        activeThreadName={selectedThread?.displayName ?? null}
        onOpenResult={onOpenResult}
      />

      {settingsOpen && (
        <Settings
          onClose={() => { setSettingsOpen(false); setSettingsSection('engine'); }}
          thread={selectedThread}
          initialSection={settingsSection}
        />
      )}
    </div>
  );
}
