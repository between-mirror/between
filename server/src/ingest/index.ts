// Orchestrates the ingestion pipeline (GAMEPLAN §2.3): hash+skip → stream parse → normalize +
// classify → resolve identities → thread → dedup → bulk insert. The app is the sole SQLite
// writer (HANDOFF invariant 2): everything below funnels into a single db.bulkInsertGraph call.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { openDb } from '../store/db';
import { parseSmsBackup } from './parse';
import { normalizeRecord } from './normalize';
import { resolveIdentities } from './identity';
import {
  memberParticipantKey,
  participantSetKey,
  participantSignature,
  selfParticipantKey,
} from './threads';
import { keyBatch } from './dedup';
import { threadCoverage } from './classify';
import { refreshMetrics } from '../metrics/index';
import { parseWhatsApp } from './importers/whatsapp';
import { parseGeneric } from './importers/generic';
import { parseIMessage, resolveConversationId } from './importers/imessage';
import type { NormalizeCtx } from './normalize';
import type {
  RawRecord,
  IngestResult,
  IngestProgress,
  NormalizedMessage,
  ResolvedGraph,
  GraphMessage,
  GraphThread,
  GraphThreadParticipant,
  GraphContact,
  GraphRecipient,
  GraphSourceFile,
  RelationshipType,
  SourceKind,
  MsgKind,
  Direction,
} from '../types';

export interface IngestOptions {
  dbPath: string;
  region?: string;
  onProgress?: (p: IngestProgress) => void;
  /** WhatsApp and generic imports cannot infer which participant is the archive owner. */
  ownerName?: string;
  /** Force WhatsApp date order when the export never proves one. */
  dateOrder?: 'dmy' | 'mdy';
  /** Opt in to importers that have never been run against a real export. Off by default. */
  importersBeta?: boolean;
  /**
   * Which conversation to read from a chat.db, by chat identifier or handle.
   *
   * Required for any real one: the file holds every conversation on the Mac, and the importer
   * refuses to pick for you. The refusal named a `--conversation` flag that nothing accepted, so no
   * real multi-conversation archive could be imported through any path in the product.
   */
  conversation?: string;
}

/**
 * Which importer reads this file.
 *
 * Dispatch is by extension, and every importer emits the same RawRecord shape, so nothing below this
 * line knows the format exists. Adding one is a new file in importers/ and one case here.
 */
export function formatOf(path: string): Exclude<SourceKind, 'unknown' | 'imessage_backup'> {
  const p = path.toLowerCase();
  if (p.endsWith('.xml')) return 'android_smsbackup';
  if (p.endsWith('.txt') || p.endsWith('.zip')) return 'whatsapp_txt';
  if (p.endsWith('.db') || p.endsWith('.sqlite')) return 'imessage_chatdb';
  return 'generic_jsonl';
}

/**
 * Formats that are built and tested but have never been run against a real export.
 *
 * Everything behind an importer can be proven except the one thing that matters most: that the file
 * a stranger actually has looks like the file it was developed against. For iMessage that gap is
 * unusually wide — the fixtures are synthetic because the only real chat.db files in existence are
 * somebody's messages — so it stays behind a flag, saying so, until two volunteers have read real
 * files with it cleanly. The claim moves when the evidence does, not when the code lands.
 */
export const BETA_FORMATS = new Set<SourceKind>(['imessage_chatdb']);

export class ImporterBetaRequired extends Error {}

const PROGRESS_EVERY = 5000;

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(path);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * What a record CARRIES, as a fingerprint. Never its identity — see the warning below.
 *
 * `m_id` is an OPTIONAL attribute (SMS Backup & Restore writes the literal "null" when it has none),
 * and where a bucket has no source id the occurrence ranking falls back to the exact timestamp.
 * Android MMS dates arrive at second precision, so a burst of photos shares an instant AND an empty
 * body, and all of them collapsed onto one row — real messages gone, reported to the owner as
 * "duplicates collapsed at import". The attachment manifest is what tells those three apart.
 *
 * It was briefly used as the `nativeId` itself, and that was worse than the problem. A native id
 * means "the source says this is a distinct record", and content does not: two sends of the SAME
 * photo, or two ordinary text MMS whose only attachment is the SMIL layout part, have identical
 * manifests and are different messages. As an identity it merged them across different timestamps —
 * the exact loss it was written to prevent, over a wider population. It now separates rows only
 * within one exact instant, where the timestamp cannot separate them and nothing else can either.
 */
