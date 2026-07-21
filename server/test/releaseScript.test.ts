// Between — the release-immutability guard (Era 1, v0.2.1 "the truth patch").
//
// A version identifies ONE tree, forever. The previous script force-moved the tag on re-publish
// (`git tag -f` / `git push -f`), which meant "v0.2.0" could quietly mean two different pieces of
// software — the exact failure mode that makes provenance claims (signed tag + commit SHA + SHA-256)
// worthless. These tests hold the line mechanically:
//   1. the script source contains no force-move of a tag or a tag push;
//   2. a DRY RUN of a version whose tag already exists over a DIFFERENT tree is REFUSED;
//   3. re-running the identical tree is a no-op, not an error (idempotence, not mutation).
//
// The script is PowerShell, so the test drives it through a real shell in a throwaway git repo.
// If no PowerShell is on PATH the assertions on the script SOURCE still run; the behavioural ones
// skip loudly rather than pretending to pass.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/publish-release.ps1');
const REBUILD = resolve(__dirname, '../../scripts/lib/Rebuild-PublicTree.ps1');
const scriptSource = readFileSync(SCRIPT, 'utf8');

/** First PowerShell on PATH, or null. (`pwsh` on Linux/macOS runners, `powershell` on Windows.) */
function findPwsh(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawnSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8', windowsHide: true,
    });
    if (probe.status === 0) return exe;
  }
  return null;
}
const pwsh = findPwsh();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

/** A throwaway repo shaped like the real one: a `phase3` line, a `public` line, and the script. */
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'between-release-'));
  git(dir, 'init', '-q', '-b', 'phase3');
  git(dir, 'config', 'user.name', 'Between');
  git(dir, 'config', 'user.email', 'between-mirror@users.noreply.github.com');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');   // keeps the throwaway repo quiet on Windows
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts', 'publish-release.ps1'));
  // The script reads its rebuild sequence from scripts/lib/ and refuses to run without it — see
  // scripts/lib/Rebuild-PublicTree.ps1 and server/test/publishRebuild.test.ts, which is where that
  // sequence's own two properties are proven. A throwaway repo needs it as much as the real one does.
  copyFileSync(REBUILD, join(dir, 'scripts', 'lib', 'Rebuild-PublicTree.ps1'));
  writeFileSync(join(dir, 'app.txt'), 'v1 content\n');
  // A real name-sweep list so the script exercises the sweep path rather than the skip path.
  writeFileSync(join(dir, 'personal-patterns.txt'), 'zzz-no-such-name-zzz\n');
  writeFileSync(join(dir, '.gitignore'), 'personal-patterns.txt\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  git(dir, 'branch', 'public');
  return dir;
}

