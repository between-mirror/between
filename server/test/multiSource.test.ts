// Between — importing more than once, and from more than one source.
//
// Everything here is about the second import. The first one is easy and has been tested since v0.1;
// the second is where an archive quietly becomes two archives. It matters more than it sounds:
// re-importing a newer backup is the most ordinary thing an owner ever does, and it is the entire
// premise of "since you last looked". If the second import forks the world, every per-thread number
// afterwards is computed over a doubled or halved relationship, and nothing looks broken.
//
// Three things have to hold, and each one has a way of failing silently:
//   1. The same person, seen twice, is one contact — not two rows that split their own history.
//   2. The same conversation, seen twice, is one thread.
//   3. The same message, seen twice, is one message — including when the two sightings came from
//      different formats with different timestamp precision.
// And the counterweight, which is what makes (3) hard: two genuinely distinct messages that happen
// to carry the same words in the same minute must stay two. A dedup key aggressive enough to
// converge across sources is one step away from eating a real "ok".
//
// Every fixture is synthetic.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestFile } from '../src/ingest/index';
import { openDb } from '../src/store/db';
import { computeArchiveHealth } from '../src/lenses/archiveHealth';

const root = mkdtempSync(join(tmpdir(), 'between-multi-'));
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

let seq = 0;
let dbPath: string;
beforeEach(() => { dbPath = join(root, `db-${seq++}.db`); });

function write(name: string, content: string): string {
  const p = join(root, `${seq++}-${name}`);
  writeFileSync(p, content);
  return p;
}

/** One <sms> row in SMS Backup & Restore shape. */
function sms(address: string, ms: number, outgoing: boolean, body: string, contactName = 'null'): string {
  return `  <sms protocol="0" address="${address}" date="${ms}" type="${outgoing ? 2 : 1}"`
    + ` subject="null" body="${body}" toa="null" sc_toa="null" service_center="null"`
    + ` read="1" status="-1" locked="0" date_sent="0" sub_id="1"`
    + ` readable_date="—" contact_name="${contactName}" />`;
}

/**
 * One <mms> row whose <addrs> names both sides — the shape the owner heuristic reads.
 *
 * The owner's own number appears as the 137 sender on an outbound message and as a 151 recipient on
 * an inbound one, which is the only place an Android export says who the archive belongs to.
 */
function mms(counterpart: string, owner: string, ms: number, outgoing: boolean, body: string): string {
  const from = outgoing ? owner : counterpart;
  const to = outgoing ? counterpart : owner;
  return `  <mms msg_box="${outgoing ? 2 : 1}" m_type="132" date="${ms}" m_id="MID-${ms}"`
    + ` address="${counterpart}" read="1" contact_name="null">\n`
    + `    <parts><part seq="0" ct="text/plain" text="${body}" /></parts>\n`
    + `    <addrs><addr address="${from}" type="137" /><addr address="${to}" type="151" /></addrs>\n`
    + `  </mms>`;
}

