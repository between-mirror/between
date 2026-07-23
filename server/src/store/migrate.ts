// Forward-only schema migrations (SPEC-installer §1 rules).
//
// schema.sql is all `CREATE TABLE IF NOT EXISTS`, which is exactly nothing on a database that
// already exists. Every change to an existing archive happens here instead.
//
// The rules this file is built to, in the order they matter:
//   1. A timestamped backup BEFORE anything is altered, kept until the owner deletes it. This runs
//      against the only copy of years of someone's messages; there is no version of "probably fine".
//   2. Forward-only, numbered, and each migration decides for itself whether it is still needed by
//      looking at the live schema rather than trusting a stored number — a database that was
//      restored from a backup, or copied between machines mid-upgrade, still gets the right answer.
//   3. Everything inside one transaction. SQLite rolls DDL back, so a failure leaves the database
//      exactly as it was and the backup is the second line of defence, not the first.
//   4. Failure is reported, never swallowed. A migration that half-ran and said nothing would be
//      indistinguishable from an archive that was always missing those rows.
import Database from 'better-sqlite3';
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { keyBatch } from '../ingest/dedup';
import {
  memberParticipantKey,
  participantSetKey,
  participantSignature,
  selfParticipantKey,
} from '../ingest/threads';
import type { SourceKind } from '../types';

export interface Migration {
  version: number;
  name: string;
  /** Read from the live schema, not from a stored version number. */
  needed(db: Database.Database): boolean;
  apply(db: Database.Database): void;
}

export interface MigrationOutcome {
  applied: string[];
  backupPath: string | null;
}

function columns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** The same dispatch ingest uses, applied to the path the import recorded at the time. */
function kindFromPath(path: string): SourceKind {
  const p = (path ?? '').toLowerCase();
  if (p.endsWith('.xml')) return 'android_smsbackup';
  if (p.endsWith('.txt') || p.endsWith('.zip')) return 'whatsapp_txt';
  if (p.endsWith('.jsonl') || p.endsWith('.json') || p.endsWith('.csv')) return 'generic_jsonl';
  return 'unknown';
}

/**
 * v1 — source provenance, stable thread signatures, and canonical dedup keys.
 *
 * Three things that were wrong together, because they were all keyed on things that do not survive
 * a second import:
 *
 *  - Nothing recorded which format a row came from, so the archive-health surface reported a
 *    hardcoded "Android SMS Backup & Restore XML" for every import including the ones that were not.
 *  - threads.participant_signature hashed contact TEMP-IDS, which are assigned in first-encounter
 *    order within a single file. A second backup of the same phone numbered the same people
 *    differently, so the second import either collided on the UNIQUE column and aborted, or filed
 *    the same conversation as a second thread.
 *  - dedup_key hashed Android-native fields and an exact millisecond, so no two formats could ever
 *    agree that they held the same message.
 *
 * NOTHING HERE MAY ABORT. This runs inside openDb, which is the only door into the store — the
 * server and every CLI go through it — so a migration that throws does not fail an upgrade, it takes
 * the archive away. There is no repair path and no --skip flag; the owner's messages simply become
 * unreachable by the program that was supposed to be keeping them.
 *
 * That is not hypothetical. An earlier version of this file asserted, in this comment, that the key
 * recompute "cannot lose a row" because occurrences are "assigned in id order" — and that was
 * already false when it was written: the keyer ranks by identity, not position, so two pre-existing
 * rows that canonicalize together collided on the UNIQUE index and the whole migration threw. Any
 * archive holding two photos sent in the same second was bricked on upgrade. The comment was the
 * only thing that said otherwise, and a comment enforces nothing.
 *
 * So both rewrites below are collision-SAFE by construction rather than by argument: a value that
 * would collide is not written, the row keeps a unique legacy value instead, and the count is
 * recorded. Nothing is deleted, nothing is merged, and no evidence id in a frozen reading is left
 * pointing at nothing. A row that keeps a legacy key simply does not participate in cross-import
 * convergence until it is re-imported — strictly better than an archive that will not open.
 */
