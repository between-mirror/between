// Between Mirror — the release rebuild must not resurrect deleted files, and must not ship private ones.
//
// scripts/publish-release.ps1 is the only sanctioned path to the public repo. Its core is four git
// commands that rebuild the `public` tree from `phase3` with .gitignore re-applied, and those four
// commands have to satisfy two properties that pull against each other:
//
//   (a) A file deleted on phase3 must DIE. The original sequence only ever ran `git rm --cached`,
//       which untracks without deleting — so a file left over in the working tree from the previous
//       release was re-added by the final `git add .` and came back. A document removed FOR PRIVACY
//       would have persisted in every future release, silently.
//
//   (b) A file tracked on phase3 but git-ignored must NOT ship. docs/DECISIONS.md — the author's
//       private journal — is both tracked on phase3 and listed in .gitignore. It only stays out
//       because the index is empty when `git add .` runs.
//
// The obvious repair for (a) breaks (b), which is the whole reason this test exists rather than a
// code comment. So all three sequences run here against throwaway repositories: the original, the
// naive repair, and the one that ships. The first two are historical replicas, kept deliberately so
// that "this ordering is load-bearing" is a thing the suite proves rather than a thing a comment
// claims. The third is not a replica — it invokes the real scripts/lib/Rebuild-PublicTree.ps1, so
// this test cannot drift away from what the release actually does.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REBUILD_SCRIPT = resolve(__dirname, '../../scripts/lib/Rebuild-PublicTree.ps1');

const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * The PowerShell that will run the release script, or null.
 *
 * Returns null rather than throwing, and the suite skips. This used to throw — at describe-collection
 * time, which turns a missing shell into a collection ERROR rather than a skip, and since the Pages
 * deploy now runs the whole suite, that error would block publishing the landing page on a machine
 * that simply has no pwsh. Its sibling releaseScript.test.ts already skipped, so the two files
 * disagreed about the same condition. They now agree — and the CI guard below makes the skip
 * impossible to hide in the place where it would actually matter.
 */
function findPowerShell(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'ignore' });
      return exe;
    } catch { /* try the next one */ }
  }
  return null;
}

const shell = findPowerShell();

describe('the release path is verifiable here', () => {
  it('has a PowerShell on CI, where skipping would be silent', () => {
    // Locally a skip is a courtesy. On CI it would mean the only test of the release rebuild quietly
    // stopped running — a claim without an enforcement, which is the thing this project refuses.
    if (!process.env.CI) return;
    expect(shell, 'no PowerShell on a CI runner — the release rebuild would go untested').not.toBeNull();
  });
});

/**
 * A throwaway repo shaped like the real one at the moment of a release:
 *
 *   phase3  .gitignore, keep.md, private.md   (private.md is tracked here but git-ignored — force-added,
 *                                              exactly as docs/DECISIONS.md is)
 *   public  .gitignore, keep.md, obsolete.txt (what the PREVIOUS release published; phase3 has since
 *                                              deleted obsolete.txt and never carried private.md)
 *
 * plus an ignored, untracked local-secret.db sitting in the working tree — standing in for between.db,
 * data/ and airlock/, which live in this same directory and are not recoverable from git.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'between-rebuild-'));
  created.push(dir);

  git(dir, 'init', '-q');
  git(dir, 'checkout', '-q', '-b', 'phase3');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');

  writeFileSync(join(dir, '.gitignore'), 'private.md\nlocal-secret.db\nleaked.env\n');
  writeFileSync(join(dir, 'keep.md'), 'kept\n');
  writeFileSync(join(dir, 'obsolete.txt'), 'this file will be deleted on phase3\n');
  writeFileSync(join(dir, 'private.md'), 'the private journal\n');
  writeFileSync(join(dir, 'leaked.env'), 'SECRET=shipped-by-mistake-in-an-earlier-release\n');
  git(dir, 'add', '.gitignore', 'keep.md', 'obsolete.txt');
  git(dir, 'add', '-f', 'private.md');          // tracked DESPITE .gitignore, as DECISIONS.md is
  git(dir, 'commit', '-q', '-m', 'phase3 initial');

  // What the previous release published: no private.md, but obsolete.txt still present — and
  // leaked.env, which a past release shipped before anyone thought to ignore it. Recovering from
  // that is a property the rebuild has to have: adding a path to .gitignore must actually withdraw
  // it, not merely stop it being added again.
  git(dir, 'checkout', '-q', '-b', 'public');
  git(dir, 'rm', '-q', '--cached', 'private.md');
  git(dir, 'add', '-f', 'leaked.env');
  git(dir, 'commit', '-q', '-m', 'public: previous release');

  // phase3 then deletes obsolete.txt.
  git(dir, 'checkout', '-q', 'phase3');
  git(dir, 'rm', '-q', 'obsolete.txt');
  git(dir, 'commit', '-q', '-m', 'phase3: delete obsolete.txt');

  // Land on public, as publish-release.ps1 does, and drop the un-recoverable private data in place.
  git(dir, 'checkout', '-q', 'public');
  writeFileSync(join(dir, 'local-secret.db'), 'irreplaceable local data\n');

  return dir;
}

/** What `git add .` staged — i.e. exactly what the release would commit. */
function staged(dir: string): string[] {
  return git(dir, 'ls-files').split('\n').map((s) => s.trim()).filter(Boolean).sort();
}

