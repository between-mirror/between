#!/usr/bin/env node
// T-CLEAN — the privacy linter (HANDOFF invariant 3 / TESTING T-CLEAN).
// Blocks commits (or reports on the tree) containing:
//   - phone-number-shaped strings in NON-test source,
//   - the SMS/MMS archive filename pattern anywhere,
//   - any pattern listed in the local, git-ignored personal-patterns.txt (real PII catcher).
// Synthetic numbers inside test/fixtures are allowed (the invariant forbids REAL data, not fixtures);
// personal-patterns.txt still catches the real ones even there.
//
// Usage: node scripts/check-clean.mjs [--staged]
// Emergency override (use sparingly): SKIP_CLEAN=1 git commit ...

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

if (process.env.SKIP_CLEAN === '1') {
  console.log('T-CLEAN skipped (SKIP_CLEAN=1).');
  process.exit(0);
}

const STAGED = process.argv.includes('--staged');

// A US/E.164-shaped number: optional +1, 10 digits with optional separators,
// NOT embedded in a longer digit run (so 13-digit epoch timestamps don't trip it).
const PHONE = /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?!\d)/;

// Published crisis lines are the one class of phone number that is definitionally NOT personal data:
// they belong to organisations, they exist to be copied, and SUPPORT.md is required to carry them.
// Allowlisted by exact digits rather than left to the blanket per-line `clean-ok` escape hatch, so the
// reason stays visible and a real number can never ride along on the same line as one.
const PUBLIC_HELPLINES = new Set([
  '18007997233',   // US National Domestic Violence Hotline
  '18002738255',   // US Suicide & Crisis Lifeline (the pre-988 number, still widely published)
  '18006564673',   // RAINN
]);
const isPublicHelpline = (line) => {
  const hits = line.match(new RegExp(PHONE.source, 'g')) ?? [];
  return hits.length > 0 && hits.every((h) => PUBLIC_HELPLINES.has(h.replace(/\D/g, '')));
};

// The second class that is definitionally not personal data: 555-0100 through 555-0199, which the
// North American Numbering Plan permanently reserves for fiction. Those numbers cannot be assigned to
// a subscriber, so one can never belong to a real person.
//
// This is not a convenience exemption. The synthetic fixture generator has always emitted this range
// on purpose (server/test/fixtures/gen.ts: "All phone numbers live in the fictional 555-0100..555-0199
// range"), and test files were already skipped wholesale — so the rule only bit once the demo export
// started writing the same fictional contacts into site/demo-data, on their way to a public page.
// The alternative was to redact them, which would have meant the demo showing something the real
// application does not.
//
// Deliberately narrow: the exchange must be 555 AND the line number must start 01. 555-1234 is a real,
// assignable number and is still caught.
const isFictionalRange = (line) => {
  const hits = line.match(new RegExp(PHONE.source, 'g')) ?? [];
  if (hits.length === 0) return false;
  return hits.every((h) => {
    const d = h.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');   // normalise to 10 digits
    return d.length === 10 && d.slice(3, 6) === '555' && d.slice(6, 8) === '01';
  });
};

const ARCHIVE = /\b(?:sms|calls)-\d{14}\.xml\b/i;
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|html?|sql|txt|ya?ml|sh)$/i;
const IS_TEST = (f) => /(^|\/)(tests?|__tests__|fixtures)(\/|$)|\.(test|spec)\./i.test(f);
const SELF = new Set(['personal-patterns.txt', 'scripts/check-clean.mjs']);

const extra = [];
if (existsSync('personal-patterns.txt')) {
  for (const line of readFileSync('personal-patterns.txt', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) extra.push(t.toLowerCase());
  }
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const files = (STAGED
  ? sh('git diff --cached --name-only --diff-filter=ACM')
  : sh('git ls-files')
).split(/\r?\n/).filter(Boolean);

const contentOf = (f) => {
  try {
    return STAGED ? sh(`git show :"${f}"`) : (existsSync(f) ? readFileSync(f, 'utf8') : '');
  } catch {
    return '';
  }
};

const violations = [];
for (const f of files) {
  if (SELF.has(f) || !TEXT_EXT.test(f)) continue;
  const lines = contentOf(f).split(/\r?\n/);
  const test = IS_TEST(f);
  lines.forEach((line, i) => {
    if (/\bclean-ok\b/.test(line)) return; // explicit reviewer allowlist for legit false positives
    const at = { f, n: i + 1, text: line.trim().slice(0, 80) };
    if (ARCHIVE.test(line)) violations.push({ ...at, why: 'archive filename' });
    if (!test && PHONE.test(line) && !isPublicHelpline(line) && !isFictionalRange(line)) violations.push({ ...at, why: 'phone-shaped number' });
    const low = line.toLowerCase();
    for (const p of extra) if (low.includes(p)) violations.push({ ...at, why: `personal pattern "${p}"` });
  });
}

if (violations.length) {
  console.error('\n⛔  T-CLEAN blocked the commit — possible personal data:\n');
  for (const v of violations.slice(0, 50)) console.error(`   ${v.f}:${v.n}  [${v.why}]  ${v.text}`);
  if (violations.length > 50) console.error(`   ... and ${violations.length - 50} more`);
  console.error('\nRemove it or use a placeholder. Emergency override: SKIP_CLEAN=1 git commit ...\n');
  process.exit(1);
}
console.log(`T-CLEAN clean (${files.length} file(s) scanned${STAGED ? ', staged' : ''}).`);
