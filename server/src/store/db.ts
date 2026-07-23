// Between — the store. The app is the SOLE writer (HANDOFF invariant 2).
// Canonical schema is store/schema.sql (mirror of docs/SPECS/schema.sql).
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './migrate';
import {
  memberParticipantKey,
  participantSetKey,
  participantSignature,
  selfParticipantKey,
} from '../ingest/threads';
import { keyBatch } from '../ingest/dedup';
import type {
  ResolvedGraph, IngestResult, ThreadSummary, MessageDTO, SearchHit,
  MomentDTO, ContactSummary, RelationshipType,
} from '../types';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

/**
 * Re-key the threads that were built before anyone knew who the owner was.
 *
 * Runs the first time an import establishes the owner's contact id. Threads created earlier hold
 * that person as an ordinary member, so their participant signature — and every message's dedup key
 * underneath it — counts one participant too many. Left alone, the next import of the same
 * conversation computes the correct key, matches nothing, and files a second copy of a thread that
 * already exists, flagged as a group chat, with its messages counted in both.
 *
 * Collision-safe by construction, in the same shape as the v1 migration: park the rows on a value
 * that cannot collide, then write the real keys, skipping any that a row not being rewritten has
 * already taken. Nothing is deleted and nothing is merged on ambiguity — a thread that cannot take
 * its corrected key keeps the one it has, which leaves the archive exactly as separate as it is now
 * rather than risking the wrong two conversations becoming one.
 */
