// Between — at-rest posture (P1-12). Local-first is not "safe from everything" (see docs/THREAT-MODEL.md).
// This module hardens what it can, best-effort, at boot: owner-only file ACLs on the sensitive paths, a
// loud warning when the working directory sits under a cloud-sync folder, and retention that deletes
// drained airlock plaintext after a window. Full at-rest encryption is DEFERRED (a forgotten passphrase
// on a no-account tool = unrecoverable loss of irreplaceable data) — the honest trade-off is documented.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { airlockPaths } from '../airlock/paths';

/** Folder-name markers of the common consumer cloud-sync clients. */
const SYNC_MARKERS = /(dropbox|onedrive|one ?drive|google ?drive|googledrive|icloud|pcloud|creative cloud|\bsync\b)/i;

export const DEFAULT_RETENTION_DAYS = 7;

/** A loud warning string when the working directory looks cloud-synced, else null (P1-12). Detection is
 *  by path name only — it cannot see a sync client configured on an ordinary-looking folder, so the
 *  warning is a nudge, not a guarantee. */
export function cloudSyncWarning(dir: string): string | null {
  if (!SYNC_MARKERS.test(dir)) return null;
  return (
    `Between’s working directory looks like it is inside a cloud-synced folder:\n  ${dir}\n`
    + `A sync client (Dropbox / OneDrive / Google Drive / iCloud / …) could copy your archive and database `
    + `off this machine. Move Between to a local-only folder. See docs/THREAT-MODEL.md.`
  );
}

/** Can the current process still read (and write) this path? The one question the hardening is not
 *  allowed to get wrong. */
function ownerStillHasAccess(t: string): boolean {
  // Deliberately NOT accessSync: on Windows it largely reflects the read-only attribute rather than
  // the DACL, so it cheerfully reports access to a file with an empty ACL. The only trustworthy check
  // is to actually open the thing.
  const canRead = (p: string): boolean => {
    let fd: number | undefined;
    try { fd = openSync(p, 'r'); return true; } catch { return false; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ } }
  };
  try {
    if (statSync(t).isDirectory()) {
      // A readable folder full of unreadable files is exactly the failure this exists to catch.
      for (const e of readdirSync(t)) {
        const child = join(t, e);
        if (statSync(child).isDirectory()) continue;   // one level is enough to detect the breakage
        if (!canRead(child)) return false;
      }
      return true;
    }
    return canRead(t);
  } catch {
    return false;
  }
}

/**
 * Best-effort owner-only ACLs on the sensitive paths. Never throws — a failure is reported, not fatal
 * (some filesystems can't be tightened, and that must not stop the tool booting).
 *
 * "Best-effort" applies to how much this can lock OUT. It has never applied to whether the owner keeps
 * access, and the previous implementation got that exactly backwards on Windows. It ran
 *
 *     icacls <path> /inheritance:r /grant:r <user>:(OI)(CI)F /T /C /Q
 *
 * against files as well as directories. `(OI)(CI)` are inheritance flags: meaningful on a container,
 * inert on a file — so on a file the grant contributed nothing while `/inheritance:r` had already
 * stripped every inherited ACE. `/C` continued past the error, `/Q` silenced it, `stdio: 'ignore'`
 * discarded what was left, and the function returned ok:true. The observed result was a database file
 * with a completely empty DACL: unreadable by its own owner, reported as hardened.
 *
 * So the order is now: GRANT FIRST (while access is still guaranteed), then remove inheritance, then
 * VERIFY — and roll the whole thing back if the owner cannot still read and write what they own.
 * Losing the tightening is a downgrade. Losing the archive is not a downgrade, it is the disaster the
 * tool exists to avoid.
 */
