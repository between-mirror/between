// Between Mirror — the public-history audit must catch what it claims to, and must never fail open.
//
// scripts/audit-public-history.ps1 answers the question the release gate structurally cannot: not
// "is this private thing in the tree I am about to publish", but "is it in the history I already
// published". A file removed today is still in the commit that carried it.
//
// The failure mode that matters is silence. A sweep that cannot read the repository, or that runs
// zero patterns, or that treats git's "no match" and git's "I broke" as the same answer, reports
// CLEAN over a repository it never looked at — and CLEAN is the answer that ends the investigation.
// So every test here is about the audit being unable to lie in that particular direction.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const AUDIT = resolve(__dirname, '../../scripts/audit-public-history.ps1');
const created: string[] = [];
afterAll(() => {
  for (const d of created) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  }
});

function findPowerShell(): string | null {
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { stdio: 'ignore' });
      return exe;
    } catch { /* next */ }
  }
  return null;
}
const shell = findPowerShell();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A throwaway "public" repository plus a local checkout to run the audit from.
 *
 * `seed` decides where the synthetic private string is planted. The point of each variant is a place
 * a naive sweep would miss: a file that no longer exists in the tip tree, a path rather than content,
 * a commit message, a tag message.
 */
function makePublic(seed: 'clean' | 'old-file' | 'path' | 'commit-msg' | 'tag-msg'): string {
  const root = mkdtempSync(join(tmpdir(), 'between-audit-'));
  created.push(root);
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');

  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', work);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'checkout', '-q', '-b', 'main');

  writeFileSync(join(work, 'README.md'), 'a public project\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'initial');

  const NAME = 'Wilhelmina Farquharson';        // the synthetic private string

  if (seed === 'old-file') {
    // Present in an OLD commit, deleted before the tip. A sweep of the current tree finds nothing.
    writeFileSync(join(work, 'notes.md'), `written by ${NAME}\n`);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'add notes');
    git(work, 'rm', '-q', 'notes.md');
    git(work, 'commit', '-q', '-m', 'remove notes');
  } else if (seed === 'path') {
    // The name is only ever in a FILENAME. No content sweep sees it; every clone lists it.
    writeFileSync(join(work, `${NAME}-interview.md`), 'nothing sensitive inside\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'add an interview');
  } else if (seed === 'commit-msg') {
    writeFileSync(join(work, 'x.md'), 'harmless\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', `thanks to ${NAME} for the report`);
  } else {
    writeFileSync(join(work, 'x.md'), 'harmless\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'ordinary');
  }

  // Nine tags, because the audit asserts a known release floor and would otherwise refuse the fixture
  // for being incomplete — which is itself the coverage check doing its job.
  for (let i = 0; i < 9; i++) {
    if (seed === 'tag-msg' && i === 3) {
      git(work, 'tag', '-a', `v0.0.${i}`, '-m', `release prepared by ${NAME}`);
    } else {
      git(work, 'tag', `v0.0.${i}`);
    }
  }

  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '--mirror', 'origin');
  return origin;
}

/** Run the audit against a local bare repo standing in for the public one. */
function runAudit(originPath: string, patterns: string, extra: Record<string, string> = {}):
{ code: number; out: string } {
  const home = mkdtempSync(join(tmpdir(), 'between-audit-run-'));
  created.push(home);
  mkdirSync(join(home, 'scripts'), { recursive: true });
  writeFileSync(join(home, 'personal-patterns.txt'), patterns);
  const r = spawnSync(shell!, [
    '-NoProfile', '-NonInteractive', '-File', AUDIT,
    '-PatternFile', join(home, 'personal-patterns.txt'),
    '-RepoUrl', originPath,
    '-WorkDir', join(home, 'scratch'),
    ...Object.entries(extra).flatMap(([k, v]) => [k, v]),
  ], { cwd: home, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe.skipIf(!shell)('the public-history audit', () => {
  it('passes a genuinely clean history, and says what it swept', () => {
    const origin = makePublic('clean');
    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out, `expected CLEAN:\n${out}`).toMatch(/VERDICT: CLEAN/);
    expect(out, 'the evidence line must state what was actually covered').toMatch(/commits/);
    expect(code).toBe(0);
  });

  it('catches a name in a file that only exists in an old commit', () => {
    const origin = makePublic('old-file');
    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/MATCHES FOUND/);
    expect(out).toMatch(/CONTENT/);
    expect(code).not.toBe(0);
  });

  it('catches a name that appears only in a path', () => {
    const origin = makePublic('path');
    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/MATCHES FOUND/);
    expect(out).toMatch(/PATH/);
    expect(code).not.toBe(0);
  });

  it('catches a name in a commit message', () => {
    const origin = makePublic('commit-msg');
    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/MATCHES FOUND/);
    expect(out).toMatch(/MESSAGE/);
    expect(code).not.toBe(0);
  });

  it('catches a name in an annotated tag message', () => {
    const origin = makePublic('tag-msg');
    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/MATCHES FOUND/);
    expect(out).toMatch(/TAGMSG/);
    expect(code).not.toBe(0);
  });

  it('refuses an empty pattern list rather than sweeping nothing and reporting clean', () => {
    // The purest form of the failure this whole file exists to prevent.
    const origin = makePublic('old-file');
    const { code, out } = runAudit(origin, '# every line a comment\n');
    expect(out).toMatch(/no active patterns|not a sweep/i);
    expect(out).not.toMatch(/VERDICT: CLEAN/);
    expect(code).not.toBe(0);
  });

  it('refuses a repository that carries the private branch', () => {
    // The interlock. Pointed at the local repo every pattern would match by design, the "finding"
    // would be meaningless, and the habit of dismissing its output would be established.
    const root = mkdtempSync(join(tmpdir(), 'between-audit-'));
    created.push(root);
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q', work);
    git(work, 'config', 'user.email', 'test@example.invalid');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'checkout', '-q', '-b', 'phase3');
    writeFileSync(join(work, 'x.md'), 'private history\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'private');
    for (let i = 0; i < 9; i++) git(work, 'tag', `v0.0.${i}`);
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', '--mirror', 'origin');

    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/phase3/);
    expect(out).toMatch(/AUDIT FAILED/);
    expect(out).not.toMatch(/VERDICT: CLEAN/);
    expect(code).not.toBe(0);
  });

  it('fails rather than reports clean when the repository cannot be read', () => {
    // git exits >1 on an error. Treating "not 0" as clean is the fail-open, and it is the reason
    // this script classifies all three exit codes instead of two.
    const { code, out } = runAudit(join(tmpdir(), 'no-such-repo-at-all.git'), 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/AUDIT FAILED|could not clone/i);
    expect(out).not.toMatch(/VERDICT: CLEAN/);
    expect(code).not.toBe(0);
  });

  it('refuses a history too short to be the real one', () => {
    // Known-coverage. A shallow or partial clone that reports clean is the quietest possible lie.
    const root = mkdtempSync(join(tmpdir(), 'between-audit-'));
    created.push(root);
    const origin = join(root, 'origin.git');
    const work = join(root, 'work');
    git(root, 'init', '-q', '--bare', origin);
    git(root, 'init', '-q', work);
    git(work, 'config', 'user.email', 'test@example.invalid');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'checkout', '-q', '-b', 'main');
    writeFileSync(join(work, 'x.md'), 'one commit, one tag\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'only');
    git(work, 'tag', 'v0.0.1');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', '--mirror', 'origin');

    const { code, out } = runAudit(origin, 'Wilhelmina Farquharson\n');
    expect(out).toMatch(/incomplete|releases are known/i);
    expect(out).not.toMatch(/VERDICT: CLEAN/);
    expect(code).not.toBe(0);
  });
});
