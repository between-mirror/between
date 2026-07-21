// Between Mirror — the app never assumes anyone's gender (Era 1, v0.3.0).
//
// The Eras view shipped stat labels reading "His hostile share", "She initiates" and "His
// reciprocation" — with the tooltip on "His hostile share" explaining it as *your* messages. So the
// UI hard-coded that the archive's owner is a man and the other person is a woman, in the primary
// analysis surface, on a screen full of claims about their relationship.
//
// The app knows two things: which number is yours, and what you named the other person. It does not
// know anyone's gender and has no business guessing — a tool that reads a marriage's worst hours and
// then misgenders one of them has failed at something more basic than analysis. VOICE says it
// directly: *subject/person → you; the two of you*.
//
// This sweeps the user-visible copy rather than trusting a one-time fix, because the gendered words
// were spread across three views and a set of fallback defaults.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(__dirname, '../..');

const webSources = execFileSync('git', ['ls-files', 'web/src'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  .split('\n')
  .filter((f) => /\.tsx?$/.test(f));

/** Strings a user can actually read: JSX text, and the common label/title/placeholder props. */
function visibleCopy(file: string): string[] {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const out: string[] = [];
  // label="…" / title="…" / placeholder="…" / aria-label="…"
  for (const m of src.matchAll(/\b(?:label|title|placeholder|aria-label)=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    out.push(m[1] ?? m[2] ?? '');
  }
  // >text between tags<, single line. Braces are STRIPPED rather than used to skip the run: the
  // first version of this test refused any run containing `{…}`, which is most real JSX copy, and it
  // sailed past `Amber is you, slate is {her}.` in the Findings view for exactly that reason.
  for (const m of src.matchAll(/>([^<>\n]{4,120})</g)) {
    const text = m[1].replace(/\{[^}]*\}/g, ' ').trim();
    if (text && /[a-z]{3}/.test(text)) out.push(text);
  }
  // `${…}` renders a value, not a word — usually the contact's own name. Judge the prose around it,
  // never the identifier inside it, or this test starts policing variable names it cannot see the
  // output of.
  return out.map((s) => s.replace(/\$\{[^}]*\}/g, ' ').trim()).filter(Boolean);
}

const GENDERED = /\b(his|her|hers|she|he|him|husband|wife|boyfriend|girlfriend)\b/i;

describe('no user-visible copy assumes a gender', () => {
  for (const file of webSources) {
    const offenders = visibleCopy(file).filter((s) => GENDERED.test(s));
    it(file, () => {
      expect(offenders, `gendered copy in ${file}:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }
});

describe('no string constant IS a gendered word', () => {
  // `const her = 'her';` at module scope, interpolated into seven places including the crisis banner.
  // A sweep that only reads props and JSX text cannot see it — the gendered word enters the DOM
  // through an identifier, so the copy check has to look at what the identifiers hold too.
  it('no view defines a gendered pronoun as a value', () => {
    const bad: string[] = [];
    for (const file of webSources) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of src.matchAll(/(?:const|let|var)\s+\w+\s*(?::\s*string\s*)?=\s*'([^']*)'/g)) {
        if (GENDERED.test(m[1])) bad.push(`${file}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the fallbacks used when a contact has no name are neutral too', () => {
  // `displayName.split(' ')[0] || 'Her'` puts a gendered word on screen for any unnamed contact.
  it('no view falls back to a gendered placeholder name', () => {
    const bad: string[] = [];
    for (const file of webSources) {
      const src = readFileSync(resolve(ROOT, file), 'utf8');
      for (const m of src.matchAll(/\|\|\s*'(Her|She|His|He|Him)'/g)) bad.push(`${file}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