const V1: Migration = {
  version: 1,
  name: 'source-provenance-and-canonical-keys',

  needed(db) {
    return !columns(db, 'source_files').has('kind') || !columns(db, 'messages').has('source_kind');
  },

  apply(db) {
    // ADD COLUMN cannot be NOT NULL without a default on a populated table, so these arrive nullable
    // and are filled below. A database created fresh from schema.sql has them NOT NULL; the read
    // paths coalesce, and no ingest path can leave one empty.
    if (!columns(db, 'source_files').has('kind')) {
      db.exec(`ALTER TABLE source_files ADD COLUMN kind TEXT`);
    }
    if (!columns(db, 'messages').has('source_kind')) {
      db.exec(`ALTER TABLE messages ADD COLUMN source_kind TEXT`);
    }

    // ── provenance, derived from the path each import recorded ──
    const files = db.prepare(`SELECT id, path FROM source_files`).all() as { id: number; path: string }[];
    const setFileKind = db.prepare(`UPDATE source_files SET kind = ? WHERE id = ?`);
    for (const f of files) setFileKind.run(kindFromPath(f.path), f.id);
    db.exec(`
      UPDATE messages SET source_kind = COALESCE(
        (SELECT sf.kind FROM source_files sf WHERE sf.id = messages.source_file_id), 'unknown')`);

    // ── thread signatures, recomputed onto the participants' natural keys ──
    // One key per contact: the E.164 where identity resolved one, else the raw address. Every
    // identifier in a cluster shares that key, so MIN picks it deterministically.
    const threads = db.prepare(`SELECT id FROM threads`).all() as { id: number }[];
    const keysOf = db.prepare(`
      SELECT MIN(COALESCE(i.normalized_e164, i.raw_value)) AS k
        FROM thread_participants tp
        JOIN identifiers i ON i.contact_id = tp.contact_id
       WHERE tp.thread_id = ? AND tp.role != 'owner'
       GROUP BY tp.contact_id
       ORDER BY k`);
    const ownersOf = db.prepare(`
      SELECT MIN(COALESCE(i.normalized_e164, i.raw_value)) AS k
        FROM thread_participants tp
        JOIN identifiers i ON i.contact_id = tp.contact_id
       WHERE tp.thread_id = ? AND tp.role = 'owner'
       GROUP BY tp.contact_id
       ORDER BY k`);
    const setSig = db.prepare(`UPDATE threads SET participant_signature = ? WHERE id = ?`);
    // Two passes: park every row on a value that cannot collide with a real signature, then write
    // the real ones. A single pass can trip the UNIQUE index on a signature not yet rewritten.
    for (const t of threads) setSig.run(`migrating:${t.id}`, t.id);
    const takenSig = new Set<string>();
    const counterpartByThread = new Map<number, string>();
    let sigCollisions = 0;
    for (const t of threads) {
      const keys = (keysOf.all(t.id) as { k: string | null }[])
        .map((r) => r.k)
        .filter((k): k is string => k != null)
        .map(memberParticipantKey);
      // The same rule ingest uses, so a migrated thread and a re-imported one agree. A thread with
      // no counterpart is a note to self and is keyed on WHOSE self. A `legacy:` string here would
      // make the thread impossible to match by signature, so the next import would file a second
      // copy of the same conversation.
      const owners = (ownersOf.all(t.id) as { k: string | null }[])
        .map((r) => r.k).filter((k): k is string => k != null).map(selfParticipantKey).sort();
      const participants = keys.length > 0 ? keys : owners;
      counterpartByThread.set(
        t.id,
        participants.length > 0 ? participantSetKey(participants) : `thread:${t.id}`,
      );
      let sig = participantSignature(participants);
      // Two threads CAN resolve to one key: identifiers.raw_value is unique but normalized_e164 is
      // not, so the same number written two ways became two contacts that collapse back onto one
      // key. That is exactly the forked archive this migration exists to help — it must not be the
      // archive it destroys. The second thread keeps a unique legacy signature; the conversations
      // stay separate, as they already were, rather than the upgrade failing.
      if (takenSig.has(sig)) { sig = `legacy:${t.id}`; sigCollisions += 1; }
      takenSig.add(sig);
      setSig.run(sig, t.id);
    }

    // ── dedup keys, recomputed canonically ──
    const msgs = db.prepare(`
      SELECT m.id, m.thread_id, m.direction, m.sent_at_ms, m.body_text
        FROM messages m
       ORDER BY m.id`).all() as {
      id: number; thread_id: number; direction: string;
      sent_at_ms: number; body_text: string | null;
    }[];

    const keys = keyBatch(msgs, (m) => ({
      // Exactly what INGEST passes for the same thread: the counterpart keys, or — for a thread
      // with no counterpart, which is a note to self — that owner's role-tagged key. A placeholder
      // unique to the row (`thread:<id>`) meant the migrated thread was found by the next import
      // while none of its MESSAGES were, so the conversation was matched and written twice; a bare
      // '' meant every owner-only thread in the archive shared one counterpart.
      counterpart: counterpartByThread.get(m.thread_id) ?? `thread:${m.thread_id}`,
      direction: m.direction,
      sentAtMs: m.sent_at_ms,
      bodyText: m.body_text,
      // Rows already in the database are distinct by definition — the archive is holding them
      // separately. Their row id is the identity that says so, and without it two rows sharing an
      // instant and a body (two photos in one second) canonicalize together and the UNIQUE index
      // takes the whole archive down.
      nativeId: `row:${m.id}`,
    }));
    const setKey = db.prepare(`UPDATE messages SET dedup_key = ? WHERE id = ?`);
    for (let i = 0; i < msgs.length; i++) setKey.run(`migrating:${msgs[i].id}`, msgs[i].id);

    // Belt and braces. The native id above should make a collision impossible, but "should" is what
    // the previous version of this comment said, and it was wrong. A key that would collide is not
    // written; the row keeps a unique legacy value and stays exactly where it is.
    const takenKey = new Set<string>();
    let keyCollisions = 0;
    for (let i = 0; i < msgs.length; i++) {
      let k = keys[i];
      if (takenKey.has(k)) { k = `legacy:${msgs[i].id}`; keyCollisions += 1; }
      takenKey.add(k);
      setKey.run(k, msgs[i].id);
    }

    if (sigCollisions || keyCollisions) {
      db.prepare(`INSERT INTO app_meta (key, value) VALUES ('migration_v1_collisions', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(JSON.stringify({ threads: sigCollisions, messages: keyCollisions }));
    }
  },
};

/**
 * The index archive health needs, on archives that already exist.
 *
 * Pure addition: an index creates no rows, drops none, and changes no value. It is separated from V1
 * rather than folded into it because V1 has shipped — a migration that has run on someone's archive
 * is history and does not get edited afterwards.
 *
 * Why it matters enough to be a migration at all: computeArchiveHealth runs two correlated
 * subqueries against attachments.message_id per message, and this release moved that lens onto Home
 * and onto every reading. Unindexed, on an ordinary multi-year archive, that is tens of seconds of a
 * synchronous server serving nothing else — the app looks hung on the default view of a
 * conversation.
 */
const V2: Migration = {
  version: 2,
  name: 'index-attachments-by-message',
  needed(db) {
    const rows = db.prepare(`PRAGMA index_list(attachments)`).all() as { name: string }[];
    return !rows.some((r) => {
      const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(r.name)})`).all() as { name: string }[];
      return cols[0]?.name === 'message_id';
    });
  },
  apply(db) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)`);
  },
};

export const MIGRATIONS: Migration[] = [V1, V2];
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * A cheap identity for an archive: how many messages, which id range, which span.
 *
 * Not a checksum — hashing a multi-gigabyte database to decide whether to copy it would cost more
 * than the copy. It only has to tell one archive from another, and two different archives agreeing
 * on all five of these is not a case worth engineering against.
 */
function fingerprint(db: Database.Database): string {
  const r = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(MIN(id), 0) AS lo, COALESCE(MAX(id), 0) AS hi,
           COALESCE(MIN(sent_at_ms), 0) AS t0, COALESCE(MAX(sent_at_ms), 0) AS t1
      FROM messages`).get() as { n: number; lo: number; hi: number; t0: number; t1: number };
  return `${r.n}:${r.lo}:${r.hi}:${r.t0}:${r.t1}`;
}