function xml(rows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="${rows.length}">\n${rows.join('\n')}\n</smses>\n`;
}

/** Read helper: one scalar out of the database. */
function one<T = number>(path: string, sql: string): T {
  const db = openDb(path);
  try { return (db.raw.prepare(sql).get() as { n: T }).n; } finally { db.close(); }
}

const T0 = Date.UTC(2021, 4, 10, 9, 0, 0);
const MIN = 60_000;
const ALICE = '+15550100';

describe('the second import', () => {
  it('does not fork one person into two contacts', async () => {
    // Two backups taken a month apart, as a phone actually produces them: the second contains
    // everything the first did, plus what came after. A backup is cumulative; that overlap is the
    // normal case, not an edge case.
    const first = write('backup-1.xml', xml([
      sms(ALICE, T0, false, 'are you up'),
      sms(ALICE, T0 + MIN, true, 'just about'),
    ]));
    const second = write('backup-2.xml', xml([
      sms(ALICE, T0, false, 'are you up'),
      sms(ALICE, T0 + MIN, true, 'just about'),
      sms(ALICE, T0 + 30 * 24 * 60 * MIN, false, 'a month later'),
    ]));

    await ingestFile(first, { dbPath, region: 'US' });
    await ingestFile(second, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM contacts')).toBe(1);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(1);
    // Two from the first backup, one genuinely new in the second. Not five.
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(3);
  });

  it('does not fork one person because two files spell their number differently', async () => {
    // The test above passes for a reason that hides this one: both fixtures write the identical
    // string, and the contact lookup was an exact match on identifiers.raw_value. Cross-format
    // spelling divergence is the NORMAL case — chat.db stores E.164, Android stores whatever was
    // typed — and threading already converges on the normalized key, so the thread merged while the
    // contacts did not. A 1:1 conversation then renders as "Alice, Alice", the contact list splits
    // one person's history in half, and marking them a partner (or as someone who died) labels only
    // one of the two rows while every lens keyed on those fields sees the other as unknown.
    // A number long enough to have an E.164 form at all — the short fixture numbers used elsewhere
    // in this file normalize to null, which is precisely why raw-only matching looked fine here.
    const first = write('spelled-1.xml', xml([sms('+15555550100', T0, false, 'are you up')]));
    const second = write('spelled-2.xml', xml([
      sms('(555) 555-0100', T0 + MIN, true, 'just about'),
    ]));

    await ingestFile(first, { dbPath, region: 'US' });
    await ingestFile(second, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM contacts')).toBe(1);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(1);
    expect(one(dbPath,
      "SELECT COUNT(*) AS n FROM thread_participants WHERE role != 'owner'")).toBe(1);
  });

  it('does not merge two strangers because neither export names anybody', async () => {
    // The generic format accepts a file that carries only timestamp, direction and body — no sender
    // column at all. Every such row fell back to the literal strings 'owner' and 'other', so two
    // unrelated people's exports landed in ONE thread, split by DIRECTION rather than by person:
    // both halves of both conversations mixed together, and every metric, era and episode for that
    // "relationship" computed across two strangers. The previous release aborted loudly here on a
    // UNIQUE violation; removing that accidental guard without adding a real one turned a refusal
    // into silent contamination.
    const line = (ts: string, dir: string, body: string): string =>
      JSON.stringify({ timestamp: ts, direction: dir, body });
    const alice = write('alice.jsonl', [
      line('2021-05-10T09:00:00Z', 'in', 'first person, inbound'),
      line('2021-05-10T09:01:00Z', 'out', 'first person, outbound'),
    ].join('\n'));
    const bob = write('bob.jsonl', [
      line('2021-06-10T09:00:00Z', 'in', 'second person, inbound'),
      line('2021-06-10T09:01:00Z', 'out', 'second person, outbound'),
    ].join('\n'));

    await ingestFile(alice, { dbPath, region: 'US' });
    await ingestFile(bob, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(4);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(2);
    // And each conversation keeps both of its own directions, rather than being cut in half.
    const db = openDb(dbPath);
    try {
      const rows = db.raw.prepare(
        `SELECT thread_id AS t, COUNT(DISTINCT direction) AS dirs, COUNT(*) AS n
           FROM messages GROUP BY thread_id ORDER BY thread_id`,
      ).all() as { t: number; dirs: number; n: number }[];
      expect(rows).toHaveLength(2);
      for (const r of rows) { expect(r.n).toBe(2); expect(r.dirs).toBe(2); }
    } finally { db.close(); }
  });

  describe('when only one of the two files is big enough to reveal the owner', () => {
    // The owner is found by co-occurrence: they are the one person who appears with everybody. That
    // is a fact about a WHOLE archive, but it was recomputed per FILE, and a file holding a single
    // conversation cannot show it — the owner has one neighbour there, so no unique maximum exists
    // and detection returns nothing. The owner then falls in among the counterparties, the thread is
    // keyed on TWO participants instead of one, and the same conversation gets a different signature
    // depending on which file it arrived in: one real thread becomes two, the spare one flagged as a
    // group chat that never existed, with the messages counted in both.
    //
    // The triggering flow is the ordinary one: import a single conversation to try the tool, then
    // import the whole backup. Or the reverse. Both are tested, because a fix that only works in one
    // order is a fix that depends on the user having done things in the lucky sequence.
    const OWNER = '+15555550999';
    const BOB = '+15555550111';
    const full = (): string => xml([
      mms(ALICE, OWNER, T0, false, 'dinner at seven'),
      mms(BOB, OWNER, T0 + MIN, false, 'from someone else'),
    ]);
    const justAlice = (): string => xml([mms(ALICE, OWNER, T0, false, 'dinner at seven')]);

    const expectTwoCleanThreads = (): void => {
      expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(2);
      expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(2);
      expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads WHERE is_group = 1')).toBe(0);
      expect(one(dbPath,
        "SELECT COUNT(*) AS n FROM messages WHERE body_text = 'dinner at seven'")).toBe(1);
    };

    it('does not fork the thread when the partial file comes second', async () => {
      await ingestFile(write('full.xml', full()), { dbPath, region: 'US' });
      await ingestFile(write('partial.xml', justAlice()), { dbPath, region: 'US' });
      expectTwoCleanThreads();
    });

    it('does not fork the thread when the partial file comes first', async () => {
      await ingestFile(write('partial.xml', justAlice()), { dbPath, region: 'US' });
      await ingestFile(write('full.xml', full()), { dbPath, region: 'US' });
      expectTwoCleanThreads();
    });
  });

  it('does not fork a second handset when only its full backup reveals its owner', async () => {
    // The archive may already know the owner's old number while a second handset uses another one.
    // A one-conversation partial from that handset cannot identify its owner; its full backup can.
    // Thread identity must not change with that later evidence, in either import order.
    const OWNER_A = '+15555550999';
    const OWNER_B = '+15555550888';
    const BOB = '+15555550111';
    const establish = (): string => xml([
      mms(ALICE, OWNER_A, T0, false, 'from the first handset'),
      mms(BOB, OWNER_A, T0 + MIN, false, 'also the first handset'),
    ]);
    const shared = mms(ALICE, OWNER_B, T0 + 2 * MIN, false, 'same second-handset message');
    const partial = (): string => xml([shared]);
    const full = (): string => xml([
      shared,
      mms('+15555550222', OWNER_B, T0 + 3 * MIN, false, 'reveals the second owner'),
    ]);

    for (const [label, files] of [
      ['partial-first', [partial(), full()]],
      ['full-first', [full(), partial()]],
    ] as const) {
      const path = join(root, `second-handset-${label}-${seq++}.db`);
      await ingestFile(write(`${label}-establish.xml`, establish()), { dbPath: path, region: 'US' });
      await ingestFile(write(`${label}-one.xml`, files[0]), { dbPath: path, region: 'US' });
      await ingestFile(write(`${label}-two.xml`, files[1]), { dbPath: path, region: 'US' });

      expect(one(path, "SELECT COUNT(*) AS n FROM messages WHERE body_text = 'same second-handset message'"),
        `${label}: the overlapping message must converge`).toBe(1);
      expect(one(path, 'SELECT COUNT(*) AS n FROM messages'), `${label}: no doubled row`).toBe(4);
      expect(one(path, 'SELECT COUNT(*) AS n FROM threads WHERE is_group = 1'),
        `${label}: no phantom group`).toBe(0);
    }
  });

  it('keeps partial and full Android backups stable with the real owner placeholder', async () => {
    // Android's MMS provider commonly writes `insert-address-token` in the owner's addr slot rather
    // than the phone number. The sole incoming recipient rule must treat that role as direct owner
    // evidence too; otherwise a one-conversation partial and a fuller backup disagree about the
    // participant set and the overlap is filed twice. Both orders matter because cumulative backups
    // are imported whichever one the owner happens to find first.
    const TOKEN = 'insert-address-token';
    const BOB = '+15555550111';
    const shared = mms(ALICE, TOKEN, T0, false, 'same placeholder message');
    const partial = (): string => xml([shared]);
    const full = (): string => xml([
      shared,
      mms(BOB, TOKEN, T0 + MIN, false, 'a second conversation reveals the same owner'),
    ]);

    for (const [label, files] of [
      ['partial-first', [partial(), full()]],
      ['full-first', [full(), partial()]],
    ] as const) {
      const path = join(root, `placeholder-${label}-${seq++}.db`);
      await ingestFile(write(`placeholder-${label}-one.xml`, files[0]), { dbPath: path, region: 'US' });
      await ingestFile(write(`placeholder-${label}-two.xml`, files[1]), { dbPath: path, region: 'US' });

      expect(one(path, "SELECT COUNT(*) AS n FROM messages WHERE body_text = 'same placeholder message'"),
        `${label}: the overlapping message must converge`).toBe(1);
      expect(one(path, 'SELECT COUNT(*) AS n FROM messages'), `${label}: no doubled row`).toBe(2);
      expect(one(path, 'SELECT COUNT(*) AS n FROM threads'), `${label}: one thread per counterpart`).toBe(2);
      expect(one(path, 'SELECT COUNT(*) AS n FROM threads WHERE is_group = 1'),
        `${label}: no phantom group`).toBe(0);
    }
  });

  it('files one ordinary export as one conversation, not an SMS thread plus a phantom group', async () => {
    // The most ordinary file there is: one conversation, some texts and some photos. The owner's own
    // number appears in MMS <addrs> and never in an <sms> row, so the two kinds of row produced two
    // different participant sets — and with only one counterparty, co-occurrence owner detection has
    // nothing to work with. One file, one conversation, two threads, the second flagged as a group
    // chat that does not exist, with the relationship's messages split across both.
    //
    // The file says who the owner is: an OUTGOING message's `from` address is the sender, and the
    // sender of an outgoing message is the archive owner.
    const OWNER = '+15555550999';
    const p = write('ordinary.xml', xml([
      sms(ALICE, T0, false, 'are you up'),
      sms(ALICE, T0 + MIN, true, 'just about'),
      mms(ALICE, OWNER, T0 + 2 * MIN, true, 'here is the photo'),
    ]));

    await ingestFile(p, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(1);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads WHERE is_group = 1')).toBe(0);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(3);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM contacts WHERE is_owner = 1')).toBe(1);
  });

  it('never lets a second person become a second owner', async () => {
    // is_owner was set by whichever contact THIS file's heuristic picked, with no uniqueness check
    // and no way back. Two exports whose owner resolves differently — a backup from a second phone,
    // or one file where the heuristic simply picks wrong — leave TWO contacts flagged. Every later
    // import then excludes both from the thread key, so a 1:1 conversation between two flagged
    // people has an EMPTY participant set, and participantSignature([]) is one constant value:
    // sha256(''). Two strangers' private conversations converge on it. An archive has one owner.
    const OWNER_A = '+15555550999';
    const OWNER_B = '+15555550888';
    const CARL = '+15555550222';
    const first = write('phone-a.xml', xml([
      mms(ALICE, OWNER_A, T0, false, 'from the first phone'),
      mms('+15555550111', OWNER_A, T0 + MIN, false, 'also the first phone'),
    ]));
    const second = write('phone-b.xml', xml([
      mms(CARL, OWNER_B, T0 + 2 * MIN, false, 'a different phone entirely'),
      mms('+15555550333', OWNER_B, T0 + 3 * MIN, false, 'still the other phone'),
    ]));

    await ingestFile(first, { dbPath, region: 'US' });
    await ingestFile(second, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM contacts WHERE is_owner = 1')).toBe(1);
    // Four separate conversations, and nothing collapsed onto the empty-participant signature.
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(4);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(4);
  });

  it('does not merge strangers in an archive that already has two owners on file', async () => {
    // Enforcing one owner on new writes does not help an archive that already has two: an earlier
    // release flagged whoever each file's heuristic picked, and is_owner is never set back to 0
    // anywhere. Reading BOTH as the owner drops both from every thread key, and a 1:1 conversation
    // between two dropped people has an empty participant set — one constant signature that every
    // such thread lands on. Two strangers' private conversations, one thread.
    const OWNER_A = '+15555550999';
    const OWNER_B = '+15555550888';
    await ingestFile(write('a.xml', xml([
      mms(ALICE, OWNER_A, T0, false, 'from A'),
      mms('+15555550111', OWNER_A, T0 + MIN, false, 'also A'),
    ])), { dbPath, region: 'US' });

    // Reach in and create the state an older release could leave behind.
    const seed = openDb(dbPath);
    try {
      const id = Number(seed.raw.prepare(
        "INSERT INTO contacts (display_name, primary_e164, is_owner) VALUES (NULL, ?, 1)",
      ).run(OWNER_B).lastInsertRowid);
      seed.raw.prepare(
        `INSERT INTO identifiers (contact_id, raw_value, normalized_e164, kind)
         VALUES (?, ?, ?, 'mobile')`).run(id, OWNER_B, OWNER_B);
      expect((seed.raw.prepare('SELECT COUNT(*) AS n FROM contacts WHERE is_owner = 1')
        .get() as { n: number }).n).toBe(2);
    } finally { seed.close(); }

    await ingestFile(write('b.xml', xml([
      sms(OWNER_A, T0 + 2 * MIN, false, 'note from A'),
      sms(OWNER_B, T0 + 3 * MIN, false, 'note from B'),
    ])), { dbPath, region: 'US' });

    const db = openDb(dbPath);
    try {
      const mixed = db.raw.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT thread_id FROM messages
           WHERE body_text IN ('note from A', 'note from B')
           GROUP BY thread_id HAVING COUNT(DISTINCT body_text) > 1)`).get() as { n: number };
      expect(mixed.n, 'two different people must not share a thread').toBe(0);
    } finally { db.close(); }
  });

  it('records who the owner is where the rest of the product looks for it', async () => {
    // archiveHealth reads app_meta.owner_contact_id to exclude the owner from "other conversations
    // that share a participant with this one". Only the onboarding endpoint ever wrote it, so an
    // archive built by the CLI had no owner recorded: the group-contamination warning then fired on
    // every conversation of every multi-conversation archive — on the one surface whose job is to
    // say whether the others can be trusted.
    await ingestFile(write('own.xml', xml([
      mms(ALICE, '+15555550999', T0, false, 'one'),
      mms('+15555550111', '+15555550999', T0 + MIN, false, 'two'),
    ])), { dbPath, region: 'US' });

    const db = openDb(dbPath);
    try {
      const owner = db.getMeta('owner_contact_id');
      expect(owner).not.toBeNull();
      const row = db.raw.prepare('SELECT is_owner FROM contacts WHERE id = ?')
        .get(Number(owner)) as { is_owner: number } | undefined;
      expect(row?.is_owner).toBe(1);
    } finally { db.close(); }
  });

  it('survives a second backup whose contacts were seen in a different order', async () => {
    // The temp-ids identity resolution hands out are first-encounter order WITHIN a file, so the
    // same two people can be numbered differently by two backups of the same phone. Anything that
    // keys a thread on those numbers is keyed on the order the file happened to be written in.
    const BOB = '+15550111';
    const first = write('order-1.xml', xml([
      sms(ALICE, T0, false, 'alice first'),
      sms(BOB, T0 + MIN, false, 'bob second'),
    ]));
    const second = write('order-2.xml', xml([
      sms(BOB, T0 + 2 * MIN, false, 'bob first this time'),
      sms(ALICE, T0 + 3 * MIN, false, 'alice second'),
    ]));

    await ingestFile(first, { dbPath, region: 'US' });
    await ingestFile(second, { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM contacts')).toBe(2);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(2);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(4);
  });
});

