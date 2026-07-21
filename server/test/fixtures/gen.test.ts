// Between — tests for the synthetic fixture generator (TESTING §1).
// Asserts: determinism per seed, ground-truth counts == actual XML occurrences,
// the oversized-part scenario really emits a >= 5 MB attribute, and every planted
// feature is present and correctly described in `expected`. SYNTHETIC data only.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixture, writeFixtureXml, SCENARIOS, mulberry32, REACTION_VERBS } from './gen';
import type { FixtureFileExpected } from './gen';

const FIVE_MB = 5 * 1024 * 1024;

const countSms = (xml: string): number => (xml.match(/<sms /g) ?? []).length;
const countMms = (xml: string): number => (xml.match(/<mms /g) ?? []).length;
const declaredCountOf = (xml: string): number => {
  const m = xml.match(/<smses count="(\d+)"/);
  return m ? Number(m[1]) : NaN;
};

/** True iff `addr` is inside the fictional +1 555 555 0100..0199 range. */
function inFictionalRange(addr: string): boolean {
  let d = addr.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10 || !d.startsWith('555555')) return false;
  const line = Number(d.slice(6));
  return line >= 100 && line <= 199;
}

describe('mulberry32', () => {
  it('is deterministic and stays in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('SCENARIOS coverage', () => {
  it('includes basic plus every required planted scenario', () => {
    for (const key of [
      'basic',
      'duplicatesAcrossFiles',
      'groupMms',
      'oneToOneMms',
      'oversizedPart',
      'tapbacks',
      'nonEnglish',
      'coverageHole',
      'emojiTorture',
      'draftOutboxFailed',
      'samePersonTwoNumbers',
      'everything',
    ]) {
      expect(SCENARIOS[key], `scenario ${key}`).toBeDefined();
    }
  });

  it('SCENARIOS.basic is a normal 2-contact archive with sms + mms', () => {
    const { xml, expected } = buildFixture(SCENARIOS.basic);
    expect(SCENARIOS.basic.contacts).toHaveLength(2);
    expect(expected.contacts).toBe(2);
    expect(expected.smsCount).toBeGreaterThan(0);
    expect(expected.mmsCount).toBeGreaterThan(0);
    expect(xml.startsWith("<?xml version='1.0'")).toBe(true);
    expect(xml.trimEnd().endsWith('</smses>')).toBe(true);
  });
});

describe('every scenario', () => {
  const entries = Object.entries(SCENARIOS);

  it.each(entries)('%s is deterministic for a fixed seed (identical xml twice)', (_name, spec) => {
    const a = buildFixture(spec);
    const b = buildFixture(spec);
    expect(a.xml).toBe(b.xml);
    // the ground-truth files (and thus every per-file xml) are stable too
    expect(JSON.stringify(a.expected.files)).toBe(JSON.stringify(b.expected.files));
  });

  it.each(entries)('%s: expected counts equal actual <sms/<mms occurrences', (_name, spec) => {
    const { xml, expected } = buildFixture(spec);
    // primary xml
    expect(countSms(xml)).toBe(expected.smsCount);
    expect(countMms(xml)).toBe(expected.mmsCount);
    expect(expected.totalRecords).toBe(expected.smsCount + expected.mmsCount);
    expect(expected.reactionCount).toBeLessThanOrEqual(expected.smsCount);

    // per-file counts also match, for every emitted file (dedup consumers rely on these)
    const files = expected.files as FixtureFileExpected[];
    for (const f of files) {
      expect(countSms(f.xml), `${f.label} sms`).toBe(f.smsCount);
      expect(countMms(f.xml), `${f.label} mms`).toBe(f.mmsCount);
      expect(f.totalRecords).toBe(f.smsCount + f.mmsCount);
      expect(declaredCountOf(f.xml)).toBe(f.declaredCount);
    }
    // primary xml corresponds to the 'main' file
    expect(files.some((f) => f.xml === xml)).toBe(true);
  });

  it.each(entries)('%s: every MMS carries exactly one seq="-1" SMIL part', (_name, spec) => {
    const { xml, expected } = buildFixture(spec);
    const smil = (xml.match(/seq="-1"/g) ?? []).length;
    const smilApp = (xml.match(/ct="application\/smil"/g) ?? []).length;
    expect(smil).toBe(expected.mmsCount);
    expect(smilApp).toBe(expected.mmsCount);
  });

  it.each(entries)('%s: all phone numbers stay in the fictional 555-01xx range', (_name, spec) => {
    const { xml } = buildFixture(spec);
    // strip base64 blobs (they contain incidental digit runs) before scanning
    const scan = xml.replace(/ data="[^"]*"/g, ' data=""');
    // 1) every address attribute value (split ~ groups) is in range
    for (const m of scan.matchAll(/address="([^"]*)"/g)) {
      for (const part of m[1].split('~')) {
        expect(inFictionalRange(part), `address ${part}`).toBe(true);
      }
    }
    // 2) no separated phone-shaped number outside the range anywhere
    for (const m of scan.matchAll(/\d{3}[- ]\d{3}[- ]\d{4}/g)) {
      expect(inFictionalRange(m[0]), `separated ${m[0]}`).toBe(true);
    }
    // 3) no stray contiguous 10-digit phone that isn't an allowed 555555xxxx
    expect(scan.match(/(?<!\d)(?!555555)\d{10}(?!\d)/g)).toBeNull();
  });

  it.each(entries)('%s: expected exposes the required numeric fields', (_name, spec) => {
    const { expected } = buildFixture(spec);
    for (const k of ['smsCount', 'mmsCount', 'totalRecords', 'reactionCount', 'contacts']) {
      expect(typeof expected[k], k).toBe('number');
    }
  });
});