/** Run the real rebuild helper; returns its exit code and output instead of throwing. */
function runRebuild(dir: string): { code: number; out: string } {
  const r = spawnSync(
    shell!,
    ['-NoProfile', '-NonInteractive', '-File', REBUILD_SCRIPT, '-SourceBranch', 'phase3'],
    { cwd: dir, encoding: 'utf8', windowsHide: true },
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(!shell)('the rebuild refuses to overwrite what it cannot see', () => {
  // Step 2 is `git checkout <source> -- .`, which writes the source branch's paths over whatever is
  // at those paths, silently. Steps 1 and 3 use `git rm`, which touches TRACKED files only — so an
  // ignored file is invisible to every step that reports anything, and is exactly what step 2
  // destroys. On the real machine those are the database, the archive, the airlock, the pattern list.

  it('refuses when the source branch tracks a path an ignored file occupies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'between-collide-'));
    created.push(dir);
    git(dir, 'init', '-q');
    git(dir, 'checkout', '-q', '-b', 'phase3');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'notes.md'), 'the version phase3 tracks\n');
    writeFileSync(join(dir, '.gitignore'), '');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'phase3 tracks notes.md');
    git(dir, 'checkout', '-q', '-b', 'public');
    git(dir, 'rm', '-q', '--cached', 'notes.md');
    writeFileSync(join(dir, '.gitignore'), 'notes.md\n');
    git(dir, 'add', '.gitignore');
    git(dir, 'commit', '-q', '-m', 'public: notes.md is ignored here');
    // The precious, ignored, untracked local file now sitting where phase3 wants to write.
    writeFileSync(join(dir, 'notes.md'), 'PRECIOUS LOCAL CONTENT\n');

    const { code, out } = runRebuild(dir);

    expect(out, 'the collision must be named, not silently absorbed').toMatch(/overwrite|collision|does not track/i);
    expect(code).not.toBe(0);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8'), 'the local file must survive')
      .toContain('PRECIOUS LOCAL CONTENT');
  });

  it('does not refuse when the ignored private data collides with nothing', () => {
    // The check must not be so eager it blocks every real release: between.db, data/ and airlock/ do
    // not collide with anything phase3 tracks, and a guard that cries wolf gets deleted.
    const dir = makeRepo();
    const { code, out } = runRebuild(dir);
    expect(out, `unexpected refusal:\n${out}`).not.toMatch(/overwrite|collision/i);
    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'local-secret.db'), 'utf8')).toContain('irreplaceable local data');
  });
});

describe.skipIf(!shell)('the release rebuild sequence', () => {
  describe('the sequence that ships (scripts/lib/Rebuild-PublicTree.ps1)', () => {
    const dir = makeRepo();
    execFileSync(
      shell!,
      ['-NoProfile', '-NonInteractive', '-File', REBUILD_SCRIPT, '-SourceBranch', 'phase3'],
      { cwd: dir, encoding: 'utf8' },
    );

    it('kills a file phase3 deleted — index and working tree both', () => {
      expect(staged(dir), 'obsolete.txt was resurrected into the release').not.toContain('obsolete.txt');
      expect(
        existsSync(join(dir, 'obsolete.txt')),
        'obsolete.txt survived in the working tree, so the next rebuild will re-add it',
      ).toBe(false);
    });

    it('keeps the private journal out even though phase3 tracks it', () => {
      expect(staged(dir), 'the private journal would have been published').not.toContain('private.md');
    });

    it('withdraws a file an earlier release leaked, once it is git-ignored', () => {
      // The leak-recovery property, and the one a plausible refactor breaks silently: replacing the
      // second `git rm --cached` with `git reset` still satisfies every other assertion here, because
      // `reset` restores the index from HEAD — and HEAD is `public`, which still tracks leaked.env.
      // The DECISIONS/FABLE name assertion in publish-release.ps1 would not catch this: it looks for
      // two specific filenames, not for secrets in general.
      expect(staged(dir), 'a previously published secret survived being git-ignored').not.toContain('leaked.env');
    });

    it('publishes exactly the public set', () => {
      expect(staged(dir)).toEqual(['.gitignore', 'keep.md']);
    });

    it('does not touch ignored local data that git cannot restore', () => {
      // The reason this sequence uses `git rm` and never `git clean -fdx`: between.db, data/ and
      // airlock/ live in this directory, and a release must not be able to destroy them.
      expect(existsSync(join(dir, 'local-secret.db'))).toBe(true);
    });
  });

  // ── the two sequences that do NOT ship, kept so the ordering is proven load-bearing ──────────────

  it('the ORIGINAL sequence resurrects the deleted file (the defect this release fixes)', () => {
    const dir = makeRepo();
    git(dir, 'rm', '-r', '-q', '--cached', '.');   // untracks only — obsolete.txt stays on disk
    git(dir, 'checkout', 'phase3', '--', '.');
    git(dir, 'rm', '-r', '-q', '--cached', '.');
    git(dir, 'add', '.');

    expect(staged(dir), 'this sequence was supposed to be broken').toContain('obsolete.txt');
    // It did get the private file right — which is why the defect went unnoticed for so long.
    expect(staged(dir)).not.toContain('private.md');
  });

  it('the NAIVE repair kills the deleted file but publishes the private journal', () => {
    const dir = makeRepo();
    git(dir, 'rm', '-r', '-f', '-q', '.');
    git(dir, 'checkout', 'phase3', '--', '.');     // this STAGES phase3's tracked set, private.md included
    git(dir, 'add', '.');                          // ...and nothing ever re-emptied the index

    expect(staged(dir)).not.toContain('obsolete.txt');
    expect(
      staged(dir),
      'dropping the second `git rm --cached` publishes the private journal — this is why it is there',
    ).toContain('private.md');
  });
});
