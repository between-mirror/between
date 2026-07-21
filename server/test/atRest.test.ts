// Between Mirror — at-rest posture (P1-12). The cloud-sync warning and the drained-plaintext
// retention are pure/filesystem and directly tested. The ACL hardening is best-effort about how much
// it can tighten — but never about whether the OWNER keeps access, which is asserted for real.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, accessSync, constants, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudSyncWarning, retainAirlockArchive, applyRestrictiveAcls, DEFAULT_RETENTION_DAYS } from '../src/lib/atRest';
import { ensureAirlock } from '../src/airlock/paths';

describe('P1-12 cloud-sync warning', () => {
  it('warns when the path looks cloud-synced, and is quiet otherwise', () => {
    expect(cloudSyncWarning('C:\\Users\\me\\Dropbox\\between')).toContain('cloud-synced');
    expect(cloudSyncWarning('C:\\Users\\me\\OneDrive\\between')).toContain('cloud-synced');
    expect(cloudSyncWarning('/Users/me/Google Drive/between')).toContain('cloud-synced');
    expect(cloudSyncWarning('C:\\Users\\me\\iCloudDrive\\between')).toContain('cloud-synced');
    expect(cloudSyncWarning('C:\\Users\\me\\projects\\between')).toBeNull();
    expect(cloudSyncWarning('/home/me/between')).toBeNull();
  });
});

describe('P1-12 airlock retention', () => {
  it('deletes drained plaintext older than the window and keeps recent files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'between-atrest-'));
    try {
      const p = ensureAirlock(join(dir, 'airlock'));
      const now = Date.UTC(2026, 6, 20);
      const oldFile = join(p.archiveDir, 'old.json');
      const newFile = join(p.archiveDir, 'new.json');
      writeFileSync(oldFile, '{}');
      writeFileSync(newFile, '{}');
      // old = 30 days ago; new = 1 day ago.
      const day = 86_400_000;
      utimesSync(oldFile, new Date(now - 30 * day), new Date(now - 30 * day));
      utimesSync(newFile, new Date(now - 1 * day), new Date(now - 1 * day));

      const removed = retainAirlockArchive(join(dir, 'airlock'), DEFAULT_RETENTION_DAYS * day, now);
      expect(removed).toBe(1);
      expect(existsSync(oldFile)).toBe(false);
      expect(existsSync(newFile)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is a no-op when there is no archive dir', () => {
    expect(retainAirlockArchive(join(tmpdir(), 'between-nope-xyz'), 1000, Date.now())).toBe(0);
  });

  it('applyRestrictiveAcls skips missing paths and never throws', () => {
    const missing = join(tmpdir(), 'between-acl-missing-xyz-should-not-exist');
    expect(existsSync(missing)).toBe(false);
    let res: ReturnType<typeof applyRestrictiveAcls> = [];
    expect(() => { res = applyRestrictiveAcls([missing]); }).not.toThrow();
    expect(res).toEqual([]);
  });

  // The hardening's whole job is to keep OTHER accounts out. Locking the OWNER out of their own
  // database is not a stricter version of that — it is the tool destroying access to the only copy of
  // something irreplaceable, at boot, silently.
  //
  // This is not hypothetical. On Windows the previous implementation ran
  //     icacls <path> /inheritance:r /grant:r <user>:(OI)(CI)F /T /C /Q
  // against FILES as well as directories. `(OI)(CI)` are inheritance flags — meaningful on a
  // container, inert on a file — while `/inheritance:r` had already stripped every inherited ACE. With
  // `/C` (continue past errors), `/Q` (quiet) and stdio ignored, a grant that did nothing was
  // indistinguishable from one that worked, and the call reported ok:true. The result was
  // examples/demo.db with a completely empty DACL: every `npm run demo:serve` on Windows permanently
  // bricked the demo database, and the app reported only "unable to open database file".
  //
  // The previous version of this test avoided real files, noting that ACL-tightening "can make the OS
  // refuse to clean it up in CI" — which was the bug, observed and then designed around.
  describe('the hardening must never lock the owner out', () => {
    it('a file stays readable by its owner after tightening', () => {
      const dir = mkdtempSync(join(tmpdir(), 'between-acl-file-'));
      const f = join(dir, 'between.db');
      writeFileSync(f, 'the only copy of something irreplaceable');
      try {
        const res = applyRestrictiveAcls([f]);
        expect(res).toEqual([{ path: f, ok: true }]);
        expect(readFileSync(f, 'utf8')).toBe('the only copy of something irreplaceable');
        expect(() => accessSync(f, constants.R_OK | constants.W_OK)).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a directory stays usable by its owner after tightening', () => {
      const dir = mkdtempSync(join(tmpdir(), 'between-acl-dir-'));
      writeFileSync(join(dir, 'inside.json'), '{}');
      try {
        const res = applyRestrictiveAcls([dir]);
        expect(res).toEqual([{ path: dir, ok: true }]);
        expect(readFileSync(join(dir, 'inside.json'), 'utf8')).toBe('{}');
        // and still writable — the airlock has to keep working after boot hardening
        expect(() => writeFileSync(join(dir, 'after.json'), '{}')).not.toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('reports ok:false rather than claiming success it cannot verify', () => {
      // Whatever happens, the caller is told the truth: hardenAtRest logs these, and a silent
      // false success is how the original defect stayed invisible.
      const dir = mkdtempSync(join(tmpdir(), 'between-acl-report-'));
      const f = join(dir, 'x.db');
      writeFileSync(f, 'x');
      try {
        for (const r of applyRestrictiveAcls([f])) {
          expect(typeof r.ok).toBe('boolean');
          if (r.ok) expect(() => accessSync(r.path, constants.R_OK)).not.toThrow();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
