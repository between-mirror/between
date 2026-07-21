// Between — airlock filesystem layout + atomic writes (docs/SPECS/airlock.md §"Directories").
//
//   airlock/
//     jobs/     <job_id>.json      written by the app (atomic: .tmp → rename)
//     jobs/_manifest.json          run inventory, rewritten by the app
//     results/  <job_id>.json      written by the engine (atomic: .tmp → rename)
//     archive/                     processed pairs moved here by the app after ingest
//
// JSON files are transport, never truth — the DB is truth. This module is pure filesystem; it
// never imports the store, so it is safe to use from the engine (T2.8 sole-writer).
import {
  mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, existsSync, unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AirlockPaths {
  root: string;
  jobsDir: string;
  resultsDir: string;
  archiveDir: string;
  quarantineDir: string;
  manifestPath: string;
}

/** Default airlock dir: repo-root/airlock (repo root is two levels up from server/src). */
export function defaultAirlockDir(): string {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  return join(repoRoot, 'airlock');
}

export function airlockPaths(root: string): AirlockPaths {
  return {
    root,
    jobsDir: join(root, 'jobs'),
    resultsDir: join(root, 'results'),
    archiveDir: join(root, 'archive'),
    quarantineDir: join(root, 'quarantine'),
    manifestPath: join(root, 'jobs', '_manifest.json'),
  };
}

/** Create jobs/results/archive/quarantine under root if missing. */
export function ensureAirlock(root: string): AirlockPaths {
  const p = airlockPaths(root);
  for (const d of [p.jobsDir, p.resultsDir, p.archiveDir, p.quarantineDir]) mkdirSync(d, { recursive: true });
  return p;
}

/** Atomic JSON write: serialize to `<path>.tmp` then rename over `<path>`. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** List `<id>.json` basenames in a dir (ignores `_manifest.json`, `.tmp`, hidden). */
export function listJobFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp') && f !== '_manifest.json')
    .sort();
}

export function moveToArchive(fromPath: string, archiveDir: string, name: string): void {
  mkdirSync(archiveDir, { recursive: true });
  if (!existsSync(fromPath)) return;
  const dest = join(archiveDir, name);
  try {
    renameSync(fromPath, dest);
  } catch {
    // Cross-device or clobber → copy-then-unlink fallback.
    writeFileSync(dest, readFileSync(fromPath));
    unlinkSync(fromPath);
  }
}

/** Move a file the app refuses to ingest into airlock/quarantine/ (P0-4 envelope mismatch). Same
 *  mechanics as archiving — quarantine is a distinct dir so a rejected file is never confused with a
 *  processed pair, and never re-enters the ingest loop. */
export function moveToQuarantine(fromPath: string, quarantineDir: string, name: string): void {
  moveToArchive(fromPath, quarantineDir, name);
}

export { existsSync, join };
