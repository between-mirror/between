// Between — shared domain contracts. Everything downstream builds against these.
// Data shapes only; function signatures live with their modules.

// ── enums / unions ──────────────────────────────────────────────────────────
export type Direction = 'incoming' | 'outgoing' | 'draft' | 'other';
export type MsgKind = 'sms' | 'mms';
export type AddrRole = 'from' | 'to' | 'cc' | 'bcc';
export type ReactionKind =
  | 'liked' | 'loved' | 'emphasized' | 'laughed' | 'disliked' | 'questioned';
export type RelationshipType =
  | 'partner' | 'family' | 'parent_child' | 'friend' | 'coworker' | 'unknown';
export type IdentifierKind = 'mobile' | 'shortcode' | 'email' | 'alias';

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
}
export interface GraphContact extends ResolvedContact {
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