describe('duplicates across two overlapping files', () => {
  it('emits two files with a byte-identical overlap and correct dedup ground truth', () => {
    const { xml, expected } = buildFixture(SCENARIOS.duplicatesAcrossFiles);
    const files = expected.files as FixtureFileExpected[];
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.label).sort()).toEqual(['main', 'overlap']);

    const dup = expected.duplicatesAcrossFiles as {
      uniqueRecords: number;
      crossFileDuplicates: number;
      overlapDuplicateBodies: string[];
    };
    expect(expected.uniqueRecords).toBe(6);
    expect(dup.uniqueRecords).toBe(6);
    expect(dup.crossFileDuplicates).toBe(2);

    const main = files.find((f) => f.label === 'main')!;
    const overlap = files.find((f) => f.label === 'overlap')!;
    expect(main.xml).toBe(xml); // primary xml is file A
    // the two overlapping records appear verbatim in BOTH files
    for (const needle of dup.overlapDuplicateBodies) {
      expect(main.xml).toContain(needle);
      expect(overlap.xml).toContain(needle);
    }
    // total records across both files = uniques + duplicate copies
    expect(main.totalRecords + overlap.totalRecords).toBe(dup.uniqueRecords + dup.crossFileDuplicates);
  });
});

describe('oversized base64 part', () => {
  it('really produces a >= 5 MB single attribute (generated, not hardcoded)', () => {
    const { xml, expected } = buildFixture(SCENARIOS.oversizedPart);
    const dataLens = [...xml.matchAll(/ data="([^"]*)"/g)].map((m) => m[1].length);
    expect(dataLens.length).toBeGreaterThan(0);
    const max = Math.max(...dataLens);
    expect(max).toBeGreaterThanOrEqual(FIVE_MB);
    expect(expected.oversizedPartBytes).toBe(max);
  });
});

describe('all six tapback reactions', () => {
  it('flags six reactions with all six normalized kinds', () => {
    const { expected } = buildFixture(SCENARIOS.tapbacks);
    expect(expected.reactionCount).toBe(6);
    const tb = expected.tapbacks as { count: number; kinds: string[] };
    expect(tb.count).toBe(6);
    expect([...tb.kinds].sort()).toEqual(
      [...REACTION_VERBS.map(([, k]) => k)].sort(),
    );
    expect(new Set(tb.kinds).size).toBe(6);
  });
});

describe('MMS addressing', () => {
  it('group MMS carries full <addrs> with 137/151/130 roles', () => {
    const { xml, expected } = buildFixture(SCENARIOS.groupMms);
    expect(xml).toContain('<addrs>');
    expect(xml).toContain('type="137"'); // sender / from
    expect(xml).toContain('type="151"'); // to
    expect(xml).toContain('type="130"'); // cc
    expect(xml).toContain('~'); // ~-joined group envelope address
    expect(expected.mmsCount).toBe(2);
  });

  it('1:1 MMS omits <addrs> entirely (envelope-address fallback)', () => {
    const { xml, expected } = buildFixture(SCENARIOS.oneToOneMms);
    expect(xml).not.toContain('<addrs>');
    expect(xml).not.toContain('<addr ');
    expect(expected.mmsCount).toBe(2);
  });
});