function repairOwnerThreads(db: Database.Database, ownerId: number): void {
  const before = (db.prepare(
    `SELECT DISTINCT t.id AS id, t.participant_signature AS sig, t.is_group AS grp
       FROM thread_participants tp JOIN threads t ON t.id = tp.thread_id
      WHERE tp.contact_id = ? AND tp.role != 'owner' ORDER BY t.id`,
  ).all(ownerId) as { id: number; sig: string; grp: number }[]);
  const affected = before.map((r) => r.id);
  if (affected.length === 0) return;
  // What each row held before anything was parked, so a row that cannot take its corrected key can
  // be put back exactly as it was rather than left on an invented one.
  const priorSig = new Map(before.map((r) => [r.id, r.sig]));
  const priorGrp = new Map(before.map((r) => [r.id, r.grp]));

  db.prepare(
    `UPDATE thread_participants SET role = 'owner' WHERE contact_id = ? AND role != 'owner'`,
  ).run(ownerId);

  const ph = affected.map(() => '?').join(',');
  const taken = new Set((db.prepare(
    `SELECT participant_signature AS s FROM threads WHERE id NOT IN (${ph})`,
  ).all(...affected) as { s: string }[]).map((r) => r.s));

  const keysOf = db.prepare(`
    SELECT MIN(COALESCE(i.normalized_e164, i.raw_value)) AS k
      FROM thread_participants tp
      JOIN identifiers i ON i.contact_id = tp.contact_id
     WHERE tp.thread_id = ? AND tp.role != 'owner'
     GROUP BY tp.contact_id
     ORDER BY k`);
  const selfOf = db.prepare(`
    SELECT MIN(COALESCE(i.normalized_e164, i.raw_value)) AS k
      FROM thread_participants tp
      JOIN identifiers i ON i.contact_id = tp.contact_id
     WHERE tp.thread_id = ? AND tp.role = 'owner'
     GROUP BY tp.contact_id
     ORDER BY k`);
  const park = db.prepare(`UPDATE threads SET participant_signature = ? WHERE id = ?`);
  const setSig = db.prepare(
    `UPDATE threads SET participant_signature = ?, is_group = ? WHERE id = ?`);

  let sigCollisions = 0;
  for (const id of affected) park.run(`repairing:${id}`, id);
  for (const id of affected) {
    const keys = (keysOf.all(id) as { k: string | null }[])
      .map((r) => r.k).filter((k): k is string => k != null).map(memberParticipantKey);
    // Whose self, when there is no counterpart — the same rule ingest and the migration use. A
    // role-tagged owner key keeps separate owners' note-to-self threads separate and remains
    // matchable on the next import; a `legacy:` value here would make the repair cause a fork.
    const selves = (selfOf.all(id) as { k: string | null }[])
      .map((r) => r.k).filter((k): k is string => k != null).map(selfParticipantKey).sort();
    const sig = participantSignature(keys.length > 0 ? keys : selves);
    if (taken.has(sig)) {
      // Another thread already holds this identity. Put this row back exactly as it was: the two
      // conversations stay as separate as the archive already had them, which is a state the owner
      // can see and the app can still open, rather than a merge decided here on a guess.
      sigCollisions += 1;
      setSig.run(priorSig.get(id)!, priorGrp.get(id)!, id);
      continue;
    }
    taken.add(sig);
    setSig.run(sig, keys.length > 1 ? 1 : 0, id);
  }
  if (sigCollisions > 0) {
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('owner_repair_collisions', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(sigCollisions));
  }

  // The messages underneath them: same rewrite, same discipline. The counterpart in the key is the
  // set of non-owner participants, which is exactly what just changed.
  const counterpartByThread = new Map(affected.map((id) => {
    const members = (keysOf.all(id) as { k: string | null }[])
      .map((r) => r.k).filter((k): k is string => k != null).map(memberParticipantKey);
    const selves = (selfOf.all(id) as { k: string | null }[])
      .map((r) => r.k).filter((k): k is string => k != null).map(selfParticipantKey);
    const participants = members.length > 0 ? members : selves;
    return [id, participants.length > 0 ? participantSetKey(participants) : `thread:${id}`] as const;
  }));
  const msgs = db.prepare(`
    SELECT m.id, m.thread_id, m.direction, m.sent_at_ms, m.body_text, m.dedup_key AS priorKey
      FROM messages m
     WHERE m.thread_id IN (${ph})
     ORDER BY m.id`).all(...affected) as {
    id: number; thread_id: number; direction: string; priorKey: string;
    sent_at_ms: number; body_text: string | null;
  }[];
  if (msgs.length === 0) return;

  const keys = keyBatch(msgs, (m) => ({
    // Exactly what ingest passes for the same thread: the counterparts, or that owner's own `self:`
    // key where there are none. `thread:<id>` here meant the repaired thread was found by the next
    // import while none of its MESSAGES were, so the conversation was written a second time — the
    // same defect fixed in the migration, left standing in its sibling. The row-unique form is kept
    // only for a thread with no identifiers at all, which cannot be matched by signature either.
    counterpart: counterpartByThread.get(m.thread_id) ?? `thread:${m.thread_id}`,
    direction: m.direction,
    sentAtMs: m.sent_at_ms,
    bodyText: m.body_text,
    // Rows the archive already holds separately are distinct by definition; their row id is what
    // says so. Without it, two photos sent in one second canonicalize together and one is lost.
    nativeId: `row:${m.id}`,
  }));
  const takenKeys = new Set((db.prepare(
    `SELECT dedup_key AS k FROM messages WHERE thread_id NOT IN (${ph})`,
  ).all(...affected) as { k: string }[]).map((r) => r.k));
  const setKey = db.prepare(`UPDATE messages SET dedup_key = ? WHERE id = ?`);
  for (const m of msgs) setKey.run(`repairing:${m.id}`, m.id);
  let keyCollisions = 0;
  for (let i = 0; i < msgs.length; i++) {
    const key = keys[i];
    // Same rule as the signatures: a row that cannot take its corrected key keeps the one it had.
    if (takenKeys.has(key)) {
      keyCollisions += 1;
      setKey.run(msgs[i].priorKey, msgs[i].id);
      continue;
    }
    takenKeys.add(key);
    setKey.run(key, msgs[i].id);
  }
  if (keyCollisions > 0) {
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('owner_repair_key_collisions', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(keyCollisions));
  }
}

