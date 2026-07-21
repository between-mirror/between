// Between Mirror — no committed source file may carry an invisible control byte.
//
// This guard exists because of a defect that survived three rounds of review by being literally
// impossible to see. A heredoc ate the backslashes out of a regex and left four U+0008 BACKSPACE
// bytes behind, so `/\bno\b|\bnot\b|\bnever\b/` became `/<BS>no<BS>|<BS>not<BS>|never/`. It still
// parsed, still ran, and still passed — but two of its three alternatives could never match anything,
// and the site's central honesty check had quietly degraded to a substring search for "never".
//
// Every editor, every diff, every code review renders that file identically to the correct one. The
// only thing that can catch it is a machine counting bytes, so that is what this does.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(__dirname, '../..');

// Inverted deliberately: name the BINARY formats and check everything else.
//
// The first version listed the text extensions instead, and the list was the bug. `extname()` returns
// '' for a dotfile, so every one of them — .gitignore, .gitattributes, .editorconfig, and the
// .githooks/pre-commit that is this repo's own privacy linter — was skipped by construction. LICENSE
// has no extension either, and .svg was absent even though the site tests treat SVG as text. A guard
// whose coverage depends on remembering to extend a list will drift out of coverage silently, which
// is the failure this whole file exists to prevent.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
  '.db', '.sqlite', '.sqlite3', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tar', '.pdf', '.exe', '.dll', '.node', '.wasm', '.mp4', '.mov', '.webm',
]);

// Tab, LF and CR are the three C0 codes that legitimately appear in text.
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function committedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 });
  return out.split('\0').filter((p) => p && !BINARY_EXT.has(extname(p).toLowerCase()));
}

describe('committed source carries no invisible control bytes', () => {
  const files = committedTextFiles();

  it('actually covers the files it claims to', () => {
    // A guard that silently checks nothing is worse than no guard: it reports green forever. A bare
    // count is a weak sentinel — dropping every .ts file still left 107, comfortably over the old
    // threshold of 50. So name the specific things that must be in scope, including the categories
    // the first version skipped by construction.
    const must = [
      'server/test/siteNoEgress.test.ts',   // where the original invisible bytes were
      'docs/SPECS/airlock.md',              // where the second instance was found
      'scripts/lib/Rebuild-PublicTree.ps1',
      'site/index.html',
      'site/favicon.svg',
      'README.md',
      'package.json',
      '.gitignore',                         // a dotfile: extname() is '' for these
      '.gitattributes',
      '.githooks/pre-commit',               // no extension, and it is the privacy linter itself
      'LICENSE',
      '.github/workflows/pages.yml',
    ];
    const missing = must.filter((m) => !files.includes(m));
    expect(missing, `these committed files are not being checked:\n  ${missing.join('\n  ')}`).toEqual([]);
    expect(files.length).toBeGreaterThan(150);
  });

  it('has no C0 control character other than tab, CR or LF', () => {
    const bad: string[] = [];

    for (const relPath of files) {
      const buf = readFileSync(join(ROOT, relPath));
      let line = 1;
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === 0x0a) { line++; lineStart = i + 1; continue; }
        if (b < 0x20 && !ALLOWED.has(b)) {
          // Decode the line so far to get a CHARACTER column. Counting bytes and calling the result a
          // column is wrong in exactly the files this repo is full of: one em dash costs three bytes,
          // so a byte offset can name a column that does not exist on the line. `byte` stays too —
          // that is the figure a hex editor wants.
          const col = buf.toString('utf8', lineStart, i).length + 1;
          bad.push(
            `${relPath}:${line}:${col} — byte ${i} is 0x${b.toString(16).padStart(2, '0').toUpperCase()}` +
            ` (${b === 0x08 ? 'BACKSPACE — an eaten \\b escape?' : 'C0 control'})`,
          );
        }
      }
    }

    expect(
      bad,
      `committed text files contain control bytes that no editor will show you:\n  ${bad.join('\n  ')}`,
    ).toEqual([]);
  });
});