function contentNativeId(m: NormalizedMessage): string | null {
  if (m.attachments.length === 0) return null;
  const manifest = m.attachments
    .map((a) => JSON.stringify([a.mimeType, a.filename, a.sizeBytes, a.sha256, a.isSmil]))
    .sort()
    .join('|');
  return `content:${createHash('sha256').update(manifest).digest('hex').slice(0, 16)}`;
}

interface ThreadAcc {
  tempId: number;
  signature: string;
  nonOwner: number[]; // sorted, distinct non-owner contact temp-ids
  /**
   * The contact temp-ids in this thread that ARE the owner. Usually one, and usually the same as
   * `ownerTempId` — but when this file was too small to reveal the owner and the archive already
   * knew them, it is recognised by key instead, and nothing else in this file would record them as
   * a participant at all.
   */
  owners: Set<number>;
  isGroup: boolean;
  msgs: NormalizedMessage[];
  first: number;
  last: number;
  langCounts: Map<string, number>;
}

export async function ingestFile(xmlPath: string, opts: IngestOptions): Promise<IngestResult> {
  const started = Date.now();
  const region = opts.region ?? 'US';
  const onProgress = opts.onProgress;
  const db = openDb(opts.dbPath);

  try {
    // ── Stage 1: hash the source file; skip entirely if already fully imported (T0.9). ──
    // The identity of what is being imported, not merely of the file. A chat.db holds every
    // conversation on the Mac and is imported ONE conversation at a time, so keying the skip on the
    // file alone meant the first conversation imported and every later one reported
    // "alreadyImported", zero rows, exit 0 — with no way to ever get the rest in. The flag that made
    // a real chat.db importable would have made all but one of its conversations unreachable.
    // Keyed on the conversation the request RESOLVES to, not on the string that was typed: a
    // conversation can be named by its identifier or by any of its handles, and hashing the raw
    // string let the same conversation import again under each spelling.
    const fileSha256 = await hashFile(xmlPath);
    const chosenId = formatOf(xmlPath) === 'imessage_chatdb'
      ? resolveConversationId(xmlPath, opts.conversation) : null;
    const contentSha256 = chosenId
      ? createHash('sha256').update(fileSha256 + '|' + chosenId).digest('hex')
      : fileSha256;
    const existing = db.getSourceFileByHash(contentSha256);
    if (existing) {
      return {
        sourceFileId: existing.id,
        alreadyImported: true,
        smsCount: 0,
        mmsCount: 0,
        messageRows: 0,
        reactionCount: 0,
        contacts: 0,
        threads: 0,
        durationMs: Date.now() - started,
      };
    }

    // ── Stage 2: streaming parse + per-record normalize (media discarded to metadata). ──
    // sourceFileId is assigned by the store at insert time; the placeholder here never reaches
    // the graph (GraphMessage carries no source id — db.ts stamps it uniformly).
    const ctx: NormalizeCtx = { region, sourceFileId: 0 };
    const messages: NormalizedMessage[] = [];
    let parsed = 0;
    const emit = (rec: RawRecord): void => {
      messages.push(normalizeRecord(rec, ctx));
      parsed++;
      if (onProgress && parsed % PROGRESS_EVERY === 0) onProgress({ stage: 'parsing', parsed });
    };
    const format = formatOf(xmlPath);
    if (BETA_FORMATS.has(format) && !opts.importersBeta) {
      throw new ImporterBetaRequired(
        `The iMessage importer is unverified on real archives — help us verify it. It is built and `
        + `tested, but every fixture behind it is synthetic, because the only real chat.db files that `
        + `exist are somebody's own messages. Re-run with --importers-beta if you are willing to be `
        + `one of the people it gets proven on, and say how it went in the waitlist discussion. It is `
        + `read-only: nothing is written to the file you point it at.`,
      );
    }
    // Rows an importer could not read. It counts them and says why, and the only call site used to
    // throw the whole report away — so a file whose dates were in an unreadable format imported
    // silently short, with nothing anywhere saying how much of it never arrived. An archive being
    // quietly smaller than the life it came from is this product's defining failure.
    let unreadRows = 0;
    let unreadWhy: string[] = [];
    if (format === 'android_smsbackup') await parseSmsBackup(xmlPath, emit);
    else if (format === 'whatsapp_txt') parseWhatsApp(xmlPath, emit, { ownerName: opts.ownerName, dateOrder: opts.dateOrder });
    else if (format === 'imessage_chatdb') {
      const scan = parseIMessage(xmlPath, emit, {
        ownerName: opts.ownerName, conversation: opts.conversation,
      });
      // Rows the importer counted and then skipped. The counter existed and its only caller threw
      // it away, so a chat.db could import short while the result affirmatively reported zero
      // unreadable rows. (`unreadable` is not counted here: those rows ARE imported, as
      // [unreadable message], which is the point of them.)
      if (scan.undated > 0) {
        unreadRows = scan.undated;
        unreadWhy = [`${scan.undated} messages carry no timestamp and cannot be placed in the `
          + 'conversation, so they were not imported.'];
      }
    }
    else {
      const scan = parseGeneric(xmlPath, emit, { ownerName: opts.ownerName });
      unreadRows = scan.skipped;
      unreadWhy = scan.problems;
    }
    const total = messages.length;
    onProgress?.({ stage: 'normalizing', parsed: total, total });

    // ── Stage 3: identity resolution (before threading). ──
    onProgress?.({ stage: 'resolving', parsed: total, total });
    const identity = resolveIdentities(messages, region);
    const ownerTempId = identity.ownerTempId;
    const contactOf = (raw: string): number | undefined => identity.contactIdByAddress.get(raw);
    // Natural key per contact — what the thread signature and the dedup key are built from, so both
    // survive a second import that numbered the same people differently.
    const keyOfContact = new Map(identity.contacts.map((c) => [c.tempId, c.key]));
    // Who the owner is is a fact about the ARCHIVE, not about this file. The heuristic needs a
    // person who appears with more than one other person, so a file holding a single conversation
    // cannot produce one — and the owner then falls in among the counterparties, giving the same
    // conversation a two-participant key here and a one-participant key in a fuller import. Once any
    // import has identified them, every later import reads it from the store rather than re-deriving
    // it from whatever this file happens to contain.
    const knownOwnerKeys = db.getOwnerKeys();
    // Anyone this archive knows to be the owner, plus anyone this file worked out to be — a plain
    // union, decided per contact, and independent of what else the file happens to contain.
    //
    // Two narrower rules were tried first and both failed, in opposite directions. Taking ONLY the
    // archive's answer filed the real owner of a second handset's backup as an ordinary
    // participant, so every 1:1 conversation in it became a group thread and its messages were
    // written twice. Making that conditional on whether the archive's owner appeared in the file
    // then made a thread's key depend on which OTHER conversations shared the file with it, so two
    // cumulative backups of the same conversation could disagree.
    //
    // The union was originally rejected because excluding two different people left a conversation
    // between them with an EMPTY participant set, and an empty key list hashed to one constant that
    // every such thread landed on. That constant is what actually caused the merges, and it is gone
    // — a thread with no counterpart is now keyed on whose self it is, below. With the constant
    // fixed at its source, the simplest rule is also the safe one.
    const isOwnerContact = (id: number): boolean => {
      if (id === ownerTempId) return true;
      const key = keyOfContact.get(id);
      return key != null && knownOwnerKeys.has(key);
    };

    // ── Stages 4 + 5: thread reconstruction + per-message dedup key. ──
    onProgress?.({ stage: 'threading', parsed: total, total });
    const threadBySig = new Map<string, ThreadAcc>();
    let nextThreadTempId = 1;
    const graphMessages: GraphMessage[] = [];
    /** Parallel to graphMessages: each message's counterpart key(s), for the dedup pass below. */
    const counterpartOf: string[] = [];
    /** Parallel to graphMessages: the source's own id for the record, where it has one. */
    const nativeIdOf: (string | null)[] = [];
    /** Parallel to graphMessages: what each record carries, to separate rows sharing one instant. */
    const contentOf: string[] = [];

    for (const m of messages) {
      const contactIds = new Set<number>();
      for (const a of m.addresses) {
        const cid = contactOf(a.raw);
        if (cid !== undefined) contactIds.add(cid);
      }
      const nonOwner = [...contactIds].filter((id) => !isOwnerContact(id)).sort((x, y) => x - y);
      // A conversation with no counterpart is a note to self, and it must be keyed on WHOSE self.
      //
      // An empty key list hashes to one constant — the same signature for every owner-only thread in
      // every archive — and that constant has now been the merge point for three separate defects in
      // this leg: two flagged owners, an ORed owner rule, and a file whose owner the archive has not
      // met. Each fix moved which contacts fall out of the key; none of them stopped an empty result
      // from meaning "the same conversation as every other empty result". Two people's private
      // notes-to-self landed in one thread, and where they also shared a minute and a body, one of
      // the two messages was dropped as a duplicate.
      //
      // Naming the owner in the key ends that class: a note to self belongs to somebody. A
      // structural role tag keeps it out of the space of ordinary counterpart keys, so it cannot
      // collide with a real conversation whose source identifier happens to look special.
      const ownerKeys = [...contactIds].filter(isOwnerContact)
        .map((id) => selfParticipantKey(keyOfContact.get(id) ?? String(id))).sort();
      const counterpartKeys = nonOwner.length > 0
        ? nonOwner.map((id) => memberParticipantKey(keyOfContact.get(id) ?? String(id))).sort()
        : ownerKeys;
      const signature = participantSignature(counterpartKeys);

      let th = threadBySig.get(signature);
      if (!th) {
        th = {
          tempId: nextThreadTempId++,
          signature,
          nonOwner,
          owners: new Set<number>(),
          isGroup: nonOwner.length > 1,
          msgs: [],
          first: m.sentAtMs,
          last: m.sentAtMs,
          langCounts: new Map(),
        };
        threadBySig.set(signature, th);
      }
      for (const id of contactIds) if (isOwnerContact(id)) th.owners.add(id);
      th.msgs.push(m);
      if (m.sentAtMs < th.first) th.first = m.sentAtMs;
      if (m.sentAtMs > th.last) th.last = m.sentAtMs;
      if (m.lang) th.langCounts.set(m.lang, (th.langCounts.get(m.lang) ?? 0) + 1);

      // Sender: owner for anything the owner composed; the from-address contact for inbound.
      let sender: number | null;
      if (m.direction === 'incoming') {
        const from = m.addresses.find((a) => a.role === 'from') ?? m.addresses[0];
        sender = from ? contactOf(from.raw) ?? null : null;
      } else if (m.direction === 'outgoing' || m.direction === 'draft') {
        sender = ownerTempId;
      } else {
        sender = null;
      }

      // Recipients (group-MMS addr roles); dedup on (contact, role).
      const recipients: GraphRecipient[] = [];
      const seenRec = new Set<string>();
      for (const a of m.addresses) {
        const cid = contactOf(a.raw);
        if (cid === undefined) continue;
        const k = `${cid}:${a.role}`;
        if (seenRec.has(k)) continue;
        seenRec.add(k);
        recipients.push({ contactTempId: cid, role: a.role });
      }

      graphMessages.push({
        threadTempId: th.tempId,
        senderContactTempId: sender,
        direction: m.direction,
        kind: m.kind,
        sentAtMs: m.sentAtMs,
        bodyText: m.bodyText,
        isRead: m.isRead,
        isReaction: m.isReaction,
        reactionKind: m.reactionKind,
        lang: m.lang,
        rawType: m.rawType,
        rawMsgBox: m.rawMsgBox,
        dedupKey: '', // assigned in one pass below — the occurrence index needs the whole batch
        recipients,
        attachments: m.attachments,
      });
      counterpartOf.push(participantSetKey(counterpartKeys));
      nativeIdOf.push(m.mmsMId ?? null);
      contentOf.push(contentNativeId(m) ?? '');
    }

    // ── Stage 5b: the canonical dedup keys, keyed over the batch as a whole. ──
    // The occurrence index that keeps two same-minute "ok"s apart can only be assigned once every
    // message in the file is visible, so it cannot be done in the loop above.
    const keys = keyBatch(graphMessages, (m, i) => ({
      counterpart: counterpartOf[i],
      direction: m.direction,
      sentAtMs: m.sentAtMs,
      bodyText: m.bodyText,
      // The source's own id for this record, where it has one. MMS carries m_id; three photos sent
      // in the same second are three records to the phone and must stay three here.
      nativeId: nativeIdOf[i],
      contentDigest: contentOf[i],
    }));
    for (let i = 0; i < graphMessages.length; i++) graphMessages[i].dedupKey = keys[i];

    // ── Assemble threads + participants from the accumulators. ──
    const graphThreads: GraphThread[] = [];
    const threadParticipants: GraphThreadParticipant[] = [];
    for (const th of threadBySig.values()) {
      const { confidence, note } = threadCoverage(
        th.msgs.map((m) => ({ sentAtMs: m.sentAtMs, kind: m.kind, direction: m.direction })),
      );
      let primaryLang: string | null = null;
      const ranked = [...th.langCounts.entries()].sort(
        (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
      );
      if (ranked.length) primaryLang = ranked[0][0];

      graphThreads.push({
        tempId: th.tempId,
        participantSignature: th.signature,
        isGroup: th.isGroup,
        title: null,
        coverageConfidence: confidence,
        coverageNote: note,
        primaryLang,
        firstMs: th.first,
        lastMs: th.last,
        messageCount: th.msgs.length,
      });

      // The owner belongs to every thread in the archive, whether or not this file's addresses
      // happened to name them — an SMS row carries only the counterpart. The second loop is for the
      // case where THIS file could not identify the owner but the archive already had: that contact
      // is in the thread's messages, is excluded from its key, and would otherwise be filed in no
      // role at all.
      if (ownerTempId != null) {
        threadParticipants.push({ threadTempId: th.tempId, contactTempId: ownerTempId, role: 'owner' });
      }
      for (const cid of th.owners) {
        if (cid === ownerTempId) continue;
        threadParticipants.push({ threadTempId: th.tempId, contactTempId: cid, role: 'owner' });
      }
      for (const cid of th.nonOwner) {
        threadParticipants.push({ threadTempId: th.tempId, contactTempId: cid, role: 'member' });
      }
    }

    // ── Stage 6: assemble the resolved graph and hand it to the sole writer. ──
    const contacts: GraphContact[] = identity.contacts.map((c) => ({
      ...c,
      relationshipType: 'unknown' as RelationshipType,
    }));
    const sourceFile: GraphSourceFile = {
      path: xmlPath,
      contentSha256,
      importedAt: new Date().toISOString(),
      recordCount: total,
      kind: format,
    };
    const graph: ResolvedGraph = {
      sourceFile,
      contacts,
      identifiers: identity.identifiers,
      threads: graphThreads,
      threadParticipants,
      messages: graphMessages,
    };

    onProgress?.({ stage: 'writing', parsed: total, total });
    const result = db.bulkInsertGraph(graph);

    // Coverage is recomputed over the thread's whole contents, not this file's slice of it. A gap in
    // one source that a second source fills is not a gap, and a thread that still reads quiet after
    // both imports genuinely is — but only the union can tell you which.
    const allOf = db.raw.prepare(
      `SELECT sent_at_ms AS sentAtMs, kind, direction FROM messages WHERE thread_id = ? ORDER BY sent_at_ms`);
    const setCoverage = db.raw.prepare(
      `UPDATE threads SET coverage_confidence = ?, coverage_note = ? WHERE id = ?`);
    for (const th of db.listThreads()) {
      const rows = allOf.all(th.id) as { sentAtMs: number; kind: MsgKind; direction: Direction }[];
      const { confidence, note } = threadCoverage(rows);
      setCoverage.run(confidence, note, th.id);
    }

    // Stage 8 (GAMEPLAN §2.3): warm the Tier-1 metrics cache so the Overview opens instantly.
    // Best-effort — a metrics failure must never fail an ingest.
    try {
      for (const th of db.listThreads()) refreshMetrics(db, th.id);
    } catch {
      // non-blocking: leave the cache cold; it recomputes read-through on first request.
    }

    onProgress?.({ stage: 'done', parsed: total, total });
    return { ...result, unreadableRows: unreadRows, unreadableWhy: unreadWhy };
  } finally {
    db.close();
  }
}
