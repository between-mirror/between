// Between — a synthetic Mac `chat.db` builder.
//
// The iMessage importer cannot be developed against a real archive: the only ones available are
// someone's actual messages, and this project's first rule is that none of those are ever in the
// repository. So the test bed is constructed — real schema, real column names, real Apple epochs,
// real typedstream bytes — and it ships in the test tree per SPEC-imports §4.
//
// WHAT THIS DOES AND DOES NOT PROVE. It proves the importer handles every SHAPE the format can take,
// including the ones that are easy to get wrong. It does not prove the importer handles a real
// export, because both sides of that comparison were written here by the same hand. That is exactly
// why the importer ships labelled unverified and asks for volunteers, and the label comes off when
// two real files have been read cleanly — not before.
//
// Everything below is invented. No real handle, message or identifier appears.
import Database from 'better-sqlite3';

/** Apple's epoch: 2001-01-01T00:00:00Z, in Unix ms. */
export const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Seconds since the Apple epoch — the pre-High-Sierra encoding. */
export const toAppleSeconds = (ms: number): number => Math.floor((ms - APPLE_EPOCH_MS) / 1000);
/** Nanoseconds since the Apple epoch — what macOS 10.13+ writes. */
export const toAppleNanos = (ms: number): bigint => BigInt(ms - APPLE_EPOCH_MS) * 1_000_000n;

// ── a typedstream writer, so the decoder is tested against real structure ────

/** typedstream's variable-length integer, in the encoding the reader has to accept. */
function writeInt(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n <= 0xFFFF) { const b = Buffer.alloc(3); b[0] = 0x81; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 0x82; b.writeUInt32LE(n, 1); return b;
}

/** A length-prefixed byte string, introduced by `+` — how contents appear in the stream. */
function writeString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([0x2B]), writeInt(bytes.length), bytes]);
}

/**
 * An `attributedBody` blob carrying `text`.
 *
 * The header is byte-for-byte what macOS writes — version 4, the length-prefixed signature
 * `streamtyped` (not `typedstream`; the name and the magic are reversed with respect to each other),
 * then the system version as a variable-length int. The body interleaves class names and attribute
 * keys around the contents the way a real NSAttributedString does, so a reader that survives this
 * has to actually skip metadata rather than take the first or longest string it finds.
 */
export function attributedBody(text: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x04]),
    writeInt(11), Buffer.from('streamtyped', 'latin1'),
    Buffer.from([0x81, 0xE8, 0x03]),            // system version 1000
    writeString('NSMutableAttributedString'),   // class chain, before the words
    writeString('NSAttributedString'),
    writeString('NSObject'),
    writeString(text),                          // the message itself
    writeString('NSDictionary'),                // attribute run metadata, after the words
    writeString('__kIMMessagePartAttributeName'),
  ]);
}

/** A blob that is a typedstream but holds no readable contents — decodable, and empty. */
export function attributedBodyEmpty(): Buffer {
  return Buffer.concat([
    Buffer.from([0x04]),
    writeInt(11), Buffer.from('streamtyped', 'latin1'),
    Buffer.from([0x81, 0xE8, 0x03]),
    writeString('NSMutableAttributedString'),
    writeString('NSDictionary'),
  ]);
}

/** Bytes that are not a typedstream at all — a truncated or corrupt column value. */
export function attributedBodyCorrupt(): Buffer {
  return Buffer.from([0x04, 0x0b, 0x00, 0xFF, 0xFE, 0x42, 0x42]);
}

// ── the database ─────────────────────────────────────────────────────────────

export interface ChatDbMessage {
  /** Unix ms; converted to the chosen Apple encoding on write. */
  ms: number;
  fromMe: boolean;
  /** The `text` column. null puts the words in attributedBody instead, as modern macOS does. */
  text?: string | null;
  attributedBody?: Buffer | null;
  /** 2000–3007 marks a tapback rather than a message. */
  associatedMessageType?: number;
  associatedGuid?: string | null;
  /** macOS 13+ edit/unsend metadata. */
  messageSummaryInfo?: Buffer | null;
  dateEdited?: number;
  dateRetracted?: number;
  handle?: string;
  service?: string;
}

export interface ChatDbSpec {
  /** 'seconds' is pre-High-Sierra; 'nanos' is macOS 10.13+. Both appear in the wild. */
  epoch?: 'seconds' | 'nanos';
  chatIdentifier?: string;
  /** More than one participant makes it a group chat, which the importer must refuse. */
  participants?: string[];
  messages: ChatDbMessage[];
  /**
   * Further conversations in the same file.
   *
   * A real chat.db holds EVERY conversation on the Mac. Building one-chat fixtures is what let a
   * whole-database participant scan pass twenty-three tests while refusing every real archive.
   */
  alsoChats?: { chatIdentifier: string; participants: string[]; messages: ChatDbMessage[] }[];
  /**
   * A schema from before macOS 13 (Ventura), which has no `date_edited` / `date_retracted` /
   * `message_summary_info` — those arrived with Edit and Unsend in 2022.
   *
   * This matters more than it looks: the seconds epoch is pre-2017, so a file old enough to
   * exercise that branch CANNOT carry the Ventura columns. A fixture builder that always writes
   * today's schema makes the older path untestable while appearing to test it.
   */
  preVentura?: boolean;
}

