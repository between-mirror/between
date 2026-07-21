// Between — the store. The app is the SOLE writer (HANDOFF invariant 2).
// Canonical schema is store/schema.sql (mirror of docs/SPECS/schema.sql).
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ResolvedGraph, IngestResult, ThreadSummary, MessageDTO, SearchHit,
  MomentDTO, ContactSummary, RelationshipType,
} from '../types';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

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

  // ── prepared writes ──
  const insSource = db.prepare(
    `INSERT INTO source_files (path, content_sha256, imported_at, record_count)
     VALUES (@path, @contentSha256, @importedAt, @recordCount)`);
  const insContact = db.prepare(
    `INSERT INTO contacts (display_name, primary_e164, is_owner, relationship_type)
     VALUES (@displayName, @primaryE164, @isOwner, @relationshipType)`);
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
        is_reaction, reaction_kind, lang, raw_type, raw_msg_box, source_file_id, dedup_key)
     VALUES (@threadId, @senderContactId, @direction, @kind, @sentAtMs, @bodyText, @isRead,
        @isReaction, @reactionKind, @lang, @rawType, @rawMsgBox, @sourceFileId, @dedupKey)`);
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
    });
    const sourceFileId = Number(sfInfo.lastInsertRowid);

    const cMap = new Map<number, number>();
    for (const c of graph.contacts) {
      const info = insContact.run({
        displayName: c.displayName,
        primaryE164: c.primaryE164,
        isOwner: c.isOwner ? 1 : 0,
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

    const tMap = new Map<number, number>();
    for (const t of graph.threads) {
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
