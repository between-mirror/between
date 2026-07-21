// Between Mirror — the governance surface (Era 1, v0.3.0).
//
// A project that asks strangers to trust it with years of private messages owes them the boring
// documents: how to contribute without breaking the promises, how people are expected to behave,
// where to take a problem, and — the one most projects skip — what will never be built.
//
// These are tested because they are load-bearing claims, not decoration. The "not planned" list in
// particular is a commitment; if a future release quietly drops it, that should fail here first.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const has = (p: string) => existsSync(resolve(ROOT, p));

describe('the governance files exist where GitHub and strangers look for them', () => {
  for (const f of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SUPPORT.md', 'SECURITY.md', 'TRADEMARK.md',
    'docs/ROADMAP.md', 'docs/OPERATIONS.md']) {
    it(f, () => expect(has(f), `${f} is missing`).toBe(true));
  }
});

describe('CONTRIBUTING states the rules that are actually PR-blocking', () => {
  const c = read('CONTRIBUTING.md');

  it('requires the failing test first', () => {
    expect(c).toMatch(/failing test/i);
  });

  it('bans real personal data in fixtures without hedging', () => {
    expect(c).toMatch(/synthetic/i);
    expect(c).toMatch(/Alex & Jordan/);
    // "anonymised" is the loophole people reach for; it has to be closed by name.
    expect(c).toMatch(/anonymis|anonymiz/i);
  });

  it('names the privacy invariants as blocking, including no telemetry', () => {
    expect(c).toMatch(/PR-blocking|will be declined/i);
    expect(c).toMatch(/telemetry/i);
    expect(c).toMatch(/loopback/i);
  });

  it('requires DCO sign-off', () => {
    expect(c).toMatch(/Developer Certificate of Origin/);
    expect(c).toMatch(/Signed-off-by/);
  });

  it('discloses the unresolved contributor-rights question up front', () => {
    // Letting someone build a feature and THEN telling them it cannot be merged is the failure mode.
    expect(c).toMatch(/CLA/);
    expect(c).toMatch(/cannot be merged/i);
  });

  it('states the real Node floor rather than the one that was wrong on Windows', () => {
    expect(c).toMatch(/Node 22/);
  });
});

describe('CODE_OF_CONDUCT is the Contributor Covenant 2.1, unmodified in substance', () => {
  const c = read('CODE_OF_CONDUCT.md');
  it('is version 2.1 and attributes properly', () => {
    expect(c).toMatch(/Contributor Covenant/);
    expect(c).toMatch(/version\s*2\/1|version 2\.1/i);
    expect(c).toMatch(/contributor-covenant\.org/);
  });
  it('keeps the four-step enforcement ladder', () => {
    for (const step of ['Correction', 'Warning', 'Temporary Ban', 'Permanent Ban']) {
      expect(c).toContain(step);
    }
  });
});

describe('SUPPORT puts the crisis language first and does not pretend to be a service', () => {
  const s = read('SUPPORT.md');

  it('leads with the fact that this is not a crisis service', () => {
    const firstScreen = s.split('\n').slice(0, 12).join('\n');
    expect(firstScreen).toMatch(/not a crisis service/i);
  });

  it('carries 988 and an international route', () => {
    expect(s).toMatch(/\b988\b/);
    expect(s).toMatch(/findahelpline/i);
    expect(s).toMatch(/emergency services/i);
  });

  it('routes security away from public issues', () => {
    expect(s).toMatch(/advisor/i);
    expect(s).toMatch(/[Nn]ot an issue|do \*\*not\*\* open a public issue/);
  });

  it('asks people not to paste their own messages', () => {
    expect(s).toMatch(/do not paste your own messages/i);
  });
});

describe('the ROADMAP "not planned" list is a commitment, not a mood', () => {
  const r = read('docs/ROADMAP.md');

  it('has the three sections', () => {
    expect(r).toMatch(/^## Committed$/m);
    expect(r).toMatch(/^## Investigating$/m);
    expect(r).toMatch(/^## Not planned$/m);
  });

  it('permanently rules out each thing SHIP.md §4 says is a hard line', () => {
    const notPlanned = r.slice(r.indexOf('## Not planned'));
    for (const [what, pattern] of [
      ['DRM', /DRM/],
      ['accounts', /\*\*Accounts\.\*\*/],
      ['telemetry', /Telemetry, in any form/i],
      ['a hosted service', /hosted service/i],
      ['per-reading fees', /[Pp]er-reading or per-message fees/],
      ['evidence-grade claims', /[Ee]vidence-grade/],
    ] as const) {
      expect(notPlanned, `"not planned" is missing: ${what}`).toMatch(pattern);
    }
  });

  it('says the list is permanent and unmovable by a pull request', () => {
    expect(r).toMatch(/[Pp]ermanent/);
    expect(r).toMatch(/pull request will not move them|settled/i);
  });

  it('keeps the v1.0 validation gate external', () => {
    expect(r).toMatch(/external by design/i);
    expect(r).toMatch(/whatever they say/i);
  });
});

describe('OPERATIONS encodes how a release actually goes out', () => {
  const o = read('docs/OPERATIONS.md');

  it('has the triage lanes with the security clock', () => {
    expect(o).toMatch(/48 hours/);
    expect(o).toMatch(/Correctness/);
    expect(o).toMatch(/Installability/);
  });

  it('names the release script as the only sanctioned path, and tags as immutable', () => {
    expect(o).toMatch(/publish-release\.ps1/);
    expect(o).toMatch(/only.*sanctioned|sanctioned path/i);
    expect(o).toMatch(/immutable/i);
  });

  it('requires watching CI on the public repo after publishing', () => {
    expect(o).toMatch(/four matrix cells|all four/i);
  });

  it('carries the standing doctrine verbatim', () => {
    expect(o).toMatch(/A claim may only be as strong as its enforcement/);
  });

  it('says what to do when a report contains personal data', () => {
    expect(o).toMatch(/Edit the issue immediately/i);
  });
});
