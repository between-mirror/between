// Between Mirror — "Your data": where it lives, whether it is intact, how to copy it, how to get rid
// of it (Era 1, v0.3.0).
//
// The tool holds the most sensitive data a consumer application can hold and, until now, offered no
// way to see any of it. "Your data stays with you" is only half a promise if you cannot find it, and
// worth very little if leaving is not one of the things you can do. Everything here is deliberately
// boring, reversible where it can be, and loud where it cannot.
//
// Two rules run through all of it:
//   1. Say what actually happened, in words. Not "purge complete (3)" — "Removed 3 transport files."
//   2. Never delete anything outside the folders Between owns. A path in the database is a string,
//      and a string is not permission.
import { execFile } from 'node:child_process';
import {
  existsSync, statSync, readdirSync, rmSync, mkdirSync, unlinkSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { BetweenDB } from '../store/db';
import { migrationBackupsBeside } from '../store/migrate';
import { airlockPaths } from '../airlock/paths';

export interface DataPaths {
  dbPath: string;
  dataDir: string;
  airlockDir: string;
  exportsDir: string;
  backupsDir: string;
}

export interface SourceFileInfo {
  path: string;
  importedAt: string;
  recordCount: number | null;
  /** Whether the file is still on disk — deleting it yourself is a reasonable thing to have done. */
  present: boolean;
  sizeBytes: number;
}

export interface DataOverview {
  dbPath: string;
  dbSizeBytes: number;
  dataDir: string;
  exportsDir: string;
  backupsDir: string;
  airlockDir: string;
  sources: SourceFileInfo[];
  messageCount: number;
  exportCount: number;
  /** Archived + quarantined model transport still on disk. */
  transportFiles: number;
}

const LOG_KEY = 'data_action_log';
const LOG_MAX = 50;

export interface ActionLogEntry { at: string; message: string }

/** Newest first. Plain language only — this is shown to the owner, not to a developer. */
export function readActionLog(db: BetweenDB): ActionLogEntry[] {
  try {
    const raw = db.getMeta(LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as ActionLogEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function log(db: BetweenDB, message: string, at: Date = new Date()): void {
  const next = [{ at: at.toISOString(), message }, ...readActionLog(db)].slice(0, LOG_MAX);
  try { db.setMeta(LOG_KEY, JSON.stringify(next)); } catch { /* logging must never break the action */ }
}

function sizeOf(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

function countFiles(dir: string): number {
  try { return readdirSync(dir).filter((f) => { try { return statSync(join(dir, f)).isFile(); } catch { return false; } }).length; }
  catch { return 0; }
}

/** Is `p` genuinely inside `root`? String prefixes are not containment — `..` has to be resolved. */
function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ── overview ─────────────────────────────────────────────────────────────────

export function dataOverview(db: BetweenDB, paths: DataPaths): DataOverview {
  const rows = db.raw
    .prepare('SELECT path, imported_at, record_count FROM source_files ORDER BY imported_at')
    .all() as { path: string; imported_at: string; record_count: number | null }[];

  const sources: SourceFileInfo[] = rows.map((r) => {
    const present = existsSync(r.path);
    return {
      path: r.path,
      importedAt: r.imported_at,
      recordCount: r.record_count,
      present,
      sizeBytes: present ? sizeOf(r.path) : 0,
    };
  });

  const a = airlockPaths(paths.airlockDir);
  return {
    dbPath: paths.dbPath,
    // The WAL is part of the database as far as "how much space is this taking" goes.
    dbSizeBytes: sizeOf(paths.dbPath) + sizeOf(`${paths.dbPath}-wal`) + sizeOf(`${paths.dbPath}-shm`),
    dataDir: paths.dataDir,
    exportsDir: paths.exportsDir,
    backupsDir: paths.backupsDir,
    airlockDir: paths.airlockDir,
    sources,
    messageCount: (db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n,
    exportCount: countFiles(paths.exportsDir),
    transportFiles: countFiles(a.archiveDir) + countFiles(a.quarantineDir),
  };
}

// ── integrity ────────────────────────────────────────────────────────────────

export interface IntegrityResult { ok: boolean; detail: string; message: string }

/** SQLite's own answer, reported verbatim. This is the owner's only copy; a reassuring summary that
 *  hides a real result would be the worst possible thing to write here. */
export function verifyIntegrity(db: BetweenDB): IntegrityResult {
  let detail: string;
  try {
    const rows = db.raw.pragma('integrity_check') as { integrity_check: string }[];
    detail = rows.map((r) => r.integrity_check).join('; ') || 'ok';
  } catch (e) {
    detail = e instanceof Error ? e.message : String(e);
  }
  const ok = detail === 'ok';
  const message = ok
    ? 'Checked the database. No problems found — everything is intact.'
    : `Checked the database and found a problem: ${detail}. Make a backup now, before anything else.`;
  log(db, message);
  return { ok, detail, message };
}

// ── backup ───────────────────────────────────────────────────────────────────

export interface BackupResult { path: string; sizeBytes: number; message: string }

const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[:]/g, '-');

/**
 * A timestamped copy, taken through SQLite's own online-backup API rather than a file copy — so it is
 * consistent even though the app is running, and cannot capture a half-written page. Never overwrites:
 * a backup that can clobber the previous backup is one mistake away from being no backup at all.
 */
export async function backupNow(db: BetweenDB, paths: DataPaths, now: Date = new Date()): Promise<BackupResult> {
  mkdirSync(paths.backupsDir, { recursive: true });
  const base = `between-${stamp(now)}`;
  let dest = join(paths.backupsDir, `${base}.db`);
  for (let n = 2; existsSync(dest); n++) dest = join(paths.backupsDir, `${base}-${n}.db`);

  await db.raw.backup(dest);
  const sizeBytes = sizeOf(dest);
  const message = `Backed up to ${dest} (${formatBytes(sizeBytes)}). Your working database is unchanged.`;
  log(db, message, now);
  return { path: dest, sizeBytes, message };
}

// ── delete the imported source XML ───────────────────────────────────────────

export interface DeleteSourcesResult {
  deleted: number; freedBytes: number; skippedOutside: number; skippedMissing: number; message: string;
}

/**
 * Remove the SMS Backup & Restore exports that have already been ingested. The messages are in the
 * database — this is tidying, not losing — but it is still a deletion, so it only ever touches files
 * inside the data folder Between owns. A `source_files.path` is a string that arrived from an import;
 * treating it as authority to unlink an arbitrary path is how "clean up my archive" becomes something
 * much worse on a database that was handed over rather than built here.
 */
export function deleteImportedSources(db: BetweenDB, paths: DataPaths): DeleteSourcesResult {
  const rows = db.raw.prepare('SELECT path FROM source_files').all() as { path: string }[];
  let deleted = 0, freedBytes = 0, skippedOutside = 0, skippedMissing = 0;

  for (const r of rows) {
    if (!isInside(paths.dataDir, r.path)) { skippedOutside++; continue; }
    if (!existsSync(r.path)) { skippedMissing++; continue; }
    const size = sizeOf(r.path);
    try { unlinkSync(r.path); deleted++; freedBytes += size; } catch { skippedMissing++; }
  }

  const kept = (db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n;
  const parts: string[] = [];
  parts.push(deleted === 0
    ? 'No source files left to delete.'
    : `Deleted ${deleted} source ${deleted === 1 ? 'file' : 'files'}, freeing ${formatBytes(freedBytes)}. All ${kept} messages are still here — they live in the database now.`);
  if (skippedOutside > 0) {
    parts.push(`Left ${skippedOutside} alone because ${skippedOutside === 1 ? 'it sits' : 'they sit'} outside Between’s data folder.`);
  }
  const message = parts.join(' ');
  log(db, message);
  return { deleted, freedBytes, skippedOutside, skippedMissing, message };
}

// ── purge model transport ────────────────────────────────────────────────────

export interface PurgeResult { removed: number; message: string }

/** Delete drained and quarantined transport now, rather than waiting out the retention window. Pending
 *  jobs are left alone: purging is tidying up after work, not cancelling it. */
export function purgeTransportFiles(paths: DataPaths, db?: BetweenDB): PurgeResult {
  const a = airlockPaths(paths.airlockDir);
  let removed = 0;
  for (const dir of [a.archiveDir, a.quarantineDir]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).isFile()) { rmSync(p, { force: true }); removed++; }
      } catch { /* skip what we cannot remove */ }
    }
  }
  const message = removed === 0
    ? 'No model transport files were left to remove.'
    : `Removed ${removed} model transport ${removed === 1 ? 'file' : 'files'} — the plaintext copies of what was sent for reading. The readings themselves are kept.`;
  if (db) log(db, message);
  return { removed, message };
}

// ── delete everything ────────────────────────────────────────────────────────

export interface DeleteAllResult { ok: boolean; message: string }

/**
 * Every table holding content, children first. `app_meta` deliberately survives so the app still
 * boots and this very action stays in the log.
 *
 * These names are asserted against `sqlite_master` by test. The first version of this list carried
 * four names that are not tables at all — they were metric_keys — and a per-table try/catch swallowed
 * the misses silently, so the list looked twice as thorough as it was while the real `metrics` table
 * (which stores 120-character verbatim previews of the longest messages, and each party's most-used
 * words) was never cleared. A delete that quietly skips what it cannot find is worse than one that
 * fails, because it reports success.
 */
export const DELETED_TABLES = [
  'messages_fts', 'message_recipients', 'attachments', 'overrides', 'events',
  'reflections', 'episodes', 'prefilter', 'metrics',
  'analysis_results', 'analysis_jobs', 'messages', 'thread_participants', 'threads',
  'identifiers', 'contacts', 'source_files',
] as const;

/**
 * Empty the database and remove every file Between owns.
 *
 * The database file itself is emptied rather than deleted: the server holds it open, and on Windows an
 * open file cannot be unlinked — so "delete the file" would fail halfway and leave the owner unsure
 * what had actually gone. Emptying every table inside one transaction and then VACUUMing is both
 * verifiable and honest, and the copy says exactly that.
 *
 * The typed word is the last thing standing between the owner and an empty archive, so it is compared
 * exactly (trimmed, case-sensitive). "DELETE ALL" is not the word. Neither is "delete.".
 */
export function deleteAllData(db: BetweenDB, paths: DataPaths, confirmation: string): DeleteAllResult {
  if (confirmation.trim() !== 'delete') {
    return { ok: false, message: 'Nothing was deleted. Type the word delete exactly to confirm.' };
  }

  db.raw.exec('PRAGMA foreign_keys = OFF');
  try {
    db.raw.transaction(() => {
      for (const t of DELETED_TABLES) db.raw.exec(`DELETE FROM ${t}`);
    })();
  } finally {
    db.raw.exec('PRAGMA foreign_keys = ON');
  }

  // WAL, then VACUUM, then WAL again. The database runs in WAL mode, so DELETE and VACUUM both write
  // to the sidecar: without the checkpoints the message bodies simply move from between.db into
  // between.db-wal and sit there, with the panel reporting zero messages beside a database that is
  // still most of a megabyte. TRUNCATE (not PASSIVE) so the log is emptied rather than reused.
  const checkpoint = () => { try { db.raw.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ } };
  checkpoint();
  try { db.raw.exec('VACUUM'); } catch { /* not fatal; the rows are gone either way */ }
  checkpoint();

  // Files: the imported sources, every export, and all airlock transport including pending work.
  let files = 0;
  const wipeDir = (dir: string, recurse = false) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) { if (recurse) { rmSync(p, { recursive: true, force: true }); files++; } }
        else { rmSync(p, { force: true }); files++; }
      } catch { /* skip */ }
    }
  };
  wipeDir(paths.exportsDir);
  // The backups too. A backup is a complete, unencrypted copy of the archive — leaving those behind
  // while the confirmation says "there is no copy anywhere else" would make that sentence false at
  // exactly the moment someone is relying on it.
  let backups = 0;
  if (existsSync(paths.backupsDir)) {
    for (const name of readdirSync(paths.backupsDir)) {
      try { rmSync(join(paths.backupsDir, name), { force: true, recursive: true }); backups++; files++; } catch { /* skip */ }
    }
  }
  // And the pre-migration copies, which are the ones that do NOT live in backupsDir: an upgrade
  // takes a full copy of the archive and writes it beside the database. Sweeping by directory
  // missed exactly that file, so a deletion could report "0 backups" with every message still
  // readable in plaintext next door. Matched by the migration's own naming function, not by a
  // pattern repeated here, and narrow by construction — nothing else in that folder is touched.
  for (const stale of migrationBackupsBeside(paths.dbPath)) {
    try { rmSync(stale, { force: true }); backups++; files++; } catch { /* skip */ }
  }
  const a = airlockPaths(paths.airlockDir);
  for (const d of [a.jobsDir, a.resultsDir, a.archiveDir, a.quarantineDir]) wipeDir(d);
  // Sources live directly in the data folder; leave any subfolders the owner made themselves.
  if (existsSync(paths.dataDir)) {
    for (const name of readdirSync(paths.dataDir)) {
      const p = join(paths.dataDir, name);
      try { if (statSync(p).isFile()) { rmSync(p, { force: true }); files++; } } catch { /* skip */ }
    }
  }

  const message =
    `Deleted everything: every message, contact, reading and export, ${backups} ${backups === 1 ? 'backup' : 'backups'}, `
    + `and ${files} ${files === 1 ? 'file' : 'files'} from disk in total. `
    + `Three files are still on your machine — now emptied — because Between Mirror is holding them open: `
    + `${paths.dbPath}, ${paths.dbPath}-wal and ${paths.dbPath}-shm. `
    + `Delete those yourself once you close the app, if you want them gone too.`;
  log(db, message);
  return { ok: true, message };
}

// ── open the folder ──────────────────────────────────────────────────────────

/** Reveal the data folder in the OS file manager. The path is Between's own, never anything the client
 *  supplied — this is a fixed target, not a "open whatever I name" endpoint. */
export function openDataFolder(paths: DataPaths): { ok: boolean; message: string } {
  const target = paths.dataDir;
  if (!existsSync(target)) return { ok: false, message: 'That folder does not exist yet.' };
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [target]]
      : process.platform === 'darwin' ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    // Fire and forget: explorer.exe returns a non-zero exit code even on success.
    execFile(cmd as string, args as string[], () => { /* ignore */ });
    return { ok: true, message: `Opened ${target}.` };
  } catch {
    return { ok: false, message: `Could not open the folder. It is at ${target}.` };
  }
}

// ── formatting ───────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