/**
 * True when `path` is a readable database holding this archive's pre-migration state.
 *
 * Anything unreadable, truncated, or belonging to a different archive answers false, and the caller
 * takes a fresh copy instead of trusting the name on the file.
 */
function standsInFor(path: string, live: Database.Database): boolean {
  let copy: Database.Database | null = null;
  try {
    copy = new Database(path, { readonly: true, fileMustExist: true });
    const hasMessages = copy.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages'`,
    ).get() as { n: number };
    if (hasMessages.n !== 1) return false;
    return fingerprint(copy) === fingerprint(live);
  } catch {
    return false;
  } finally {
    try { copy?.close(); } catch { /* best effort */ }
  }
}

/** True when the database holds nothing worth backing up. */
function isEmpty(db: Database.Database): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number };
  return row.n === 0;
}

/**
 * Every pre-migration copy sitting beside the database, oldest name first.
 *
 * Exported because the "Delete all Between data" sweep has to find these too, and the two must not
 * drift: this file once carried a comment asserting the deletion sweep matched them "because the
 * name ends in .db", but that sweep enumerates DIRECTORIES, and these are the one copy that lands
 * outside all of them — beside the database rather than in backupsDir. The result was a complete
 * unencrypted archive surviving a deletion that reported "0 backups". One definition, used by both.
 */