function runScript(dir: string, version: string): { code: number; out: string } {
  const r = spawnSync(pwsh!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(dir, 'scripts', 'publish-release.ps1'), '-Version', version],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Run the script for real, with -Publish, against whatever state the caller has set up. */
function publish(dir: string, version: string, extra: string[] = []): { code: number; out: string } {
  const r = spawnSync(pwsh!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(dir, 'scripts', 'publish-release.ps1'), '-Version', version, '-Publish', ...extra],
    { cwd: dir, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(!pwsh)('the -Publish path fails loudly, never silently', () => {
  // These were source greps before, and the greps did not work: deleting the branch-push guard
  // outright still passed, because the scan window slid onto the NEXT command's check. Replacing the
  // guard with `Write-Host "carrying on"` — the exact original bug — also passed. A test that asserts
  // a substring sits near a command is not a test of what the command does on failure.

  it('does not report success when the push fails', () => {
    const dir = scaffold();
    try {
      // A remote path that cannot be pushed to.
      git(dir, 'remote', 'add', 'public', join(dir, 'no-such-remote-here.git'));
      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'a failed push must not print success').not.toMatch(/Published/);
      expect(out).toMatch(/ABORTING/);
      expect(code, 'a failed release must not exit 0').not.toBe(0);
      expect(git(dir, 'tag', '-l'), 'a tag survived a failed release, wedging the version').toBe('');
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('phase3');
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
    }
  });

  it('refuses when a name-sweep pattern cannot be evaluated, rather than reporting it clean', () => {
    // `git grep` exits 128 on an invalid pattern and 1 on "no match". Reading both as clean meant a
    // broken sweep reported "no name-sweep hit" and published. Separately, git grep defaults to POSIX
    // BASIC regex, where '|' is literal — so the obvious `A|B` pattern matched nothing, silently.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'personal-patterns.txt'), 'Unclosed[\n');
      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'an unevaluable pattern must not read as a clean sweep').toMatch(/could NOT be evaluated/i);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote), 'it published anyway').toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  it('sweeps alternation patterns as a human would write them', () => {
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'app.txt'), 'v1 content by Ada Lovelace\n');
      git(dir, 'add', 'app.txt'); git(dir, 'commit', '-q', '-m', 'a name lands in a tracked file');
      writeFileSync(join(dir, 'personal-patterns.txt'), 'Grace Hopper|Ada Lovelace|somehandle\n');
      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'the alternation must actually match').toMatch(/name-sweep pattern .* found in tracked file/i);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote), 'a real name reached the remote').toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  // ── the sweep's silent-miss paths (round three) ────────────────────────────────────────────────
  //
  // Each of these published a real name while printing "N name pattern(s) swept clean". They are one
  // test per shape because they fail independently and a single combined case would stop at the first.
  const SILENT_MISSES: Array<{ why: string; pattern: string; place: 'content' | 'filename' | 'binary' }> = [
    // The filter tested $_.Trim() but handed the UNTRIMMED line to git grep.
    { why: 'a pattern with trailing whitespace', pattern: 'Ada Lovelace   \n', place: 'content' },
    // personal-patterns.txt's own instructions document this shape, so following them disabled the
    // sweep: the ERE "Ada Lovelace  # the full name" is valid and can never match.
    { why: 'a pattern with a trailing inline comment', pattern: 'Ada Lovelace   # the full name\n', place: 'content' },
    // git grep searches contents, never paths.
    { why: 'a name that appears only in a FILENAME', pattern: 'Ada Lovelace\n', place: 'filename' },
    // -I told git grep to skip binaries, and .gitattributes marks *.png binary — so a name baked into
    // a shipped screenshot was never looked at.
    { why: 'a name inside a file git treats as binary', pattern: 'Ada Lovelace\n', place: 'binary' },
  ];

  for (const { why, pattern, place } of SILENT_MISSES) {
    it(`refuses to publish when the name is hidden by ${why}`, () => {
      const dir = scaffold();
      const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
      try {
        git(dir, 'init', '-q', '--bare', remote);
        git(dir, 'remote', 'add', 'public', remote);

        if (place === 'filename') {
          writeFileSync(join(dir, 'Ada Lovelace notes.md'), 'nothing sensitive in here\n');
        } else if (place === 'binary') {
          // A NUL early in the file is what makes git call it binary.
          writeFileSync(join(dir, 'shot.png'), Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]),
            Buffer.from('captured by Ada Lovelace', 'utf8'),
          ]));
          writeFileSync(join(dir, '.gitattributes'), '*.png binary\n');
        } else {
          writeFileSync(join(dir, 'app.txt'), 'v1 content by Ada Lovelace\n');
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'the name lands somewhere the sweep used to not look');
        writeFileSync(join(dir, 'personal-patterns.txt'), pattern);

        const { code, out } = publish(dir, '9.9.9');

        expect(out, `${why}: the sweep reported clean over a real name`).not.toMatch(/swept clean/);
        expect(out).toMatch(/ABORTING/);
        expect(code).not.toBe(0);
        expect(git(dir, 'ls-remote', '--tags', remote), `${why}: a real name reached the remote`).toBe('');
      } finally {
        for (const d of [remote, dir]) {
          try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
        }
      }
    });
  }

  it('sweeps the -Title text, which is spliced into a permanent public commit message', () => {
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'personal-patterns.txt'), 'Ada Lovelace\n');

      const { code, out } = publish(dir, '9.9.9', ['-Title', 'thanks to Ada Lovelace']);

      expect(out, 'the title is the one operator string that reached the remote unswept')
        .toMatch(/-Title text matches name-sweep pattern/i);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });
});

