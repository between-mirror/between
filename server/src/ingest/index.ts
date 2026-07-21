// Orchestrates the ingestion pipeline (GAMEPLAN §2.3): hash+skip → stream parse → normalize +
// classify → resolve identities → thread → dedup → bulk insert. The app is the sole SQLite
// writer (HANDOFF invariant 2): everything below funnels into a single db.bulkInsertGraph call.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { openDb } from '../store/db';
import { parseSmsBackup } from './parse';
import { normalizeRecord } from './normalize';
import { resolveIdentities } from './identity';
import { participantSignature } from './threads';
import { computeDedupKey } from './dedup';
import { threadCoverage } from './classify';
import { refreshMetrics } from '../metrics/index';
import type { NormalizeCtx } from './normalize';
import type {
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
} from '../types';

export interface IngestOptions {
  dbPath: string;
  region?: string;
  onProgress?: (p: IngestProgress) => void;
}

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

interface ThreadAcc {
  tempId: number;
  signature: string;
  nonOwner: number[]; // sorted, distinct non-owner contact temp-ids
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
    const contentSha256 = await hashFile(xmlPath);
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
    await parseSmsBackup(xmlPath, (rec) => {
      messages.push(normalizeRecord(rec, ctx));
      parsed++;
      if (onProgress && parsed % PROGRESS_EVERY === 0) onProgress({ stage: 'parsing', parsed });
    });
    const total = messages.length;
    onProgress?.({ stage: 'normalizing', parsed: total, total });

    // ── Stage 3: identity resolution (before threading). ──
    onProgress?.({ stage: 'resolving', parsed: total, total });
    const identity = resolveIdentities(messages, region);
    const ownerTempId = identity.ownerTempId;
    const contactOf = (raw: string): number | undefined => identity.contactIdByAddress.get(raw);

    // ── Stages 4 + 5: thread reconstruction + per-message dedup key. ──
    onProgress?.({ stage: 'threading', parsed: total, total });
    const threadBySig = new Map<string, ThreadAcc>();
    let nextThreadTempId = 1;
    const graphMessages: GraphMessage[] = [];

    for (const m of messages) {
      const contactIds = new Set<number>();
      for (const a of m.addresses) {
        const cid = contactOf(a.raw);
        if (cid !== undefined) contactIds.add(cid);
      }
      const nonOwner = [...contactIds].filter((id) => id !== ownerTempId).sort((x, y) => x - y);
      const signature = participantSignature(nonOwner);

      let th = threadBySig.get(signature);
      if (!th) {
        th = {
          tempId: nextThreadTempId++,
          signature,
          nonOwner,
          isGroup: nonOwner.length > 1,
          msgs: [],
          first: m.sentAtMs,
          last: m.sentAtMs,
          langCounts: new Map(),
        };
        threadBySig.set(signature, th);
      }
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
        dedupKey: computeDedupKey(m),
        recipients,
        attachments: m.attachments,
      });
    }

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

      if (ownerTempId != null) {
        threadParticipants.push({ threadTempId: th.tempId, contactTempId: ownerTempId, role: 'owner' });
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

    // Stage 8 (GAMEPLAN §2.3): warm the Tier-1 metrics cache so the Overview opens instantly.
    // Best-effort — a metrics failure must never fail an ingest.
    try {
      for (const th of db.listThreads()) refreshMetrics(db, th.id);
    } catch {
      // non-blocking: leave the cache cold; it recomputes read-through on first request.
    }

    onProgress?.({ stage: 'done', parsed: total, total });
    return result;
  } finally {
    db.close();
  }
}
