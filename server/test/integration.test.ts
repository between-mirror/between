// End-to-end ingest (agent ASSEMBLE): FIXTURES generator → temp XML → ingestFile → temp SQLite.
// Exercises the whole §2.3 pipeline: parse → normalize/classify → identity → thread → dedup →
// bulk insert. Synthetic data only (the generator plants 555-01xx numbers, ME/THEM speakers).
//
// Cross-agent contract: FIXTURES exports SCENARIOS (Record<string, FixtureSpec>),
// buildFixture(spec) → { xml, expected } and writeFixtureXml(spec, path). The exact field names
// on `expected` are not fixed by the ASSEMBLE spec, so count comparisons below run only when the
// matching field is present; the hard invariants (dedup convergence, re-import skip, identity
// merge correctness) are asserted directly against the database and always run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFile } from '../src/ingest/index';
import { openDb } from '../src/store/db';
import { SCENARIOS, buildFixture, writeFixtureXml } from './fixtures/gen';
import type { IngestResult } from '../src/types';

interface FixtureExpected {
  smsCount?: number;
  sms?: number;
  mmsCount?: number;
  mms?: number;
  reactionCount?: number;
  reactions?: number;
  contactCount?: number;
  contacts?: number;
}

// Double every record inside a single <smses> root: an archive whose entire contents overlap
// itself. One ingest must collapse the duplicates back to the original distinct message set.
function doubleRecords(xml: string): string {
  const openIdx = xml.indexOf('<smses');
  const headEnd = xml.indexOf('>', openIdx) + 1;
  const closeIdx = xml.lastIndexOf('</smses>');
  const head = xml.slice(0, headEnd);
  const inner = xml.slice(headEnd, closeIdx);
  return `${head}${inner}${inner}</smses>`;
}

const dir = mkdtempSync(join(tmpdir(), 'between-int-'));
const fileA = join(dir, 'basic.xml');
const dbA = join(dir, 'a.db');

function count(dbPath: string, sql: string): number {
  const db = openDb(dbPath);
  try {
    return (db.raw.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const spec = SCENARIOS.basic;
const expected = buildFixture(spec).expected as unknown as FixtureExpected;
const expSms = expected.smsCount ?? expected.sms;
const expMms = expected.mmsCount ?? expected.mms;
const expReactions = expected.reactionCount ?? expected.reactions;
const expContacts = expected.contactCount ?? expected.contacts;

let r1: IngestResult;

beforeAll(async () => {
  writeFixtureXml(spec, fileA);
  r1 = await ingestFile(fileA, { dbPath: dbA, region: 'US' });
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

describe('ingestFile — end to end (SCENARIOS.basic)', () => {
  it('imports the fixture with counts matching the generator ground truth', () => {
    expect(r1.alreadyImported).toBe(false);
    expect(r1.smsCount + r1.mmsCount).toBe(r1.messageRows); // every inserted row is sms xor mms
    expect(r1.messageRows).toBeGreaterThan(0);
    if (expSms !== undefined) expect(r1.smsCount).toBe(expSms);
    if (expMms !== undefined) expect(r1.mmsCount).toBe(expMms);

    // Stored rows agree with the reported counts.
    expect(count(dbA, 'SELECT count(*) n FROM messages')).toBe(r1.messageRows);
    expect(count(dbA, "SELECT count(*) n FROM messages WHERE kind='sms'")).toBe(r1.smsCount);
    expect(count(dbA, "SELECT count(*) n FROM messages WHERE kind='mms'")).toBe(r1.mmsCount);
  });

  it('flags reactions and reports them consistently with the stored rows', () => {
    const flagged = count(dbA, 'SELECT count(*) n FROM messages WHERE is_reaction=1');
    expect(r1.reactionCount).toBe(flagged);
    if (expReactions !== undefined) {
      expect(flagged).toBe(expReactions);
      if (expReactions > 0) expect(flagged).toBeGreaterThan(0);
    }
  });

  it('merges each number to exactly one contact (two formats → one person)', () => {
    // #contacts-carrying-a-number must equal #distinct-normalized-numbers: no number is split
    // across contacts, and no two formats of the same number create two contacts.
    const distinctE164 = count(
      dbA,
      'SELECT count(DISTINCT normalized_e164) n FROM identifiers WHERE normalized_e164 IS NOT NULL',
    );
    const contactsWithE164 = count(dbA, 'SELECT count(*) n FROM contacts WHERE primary_e164 IS NOT NULL');
    expect(contactsWithE164).toBe(distinctE164);

    // No single contact may own two different numbers.
    const splitContacts = count(
      dbA,
      `SELECT count(*) n FROM (
         SELECT contact_id FROM identifiers WHERE normalized_e164 IS NOT NULL
         GROUP BY contact_id HAVING count(DISTINCT normalized_e164) > 1)`,
    );
    expect(splitContacts).toBe(0);

    // At most one owner ever.
    expect(count(dbA, 'SELECT count(*) n FROM contacts WHERE is_owner=1')).toBeLessThanOrEqual(1);
    if (expContacts !== undefined) {
      // The generator's `contacts` ground truth counts distinct NON-OWNER people (touchedContacts,
      // owner never touched). The owner is legitimately persisted as its own contact row
      // (is_owner=1, referenced by the thread_participants owner role), so compare against the
      // non-owner contacts rather than the full table.
      expect(count(dbA, 'SELECT count(*) n FROM contacts WHERE is_owner=0')).toBe(expContacts);
    }
  });

  it('re-importing the identical file is a no-op (T0.9 skip, row counts unchanged)', async () => {
    const before = count(dbA, 'SELECT count(*) n FROM messages');
    const r = await ingestFile(fileA, { dbPath: dbA, region: 'US' });
    expect(r.alreadyImported).toBe(true);
    expect(r.messageRows).toBe(0);
    expect(count(dbA, 'SELECT count(*) n FROM messages')).toBe(before);
  });

  it('converges overlapping/duplicate records via the dedup key', async () => {
    const baselineRows = count(dbA, 'SELECT count(*) n FROM messages');
    const fileB = join(dir, 'doubled.xml');
    const dbB = join(dir, 'b.db');
    writeFileSync(fileB, doubleRecords(readFileSync(fileA, 'utf8')));

    const r = await ingestFile(fileB, { dbPath: dbB, region: 'US' });
    expect(r.alreadyImported).toBe(false);
    // Same logical archive, doubled: dedup collapses it back to the original distinct set.
    expect(count(dbB, 'SELECT count(*) n FROM messages')).toBe(baselineRows);
    expect(r.messageRows).toBe(baselineRows);
  });
});
