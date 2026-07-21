// Between Mirror — "Your data": the lifecycle panel inside Settings.
//
// The tool holds years of someone's private messages. Until now it offered no way to see where that
// lives, check it is intact, copy it somewhere safe, or get rid of it — which makes "your data stays
// with you" only half a promise. Leaving has to be one of the things you can do.
//
// Register: this panel is plumbing, not weather. Plain nouns, real paths, real sizes, and every action
// answered in a sentence that says what actually happened. The destructive ones look exactly as
// serious as they are and no more — no red (VOICE: amber/slate/clay only), no scare copy, just an
// accurate description and a confirmation proportional to how permanent it is.
import { useCallback, useEffect, useState } from 'react';
import {
  getDataOverview, postDataIntegrity, postDataBackup, postDeleteSources,
  postPurgeTransport, postOpenDataFolder, postDeleteAll,
  type DataOverview, type DataActionLogEntry,
} from '../lib/api';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const shortTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function DataPanel() {
  const [overview, setOverview] = useState<DataOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<DataActionLogEntry[]>([]);

  // Which destructive action is mid-confirmation, and the typed word for the final one.
  const [confirming, setConfirming] = useState<'sources' | 'all' | null>(null);
  const [typed, setTyped] = useState('');

  const load = useCallback((signal?: AbortSignal) => {
    getDataOverview(signal)
      .then((o) => { setOverview(o); setLog(o.log ?? []); })
      .catch(() => setError('Could not read where your data lives just now.'));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  /** Run an action, show its own sentence, and refresh the facts underneath it. */
  const run = useCallback(async (key: string, fn: () => Promise<{ message: string }>) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      setLog((prev) => [{ at: new Date().toISOString(), message: r.message }, ...prev].slice(0, 50));
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work. Nothing was changed.');
    } finally {
      setBusy(null);
      setConfirming(null);
      setTyped('');
    }
  }, [load]);

  if (error && !overview) return <p className="analyze-status analyze-status--error">{error}</p>;
  if (!overview) return <p className="settings-lede">Looking at where your data lives…</p>;

  const sourcesPresent = overview.sources.filter((s) => s.present);

  return (
    <div className="data-panel">
      <p className="settings-lede">
        Everything Between knows is in these places, on this machine. Nothing here is a copy of
        something held elsewhere.
      </p>

      {/* ── where it lives ─────────────────────────────────────────────── */}
      <dl className="data-facts">
        <div className="data-fact">
          <dt>The database</dt>
          <dd>
            <code className="data-path">{overview.dbPath}</code>
            <span className="data-meta tnum">
              {formatBytes(overview.dbSizeBytes)} · {overview.messageCount.toLocaleString()} messages
            </span>
          </dd>
        </div>
        <div className="data-fact">
          <dt>Imported from</dt>
          <dd>
            {overview.sources.length === 0
              ? <span className="data-meta">Nothing imported yet.</span>
              : overview.sources.map((s) => (
                <span key={s.path} className="data-source">
                  <code className="data-path">{s.path}</code>
                  <span className="data-meta tnum">
                    {s.present
                      ? `${formatBytes(s.sizeBytes)}${s.recordCount ? ` · ${s.recordCount.toLocaleString()} records` : ''}`
                      : 'no longer on disk'}
                  </span>
                </span>
              ))}
          </dd>
        </div>
        <div className="data-fact">
          <dt>Exports</dt>
          <dd>
            <code className="data-path">{overview.exportsDir}</code>
            <span className="data-meta tnum">
              {overview.exportCount === 0 ? 'nothing exported yet' : `${overview.exportCount} file${overview.exportCount === 1 ? '' : 's'}`}
            </span>
          </dd>
        </div>
        <div className="data-fact">
          <dt>Model transport</dt>
          <dd>
            <code className="data-path">{overview.airlockDir}</code>
            <span className="data-meta tnum">
              {overview.transportFiles === 0
                ? 'nothing left on disk'
                : `${overview.transportFiles} file${overview.transportFiles === 1 ? '' : 's'} of plaintext still here`}
            </span>
          </dd>
        </div>
      </dl>

      {/* ── the safe things ────────────────────────────────────────────── */}
      <div className="data-actions">
        <button type="button" className="btn btn--quiet" disabled={busy !== null}
          onClick={() => run('open', async () => postOpenDataFolder())}>
          Open the data folder
        </button>
        <button type="button" className="btn btn--quiet" disabled={busy !== null}
          onClick={() => run('integrity', async () => postDataIntegrity())}>
          {busy === 'integrity' ? 'Checking…' : 'Check the database is intact'}
        </button>
        <button type="button" className="btn btn--quiet" disabled={busy !== null}
          onClick={() => run('backup', async () => postDataBackup())}>
          {busy === 'backup' ? 'Copying…' : 'Back up now'}
        </button>
        <button type="button" className="btn btn--quiet" disabled={busy !== null || overview.transportFiles === 0}
          onClick={() => run('purge', async () => postPurgeTransport())}>
          Remove model transport files
        </button>
      </div>

      {/* ── the ones that remove things ────────────────────────────────── */}
      <section className="data-danger">
        <h3 className="data-danger-title">Getting rid of things</h3>

        <div className="data-danger-row">
          <p className="data-danger-text">
            <strong>Delete the imported source files.</strong>{' '}
            {sourcesPresent.length === 0
              ? 'There are none left on disk.'
              : `The ${sourcesPresent.length === 1 ? 'export' : 'exports'} you imported from. Your ${overview.messageCount.toLocaleString()} messages stay — they live in the database now.`}
          </p>
          {confirming === 'sources' ? (
            <span className="data-confirm">
              <button type="button" className="btn btn--quiet" disabled={busy !== null}
                onClick={() => run('sources', async () => postDeleteSources())}>
                Yes, delete {sourcesPresent.length === 1 ? 'it' : 'them'}
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirming(null)}>Not now</button>
            </span>
          ) : (
            <button type="button" className="btn btn--quiet" disabled={busy !== null || sourcesPresent.length === 0}
              onClick={() => setConfirming('sources')}>
              Delete source files
            </button>
          )}
        </div>

        <div className="data-danger-row">
          <p className="data-danger-text">
            <strong>Delete everything Between holds.</strong> Every message, contact, reading and
            export. This cannot be undone, and there is no copy anywhere else.
          </p>
          {confirming === 'all' ? (
            <span className="data-confirm data-confirm--typed">
              <label className="data-confirm-label" htmlFor="delete-confirm">
                Type <strong>delete</strong> to confirm
              </label>
              <input
                id="delete-confirm"
                className="data-confirm-input"
                value={typed}
                autoComplete="off"
                onChange={(e) => setTyped(e.target.value)}
              />
              <button type="button" className="btn btn--quiet" disabled={busy !== null || typed.trim() !== 'delete'}
                onClick={() => run('all', async () => postDeleteAll(typed))}>
                Delete everything
              </button>
              <button type="button" className="link-btn" onClick={() => { setConfirming(null); setTyped(''); }}>
                Not now
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--quiet" disabled={busy !== null}
              onClick={() => setConfirming('all')}>
              Delete all Between data
            </button>
          )}
        </div>
      </section>

      {error && <p className="analyze-status analyze-status--error">{error}</p>}

      {/* ── what has been done ─────────────────────────────────────────── */}
      {log.length > 0 && (
        <section className="data-log">
          <h3 className="data-danger-title">What has happened here</h3>
          <ul className="data-log-list">
            {log.map((e, i) => (
              <li key={`${e.at}-${i}`} className="data-log-item">
                <time className="data-log-time tnum" dateTime={e.at}>
                  {new Date(e.at).toLocaleDateString()} {shortTime.format(new Date(e.at))}
                </time>
                <span className="data-log-text">{e.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
