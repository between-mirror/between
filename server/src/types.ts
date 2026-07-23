// Between — shared domain contracts. Everything downstream builds against these.
// Data shapes only; function signatures live with their modules.

// ── enums / unions ──────────────────────────────────────────────────────────
export type Direction = 'incoming' | 'outgoing' | 'draft' | 'other';
export type MsgKind = 'sms' | 'mms';
export type AddrRole = 'from' | 'to' | 'cc' | 'bcc';
export type ReactionKind =
  // 'other' is a reaction whose sentiment is not recoverable: iMessage's sticker and any-emoji
  // tapbacks say only THAT someone reacted, and inventing one of the six named kinds for them
  // would be a reading of feeling that nothing in the archive supports.
  | 'liked' | 'loved' | 'emphasized' | 'laughed' | 'disliked' | 'questioned' | 'other';
export type RelationshipType =
  | 'partner' | 'family' | 'parent_child' | 'friend' | 'coworker' | 'unknown';
export type IdentifierKind = 'mobile' | 'shortcode' | 'email' | 'alias';

/**
 * Which export a row came from. Recorded per source file AND denormalized onto every message, so a
 * thread assembled from two formats can report each one's span without a join.
 *
 * `unknown` is reachable only by migration: it marks rows imported before Between recorded this,
 * whose format could not be derived from the path it kept. No ingest path may write it — an import
 * that cannot name its own format is a bug, not a category.
 */
export type SourceKind =
  | 'android_smsbackup'
  | 'whatsapp_txt'
  | 'imessage_chatdb'
  | 'imessage_backup'
  | 'generic_jsonl'
  | 'unknown';

// ── raw parse output (strings straight from XML; "null" not yet coerced) ─────
export interface RawSms {
  kind: 'sms';
  attrs: Record<string, string>;
}
export interface RawMmsPart {
  attrs: Record<string, string>;
}
export interface RawMmsAddr {
  attrs: Record<string, string>;
}
export interface RawMms {
  kind: 'mms';
  attrs: Record<string, string>;
  parts: RawMmsPart[];
  addrs: RawMmsAddr[];
}
export type RawRecord = RawSms | RawMms;

// ── normalized (record-level; before identity resolution & threading) ───────
export interface NormalizedAttachment {
  mimeType: string;
  filename: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  isSmil: boolean;
}
export interface NormalizedAddress {
  raw: string;
  e164: string | null;
  role: AddrRole; // sms: 'from' if incoming else 'to'; mms: from <addr type>
}
export interface NormalizedMessage {
  kind: MsgKind;
  direction: Direction;
  sentAtMs: number; // epoch ms UTC — primary sort key
  bodyText: string | null;
  isRead: boolean | null;
  isReaction: boolean;
  reactionKind: ReactionKind | null;
  lang: string | null;
  rawType: number | null; // sms @type
  rawMsgBox: number | null; // mms @msg_box
  addresses: NormalizedAddress[]; // counterpart(ies); owner marked during identity
  contactNameHint: string | null; // backup-time label, display hint only
  attachments: NormalizedAttachment[];
  mmsMId: string | null; // mms @m_id, preferred dedup anchor when present
  partCount: number;
  sourceFileId: number;
}

// ── identity resolution output ──────────────────────────────────────────────
export interface ResolvedContact {
  tempId: number;
  /**
   * The cluster's natural key — E.164 when it resolved, else the raw address. Stable across files,
   * which tempId is not: tempIds are handed out in first-encounter order, so the same two people
   * are numbered differently by two backups of the same phone. Anything that has to survive a
   * second import (thread signatures, dedup keys, contact merges) keys on this.
   */
  key: string;
  displayName: string | null;
  primaryE164: string | null;
  isOwner: boolean;
}
export interface ResolvedIdentifier {
  contactTempId: number;
  rawValue: string;
  normalizedE164: string | null;
  kind: IdentifierKind;
  sourceContactName: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
}
export interface IdentityResult {
  contactIdByAddress: Map<string, number>; // raw address -> contact tempId
  contacts: ResolvedContact[];
  identifiers: ResolvedIdentifier[];
  ownerTempId: number | null;
}

