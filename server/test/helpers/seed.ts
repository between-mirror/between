// Between — shared test fixture: seed a thread with per-message L1 scores in one call, exactly as the
// ingest + airlock path would leave them. Synthetic 555-01xx actors only; no personal data.
import { createAirlockStore } from '../../src/airlock/store';
import type { BetweenDB } from '../../src/store/db';
import type { ResolvedGraph, GraphMessage, Direction } from '../../src/types';

export interface SeedMsg {
  dir: Direction;
  ms: number;
  body?: string;
  valence?: number;
  warmth?: number;
  tension?: number;
}

/** Insert a one-thread graph + one covering L1 result. Returns the message ids in time order. */
export function seedThread(db: BetweenDB, msgs: SeedMsg[], thread = 1): number[] {
  const OWNER = 1, THEM = 2;
  let dk = 0;
  const gm = (m: SeedMsg): GraphMessage => {
    const out = m.dir === 'outgoing';
    return {
      threadTempId: thread, senderContactTempId: out ? OWNER : THEM,
      direction: m.dir, kind: 'sms', sentAtMs: m.ms, bodyText: m.body ?? 'x',
      isRead: true, isReaction: false, reactionKind: null, lang: 'en',
      rawType: out ? 2 : 1, rawMsgBox: null, dedupKey: `seed-${thread}-${dk++}`,
      recipients: [{ contactTempId: out ? THEM : OWNER, role: 'to' }], attachments: [],
    };
  };
  const t0 = msgs[0].ms, tn = msgs[msgs.length - 1].ms;
  const num = `+1555555${String(thread).padStart(4, '0')}`;
  const graph: ResolvedGraph = {
    sourceFile: { path: `syn-${thread}.xml`, contentSha256: `${thread}`.padStart(64, 's'), importedAt: new Date(t0).toISOString(), recordCount: msgs.length, kind: 'android_smsbackup' },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Sam', primaryE164: num, isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: THEM, rawValue: num, normalizedE164: num, kind: 'mobile', sourceContactName: 'Sam', firstSeenMs: t0, lastSeenMs: tn }],
    threads: [{ tempId: thread, participantSignature: `sig-${thread}`, isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: t0, lastMs: tn, messageCount: msgs.length }],
    threadParticipants: [
      { threadTempId: thread, contactTempId: OWNER, role: 'owner' },
      { threadTempId: thread, contactTempId: THEM, role: 'member' },
    ],
    messages: msgs.map(gm),
  };
  db.bulkInsertGraph(graph);
  const ids = (db.raw.prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY sent_at_ms ASC, id ASC').all(thread) as { id: number }[]).map((r) => r.id);

  const store = createAirlockStore(db);
  const jid = `job_seed_${thread}`, ih = `hash_seed_${thread}`;
  store.insertJob({
    id: jid, inputHash: ih, lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 0,
    chunkRef: { thread_id: thread, start_msg_id: ids[0], end_msg_id: ids[ids.length - 1], overlap_prefix_ids: [], member_ids: ids },
    promptId: 'l1-emotion', promptVersion: 1,
  });
  store.upsertResult({
    inputHash: ih, jobId: jid, lens: 'l1_emotion',
    result: { messages: ids.map((id, i) => ({ message_id: `m${id}`, valence: msgs[i].valence ?? 0, warmth: msgs[i].warmth ?? 0, tension: msgs[i].tension ?? 0 })), window: { summary: 's', notes: [] } },
    validation: { schema_ok: true, retries: 0 }, refusal: { detected: false, reason: null }, modelNote: 'test', sampleCount: 1,
  });
  return ids;
}
