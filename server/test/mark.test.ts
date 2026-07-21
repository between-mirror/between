// Between Mirror — the mark. (Era 1, v0.3.0 "the presentation release".)
//
// The product name on every public surface is "Between Mirror": the org already carries it, and
// VCNC's "Between" couples app makes the bare word commercially unsafe. Internal identifiers stay
// `between` (package names, the db filename, module paths) — this is a naming decision about what
// strangers read, not a refactor.
//
// These tests exist because a rename is exactly the kind of change that half-lands: the README gets
// updated, the browser tab keeps saying the old thing for a year. They pin the surfaces a stranger
// actually sees, and the two phrases that must not survive anywhere.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** The positioning line, verbatim (docs/SHIP.md §3). Engine options are explained deeper in the
 *  page, never in the title — the title says what it does for you, not what it runs on. */
const ONE_LINER =
  'Between Mirror turns years of messages into a private, explorable relationship history — with the words underneath every observation.';

describe('the mark — Between Mirror on every public surface', () => {
  it('the README opens with the mark and the one-liner', () => {
    const firstScreen = read('README.md').split('\n').slice(0, 14).join('\n');
    expect(firstScreen).toMatch(/^#\s+Between Mirror\s*$/m);
    expect(firstScreen).toContain(ONE_LINER);
  });

  it('the browser tab says Between Mirror', () => {
    expect(read('web/index.html')).toMatch(/<title>Between Mirror<\/title>/);
  });

  it('the app header wears the mark', () => {
    const app = read('web/src/App.tsx');
    expect(app).toMatch(/className="boot-mark">Between Mirror</);
    expect(app).toMatch(/className="brand-word">Between Mirror</);
  });

  it('the root package description carries the mark', () => {
    expect(JSON.parse(read('package.json')).description).toContain('Between Mirror');
  });

  it('the demo README introduces the tool by its mark', () => {
    expect(read('examples/README.md')).toContain('Between Mirror');
  });

  it('TRADEMARK.md exists and states the fork terms', () => {
    expect(existsSync(resolve(ROOT, 'TRADEMARK.md'))).toBe(true);
    const t = read('TRADEMARK.md');
    expect(t).toMatch(/based on Between Mirror/i);   // what a fork MAY say
    expect(t).toMatch(/Official Between Mirror/i);   // what only signed org builds may claim
  });

  it('internal identifiers are deliberately NOT renamed', () => {
    expect(JSON.parse(read('package.json')).name).toBe('between');
    expect(read('web/package.json')).toContain('@between/web');
  });
});

describe('the mark — retired phrases stay retired', () => {
  // Tracked files only: node_modules, the local db and the private journals are not public surface.
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
    .split('\n')
    .filter((f) => /\.(md|ts|tsx|html|json|css|ps1|yml)$/.test(f))
    // Two files are allowed to contain the retired phrases, for the same reason: they exist to say
    // that the phrases were retired. This test names them in order to ban them, and a changelog that
    // cannot quote what it removed is not a changelog.
    .filter((f) => !f.endsWith('server/test/mark.test.ts') && f !== 'CHANGELOG.md');

  it('no tracked file still calls Between a "working name"', () => {
    const hits = tracked.filter((f) => /working name/i.test(read(f)));
    expect(hits).toEqual([]);
  });

  it('no tracked file bills the product as "powered by Claude Code"', () => {
    // The engine options (Ollama / Claude subscription / API key) are explained deeper in the docs.
    // They are never the product's billing — a mirror is not "powered by" the thing that reads for it.
    const hits = tracked.filter((f) => /powered by Claude( Code)?/i.test(read(f)));
    expect(hits).toEqual([]);
  });
});