// ── the resolved graph handed to db.bulkInsertGraph ─────────────────────────
export interface GraphSourceFile {
  path: string;
  contentSha256: string;
  importedAt: string; // ISO
  recordCount: number;
  kind: SourceKind;
}
// `key` is identity-resolution's business — it is what the thread signature is built from before
// the graph is assembled, and nothing downstream of that reads it back.
export interface GraphContact extends Omit<ResolvedContact, 'key'> {
  relationshipType: RelationshipType;
}
export interface GraphThread {
  tempId: number;
  participantSignature: string;
  isGroup: boolean;
  title: string | null;
  coverageConfidence: number;
  coverageNote: string | null;
  primaryLang: string | null;
  firstMs: number | null;
  lastMs: number | null;
  messageCount: number;
}
export interface GraphThreadParticipant {
  threadTempId: number;
  contactTempId: number;
  role: 'owner' | 'member';
}
export interface GraphRecipient {
  contactTempId: number;
  role: AddrRole;
}
export interface GraphMessage {
  threadTempId: number;
  senderContactTempId: number | null;
  direction: Direction;
  kind: MsgKind;
  sentAtMs: number;
  bodyText: string | null;
  isRead: boolean | null;
  isReaction: boolean;
  reactionKind: ReactionKind | null;
  lang: string | null;
  rawType: number | null;
  rawMsgBox: number | null;
  dedupKey: string;
  recipients: GraphRecipient[];
  attachments: NormalizedAttachment[];
}

/** Per-source span within one thread — the honest unit of coverage once formats mix. */
export interface SourceSpan {
  kind: SourceKind;
  firstMs: number;
  lastMs: number;
  messages: number;
}
export interface ResolvedGraph {
  sourceFile: GraphSourceFile;
  contacts: GraphContact[];
  identifiers: ResolvedIdentifier[];
  threads: GraphThread[];
  threadParticipants: GraphThreadParticipant[];
  messages: GraphMessage[];
}

// ── ingest results / progress ───────────────────────────────────────────────
export interface IngestProgress {
  stage: 'parsing' | 'normalizing' | 'resolving' | 'threading' | 'writing' | 'done';
  parsed: number;
  total?: number;
}
export interface IngestResult {
  sourceFileId: number;
  alreadyImported: boolean;
  smsCount: number;
  mmsCount: number;
  messageRows: number; // rows actually inserted (post-dedup)
  reactionCount: number;
  contacts: number;
  threads: number;
  durationMs: number;
  /**
   * Rows the importer could not read, and why — never silently discarded.
   *
   * The generic importer refuses a row with an unreadable date rather than guessing at it, which is
   * right; it counted those and described them, and the caller threw the report away. A file that
   * imports short with nothing saying so is the quiet version of this product's worst failure.
   */
  unreadableRows?: number;
  unreadableWhy?: string[];
}

// ── API DTOs (read side) ────────────────────────────────────────────────────
export interface ThreadSummary {
  id: number;
  title: string | null;
  isGroup: boolean;
  displayName: string;
  messageCount: number;
  firstMs: number | null;
  lastMs: number | null;
  coverageConfidence: number;
  coverageNote: string | null;
  sentCount: number;
  receivedCount: number;
}
export interface MessageDTO {
  id: number;
  direction: Direction;
  kind: MsgKind;
  sentAtMs: number;
  bodyText: string | null;
  isReaction: boolean;
  reactionKind: ReactionKind | null;
  senderName: string | null;
  attachmentCount: number;
}
export interface SearchHit {
  messageId: number;
  threadId: number;
  threadName: string;
  sentAtMs: number;
  direction: Direction;
  snippet: string;
}
export interface MomentDTO {
  key: string;
  label: string;
  value: string;
  messageIds: number[];
}
export interface ContactSummary {
  id: number;
  displayName: string | null;
  primaryE164: string | null;
  isOwner: boolean;
  relationshipType: RelationshipType;
  isDeceased: boolean;
  messageCount: number;
}