export interface GetMessagesOptions {
  beforeMs?: number;
  afterMs?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface BetweenDB {
  raw: Database.Database;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  getSourceFileByHash(hash: string): { id: number } | undefined;
  /** The archive owner's natural keys, empty until some import has been able to identify them. */
  getOwnerKeys(): Set<string>;
  bulkInsertGraph(graph: ResolvedGraph): IngestResult;
  listThreads(): ThreadSummary[];
  getThread(id: number): ThreadSummary | undefined;
  getMessages(threadId: number, opts?: GetMessagesOptions): MessageDTO[];
  searchMessages(query: string, opts?: { threadId?: number; limit?: number }): SearchHit[];
  getMoments(threadId: number): MomentDTO[];
  listContacts(): ContactSummary[];
  updateContact(id: number, patch: Partial<{
    displayName: string; relationshipType: RelationshipType;
    isDeceased: boolean; deceasedSince: string | null;
  }>): void;
  close(): void;
}

export function openDb(path: string): BetweenDB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  // CREATE TABLE IF NOT EXISTS does nothing to a database that already exists, so every change to
  // an existing archive happens here. Backs itself up first; see store/migrate.ts.
  migrate(db, path);

  // ── prepared writes ──
  const insSource = db.prepare(
    `INSERT INTO source_files (path, content_sha256, imported_at, record_count, kind)
     VALUES (@path, @contentSha256, @importedAt, @recordCount, @kind)`);
  const insContact = db.prepare(
    `INSERT INTO contacts (display_name, primary_e164, is_owner, relationship_type)
     VALUES (@displayName, @primaryE164, @isOwner, @relationshipType)`);
  // A person already known from an earlier import, found by any identifier they arrived with.
  //
  // Both columns, because raw_value alone is not "any identifier they arrived with": raw_value is
  // UNIQUE and normalized_e164 is not, so the same number written two ways — '+15550100' from a
  // chat.db, '(555) 010-0' from an Android export — matched nothing and made a second contact for
  // a person the THREAD had already merged, since threading keys on the normalized value. The
  // conversation then rendered as its own duplicate ("Alice, Alice"), the contact list split their
  // history, and updateContact wrote partner/deceased onto one of the two rows.
  const qContactByIdentifier = db.prepare(
    `SELECT contact_id AS id FROM identifiers WHERE raw_value = ?`);
  const qContactByE164 = db.prepare(
    `SELECT contact_id AS id FROM identifiers WHERE normalized_e164 = ? ORDER BY contact_id LIMIT 1`);
  // Fill in what a later import learned without overwriting anything: a display name the owner
  // corrected in the app must survive the next backup that still carries the old one.
  const fillContact = db.prepare(
    `UPDATE contacts
        SET display_name = COALESCE(display_name, @displayName),
            primary_e164 = COALESCE(primary_e164, @primaryE164)
      WHERE id = @id`);
  const qThreadBySig = db.prepare(
    `SELECT id FROM threads WHERE participant_signature = ?`);
  // The archive's owner, as natural keys. Owner detection is a fact about a WHOLE archive — the one
  // person who appears with everybody — but it is computed per FILE, and a file holding a single
  // conversation cannot show it. Once any import has established who the owner is, later imports
  // read it from here instead of re-deriving it from too little evidence.
  //
  // Exactly ONE contact's keys, even when the stored data disagrees. An archive written by an
  // earlier release could already hold two contacts flagged is_owner — nothing enforced uniqueness
  // then — and returning both would drop both from every thread key, leaving two strangers' 1:1
  // conversations sharing the one signature an empty participant set produces. The owner recorded
  // in app_meta wins (a person may have corrected it in onboarding); otherwise the lowest flagged
  // id, which is stable across opens. Nothing is unflagged here: reading is not the place to
  // decide that someone is not who an earlier import said they were.
  const qOwnerKeys = db.prepare(
    `SELECT DISTINCT COALESCE(i.normalized_e164, i.raw_value) AS k
       FROM identifiers i
      WHERE i.contact_id = (
        SELECT COALESCE(
          (SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'owner_contact_id'
            AND CAST(value AS INTEGER) IN (SELECT id FROM contacts WHERE is_owner = 1)),
          (SELECT MIN(id) FROM contacts WHERE is_owner = 1)))`);
  // Monotone AND unique: a contact recognised as the owner stays the owner, and there is only ever
  // one. Without the uniqueness clause a second file whose heuristic picked someone else — a backup
  // from another phone, or simply a wrong guess — left TWO contacts flagged, and then every import
  // excluded both from the thread key. A 1:1 conversation between two flagged people has an EMPTY
  // participant set, and participantSignature([]) is a single constant, so two strangers' private
  // conversations converged on one thread. An archive has one owner; the first one identified wins,
  // and the app's own onboarding remains the way to correct it.
  const markOwner = db.prepare(
    `UPDATE contacts SET is_owner = 1
      WHERE id = ? AND is_owner = 0
        AND NOT EXISTS (SELECT 1 FROM contacts WHERE is_owner = 1)`);
  const qOwnerId = db.prepare(`SELECT id FROM contacts WHERE is_owner = 1 LIMIT 1`);
  // Recomputed from the rows themselves after every import, so a thread assembled from two sources
  // reports the union rather than whichever file landed last.
  const refreshThreadSpan = db.prepare(
    `UPDATE threads SET
       first_ms      = (SELECT MIN(sent_at_ms) FROM messages WHERE thread_id = threads.id),
       last_ms       = (SELECT MAX(sent_at_ms) FROM messages WHERE thread_id = threads.id),
       message_count = (SELECT COUNT(*)        FROM messages WHERE thread_id = threads.id)
     WHERE id = ?`);
  const insIdentifier = db.prepare(
    `INSERT OR IGNORE INTO identifiers
       (contact_id, raw_value, normalized_e164, kind, source_contact_name, first_seen_ms, last_seen_ms)
     VALUES (@contactId, @rawValue, @normalizedE164, @kind, @sourceContactName, @firstSeenMs, @lastSeenMs)`);
  const insThread = db.prepare(
    `INSERT INTO threads
       (participant_signature, is_group, title, coverage_confidence, coverage_note,
        primary_lang, first_ms, last_ms, message_count)
     VALUES (@participantSignature, @isGroup, @title, @coverageConfidence, @coverageNote,
        @primaryLang, @firstMs, @lastMs, @messageCount)`);
  const insThreadPart = db.prepare(
    `INSERT OR IGNORE INTO thread_participants (thread_id, contact_id, role)
     VALUES (@threadId, @contactId, @role)`);
  const insMessage = db.prepare(
    `INSERT OR IGNORE INTO messages
       (thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text, is_read,
        is_reaction, reaction_kind, lang, raw_type, raw_msg_box, source_file_id, source_kind, dedup_key)
     VALUES (@threadId, @senderContactId, @direction, @kind, @sentAtMs, @bodyText, @isRead,
        @isReaction, @reactionKind, @lang, @rawType, @rawMsgBox, @sourceFileId, @sourceKind, @dedupKey)`);
  const insFts = db.prepare(`INSERT INTO messages_fts (rowid, body_text) VALUES (?, ?)`);
  const insRecipient = db.prepare(
    `INSERT OR IGNORE INTO message_recipients (message_id, contact_id, addr_role)
     VALUES (@messageId, @contactId, @addrRole)`);
  const insAttachment = db.prepare(
    `INSERT INTO attachments (message_id, mime_type, filename, size_bytes, sha256, is_smil, blob_ref)
     VALUES (@messageId, @mimeType, @filename, @sizeBytes, @sha256, @isSmil, NULL)`);