describe.skipIf(!pwsh)('the checks are not defeated by how git prints a path or reads a pattern', () => {
  // Round four. Every one of these was found in code that round three ADDED, and every one printed
  // "N name pattern(s) swept clean" over something it never looked at — the fourth consecutive round
  // in which the previous round's fix carried the next defect.

  it('sees a real name in a NON-ASCII filename, which core.quotePath hides', () => {
    // `git ls-files` honours core.quotePath, which defaults to true: a path with any byte >= 0x80 is
    // returned octal-escaped and quoted — "docs/Zo\303\253 ...". The filename sweep and the never-ship
    // deny-list both matched their regexes against that mangled string, so one accented character
    // defeated them. Whether the sweep worked depended on a per-machine git setting.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'Zoë Ashworth interview.md'), 'nothing sensitive in the body\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'a name in a non-ascii filename');
      writeFileSync(join(dir, 'personal-patterns.txt'), 'Zoë Ashworth\n');

      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'one accented character defeated the filename sweep').not.toMatch(/swept clean/);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote), 'a real name reached the remote').toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  it('refuses an ambiguous inline comment rather than silently rewriting the pattern', () => {
    // Stripping "  #..." turned `Ada Lovelace|@ada #adalovelace` into `Ada Lovelace|@ada` — still a
    // valid ERE, so nothing errored, nothing matched, and the handle shipped. '#' is a legal regex
    // character, so the parser cannot tell a comment from a pattern and must not guess.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'credits.md'), 'built with help from #adalovelace on mastodon\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'a handle lands in a tracked file');
      writeFileSync(join(dir, 'personal-patterns.txt'), 'Ada Lovelace|@ada #adalovelace\n');

      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'the pattern must not be silently truncated').not.toMatch(/swept clean/);
      expect(out).toMatch(/ambiguous/i);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  it('reads one pattern in one regex language, not two', () => {
    // `\<Zoe\>` is a word boundary to git's ERE and an escaped literal '<' to .NET. The content sweep
    // honoured it; the filename sweep, which used PowerShell -match, silently did not.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      writeFileSync(join(dir, 'Zoe-Ashworth-interview.md'), 'a clean body\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'name only in the filename');
      writeFileSync(join(dir, 'personal-patterns.txt'), '\\<Zoe\\>\n');

      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'the filename sweep must honour the same dialect as the content sweep')
        .not.toMatch(/swept clean/);
      expect(code).not.toBe(0);
      expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  it('does not report a release as published when the remote tag is someone else\'s tree', () => {
    // The remote SHA was read and validated and then never compared to the local tag. A remote tag
    // over a different tree left the "same tree, nothing to do" branch free to report success, so the
    // operator was told their tree was live under this version when someone else's was.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    const other = mkdtempSync(join(tmpdir(), 'between-other-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);

      // Somebody else publishes v9.9.9 first, over a completely different tree.
      git(other, 'init', '-q', '-b', 'main');
      git(other, 'config', 'user.name', 'Between');
      git(other, 'config', 'user.email', 'between-mirror@users.noreply.github.com');
      writeFileSync(join(other, 'IMPOSTOR.txt'), 'not the maintainer\n');
      git(other, 'add', '.');
      git(other, 'commit', '-q', '-m', 'someone else');
      git(other, 'tag', 'v9.9.9');
      git(other, 'push', '-q', remote, 'main', 'v9.9.9');

      // Locally the version looks free-and-clear over our own tree.
      git(dir, 'tag', 'v9.9.9', 'public');

      const { code, out } = publish(dir, '9.9.9');

      expect(out, 'it must not claim a release that is not ours').not.toMatch(/already published with this exact tree/);
      expect(out).toMatch(/different objects|different release/i);
      expect(code).not.toBe(0);
      // And the impostor's tag is untouched — we neither moved it nor reported over it.
      expect(git(dir, 'ls-remote', '--tags', remote)).toMatch(/v9\.9\.9/);
    } finally {
      for (const d of [other, remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });
});

describe.skipIf(!pwsh)('what ships depends on this repository alone', () => {
  it('refuses when a file is hidden from the operator by their personal global gitignore', () => {
    // The third fail-open, and it was introduced BY the fix for the second one. The rebuild blanks
    // core.excludesFile so that a machine-local ignore cannot silently DROP files from a release. The
    // preflight's clean-tree check did not, so the two disagreed about what was in the tree: a path
    // hidden by the operator's own global ignore was invisible to "working tree is not clean" and
    // fully visible to `git add .`, and went out under a permanent tag.
    //
    // On the machine this was found on, the global ignore hid `.claude/settings.local.json` — a file
    // recording approved tool permissions and local paths, which Claude Code writes the first time a
    // permission is approved for a project.
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);

      // Outside the repo, as a real one is — it lives in the operator's home directory.
      const globalIgnore = join(remote, '..', `between-globalignore-${process.pid}`);
      writeFileSync(globalIgnore, 'secret-local-notes.md\n');
      git(dir, 'config', 'core.excludesFile', globalIgnore);
      writeFileSync(join(dir, 'secret-local-notes.md'), 'my private working notes\n');

      // The operator's own check says the tree is clean, which is exactly why this was invisible.
      expect(git(dir, 'status', '--porcelain'), 'precondition: the file is hidden from the operator').toBe('');

      const { code, out } = publish(dir, '9.9.9');

      expect(code, 'a file the operator cannot see must not publish itself').not.toBe(0);
      expect(out).toMatch(/working tree is not clean/i);
      expect(out).toMatch(/secret-local-notes\.md/);
      expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });

  it('refuses when status.showUntrackedFiles=no hides whole directories from the check', () => {
    const dir = scaffold();
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      git(dir, 'config', 'status.showUntrackedFiles', 'no');
      mkdirSync(join(dir, 'tmpwork'), { recursive: true });
      writeFileSync(join(dir, 'tmpwork', 'pricing.csv'), 'internal,numbers\n');

      expect(git(dir, 'status', '--porcelain'), 'precondition: the config hides it').toBe('');

      const { code, out } = publish(dir, '9.9.9');

      expect(code).not.toBe(0);
      expect(out).toMatch(/working tree is not clean/i);
      expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
    } finally {
      for (const d of [remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });
});

describe.skipIf(!pwsh)('a version string identifies one tree, so it must be a version', () => {
  // `-Version v1.0.0` published a permanent tag named "vv1.0.0". Worse, `-Version "0.3.2 beta"`
  // passed every assertion, pushed `main` irreversibly, and only THEN failed at `git tag` — leaving
  // the public branch published with no tag naming it. Validation has to happen before anything moves.
  for (const bad of ['v1.0.0', '0.3.2 beta', '0.3.2;echo pwned', '../../etc', '0.3']) {
    it(`refuses "${bad}" before touching the remote`, () => {
      const dir = scaffold();
      const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
      try {
        git(dir, 'init', '-q', '--bare', remote);
        git(dir, 'remote', 'add', 'public', remote);

        const { code, out } = publish(dir, bad);

        expect(code).not.toBe(0);
        expect(out).toMatch(/is not a version/i);
        expect(git(dir, 'ls-remote', '--heads', remote), 'main was pushed before the version was checked').toBe('');
        expect(git(dir, 'ls-remote', '--tags', remote)).toBe('');
      } finally {
        for (const d of [remote, dir]) {
          try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
        }
      }
    });
  }
});

describe.skipIf(!pwsh)('the release refuses to run from the wrong branch', () => {
  it('aborts on a detached HEAD and still returns the operator to phase3', () => {
    // A TAG named `public` satisfies the preflight's rev-parse, and `git checkout public` then exits 0
    // into a detached HEAD. The positive HEAD check catches it — and had no coverage at all, because
    // the worktree case below is caught by the exit-code guard before it is ever reached.
    const dir = scaffold();
    try {
      git(dir, 'branch', '-D', 'public');
      git(dir, 'tag', 'public');
      const { code, out } = publish(dir, '9.9.9');

      expect(out).toMatch(/HEAD is 'HEAD'|Refusing to rebuild/);
      expect(code).not.toBe(0);
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'left stranded on a detached HEAD').toBe('phase3');
    } finally {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
    }
  });

  it('aborts when `git checkout public` fails, instead of releasing from phase3', () => {
    // The worst defect this script has had. $ErrorActionPreference does not apply to native commands
    // (pwsh 7.6.3: $PSNativeCommandUseErrorActionPreference is False by default), so a failing
    // `git checkout public` printed its error and execution carried on to the next line — rebuilding,
    // asserting, committing, tagging and pushing while HEAD was still on phase3.
    //
    // Because `public` is an orphan line with no common ancestor, pushing a tag that points into
    // phase3 uploads the entire private history, docs/DECISIONS.md blobs included. The
    // DECISIONS/FABLE assertion does not save us there: it inspects the tracked set, not the branch.
    //
    // A worktree holding `public` is the simplest way to make the checkout fail for real.
    const dir = scaffold();
    const wt = mkdtempSync(join(tmpdir(), 'between-wt-'));
    const remote = mkdtempSync(join(tmpdir(), 'between-remote-'));
    try {
      git(dir, 'init', '-q', '--bare', remote);
      git(dir, 'remote', 'add', 'public', remote);
      git(dir, 'worktree', 'add', '-q', wt, 'public');

      const r = spawnSync(pwsh!, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        join(dir, 'scripts', 'publish-release.ps1'), '-Version', '9.9.9', '-Publish'],
        { cwd: dir, encoding: 'utf8', windowsHide: true });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

      expect(out, 'it must say why it stopped').toMatch(/ABORTING/);
      expect(r.status, 'a refused release must not exit 0').not.toBe(0);
      expect(out).not.toMatch(/Published/);
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'left on the wrong branch').toBe('phase3');
      expect(git(dir, 'tag', '-l'), 'a tag was created from the wrong branch').toBe('');
      expect(git(dir, 'ls-remote', '--tags', remote), 'something reached the remote').toBe('');
      expect(git(dir, 'ls-remote', '--heads', remote), 'something reached the remote').toBe('');
    } finally {
      try { git(dir, 'worktree', 'prune'); } catch { /* best effort */ }
      for (const d of [wt, remote, dir]) {
        try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
      }
    }
  });
});

describe('release immutability — the script source', () => {
  it('never force-moves a tag', () => {
    expect(scriptSource).not.toMatch(/git\s+tag\s+(-[a-zA-Z]*\s+)*-f\b/);
    expect(scriptSource).not.toMatch(/git\s+tag\s+--force\b/);
  });

  it('never force-pushes', () => {
    expect(scriptSource).not.toMatch(/git\s+push\s+(-[a-zA-Z]*\s+)*-f\b/);
    expect(scriptSource).not.toMatch(/git\s+push\s+--force\b/);
  });
});

describe.skipIf(!pwsh)('release immutability — the dry-run guard', () => {
  it('refuses a version whose tag already exists over a different tree', () => {
    const dir = scaffold();
    try {
      git(dir, 'tag', 'v9.9.9');                    // v9.9.9 now means THIS tree, forever
      writeFileSync(join(dir, 'app.txt'), 'v2 content — changed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'changed the tree');

      const { code, out } = runScript(dir, '9.9.9');
      expect(code).not.toBe(0);
      expect(out).toMatch(/ABORTING/);
      expect(out).toMatch(/immutable|already exists|bump/i);
      // and it must leave the operator back on phase3, never stranded on `public`
      expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('phase3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a fresh version over a changed tree', () => {
    const dir = scaffold();
    try {
      git(dir, 'tag', 'v9.9.9');
      writeFileSync(join(dir, 'app.txt'), 'v2 content — changed\n');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'changed the tree');

      const { code, out } = runScript(dir, '9.9.10');   // the patch bump: the honest correction
      expect(out).toMatch(/DRY RUN complete/);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unchanged re-run of a published version as a no-op, not a mutation', () => {
    const dir = scaffold();
    try {
      // Publish-shaped state: `public` already carries exactly the phase3 tree under the tag.
      git(dir, 'tag', 'v9.9.9', 'public');

      const { code, out } = runScript(dir, '9.9.9');
      expect(code).toBe(0);
      expect(out).toMatch(/already published|nothing to do/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