/** Build a real-schema chat.db at `path`. Only the columns the importer reads are populated. */
export function writeChatDb(path: string, spec: ChatDbSpec): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE handle (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      country TEXT,
      service TEXT NOT NULL,
      uncanonicalized_id TEXT
    );
    CREATE TABLE chat (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      style INTEGER,
      chat_identifier TEXT,
      service_name TEXT,
      display_name TEXT
    );
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      text TEXT,
      handle_id INTEGER DEFAULT 0,
      service TEXT,
      date INTEGER,
      date_read INTEGER,
      date_delivered INTEGER,
      is_from_me INTEGER DEFAULT 0,
      is_read INTEGER DEFAULT 0,
      cache_has_attachments INTEGER DEFAULT 0,
      associated_message_guid TEXT,
      associated_message_type INTEGER DEFAULT 0,
      attributedBody BLOB${spec.preVentura ? '' : `,
      message_summary_info BLOB,
      date_edited INTEGER DEFAULT 0,
      date_retracted INTEGER DEFAULT 0`}
    );
    CREATE TABLE chat_message_join (
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      message_date INTEGER DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE TABLE chat_handle_join (
      chat_id INTEGER NOT NULL,
      handle_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, handle_id)
    );
    CREATE TABLE attachment (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT UNIQUE NOT NULL,
      filename TEXT,
      mime_type TEXT,
      total_bytes INTEGER
    );
    CREATE TABLE message_attachment_join (
      message_id INTEGER NOT NULL,
      attachment_id INTEGER NOT NULL,
      PRIMARY KEY (message_id, attachment_id)
    );
  `);

  const epoch = spec.epoch ?? 'nanos';
  const handleId = new Map<string, number>();
  const insHandle = db.prepare(`INSERT INTO handle (id, service) VALUES (?, 'iMessage')`);
  const handleFor = (p: string): number => {
    const known = handleId.get(p);
    if (known != null) return known;
    const id = Number(insHandle.run(p).lastInsertRowid);
    handleId.set(p, id);
    return id;
  };

  const insMsg = db.prepare(spec.preVentura
    ? `INSERT INTO message (guid, text, handle_id, service, date, is_from_me, is_read,
                            associated_message_guid, associated_message_type, attributedBody)
       VALUES (@guid, @text, @handleId, 'iMessage', @date, @fromMe, 1,
               @assocGuid, @assocType, @body)`
    : `INSERT INTO message (guid, text, handle_id, service, date, is_from_me, is_read,
                            associated_message_guid, associated_message_type, attributedBody,
                            message_summary_info, date_edited, date_retracted)
       VALUES (@guid, @text, @handleId, 'iMessage', @date, @fromMe, 1,
               @assocGuid, @assocType, @body, @summary, @edited, @retracted)`);
  const insJoin = db.prepare(
    `INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)`);

  /** One chat row, its participants, and its messages. */
  let guidSeq = 0;
  const addChat = (
    chatIdentifier: string, participants: string[], messages: ChatDbMessage[], primary: boolean,
  ): void => {
    const chatId = Number(db.prepare(
      `INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, 'iMessage')`,
    ).run(`iMessage;-;${chatIdentifier};${guidSeq++}`, participants.length > 1 ? 43 : 45, chatIdentifier)
      .lastInsertRowid);
    for (const p of participants) {
      db.prepare(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`)
        .run(chatId, handleFor(p));
    }
    messages.forEach((m, i) => {
      const date = epoch === 'seconds' ? toAppleSeconds(m.ms) : toAppleNanos(m.ms);
      const who = m.handle ?? participants[0];
      // The primary chat keeps the historical guid shape, so tests that reference SYN-<i>-<ms> by
      // hand (the tapback fixtures) keep working.
      const guid = primary ? `SYN-${i}-${m.ms}` : `SYN-${chatIdentifier}-${i}-${m.ms}`;
      const bound = {
        guid,
        text: m.text === undefined ? null : m.text,
        handleId: m.fromMe ? 0 : handleFor(who),
        date,
        fromMe: m.fromMe ? 1 : 0,
        assocGuid: m.associatedGuid ?? null,
        assocType: m.associatedMessageType ?? 0,
        body: m.attributedBody ?? null,
      };
      const info = insMsg.run(spec.preVentura ? bound : {
        ...bound,
        summary: m.messageSummaryInfo ?? null,
        edited: m.dateEdited ?? 0,
        retracted: m.dateRetracted ?? 0,
      });
      insJoin.run(chatId, Number(info.lastInsertRowid), date);
    });
  };

  const participants = spec.participants ?? ['+15550100'];
  addChat(spec.chatIdentifier ?? participants[0], participants, spec.messages, true);
  for (const extra of spec.alsoChats ?? []) {
    addChat(extra.chatIdentifier, extra.participants, extra.messages, false);
  }

  db.close();
}