  const bulkInsertGraph = db.transaction((graph: ResolvedGraph): IngestResult => {
    const started = Date.now();
    const sfInfo = insSource.run({
      path: graph.sourceFile.path,
      contentSha256: graph.sourceFile.contentSha256,
      importedAt: graph.sourceFile.importedAt,
      recordCount: graph.sourceFile.recordCount,
      kind: graph.sourceFile.kind,
    });
    const sourceFileId = Number(sfInfo.lastInsertRowid);

    // Contacts merge across imports rather than accumulating. A person is matched on the raw
    // identifiers they arrived with — never on display name, which two people can share and which
    // an export is free to spell differently every time.
    const rawsOf = new Map<number, { raw: string; e164: string | null }[]>();
    for (const idf of graph.identifiers) {
      const entry = { raw: idf.rawValue, e164: idf.normalizedE164 };
      const list = rawsOf.get(idf.contactTempId);
      if (list) list.push(entry); else rawsOf.set(idf.contactTempId, [entry]);
    }
    const cMap = new Map<number, number>();
    // The uniqueness rule has to hold on the INSERT path too, not only on markOwner: a second
    // file's owner is usually a person this archive has never seen, so they arrive as a new contact
    // and would be written with the flag already set, never passing through markOwner at all.
    let ownerTaken = qOwnerId.get() != null;
    for (const c of graph.contacts) {
      let existing: number | undefined;
      for (const { raw, e164 } of rawsOf.get(c.tempId) ?? []) {
        // Exact spelling first, then the number underneath it. The E.164 match is what makes this
        // "any identifier they arrived with" rather than "any identifier spelled the same way".
        const hit = (qContactByIdentifier.get(raw)
          ?? (e164 ? qContactByE164.get(e164) : undefined)) as { id: number } | undefined;
        if (hit) { existing = hit.id; break; }
      }
      if (existing != null) {
        fillContact.run({ id: existing, displayName: c.displayName, primaryE164: c.primaryE164 });
        cMap.set(c.tempId, existing);
        continue;
      }
      const claimsOwner = c.isOwner && !ownerTaken;
      if (claimsOwner) ownerTaken = true;
      const info = insContact.run({
        displayName: c.displayName,
        primaryE164: c.primaryE164,
        isOwner: claimsOwner ? 1 : 0,
        relationshipType: c.relationshipType,
      });
      cMap.set(c.tempId, Number(info.lastInsertRowid));
    }
    for (const idf of graph.identifiers) {
      insIdentifier.run({
        contactId: cMap.get(idf.contactTempId)!,
        rawValue: idf.rawValue,
        normalizedE164: idf.normalizedE164,
        kind: idf.kind,
        sourceContactName: idf.sourceContactName,
        firstSeenMs: idf.firstSeenMs,
        lastSeenMs: idf.lastSeenMs,
      });
    }

    // ── the owner, once anybody has managed to see them ──────────────────────
    //
    // A file holding one conversation cannot reveal the owner: the heuristic needs someone who
    // appears with more than one other person. So an archive that started with a single-thread
    // import has the owner filed as an ordinary counterparty, and every thread it created is keyed
    // on TWO participants rather than one. When a later, larger file finally identifies them, the
    // threads already on disk are still wearing the old key — the same conversation would fork, the
    // spare copy flagged as a group chat that never existed, its messages counted twice.
    //
    // So the moment the owner becomes known, the rows that predate that knowledge are re-keyed.
    // Collision-safe by construction, in the same shape as the v1 migration: a value that would
    // collide is not written and the row keeps the key it has. Nothing is deleted and nothing is
    // merged on ambiguity — a thread that cannot be re-keyed stays exactly as separate as it is
    // today, which is the state the archive is already in.
    const ownerTemp = graph.contacts.find((c) => c.isOwner);
    const ownerId = ownerTemp ? cMap.get(ownerTemp.tempId) : undefined;
    if (ownerId != null && markOwner.run(ownerId).changes === 1) repairOwnerThreads(db, ownerId);
    // And record it where the rest of the product looks. Only the onboarding endpoint used to write
    // this, so an archive built from the CLI had no owner on file: archive health reads it to
    // exclude the owner from "other conversations share a participant with this one", and with it
    // missing that warning fired on every conversation of every multi-conversation archive — on the
    // surface whose whole job is to say whether the others can be trusted. Never overwritten: a
    // person who corrected this in onboarding has said something an import does not get to undo.
    const settled = qOwnerId.get() as { id: number } | undefined;
    if (settled && !qMeta.get('owner_contact_id')) {
      qSetMeta.run('owner_contact_id', String(settled.id));
    }

    // Same participants, same thread. The signature is built from the participants' natural keys,
    // so a second backup of the same conversation lands here rather than colliding on the UNIQUE
    // column — which is what it used to do, aborting the whole import.
    const tMap = new Map<number, number>();
    for (const t of graph.threads) {
      const existing = qThreadBySig.get(t.participantSignature) as { id: number } | undefined;
      if (existing) {
        tMap.set(t.tempId, existing.id);
        continue;
      }
      const info = insThread.run({
        participantSignature: t.participantSignature,
        isGroup: t.isGroup ? 1 : 0,
        title: t.title,
        coverageConfidence: t.coverageConfidence,
        coverageNote: t.coverageNote,
        primaryLang: t.primaryLang,
        firstMs: t.firstMs,
        lastMs: t.lastMs,
        messageCount: t.messageCount,
      });
      tMap.set(t.tempId, Number(info.lastInsertRowid));
    }
    for (const tp of graph.threadParticipants) {
      insThreadPart.run({
        threadId: tMap.get(tp.threadTempId)!,
        contactId: cMap.get(tp.contactTempId)!,
        role: tp.role,
      });
    }

    let smsCount = 0, mmsCount = 0, reactionCount = 0, messageRows = 0;
    for (const m of graph.messages) {
      const info = insMessage.run({
        threadId: tMap.get(m.threadTempId)!,
        senderContactId: m.senderContactTempId != null ? cMap.get(m.senderContactTempId)! : null,
        direction: m.direction,
        kind: m.kind,
        sentAtMs: m.sentAtMs,
        bodyText: m.bodyText,
        isRead: m.isRead == null ? null : m.isRead ? 1 : 0,
        isReaction: m.isReaction ? 1 : 0,
        reactionKind: m.reactionKind,
        lang: m.lang,
        rawType: m.rawType,
        rawMsgBox: m.rawMsgBox,
        sourceFileId,
        sourceKind: graph.sourceFile.kind,
        dedupKey: m.dedupKey,
      });
      if (info.changes !== 1) continue; // deduped away
      messageRows++;
      if (m.kind === 'sms') smsCount++; else mmsCount++;
      if (m.isReaction) reactionCount++;
      const mid = Number(info.lastInsertRowid);
      if (m.bodyText) insFts.run(mid, m.bodyText);
      for (const r of m.recipients) {
        insRecipient.run({ messageId: mid, contactId: cMap.get(r.contactTempId)!, addrRole: r.role });
      }
      for (const a of m.attachments) {
        insAttachment.run({
          messageId: mid, mimeType: a.mimeType, filename: a.filename,
          sizeBytes: a.sizeBytes, sha256: a.sha256, isSmil: a.isSmil ? 1 : 0,
        });
      }
    }

    // The span and count a thread reports must describe every row in it, not just the ones this
    // file brought. Recomputed rather than accumulated so a re-import cannot drift them.
    for (const threadId of new Set(tMap.values())) refreshThreadSpan.run(threadId);

    return {
      sourceFileId,
      alreadyImported: false,
      smsCount, mmsCount, messageRows, reactionCount,
      contacts: graph.contacts.length,
      threads: graph.threads.length,
      durationMs: Date.now() - started,
    };
  });

