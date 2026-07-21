// Between Mirror — the T-CLEAN privacy linter has exemptions, and exemptions need tests.
//
// scripts/check-clean.mjs blocks any commit containing a phone-shaped number. It carries two
// allowlists, and an allowlist is the part of a privacy guard most likely to quietly grow until it
// exempts everything. Nothing tested this file at all before.
//
// The linter is run as a subprocess against fixture content rather than by re-implementing its rules
// here — a copied regex tests the copy, not the guard.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../scripts/check-clean.mjs');

/** Run the real linter over one file's content in a throwaway git repo; true = it allowed it. */
function allows(content: string, name = 'probe.json'): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'between-tclean-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Between'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'between-mirror@users.noreply.github.com'], { cwd: dir });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    try {
      execFileSync(process.execPath, [SCRIPT], { cwd: dir, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
  }
}

describe('the T-CLEAN phone rule', () => {
  it('blocks a real-looking number', () => {
    expect(allows('{"phone":"+12125551234"}')).toBe(false);
  });

  it('blocks a real, assignable 555 number', () => {
    // 555-1234 is not fiction. Only 555-0100..555-0199 is reserved, and the exemption must not
    // widen to "anything with 555 in it" — which is the obvious wrong version of this rule.
    expect(allows('{"phone":"+15555551234"}')).toBe(false);
  });

  it('blocks a number just outside the reserved fictional range', () => {
    expect(allows('{"phone":"555-555-0200"}')).toBe(false);
  });

  it('allows the reserved fictional range the demo and fixtures use', () => {
    // NANP permanently reserves 555-0100..555-0199 for fiction; these cannot belong to a person.
    // The demo export writes them into site/demo-data on the way to a public page.
    expect(allows('{"primaryE164":"+15555550100"}')).toBe(true);
    expect(allows('{"primaryE164":"555-555-0199"}')).toBe(true);
  });

  it('does not let a real number ride along beside a fictional one', () => {
    // The failure mode of every "all hits must be exempt" check that only tests the first hit.
    expect(allows('{"a":"4155550100","b":"4155551234"}')).toBe(false);
  });
});