describe('the same conversation from two formats', () => {
  it('converges when both sources name the same counterpart', async () => {
    // The generic importer carrying the same E.164 as the Android backup: a contributor exporting
    // the same thread from somewhere else. Same person, same words, same minute — one archive.
    const androidFile = write('mixed.xml', xml([
      sms(ALICE, T0, false, 'did you eat'),
      sms(ALICE, T0 + MIN, true, 'not yet'),
    ]));
    // WhatsApp-style minute precision: the seconds are simply not in the export.
    const genericFile = write('mixed.jsonl', [
      JSON.stringify({ v: 1, timestamp: new Date(T0).toISOString(), sender: ALICE, direction: 'in', body: 'did you eat' }),
      JSON.stringify({ v: 1, timestamp: new Date(T0 + MIN).toISOString(), sender: ALICE, direction: 'out', body: 'not yet' }),
      JSON.stringify({ v: 1, timestamp: new Date(T0 + 2 * MIN).toISOString(), sender: ALICE, direction: 'in', body: 'only this one is new' }),
    ].join('\n'));

    await ingestFile(androidFile, { dbPath, region: 'US' });
    await ingestFile(genericFile, { dbPath, region: 'US', ownerName: ALICE });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(1);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(3);
  });

  it('keeps three photos sent in the same second', async () => {
    // The regression this test exists for. Android MMS dates arrive at SECOND precision, so a burst
    // of photos shares an exact timestamp — and they all share an empty body, because a photo has no
    // words. Ranking occurrences by timestamp gave all three one key and one surviving row: two
    // photos silently gone, counted in archive health as "duplicates collapsed at import". v0.4.1
    // kept them, because its MMS key was the m_id. The spec named that tiebreak; the canonical key
    // had dropped it.
    const ms = T0;
    const mms = (mId: string, name: string): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null" sub="null"`
      + ` read_status="null" address="${ALICE}" m_id="${mId}" read="1" m_size="100" m_type="128"`
      + ` sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1" text_only="0">\n`
      + `   <parts>\n`
      + `    <part seq="0" ct="image/jpeg" name="${name}" chset="null" cd="null" fn="null" cid="&lt;0&gt;"`
      + ` cl="${name}" ctt_s="null" ctt_t="null" text="null" data="/9j/4AAQSkZJRg==" />\n`
      + `   </parts>\n  </mms>`;
    const p = write('burst.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="3">\n`
      + [mms('MID-A', 'a.jpg'), mms('MID-B', 'b.jpg'), mms('MID-C', 'c.jpg')].join('\n')
      + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'three photos, three rows').toBe(3);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM attachments')).toBe(3);
  });

  it('keeps three photos sent in the same second when the export omits m_id', async () => {
    // The fix above only worked when the export supplied an m_id. It is an optional attribute, and
    // SMS Backup & Restore writes the literal string "null" when it has none — which normalize
    // coerces to null. With no native id anywhere in the bucket the ranking falls back to the exact
    // timestamp, and the burst collapses again: same data loss, same false "duplicates collapsed"
    // label, just a different export. What distinguishes these rows is what is IN them.
    const ms = T0;
    const mms = (name: string): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null" sub="null"`
      + ` read_status="null" address="${ALICE}" m_id="null" read="1" m_size="100" m_type="128"`
      + ` sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1" text_only="0">\n`
      + `   <parts>\n`
      + `    <part seq="0" ct="image/jpeg" name="${name}" chset="null" cd="null" fn="null" cid="&lt;0&gt;"`
      + ` cl="${name}" ctt_s="null" ctt_t="null" text="null" data="/9j/4AAQSkZJRg==" />\n`
      + `   </parts>\n  </mms>`;
    const p = write('burst-no-mid.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="3">\n`
      + [mms('a.jpg'), mms('b.jpg'), mms('c.jpg')].join('\n') + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'three photos, three rows').toBe(3);
  });

  it('keeps the same photo sent twice a few seconds apart', async () => {
    // The counterweight the first attempt at this got wrong. Content is not identity: two sends of
    // the SAME picture are two messages. Using the attachment manifest as the record's native id
    // merged them across different timestamps — the very loss it was added to prevent, over a wider
    // population than the case it fixed. Content now only separates rows sharing one exact instant.
    const row = (ms: number): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null"`
      + ` sub="null" read_status="null" address="${ALICE}" m_id="null" read="1" m_size="100"`
      + ` m_type="128" sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1"`
      + ` text_only="0">\n   <parts>\n    <part seq="0" ct="image/jpeg" name="x.jpg" chset="null"`
      + ` cd="null" fn="null" cid="&lt;0&gt;" cl="x.jpg" ctt_s="null" ctt_t="null" text="null"`
      + ` data="/9j/4AAQ==" />\n   </parts>\n  </mms>`;
    const p = write('resent.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="2">\n`
      + [row(T0), row(T0 + 20_000)].join('\n') + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'sent twice, kept twice').toBe(2);
  });

  it('keeps two text MMS whose only attachment is the layout part', async () => {
    // An MMS carries a seq="-1" application/smil layout part, so every text-only MMS in an archive
    // has the identical attachment manifest. Treating that manifest as identity collapsed ordinary
    // conversation: saying "ok" twice inside one minute became one message.
    const row = (ms: number, body: string): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null"`
      + ` sub="null" read_status="null" address="${ALICE}" m_id="null" read="1" m_size="100"`
      + ` m_type="128" sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1"`
      + ` text_only="1">\n   <parts>\n`
      + `    <part seq="-1" ct="application/smil" name="smil.xml" cl="smil.xml" text="null" />\n`
      + `    <part seq="0" ct="text/plain" name="null" cl="null" text="${body}" />\n`
      + `   </parts>\n  </mms>`;
    const p = write('two-oks.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="2">\n`
      + [row(T0, 'ok'), row(T0 + 20_000, 'ok')].join('\n') + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'two oks, two rows').toBe(2);
  });

  it('collapses a same-instant burst listed twice, in either order', async () => {
    // The counterweight above only covered a burst of ONE photo, where the two copies are adjacent
    // whatever the sort does. With three, a file holding the same backup twice lists them
    // a,b,c,a,b,c — and the scan that assigns occurrences compares each row only with the one
    // before it, so no two equal rows were adjacent, all six got their own key, and the archive
    // stored the burst twice. The same records must give the same answer in any order.
    const ms = T0;
    const photo = (name: string): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null"`
      + ` sub="null" read_status="null" address="${ALICE}" m_id="null" read="1" m_size="100"`
      + ` m_type="128" sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1"`
      + ` text_only="0">\n   <parts>\n    <part seq="0" ct="image/jpeg" name="${name}" chset="null"`
      + ` cd="null" fn="null" cid="&lt;0&gt;" cl="${name}" ctt_s="null" ctt_t="null" text="null"`
      + ` data="/9j/4AAQ==" />\n   </parts>\n  </mms>`;
    const burst = [photo('a.jpg'), photo('b.jpg'), photo('c.jpg')];

    const interleaved = write('burst-twice.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="6">\n`
      + [...burst, ...burst].join('\n') + `\n</smses>\n`);
    await ingestFile(interleaved, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'three photos, listed twice').toBe(3);

    // And the same multiset in the other arrangement must give the same answer.
    const other = join(root, `paired-${seq++}.db`);
    const paired = write('burst-paired.xml',
      `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="6">\n`
      + [burst[0], burst[0], burst[1], burst[1], burst[2], burst[2]].join('\n') + `\n</smses>\n`);
    await ingestFile(paired, { dbPath: other, region: 'US' });
    expect(one(other, 'SELECT COUNT(*) AS n FROM messages'), 'order must not change the count').toBe(3);
  });

  it('keeps two people\'s notes-to-self apart', async () => {
    // A conversation with no counterpart — a text to your own number — has an EMPTY participant set,
    // and an empty key list hashes to one constant. That constant has been the merge point for three
    // separate defects in this release: two flagged owners, an ORed owner rule, and a file whose
    // owner the archive has not met. Each fix moved which contacts fall out of the key; none stopped
    // an empty result from meaning "the same conversation as every other empty result". Two people's
    // private notes to self landed in one thread, and where they shared a minute and a body, one of
    // the two messages was dropped as a duplicate and counted to the owner as one.
    const OWNER_A = '+15555550999';
    const OWNER_B = '+15555550888';
    await ingestFile(write('self-a.xml', xml([
      mms(ALICE, OWNER_A, T0, false, 'from the first phone'),
      mms('+15555550111', OWNER_A, T0 + MIN, false, 'also the first phone'),
      sms(OWNER_A, T0 + 2 * MIN, true, 'ok'),
    ])), { dbPath, region: 'US' });

    await ingestFile(write('self-b.xml', xml([
      mms('+15555550222', OWNER_B, T0 + 3 * MIN, false, 'from the second phone'),
      mms('+15555550333', OWNER_B, T0 + 4 * MIN, false, 'also the second phone'),
      sms(OWNER_B, T0 + 2 * MIN, true, 'ok'),
    ])), { dbPath, region: 'US' });

    // Both notes to self survive — the loss direction — and they are not in one thread.
    expect(one(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE body_text = 'ok'"),
      'neither note to self may be eaten as the other\'s duplicate').toBe(2);
    const db = openDb(dbPath);
    try {
      const shared = db.raw.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT thread_id FROM messages WHERE body_text = 'ok' GROUP BY thread_id)`)
        .get() as { n: number };
      expect(shared.n, 'two separate notes-to-self, two threads').toBe(2);
    } finally { db.close(); }
  });

  it('keeps the self-thread namespace separate from ordinary participant identifiers', async () => {
    // `self:` marks an owner-only thread, but a generic import may legitimately carry an arbitrary
    // sender string beginning with those same bytes. If both values enter the participant signature
    // unchanged, a stranger's conversation becomes the owner's note-to-self thread. Matching rows
    // then share a dedup key too, so one of two real messages disappears.
    const OWNER = '+15555550999';
    await ingestFile(write('owner.xml', xml([
      mms(ALICE, OWNER, T0, false, 'from the phone'),
      mms('+15555550111', OWNER, T0 + MIN, false, 'also from the phone'),
      sms(OWNER, T0 + 2 * MIN, true, 'ok'),
    ])), { dbPath, region: 'US' });

    const generic = write('prefixed-sender.jsonl', [
      JSON.stringify({
        timestamp: new Date(T0 + 2 * MIN).toISOString(),
        sender: `self:${OWNER}`,
        direction: 'out',
        body: 'ok',
      }),
      JSON.stringify({
        timestamp: new Date(T0 + 3 * MIN).toISOString(),
        sender: `self:${OWNER}`,
        direction: 'in',
        body: 'from a different conversation',
      }),
    ].join('\n'));
    await ingestFile(generic, { dbPath, region: 'US' });

    expect(one(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE body_text = 'ok'"),
      'the ordinary participant\'s row must not be eaten by an owner-only row').toBe(2);
    const db = openDb(dbPath);
    try {
      const merged = db.raw.prepare(`
        SELECT COUNT(*) AS n FROM (
          SELECT thread_id FROM messages GROUP BY thread_id
           HAVING SUM(CASE WHEN source_kind = 'android_smsbackup' AND body_text = 'ok' THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN source_kind = 'generic_jsonl'
                            AND body_text = 'from a different conversation' THEN 1 ELSE 0 END) > 0)`).get() as { n: number };
      expect(merged.n, 'an ordinary participant must not share the owner-only thread').toBe(0);
    } finally { db.close(); }
  });

  it('does not fork a backup whose owner the archive has never seen', async () => {
    // The other direction of the owner rule, and the one over-correcting for the first broke. Once
    // the archive knows an owner, a file was made to IGNORE its own detection entirely — so a backup
    // from a second phone, or from before a number change, had its real owner filed as an ordinary
    // participant. Every 1:1 conversation in it became a group thread and its messages were stored
    // a second time. The archive's owner wins where they appear; where they do not, this file's own
    // evidence is the best there is.
    const OWNER_A = '+15555550999';
    const OWNER_B = '+15555550888';
    await ingestFile(write('first-phone.xml', xml([
      mms(ALICE, OWNER_A, T0, false, 'from the first phone'),
      mms('+15555550111', OWNER_A, T0 + MIN, false, 'also the first phone'),
    ])), { dbPath, region: 'US' });

    // A different handset entirely: its owner key appears nowhere in the archive so far.
    await ingestFile(write('second-phone.xml', xml([
      mms('+15555550222', OWNER_B, T0 + 2 * MIN, false, 'from the second phone'),
      mms('+15555550333', OWNER_B, T0 + 3 * MIN, false, 'also the second phone'),
    ])), { dbPath, region: 'US' });

    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads')).toBe(4);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM threads WHERE is_group = 1'),
      'no 1:1 conversation may be filed as a group').toBe(0);
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(4);
  });

  it('still collapses one m_id-less burst seen twice', async () => {
    // The counterweight for the case above: with no source id, identical rows must still converge,
    // or a doubled file doubles the archive.
    const ms = T0;
    const row = `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null"`
      + ` sub="null" read_status="null" address="${ALICE}" m_id="null" read="1" m_size="100"`
      + ` m_type="128" sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1"`
      + ` text_only="0">\n   <parts>\n    <part seq="0" ct="image/jpeg" name="x.jpg" chset="null"`
      + ` cd="null" fn="null" cid="&lt;0&gt;" cl="x.jpg" ctt_s="null" ctt_t="null" text="null"`
      + ` data="/9j/4AAQ==" />\n   </parts>\n  </mms>`;
    const p = write('burst-no-mid-doubled.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="2">\n`
      + [row, row].join('\n') + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'one photo, seen twice').toBe(1);
  });

  it('still collapses the same photo seen twice', async () => {
    // The counterweight: two backups of the same burst must not double it. Same m_ids, so the same
    // records — which is what the native id is for.
    const ms = T0;
    const mms = (mId: string): string =>
      `  <mms date="${ms}" ct_t="application/vnd.wap.multipart.related" msg_box="2" rr="null" sub="null"`
      + ` read_status="null" address="${ALICE}" m_id="${mId}" read="1" m_size="100" m_type="128"`
      + ` sub_id="1" date_sent="0" readable_date="—" contact_name="null" seen="1" text_only="0">\n`
      + `   <parts>\n    <part seq="0" ct="image/jpeg" name="x.jpg" chset="null" cd="null" fn="null"`
      + ` cid="&lt;0&gt;" cl="x.jpg" ctt_s="null" ctt_t="null" text="null" data="/9j/4AAQ==" />\n`
      + `   </parts>\n  </mms>`;
    const rows = [mms('MID-A'), mms('MID-B')];
    const p = write('burst-doubled.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="4">\n`
      + [...rows, ...rows].join('\n') + `\n</smses>\n`);

    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages'), 'two distinct photos, seen twice').toBe(2);
  });

  it('keeps two real messages that share a minute and a word', async () => {
    // The counterweight. Saying "ok" twice inside one minute is not a duplicate, and a key built
    // from counterpart + minute + body alone cannot tell the difference. If this ever passes by
    // merging, the dedup key is eating real messages and no other test would notice.
    const p = write('twice.xml', xml([
      sms(ALICE, T0 + 1_000, false, 'ok'),
      sms(ALICE, T0 + 5_000, false, 'ok'),
    ]));
    await ingestFile(p, { dbPath, region: 'US' });
    expect(one(dbPath, 'SELECT COUNT(*) AS n FROM messages')).toBe(2);
  });
});

describe('source provenance', () => {
  it('records which format every message actually came from', async () => {
    // The archive-health surface exists to say what you are looking at. Before this column existed
    // it reported a hardcoded "Android SMS Backup & Restore XML" for every import, including the
    // ones that were not.
    const androidFile = write('prov.xml', xml([sms(ALICE, T0, false, 'from the phone')]));
    const waFile = write('prov.txt', [
      `[10/05/2021, 09:10:00] Alice: from whatsapp`,
      `[10/05/2021, 09:11:00] Me: and a reply`,
    ].join('\n'));

    await ingestFile(androidFile, { dbPath, region: 'US' });
    await ingestFile(waFile, { dbPath, region: 'US', ownerName: 'Me' });

    const db = openDb(dbPath);
    try {
      const kinds = db.raw.prepare(
        `SELECT kind, COUNT(*) AS n FROM source_files GROUP BY kind ORDER BY kind`,
      ).all() as { kind: string; n: number }[];
      expect(kinds).toEqual([
        { kind: 'android_smsbackup', n: 1 },
        { kind: 'whatsapp_txt', n: 1 },
      ]);

      const msgKinds = db.raw.prepare(
        `SELECT source_kind AS k, COUNT(*) AS n FROM messages GROUP BY k ORDER BY k`,
      ).all() as { k: string; n: number }[];
      expect(msgKinds).toEqual([
        { k: 'android_smsbackup', n: 1 },
        { k: 'whatsapp_txt', n: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it('reports each format with its own span on the health surface', async () => {
    // The surface exists to answer "what am I looking at". It used to answer with a hardcoded
    // string, so an archive with no Android backup in it at all still described itself as one.
    const waFile = write('health.txt', [
      `[10/05/2021, 09:10:00] Alice: only whatsapp here`,
      `[10/05/2021, 09:11:00] Me: none of this is sms`,
    ].join('\n'));
    await ingestFile(waFile, { dbPath, region: 'US', ownerName: 'Me' });

    const db = openDb(dbPath);
    try {
      const thread = db.listThreads()[0];
      const health = computeArchiveHealth(db, thread.id);
      expect(health.source.spans.map((s) => s.kind)).toEqual(['whatsapp_txt']);
      expect(health.source.spans[0].messages).toBe(2);
    } finally {
      db.close();
    }
  });

  it('separates the spans when one thread holds two formats', async () => {
    const androidFile = write('two-a.xml', xml([
      sms(ALICE, T0, false, 'the early years'),
      sms(ALICE, T0 + MIN, true, 'sms only'),
    ]));
    const genericFile = write('two-b.jsonl', [
      JSON.stringify({ v: 1, timestamp: new Date(T0 + 400 * 24 * 60 * MIN).toISOString(), sender: ALICE, direction: 'in', body: 'much later, elsewhere' }),
    ].join('\n'));

    await ingestFile(androidFile, { dbPath, region: 'US' });
    await ingestFile(genericFile, { dbPath, region: 'US', ownerName: ALICE });

    const db = openDb(dbPath);
    try {
      const health = computeArchiveHealth(db, db.listThreads()[0].id);
      expect(health.source.spans.map((s) => s.kind)).toEqual(['android_smsbackup', 'generic_jsonl']);
      expect(health.source.spans.map((s) => s.messages)).toEqual([2, 1]);
      // Each span describes only its own source — the Android one must not claim the later date.
      expect(health.source.spans[0].lastMs).toBe(T0 + MIN);
    } finally {
      db.close();
    }
  });
});