export function migrationBackupsBeside(dbPath: string, version?: number): string[] {
  const dir = dirname(dbPath);
  // No version means EVERY version, which is what deletion wants: an archive upgraded a year ago
  // still has that upgrade's copy beside it, and "delete everything" must not start missing the
  // older ones the moment a new migration ships. The migration itself asks about one version,
  // because it is deciding whether it already took today's copy.
  const prefix = `${basename(dbPath)}.pre-v`;
  const suffix = version == null ? '' : `${version}-`;
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(prefix + suffix) && /\.pre-v\d+-.+\.db$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * A usable pre-migration copy for this version, if one is sitting beside the database.
 *
 * Every candidate is considered, not just the oldest-stamped one: a single unusable file whose name
 * sorts first would otherwise hide the good copy behind it and a fresh full copy would be written on
 * every attempt — which is the disk-filling behaviour this reuse exists to stop.
 */
function existingBackup(dbPath: string, version: number, live: Database.Database): string | null {
  for (const candidate of migrationBackupsBeside(dbPath, version)) {
    if (standsInFor(candidate, live)) return candidate;
  }
  return null;
}

/**
 * Bring `db` up to SCHEMA_VERSION. Returns what ran and where the pre-migration backup went.
 *
 * `stamp` is the backup filename's timestamp; injectable so a test can assert the name rather than
 * race the clock.
 */
export function migrate(
  db: Database.Database,
  dbPath: string,
  stamp: string = new Date().toISOString().replace(/[:.]/g, '-'),
): MigrationOutcome {
  const pending = MIGRATIONS.filter((m) => m.needed(db));
  if (pending.length === 0) {
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    return { applied: [], backupPath: null };
  }

  // A brand-new database has nothing to lose and no reason to leave a backup file behind.
  let backupPath: string | null = null;
  if (!isEmpty(db) && dbPath !== ':memory:') {
    // Ends in .db deliberately. A backup is a complete, unencrypted copy of the archive, and every
    // rule that keeps a database out of a commit — .gitignore's `*.db`, the publish recipe, the
    // deletion sweep in the "Your data" panel — matches on that extension. A `.bak` suffix would sit
    // outside all of them and be the one copy of someone's messages that git was willing to take.
    const version = pending[pending.length - 1].version;
    const already = existingBackup(dbPath, version, db);
    if (already) {
      // One copy, not one per attempt. If a migration ever does fail, the natural thing for the
      // owner to do is relaunch — and that used to write another full, unencrypted copy of the whole
      // archive every single time, with nothing checking and nothing cleaning up. A few restarts on
      // a multi-gigabyte archive fills the disk with plaintext copies of someone's private messages.
      //
      // Reused only when the file actually IS this archive's pre-migration state, which the name
      // alone does not establish. A copy interrupted mid-VACUUM is a truncated non-database wearing
      // the right name, and an archive restored from elsewhere over this path leaves a valid copy of
      // a DIFFERENT archive beside it. In both cases the previous code skipped the copy and then
      // rewrote every key in the archive with no usable safety net — while the failure message
      // pointed the owner at the file as though it were one.
      backupPath = already;
    } else {
      backupPath = `${dbPath}.pre-v${version}-${stamp}.db`;
      try {
        // VACUUM INTO, not a file copy: it is synchronous, it takes the WAL contents with it, and it
        // refuses rather than overwrites if the name is somehow taken.
        db.prepare(`VACUUM INTO ?`).run(backupPath);
      } catch (e) {
        // A disk that cannot hold the copy cannot be trusted to hold a half-migrated archive either.
        // Refuse in words, rather than migrating without the safety copy or dying on a raw
        // SQLITE_FULL thrown from outside the handler below.
        const why = e instanceof Error ? e.message : 'unknown problem';
        throw new Error(
          `The archive was NOT upgraded, and nothing was changed: a safety copy could not be written `
          + `first (${why}). Free some space beside ${dbPath} and start again.`,
        );
      }
    }
  }

  const applied: string[] = [];
  try {
    db.transaction(() => {
      for (const m of pending) {
        m.apply(db);
        applied.push(m.name);
      }
      db.prepare(`INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    })();
  } catch (e) {
    const why = e instanceof Error ? e.message : 'unknown problem';
    throw new Error(
      `The archive could not be upgraded: ${why}. Nothing was changed — the upgrade ran as a single `
      + `transaction and it has been rolled back.`
      + (backupPath ? ` A copy taken before the attempt is at ${backupPath}.` : ''),
    );
  }

  return { applied, backupPath };
}
