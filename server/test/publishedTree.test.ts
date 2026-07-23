// Between Mirror — what the public tree CONTAINS, not just what it excludes.
//
// Every release gate written so far asks the same shape of question: is the private journal absent,
// is a personal name absent, is an off-origin URL absent. All exclusion checks, each aimed at a thing
// somebody had already thought of.
//
// So `HANDOFF.md` shipped in every release from v0.1.0 to v0.3.2. It is the internal build contract,
// and it carried the author's real archive statistics — its size, its exact message counts, its span,
// the number of people in it — and the literal local path the archive sits at. It states, as binding
// invariant 3, "No personal data in code, prompts, tests, or the repo — ever", and then gives the
// counts four paragraphs later. Nothing caught it, because nothing was looking at the published tree;
// the checks were looking for two filenames and a list of names.
//
// This test looks at the content of everything that would be published, for the categories that
// matter regardless of whether anyone remembered the specific file.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../..');

/**
 * Every path that would reach the public tree: tracked, minus anything .gitignore excludes.
 *
 * That subtraction IS the release rebuild's rule — it empties the index and re-adds with .gitignore
 * applied — so this checks the same set the publish script would produce, without running it.
 */
function publishablePaths(): string[] {
  const tracked = execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: ROOT })
    .toString().split('\0').filter(Boolean);

  // Paths as ARGUMENTS, in chunks — not down --stdin, which failed at the spawn layer here (status
  // undefined, no stderr) and would have left every assertion in this file passing over an empty
  // list. `-z` is deliberately absent: git rejects it without --stdin ("only makes sense with
  // --stdin"), so output is line-separated and core.quotePath=false is what keeps a non-ASCII path
  // from arriving octal-escaped and matching nothing. check-ignore exits 1 when a chunk contains no
  // ignored path, which is an answer, not an error.
  const ignored = new Set<string>();
  for (let i = 0; i < tracked.length; i += 200) {
    const chunk = tracked.slice(i, i + 200);
    let out = '';
    try {
      out = execFileSync('git', ['-c', 'core.quotePath=false', 'check-ignore', '--no-index', '--', ...chunk],
        { cwd: ROOT }).toString();
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer };
      if (err.status !== 1) throw e;
      out = err.stdout?.toString() ?? '';
    }
    for (const p of out.split(/\r?\n/)) if (p) ignored.add(p);
  }
  return tracked.filter((p) => !ignored.has(p));
}

// .html is in this list on purpose. The first hand-audit of this leak grepped markdown and source and
// found four documents; docs/between-brief.html was the fifth, and it held the archive's size and its
// exact message count in a facts panel, because nobody thought to look in the design brief.
const TEXT = /\.(md|txt|ts|tsx|js|mjs|cjs|json|yml|yaml|html|css|sql|ps1|sh)$/i;

// This file necessarily contains the patterns it searches for, and the fixtures below deliberately
// contain synthetic paths — `C:\Users\me\...`, `/home/me` — which are the point of those tests.
// Exempting them by NAME rather than by pattern, so the exemption is visible and cannot quietly widen.
const SELF_REFERENTIAL = new Set([
  'server/test/publishedTree.test.ts',
  'server/test/atRest.test.ts',
  'server/test/demoExport.test.ts',
]);

let paths: string[] = [];
try { paths = publishablePaths(); } catch { paths = []; }
const textPaths = paths.filter((p) => TEXT.test(p) && existsSync(join(ROOT, p)));