describe('emoji / entity torture', () => {
  it('emits surrogate pairs, a raw numeric entity, nested escaped XML, and a literal "null" body', () => {
    const { xml, expected } = buildFixture(SCENARIOS.emojiTorture);
    const t = expected.emojiTorture as {
      tortureRawXmlBody: string;
      tortureDecoded: string;
      emojiBody: string;
      hasLiteralNullBody: boolean;
    };
    // raw numeric character reference present verbatim (parser will decode to 😂)
    expect(xml).toContain('&#128514;');
    // nested XML is escaped, not literal
    expect(xml).toContain('&lt;task');
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('<task');
    // decoded ground truth has the real un-escaped nested XML + real emoji
    expect(t.tortureDecoded).toContain('<task pri="high">call & text</task>');
    expect(t.tortureDecoded).toContain('\u{1F602}');
    // a surrogate-pair emoji rides literally in the body attribute
    expect(xml).toContain('\u{1F389}');
    expect(t.hasLiteralNullBody).toBe(true);
    // a genuine `body="null"` (word null as text) is present
    expect(xml).toContain('body="null"');
  });
});

describe('draft / outbox / failed types', () => {
  it('plants types 3, 4 and 5', () => {
    const { expected } = buildFixture(SCENARIOS.draftOutboxFailed);
    const d = expected.draftOutboxFailed as { byType: Record<string, number> };
    expect(d.byType['3']).toBe(1);
    expect(d.byType['4']).toBe(1);
    expect(d.byType['5']).toBe(1);
  });
});

describe('same person under two numbers', () => {
  it('records one contact reachable at two distinct in-range addresses', () => {
    const { expected } = buildFixture(SCENARIOS.samePersonTwoNumbers);
    const s = expected.samePersonTwoNumbers as { name: string; addresses: [string, string] };
    expect(s.addresses).toHaveLength(2);
    expect(s.addresses[0]).not.toBe(s.addresses[1]);
    for (const a of s.addresses) expect(inFictionalRange(a)).toBe(true);
    expect(expected.contacts).toBe(1); // one person…
    expect(expected.distinctAddresses).toBe(2); // …two numbers
  });
});

describe('coverage hole', () => {
  it('describes a quiet thread with an abrupt gap and a separate active thread', () => {
    const { expected } = buildFixture(SCENARIOS.coverageHole);
    const h = expected.coverageHole as {
      quietContactIndex: number;
      activeContactIndex: number;
      gapStartMs: number;
      gapEndMs: number;
    };
    expect(h.quietContactIndex).not.toBe(h.activeContactIndex);
    expect(h.gapEndMs).toBeGreaterThan(h.gapStartMs);
    // the planted gap is large (iMessage-shaped silence)
    expect(h.gapEndMs - h.gapStartMs).toBeGreaterThan(100 * 24 * 3600 * 1000);
  });
});

describe('non-English run', () => {
  it('records the planted non-English languages and a code-switch', () => {
    const { expected } = buildFixture(SCENARIOS.nonEnglish);
    const n = expected.nonEnglish as { langs: string[]; codeSwitch: boolean; messageCount: number };
    expect(n.langs).toContain('es');
    expect(n.langs).toContain('fr');
    expect(n.codeSwitch).toBe(true);
    expect(n.messageCount).toBeGreaterThan(0);
  });
});

describe('wrong declared count (T0.5 support)', () => {
  it('the everything scenario declares a count that mismatches the real record total', () => {
    const { expected } = buildFixture(SCENARIOS.everything);
    expect(expected.declaredCount).toBe(expected.totalRecords + 7);
  });
});

describe('writeFixtureXml', () => {
  it('writes the primary xml to disk byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'between-fixtures-'));
    try {
      const path = join(dir, 'sms-fixture.xml');
      writeFixtureXml(SCENARIOS.basic, path);
      const onDisk = readFileSync(path, 'utf8');
      expect(onDisk).toBe(buildFixture(SCENARIOS.basic).xml);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
