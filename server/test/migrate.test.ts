// Between — the forward-only schema migration.
//
// This is the one piece of the program that edits an archive that already exists. Everything else
// either reads, or writes rows of its own; this rewrites keys under years of someone's messages,
// and there is no second copy to fall back on unless it makes one. So the tests are about damage
// rather than about features: what it must not lose, what it must leave behind, and what it must
// still be true of the database afterwards.
//
// The database it migrates FROM is written out literally below rather than generated, because a
// migration test that builds its input with the current code is testing the current code twice.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { openDb } from '../src/store/db';
import { ingestFile } from '../src/ingest/index';

const root = mkdtempSync(join(tmpdir(), 'between-migrate-'));
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

let seq = 0;
let dbPath: string;
beforeEach(() => { dbPath = join(root, `old-${seq++}.db`); });

const ALICE = '+15550100';
const T0 = Date.UTC(2021, 4, 10, 9, 0, 0);
const MIN = 60_000;

/**
 * The schema as it shipped in v0.4.1: no source_files.kind, no messages.source_kind, thread
 * signatures hashed from per-file contact temp-ids, dedup keys hashed from Android-native fields.
 */
function writeLegacyDb(path: string, opts: { bodies?: string[]; spacingMs?: number } = {}): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, display_name TEXT, primary_e164 TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0,
      relationship_type TEXT NOT NULL DEFAULT 'unknown',
      is_deceased INTEGER NOT NULL DEFAULT 0, deceased_since TEXT, notes TEXT);
    CREATE TABLE identifiers (
      id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, raw_value TEXT NOT NULL,
      normalized_e164 TEXT, kind TEXT NOT NULL DEFAULT 'mobile', source_contact_name TEXT,
      first_seen_ms INTEGER, last_seen_ms INTEGER, UNIQUE (raw_value));
    CREATE TABLE threads (
      id INTEGER PRIMARY KEY, participant_signature TEXT NOT NULL UNIQUE,
      is_group INTEGER NOT NULL DEFAULT 0, title TEXT,
      coverage_confidence REAL NOT NULL DEFAULT 1.0, coverage_note TEXT, primary_lang TEXT,
      first_ms INTEGER, last_ms INTEGER, message_count INTEGER);
    CREATE TABLE thread_participants (
      thread_id INTEGER NOT NULL, contact_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', PRIMARY KEY (thread_id, contact_id));
    CREATE TABLE source_files (
      id INTEGER PRIMARY KEY, path TEXT NOT NULL, content_sha256 TEXT NOT NULL UNIQUE,
      imported_at TEXT NOT NULL, record_count INTEGER);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, sender_contact_id INTEGER,
      direction TEXT NOT NULL, kind TEXT NOT NULL, sent_at_ms INTEGER NOT NULL, body_text TEXT,
      is_read INTEGER, is_reaction INTEGER NOT NULL DEFAULT 0, reaction_kind TEXT, lang TEXT,
      raw_type INTEGER, raw_msg_box INTEGER, source_file_id INTEGER NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE);
    CREATE TABLE app_meta ( key TEXT PRIMARY KEY, value TEXT );
  `);

  db.prepare(`INSERT INTO contacts (id, display_name, primary_e164) VALUES (1, 'Alice', ?)`).run(ALICE);
  db.prepare(`INSERT INTO identifiers (contact_id, raw_value, normalized_e164) VALUES (1, ?, ?)`)
    .run(ALICE, ALICE);
  // A signature hashed from the temp-id "1" — the shape that made the second import collide.
  db.prepare(`INSERT INTO threads (id, participant_signature, first_ms, last_ms, message_count)
              VALUES (1, 'legacy-signature-from-tempid-1', ?, ?, ?)`)
    .run(T0, T0 + 2 * MIN, 3);
  db.prepare(`INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (1, 1, 'member')`).run();
  db.prepare(`INSERT INTO source_files (id, path, content_sha256, imported_at, record_count)
              VALUES (1, 'sms-20210510.xml', 'legacy-sha', ?, 3)`).run(new Date(T0).toISOString());

  const bodies = opts.bodies ?? ['are you up', 'just about', 'see you at five'];
  const spacing = opts.spacingMs ?? MIN;
  bodies.forEach((body, i) => {
    db.prepare(`INSERT INTO messages
        (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
         is_reaction, raw_type, source_file_id, dedup_key)
      VALUES (?, 1, ?, ?, 'sms', ?, ?, 0, ?, 1, ?)`)
      .run(i + 1, i % 2 === 0 ? 1 : null, i % 2 === 0 ? 'incoming' : 'outgoing',
        T0 + i * spacing, body, i % 2 === 0 ? 1 : 2, `legacy-key-${i}`);
  });
  db.close();
}

function sms(address: string, ms: number, outgoing: boolean, body: string): string {
  return `  <sms protocol="0" address="${address}" date="${ms}" type="${outgoing ? 2 : 1}"`
    + ` subject="null" body="${body}" toa="null" sc_toa="null" service_center="null"`
    + ` read="1" status="-1" locked="0" date_sent="0" sub_id="1"`
    + ` readable_date="—" contact_name="null" />`;
}

describe('migrating an archive written by the previous release', () => {
  it('adds the provenance columns and fills them from the path each import recorded', () => {
    writeLegacyDb(dbPath);
    const db = openDb(dbPath);
    try {
      const files = db.raw.prepare(`SELECT kind FROM source_files`).all() as { kind: string }[];
      expect(files).toEqual([{ kind: 'android_smsbackup' }]);
      const msgs = db.raw.prepare(
        `SELECT DISTINCT source_kind AS k FROM messages`).all() as { k: string }[];
      expect(msgs).toEqual([{ k: 'android_smsbackup' }]);
    } finally { db.close(); }
  });

  it('indexes the attachment lookup that archive health runs on every message', () => {
    // computeArchiveHealth issues two correlated subqueries against attachments.message_id for each
    // message in a thread, and that column had no index — so each one scanned the whole attachments
    // table. It used to be reachable only by deliberately opening the Archive health tab; this
    // release puts it on Home and on every reading opened, where a multi-year archive turns the
    // default view of a conversation into tens of seconds of a frozen app. better-sqlite3 is
    // synchronous, so nothing else is served while it runs.
    writeLegacyDb(dbPath);
    const db = openDb(dbPath);
    try {
      const idx = db.raw.prepare(`PRAGMA index_list(attachments)`).all() as { name: string }[];
      const covering = idx.some((i) => {
        const cols = db.raw.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`)
          .all() as { name: string }[];
        return cols[0]?.name === 'message_id';
      });
      expect(covering, 'attachments(message_id) must be indexed').toBe(true);
    } finally { db.close(); }
  });

  it('loses nothing: every row that went in comes back out', () => {
    writeLegacyDb(dbPath);
    const db = openDb(dbPath);
    try {
      const rows = db.raw.prepare(
        `SELECT id, body_text AS body FROM messages ORDER BY id`).all() as { id: number; body: string }[];
      expect(rows).toEqual([
        { id: 1, body: 'are you up' },
        { id: 2, body: 'just about' },
        { id: 3, body: 'see you at five' },
      ]);
      // Ids are what every frozen reading's receipts point at. If a migration renumbered them, the
      // evidence under an existing reading would quietly start citing different messages.
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it('keeps three same-minute repeats apart when it recomputes their keys', () => {
    // The recompute assigns occurrence indices over rows that already exist separately. If it ever
    // collapsed them, a UNIQUE violation would abort — or worse, rows would be silently lost.
    // Two seconds apart, so all three land in one minute bucket and the occurrence index is the
    // only thing keeping them distinct. Spaced a minute apart this would pass without testing it.
    writeLegacyDb(dbPath, { bodies: ['ok', 'ok', 'ok'], spacingMs: 2_000 });
    const db = openDb(dbPath);
    try {
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 3 });
      expect(db.raw.prepare(`SELECT COUNT(DISTINCT dedup_key) AS n FROM messages`).get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });

  it('opens an archive whose rows canonicalize together, instead of bricking it', () => {
    // The defect this test exists for. Two rows sharing counterpart, direction, exact timestamp and
    // body — two photos sent in the same second, which v0.4.1 kept apart by m_id — canonicalized to
    // one key, tripped messages.dedup_key UNIQUE, and threw out of openDb. openDb is the ONLY door
    // into the store, so the archive became unopenable by the server and every CLI, permanently,
    // with no repair path. The file's own comment asserted this could not happen.
    writeLegacyDb(dbPath, { bodies: ['', ''], spacingMs: 0 });
    const db = openDb(dbPath);
    try {
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 2 });
      expect(db.raw.prepare(`SELECT COUNT(DISTINCT dedup_key) AS n FROM messages`).get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  it('opens an archive already forked onto two threads for one person', () => {
    // identifiers.raw_value is UNIQUE but normalized_e164 is not, so the same number written two
    // ways became two contacts that collapse back onto ONE participant key — colliding on
    // threads.participant_signature. That is exactly the forked archive this migration exists to
    // help; it must not be the archive it destroys.
    writeLegacyDb(dbPath);
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO contacts (id, display_name, primary_e164) VALUES (2, 'Alice', ?)`).run(ALICE);
    raw.prepare(`INSERT INTO identifiers (contact_id, raw_value, normalized_e164) VALUES (2, '(555) 010-0100', ?)`).run(ALICE);
    raw.prepare(`INSERT INTO threads (id, participant_signature, first_ms, last_ms, message_count)
                 VALUES (2, 'legacy-signature-from-tempid-2', ?, ?, 0)`).run(T0, T0);
    raw.prepare(`INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (2, 2, 'member')`).run();
    raw.close();

    const db = openDb(dbPath);
    try {
      // Both threads survive, still distinct. Merging them would be a guess about whose
      // conversation is whose; aborting would take the archive away.
      expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM threads`).get()).toEqual({ n: 2 });
      expect(db.raw.prepare(`SELECT COUNT(DISTINCT participant_signature) AS n FROM threads`).get()).toEqual({ n: 2 });
    } finally { db.close(); }
  });

  it('writes one backup however many times a migration is attempted', () => {
    // A failing migration used to write a full, unencrypted copy of the whole archive on EVERY open.
    // The natural response to "it will not start" is to relaunch, and a few restarts on a large
    // archive fills the disk with plaintext copies of someone's private messages.
    writeLegacyDb(dbPath);
    openDb(dbPath).close();
    openDb(dbPath).close();
    const copies = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`));
    expect(copies).toHaveLength(1);
  });

  it('records the collision count it says it records', () => {
    // STATUS claims of every rewrite onto a UNIQUE column that "a value that would collide is not
    // written, the row keeps the one it has, and the count is recorded". The keeping was tested;
    // the recording was not, and a clause no test can see is exactly the kind of claim this project
    // keeps writing postmortems about. Two threads that canonicalize to one key: one takes it, the
    // other keeps what it had, and the count says so.
    writeLegacyDb(dbPath);
    const seed = new Database(dbPath);
    try {
      seed.prepare(
        `INSERT INTO threads (id, participant_signature, is_group, first_ms, last_ms, message_count)
         VALUES (2, 'legacy-signature-from-tempid-2', 0, ?, ?, 0)`).run(T0, T0);
      // The same person as thread 1's participant, spelled a second way — raw_value is UNIQUE but
      // normalized_e164 is not, so both threads reduce to the identical participant key.
      seed.prepare(
        `INSERT INTO contacts (id, display_name, primary_e164) VALUES (9, 'Alice', ?)`).run(ALICE);
      seed.prepare(
        `INSERT INTO identifiers (contact_id, raw_value, normalized_e164)
         VALUES (9, '(555) 010-0', ?)`).run(ALICE);
      seed.prepare(
        `INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (2, 9, 'member')`).run();
    } finally { seed.close(); }

    const db = openDb(dbPath);
    try {
      const row = db.raw.prepare(
        `SELECT value FROM app_meta WHERE key = 'migration_v1_collisions'`,
      ).get() as { value: string } | undefined;
      expect(row, 'the collision count is on file').toBeDefined();
      expect(JSON.parse(row!.value).threads).toBeGreaterThan(0);
      // And nothing was lost to it: both threads are still there, still separate.
      const n = db.raw.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
      expect(n.n).toBe(2);
    } finally { db.close(); }
  });

  it('does not accept a file that only has the right name as the safety copy', () => {
    // The "reuse the copy already on disk" branch matched on FILENAME alone. A copy interrupted
    // partway through — force-quitting an app that looks hung during a multi-gigabyte VACUUM — is a
    // truncated non-database wearing exactly that name. The migration would then rewrite every
    // participant_signature and dedup_key in the archive with no usable safety net, and if it did
    // fail, tell the owner "a copy taken before the attempt is at <that file>".
    writeLegacyDb(dbPath);
    const impostor = `${dbPath}.pre-v1-2026-07-22T00-00-00-000Z.db`;
    writeFileSync(impostor, 'not a database at all');
    openDb(dbPath).close();

    const copies = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`));
    expect(copies.length, 'a real copy is taken alongside the impostor').toBe(2);
    const real = copies.map((f) => join(root, f)).filter((f) => f !== impostor)[0];
    const check = new Database(real, { readonly: true });
    try {
      const n = check.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
      expect(n.n).toBeGreaterThan(0);
    } finally { check.close(); }
  });

  it('does not accept a backup of a DIFFERENT archive as this one\'s safety copy', () => {
    // The same branch, without any crash: an owner restores an older archive over the same path.
    // The previous upgrade's copy is still beside it, valid, and holding somebody else's — or an
    // earlier self's — messages. Reusing it means migrating with a safety copy of the wrong archive.
    writeLegacyDb(dbPath);
    const otherPath = join(root, `other-${Date.now()}.db`);
    writeLegacyDb(otherPath);
    const stale = `${dbPath}.pre-v1-2026-07-22T00-00-00-000Z.db`;
    const src = new Database(otherPath);
    try {
      src.prepare("DELETE FROM messages WHERE id > 1").run();   // make it visibly a different archive
      src.prepare('VACUUM INTO ?').run(stale);
    } finally { src.close(); }

    openDb(dbPath).close();
    const copies = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`));
    expect(copies.length, 'the stale copy is not mistaken for this archive').toBe(2);
  });

  it('leaves a timestamped backup behind before touching anything', () => {
    writeLegacyDb(dbPath);
    const db = openDb(dbPath);
    db.close();
    const backups = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`));
    expect(backups).toHaveLength(1);

    // The name has to end in .db. A backup is a complete unencrypted copy of the archive, and every
    // rule that keeps one out of a commit matches on that extension — `.gitignore` has `*.db`, and
    // nothing has a rule for whatever else this file might have been called.
    expect(backups[0].endsWith('.db')).toBe(true);

    // It has to be a real database, not a zero-byte file that only looks like insurance.
    const backup = new Database(join(root, backups[0]), { readonly: true });
    try {
      expect(backup.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 3 });
      // And it is the state from BEFORE: the old keys are still in it.
      const keys = backup.prepare(`SELECT dedup_key AS k FROM messages ORDER BY id`).all() as { k: string }[];
      expect(keys[0].k).toBe('legacy-key-0');
    } finally { backup.close(); }
  });

  it('does not back up, or migrate twice, on an archive already at this version', () => {
    writeLegacyDb(dbPath);
    openDb(dbPath).close();
    const afterFirst = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`)).length;
    openDb(dbPath).close();
    openDb(dbPath).close();
    const afterThird = readdirSync(root).filter((f) => f.startsWith(`${basename(dbPath)}.pre-v`)).length;
    expect(afterThird).toBe(afterFirst);
  });

  it('writes no backup for a database that never held anything', () => {
    const fresh = join(root, `fresh-${seq++}.db`);
    openDb(fresh).close();
    expect(existsSync(`${fresh}.pre-v1`)).toBe(false);
    expect(readdirSync(root).filter((f) => f.startsWith(`${basename(fresh)}.pre-v`))).toHaveLength(0);
  });

  it('lets the next backup import land in the migrated thread instead of a second one', () => {
    // The point of the whole migration. Before it, the legacy signature could not match anything a
    // new import computes, so the archive would fork on the very next backup.
    writeLegacyDb(dbPath);
    openDb(dbPath).close();

    const next = join(root, `next-${seq++}.xml`);
    writeFileSync(next, `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="4">\n`
      + [
        sms(ALICE, T0, false, 'are you up'),
        sms(ALICE, T0 + MIN, true, 'just about'),
        sms(ALICE, T0 + 2 * MIN, false, 'see you at five'),
        sms(ALICE, T0 + 3 * MIN, true, 'new since the last backup'),
      ].join('\n') + `\n</smses>\n`);

    return ingestFile(next, { dbPath, region: 'US' }).then(() => {
      const db = openDb(dbPath);
      try {
        expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM threads`).get()).toEqual({ n: 1 });
        expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM contacts`).get()).toEqual({ n: 1 });
        // Three already there, one genuinely new. Not seven.
        expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 4 });
      } finally { db.close(); }
    });
  });

  it('lets a note-to-self re-import land in the structurally migrated owner thread', () => {
    // The empty-participant fix changed both the thread signature and the dedup counterpart. A
    // published archive upgrades through this migration before the next import, so the migration
    // must produce exactly the same role-tagged representation as ingest or that next backup either
    // forks the thread or writes every old message again underneath the matched thread.
    writeLegacyDb(dbPath);
    const legacy = new Database(dbPath);
    legacy.prepare(`UPDATE contacts SET is_owner = 1 WHERE id = 1`).run();
    legacy.prepare(`UPDATE thread_participants SET role = 'owner' WHERE thread_id = 1`).run();
    legacy.prepare(`INSERT INTO app_meta (key, value) VALUES ('owner_contact_id', '1')`).run();
    legacy.close();

    openDb(dbPath).close();

    const next = join(root, `next-self-${seq++}.xml`);
    writeFileSync(next, `<?xml version="1.0" encoding="UTF-8"?>\n<smses count="2">\n`
      + [
        sms(ALICE, T0 + MIN, true, 'just about'),
        sms(ALICE, T0 + 3 * MIN, true, 'new note after the upgrade'),
      ].join('\n') + `\n</smses>\n`);

    return ingestFile(next, { dbPath, region: 'US' }).then((result) => {
      expect(result.messageRows, 'only the genuinely new note is inserted').toBe(1);
      const db = openDb(dbPath);
      try {
        expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM threads`).get()).toEqual({ n: 1 });
        expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM messages`).get()).toEqual({ n: 4 });
        expect(db.raw.prepare(
          `SELECT COUNT(*) AS n FROM messages WHERE body_text = 'just about'`).get()).toEqual({ n: 1 });
      } finally { db.close(); }
    });
  });
});