describe('the tree that would be published', () => {
  it('was actually enumerated', () => {
    expect(paths.length, 'could not list the publishable set').toBeGreaterThan(50);
  });

  it('carries no statistic about the author\'s own archive', () => {
    // The patterns are READ FROM THE GITIGNORED private file, never written here.
    //
    // The first version of this guard hardcoded them — the real counts, the real size, the real
    // contact number — each with a comment saying which was which. It then exempted itself from its
    // own scan, so it passed, and the release published it. The check written to stop the statistics
    // leaking leaked them, annotated, exactly as HANDOFF.md forbade personal data four paragraphs
    // before disclosing it. Writing a secret into the thing that guards it is apparently a very easy
    // mistake to make twice.
    //
    // So they live in personal-patterns.txt with the names, which is gitignored and swept by the
    // release script. Absent (a stranger's clone, CI), this assertion cannot run — and says so rather
    // than reporting a pass it did not earn. The enforcement that matters is publish-release.ps1,
    // which refuses to publish at all without that file.
    const patternFile = resolve(ROOT, 'personal-patterns.txt');
    if (!existsSync(patternFile)) {
      console.warn('[publishedTree] personal-patterns.txt absent — statistic scan SKIPPED, not passed.');
      return;
    }
    const STATS = readFileSync(patternFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => new RegExp(l, 'i'));
    expect(STATS.length, 'the private pattern file has no active patterns').toBeGreaterThan(0);

    const bad: string[] = [];
    for (const p of textPaths) {
      if (SELF_REFERENTIAL.has(p)) continue;
      const text = readFileSync(join(ROOT, p), 'utf8');
      for (const re of STATS) {
        const m = re.exec(text);
        if (m) bad.push(`${p}: ${JSON.stringify(m[0])}`);
      }
    }
    expect(bad, `a real-archive statistic would be published:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('carries no absolute path from the machine it was built on', () => {
    // The author's working directory appeared three times across two published documents. A path is
    // both a privacy detail and, in this case, a folder name that says what the folder is for.
    const bad: string[] = [];
    for (const p of textPaths) {
      if (SELF_REFERENTIAL.has(p)) continue;
      const text = readFileSync(join(ROOT, p), 'utf8');
      // A drive-letter path, excluding the obviously-generic examples the docs legitimately use.
      for (const m of text.matchAll(/\b[A-Za-z]:\\{1,2}[^\s"'`)\]]*/g)) {
        const hit = m[0];
        if (/^[A-Za-z]:\\{1,2}(path|to|your|Users\\<|\.\.\.)/i.test(hit)) continue;
        // Placeholder shapes only. This used to exempt any path containing "example", and a real
        // local path — the maintainer's own drive and directory layout, quoted in the changelog
        // entry about having leaked it — sailed through because a folder in it was named
        // `examples`. A guard whose exemption matches a substring of real data is not a guard.
        if (/sms-XXXX|sms-YYYY|<timestamp>|\\example\.db$/i.test(hit)) continue;
        bad.push(`${p}: ${hit}`);
      }
      for (const m of text.matchAll(/\/(?:Users|home)\/(?!you\b|<)[a-z0-9._-]+/gi)) {
        bad.push(`${p}: ${m[0]}`);
      }
    }
    expect(bad, `a real local path would be published:\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  it('does not publish the internal build scaffolding', () => {
    // These describe how the software was MADE — the contract between a planning phase and a build
    // phase, which model did which job, the phase gates. They are a real record and they stay in the
    // working repo; they are not a description of the product and do not belong in a public release.
    const INTERNAL = ['HANDOFF.md', 'GAMEPLAN.md', 'docs/GAMEPLAN-PHASE3.md', 'docs/HANDOFF-READINESS.md'];
    const shipped = paths.filter((p) => INTERNAL.includes(p));
    expect(shipped, `internal build documents would be published:\n  ${shipped.join('\n  ')}`).toEqual([]);
  });

  it('leaves no link pointing at a document that is no longer published', () => {
    // Removing a file from the release without fixing what links to it turns an embarrassment into a
    // broken README, which is the other way to look careless.
    const published = new Set(paths);
    const bad: string[] = [];
    for (const p of textPaths.filter((x) => x.endsWith('.md'))) {
      const text = readFileSync(join(ROOT, p), 'utf8');
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      for (const m of text.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
        const target = m[1].startsWith('/') ? m[1].slice(1)
          : [...dir.split('/').filter(Boolean), ...m[1].split('/')]
              .reduce<string[]>((acc, seg) => {
                if (seg === '.') return acc;
                if (seg === '..') { acc.pop(); return acc; }
                acc.push(seg); return acc;
              }, []).join('/');
        if (!published.has(target)) bad.push(`${p} → ${m[1]}`);
      }
    }
    expect(bad, `a published document links to one that is not published:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});