export function applyRestrictiveAcls(targets: string[]): { path: string; ok: boolean }[] {
  const out: { path: string; ok: boolean }[] = [];
  for (const t of targets) {
    if (!existsSync(t)) continue;

    const isDir = (() => { try { return statSync(t).isDirectory(); } catch { return false; } })();
    const rollback = () => {
      try {
        if (process.platform === 'win32') {
          execFileSync('icacls', [t, '/reset', '/Q'], { stdio: 'ignore' });
          execFileSync('icacls', [t, '/inheritance:e', '/Q'], { stdio: 'ignore' });
        } else {
          execFileSync('chmod', ['-R', 'u+rwX', t], { stdio: 'ignore' });
        }
      } catch { /* nothing further to try; the report below tells the truth */ }
    };

    try {
      if (process.platform === 'win32') {
        const user = process.env.USERNAME || process.env.USER || '';
        if (!user) { out.push({ path: t, ok: false }); continue; }
        const domain = process.env.USERDOMAIN;
        const principal = domain ? `${domain}\\${user}` : user;
        // Inheritance flags belong on containers only. On a file they are inert, which is precisely
        // how the original defect produced an empty DACL.
        const ace = isDir ? `${principal}:(OI)(CI)F` : `${principal}:F`;

        // No /T, on purpose. Recursing re-applies THIS ace string to every child, and on a child file
        // the (OI)(CI) flags are inert again — so `/T` reproduces the original defect one level down,
        // on exactly the files that matter (the database beside its folder). Without it, the folder
        // becomes owner-only and everything created in it inherits that, while files already present
        // keep the access they have. Slightly less tight, and it cannot brick an archive.
        // 1. Grant while inherited access still exists, so a failure here changes nothing.
        //    No /C: an error must fail loudly rather than be continued past.
        execFileSync('icacls', [t, '/grant:r', ace, '/Q'], { stdio: 'ignore' });
        // 2. Only now drop what was inherited.
        execFileSync('icacls', [t, '/inheritance:r', '/Q'], { stdio: 'ignore' });
      } else {
        execFileSync('chmod', ['-R', '700', t], { stdio: 'ignore' });
      }

      // 3. Prove it, or undo it. A claim is only as strong as its enforcement.
      if (!ownerStillHasAccess(t)) { rollback(); out.push({ path: t, ok: false }); continue; }
      out.push({ path: t, ok: true });
    } catch {
      // The tightening failed part-way; make sure it did not fail INTO a locked state.
      if (!ownerStillHasAccess(t)) rollback();
      out.push({ path: t, ok: false });
    }
  }
  return out;
}

/** Delete drained airlock plaintext (archived job/result pairs) older than maxAgeMs. Returns the count
 *  removed. `nowMs` is passed for deterministic testing. The DB keeps the cleaned results; the archived
 *  transport files are redundant plaintext once ingested. */
export function retainAirlockArchive(airlockDir: string, maxAgeMs: number, nowMs: number): number {
  const dir = airlockPaths(airlockDir).archiveDir;
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && nowMs - st.mtimeMs > maxAgeMs) { rmSync(p, { force: true }); removed++; }
    } catch { /* skip unreadable */ }
  }
  return removed;
}

export interface AtRestConfig { dbPath: string; dataDir: string; airlockDir: string }

/**
 * Run the boot-time at-rest hardening. Best-effort and non-fatal. Returns what happened so the caller
 * can log it (and surface the sync warning to a web banner).
 */
export function hardenAtRest(cfg: AtRestConfig, nowMs: number = Date.now()): {
  syncWarning: string | null; aclResults: { path: string; ok: boolean }[]; retentionRemoved: number;
} {
  const syncWarning = cloudSyncWarning(cfg.dbPath) ?? cloudSyncWarning(cfg.dataDir);
  const aclResults = applyRestrictiveAcls([
    cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`, cfg.dataDir, cfg.airlockDir, join(cfg.dataDir, 'exports'),
  ]);
  const retentionRemoved = retainAirlockArchive(cfg.airlockDir, DEFAULT_RETENTION_DAYS * 86_400_000, nowMs);
  return { syncWarning, aclResults, retentionRemoved };
}