  // ── prepared reads ──
  const qMeta = db.prepare(`SELECT value FROM app_meta WHERE key = ?`);
  const qSetMeta = db.prepare(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const qSourceByHash = db.prepare(`SELECT id FROM source_files WHERE content_sha256 = ?`);

  const threadSelect = `
    SELECT t.id, t.title, t.is_group AS isGroup, t.message_count AS messageCount,
           t.first_ms AS firstMs, t.last_ms AS lastMs,
           t.coverage_confidence AS coverageConfidence, t.coverage_note AS coverageNote,
           (SELECT group_concat(c.display_name, ', ')
              FROM thread_participants tp JOIN contacts c ON c.id = tp.contact_id
              WHERE tp.thread_id = t.id AND tp.role != 'owner' AND c.display_name IS NOT NULL) AS participantNames,
           (SELECT count(*) FROM messages m
              WHERE m.thread_id = t.id AND m.direction = 'outgoing' AND m.is_reaction = 0) AS sentCount,
           (SELECT count(*) FROM messages m
              WHERE m.thread_id = t.id AND m.direction = 'incoming' AND m.is_reaction = 0) AS receivedCount
    FROM threads t`;
  const qThreads = db.prepare(`${threadSelect} ORDER BY t.last_ms DESC`);
  const qThread = db.prepare(`${threadSelect} WHERE t.id = ?`);

  const toThreadSummary = (r: any): ThreadSummary => ({
    id: r.id, title: r.title, isGroup: !!r.isGroup,
    displayName: r.participantNames || r.title || 'Unknown',
    messageCount: r.messageCount, firstMs: r.firstMs, lastMs: r.lastMs,
    coverageConfidence: r.coverageConfidence, coverageNote: r.coverageNote,
    sentCount: r.sentCount, receivedCount: r.receivedCount,
  });

  const qContacts = db.prepare(`
    SELECT c.id, c.display_name AS displayName, c.primary_e164 AS primaryE164,
           c.is_owner AS isOwner, c.relationship_type AS relationshipType,
           c.is_deceased AS isDeceased,
           (SELECT count(*) FROM messages m WHERE m.sender_contact_id = c.id) AS messageCount
    FROM contacts c ORDER BY messageCount DESC`);

  const escapeFts = (q: string) => `"${q.replace(/"/g, '""')}"`;

  return {
    raw: db,
    getMeta: (key) => (qMeta.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (key, value) => { qSetMeta.run(key, value); },
    getSourceFileByHash: (hash) => qSourceByHash.get(hash) as { id: number } | undefined,
    getOwnerKeys: () => new Set((qOwnerKeys.all() as { k: string | null }[])
      .map((r) => r.k).filter((k): k is string => k != null && k !== '')),
    bulkInsertGraph,

    listThreads: () => (qThreads.all() as any[]).map(toThreadSummary),
    getThread: (id) => {
      const r = qThread.get(id);
      return r ? toThreadSummary(r) : undefined;
    },

    getMessages: (threadId, opts = {}) => {
      const { beforeMs, afterMs, limit = 200, order = 'desc' } = opts;
      const clauses = ['m.thread_id = @threadId'];
      if (beforeMs != null) clauses.push('m.sent_at_ms < @beforeMs');
      if (afterMs != null) clauses.push('m.sent_at_ms > @afterMs');
      const sql = `
        SELECT m.id, m.direction, m.kind, m.sent_at_ms AS sentAtMs, m.body_text AS bodyText,
               m.is_reaction AS isReaction, m.reaction_kind AS reactionKind,
               c.display_name AS senderName,
               (SELECT count(*) FROM attachments a WHERE a.message_id = m.id AND a.is_smil = 0) AS attachmentCount
        FROM messages m LEFT JOIN contacts c ON c.id = m.sender_contact_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY m.sent_at_ms ${order === 'asc' ? 'ASC' : 'DESC'} LIMIT @limit`;
      const rows = db.prepare(sql).all({ threadId, beforeMs, afterMs, limit }) as any[];
      return rows.map((r) => ({
        id: r.id, direction: r.direction, kind: r.kind, sentAtMs: r.sentAtMs,
        bodyText: r.bodyText, isReaction: !!r.isReaction, reactionKind: r.reactionKind,
        senderName: r.senderName, attachmentCount: r.attachmentCount,
      }));
    },

    searchMessages: (query, opts = {}) => {
      const { threadId, limit = 100 } = opts;
      const match = escapeFts(query.trim());
      if (!match || match === '""') return [];
      const sql = `
        SELECT m.id AS messageId, m.thread_id AS threadId, m.sent_at_ms AS sentAtMs, m.direction,
               snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
               (SELECT group_concat(c.display_name, ', ')
                  FROM thread_participants tp JOIN contacts c ON c.id = tp.contact_id
                  WHERE tp.thread_id = m.thread_id AND tp.role != 'owner') AS threadName
        FROM messages_fts f JOIN messages m ON m.id = f.rowid
        WHERE messages_fts MATCH @match ${threadId != null ? 'AND m.thread_id = @threadId' : ''}
        ORDER BY rank LIMIT @limit`;
      const rows = db.prepare(sql).all({ match, threadId, limit }) as any[];
      return rows.map((r) => ({
        messageId: r.messageId, threadId: r.threadId, threadName: r.threadName || 'Unknown',
        sentAtMs: r.sentAtMs, direction: r.direction, snippet: r.snippet,
      }));
    },

    getMoments: (threadId) => {
      const moments: MomentDTO[] = [];
      const first = db.prepare(
        `SELECT id, sent_at_ms AS ms FROM messages WHERE thread_id = ? AND is_reaction = 0
         ORDER BY sent_at_ms ASC LIMIT 1`).get(threadId) as any;
      if (first) moments.push({ key: 'first', label: 'The first message', value: new Date(first.ms).toISOString().slice(0, 10), messageIds: [first.id] });
      const biggest = db.prepare(
        `SELECT date(sent_at_ms/1000,'unixepoch') AS d, count(*) AS n
         FROM messages WHERE thread_id = ? AND is_reaction = 0
         GROUP BY d ORDER BY n DESC LIMIT 1`).get(threadId) as any;
      if (biggest) moments.push({ key: 'biggest_day', label: 'The most you two ever said in one day', value: `${biggest.n} messages on ${biggest.d}`, messageIds: [] });
      const total = db.prepare(
        `SELECT count(*) AS n FROM messages WHERE thread_id = ? AND is_reaction = 0`).get(threadId) as any;
      if (total) moments.push({ key: 'total', label: 'Messages, all told', value: `${total.n}`, messageIds: [] });
      return moments;
    },

    listContacts: () => (qContacts.all() as any[]).map((r) => ({
      id: r.id, displayName: r.displayName, primaryE164: r.primaryE164,
      isOwner: !!r.isOwner, relationshipType: r.relationshipType as RelationshipType,
      isDeceased: !!r.isDeceased, messageCount: r.messageCount,
    })),

    updateContact: (id, patch) => {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.displayName !== undefined) { sets.push('display_name = @displayName'); params.displayName = patch.displayName; }
      if (patch.relationshipType !== undefined) { sets.push('relationship_type = @relationshipType'); params.relationshipType = patch.relationshipType; }
      if (patch.isDeceased !== undefined) { sets.push('is_deceased = @isDeceased'); params.isDeceased = patch.isDeceased ? 1 : 0; }
      if (patch.deceasedSince !== undefined) { sets.push('deceased_since = @deceasedSince'); params.deceasedSince = patch.deceasedSince; }
      if (!sets.length) return;
      db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = @id`).run(params);
    },

    close: () => db.close(),
  };
}
