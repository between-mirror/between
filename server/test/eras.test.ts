// Between — T-ERA: F2 era segmentation. Pure segmentEras() on synthetic matrices with hand-known
// shifts, then a DB round-trip (compute → store → read) that also proves era name/summary survives a
// recompute. Synthetic 555-01xx actors only; no personal data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { createAirlockStore } from '../src/airlock/store';
import { segmentEras, computeEras, refreshEras, getEras } from '../src/lenses/eras';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';

describe('T-ERA segmentEras (pure)', () => {
  const step = (n: number, at: number, hi = 5): number[][] =>
    Array.from({ length: n }, (_, i) => [i >= at ? hi : 0]);

  it('finds one split at a single clear shift', () => {
    expect(segmentEras(step(10, 5))).toEqual([{ start: 0, end: 4 }, { start: 5, end: 9 }]);
  });

  it('does not split a flat series', () => {
    expect(segmentEras(Array.from({ length: 10 }, () => [1]))).toEqual([{ start: 0, end: 9 }]);
  });

  it('respects the minimum segment length (never emits a sub-minSegment segment)', () => {
    // the real change is at index 2 (< minSegment 4); the split lands at the nearest legal boundary
    const segs = segmentEras(step(10, 2));
    expect(segs.every((s) => s.end - s.start + 1 >= 4)).toBe(true);
    expect(segs.some((s) => s.start === 0 && s.end === 1)).toBe(false); // can't isolate the first 2 months
  });

  it('does not split a noisy series with no change point (shift below the sigma floor)', () => {
    const alt = Array.from({ length: 10 }, (_, i) => [i % 2]); // 0,1,0,1,… trendless noise
    expect(segmentEras(alt)).toEqual([{ start: 0, end: 9 }]);
  });

  it('caps the era count', () => {
    // a staircase that would split many times, capped at 3
    const rows = Array.from({ length: 24 }, (_, i) => [Math.floor(i / 4)]);
    expect(segmentEras(rows, { maxEras: 3 }).length).toBe(3);
  });

  it('returns a single era when there are too few months to segment', () => {
    expect(segmentEras(step(6, 3))).toEqual([{ start: 0, end: 5 }]);
  });
});

// ── DB round-trip ──────────────────────────────────────────────────────────
const OWNER = 1, THEM = 2, THREAD = 1;
let dk = 0;
function gmsg(direction: Direction, t: number): GraphMessage {
  const outgoing = direction === 'outgoing';
  return {
    threadTempId: THREAD, senderContactTempId: outgoing ? OWNER : THEM,
    direction, kind: 'sms', sentAtMs: t, bodyText: 'x',
    isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: outgoing ? 2 : 1, rawMsgBox: null, dedupKey: `era-${dk++}`,
    recipients: [{ contactTempId: outgoing ? THEM : OWNER, role: 'to' }], attachments: [],
  };
}

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-eras-'));
  db = openDb(join(tmpDir, 'test.db'));
  const JAN = Date.UTC(2024, 0, 5, 12), FEB = Date.UTC(2024, 1, 5, 12);
  const times = [JAN, JAN + 60_000, JAN + 120_000, FEB, FEB + 60_000, FEB + 120_000];
  const graph: ResolvedGraph = {
    sourceFile: { path: 'syn-eras.xml', contentSha256: 'e'.repeat(64), importedAt: new Date(JAN).toISOString(), recordCount: times.length },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Sam', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: THEM, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Sam', firstSeenMs: times[0], lastSeenMs: times[5] }],
    threads: [{ tempId: THREAD, participantSignature: 'sig-eras', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: times[0], lastMs: times[5], messageCount: times.length }],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages: [gmsg('incoming', times[0]), gmsg('outgoing', times[1]), gmsg('incoming', times[2]),
      gmsg('incoming', times[3]), gmsg('outgoing', times[4]), gmsg('incoming', times[5])],
  };
  db.bulkInsertGraph(graph);
  const ids = (db.raw.prepare('SELECT id FROM messages ORDER BY sent_at_ms ASC').all() as { id: number }[]).map((r) => r.id);
  const store = createAirlockStore(db);
  store.insertJob({
    id: 'job_era01', inputHash: 'hash_era01', lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 0,
    chunkRef: { thread_id: THREAD, start_msg_id: ids[0], end_msg_id: ids[ids.length - 1], overlap_prefix_ids: [], member_ids: ids },
    promptId: 'l1-emotion', promptVersion: 1,
  });
  store.upsertResult({
    inputHash: 'hash_era01', jobId: 'job_era01', lens: 'l1_emotion',
    result: { messages: ids.map((_, i) => ({ message_id: `m${ids[i]}`, valence: 0, warmth: i % 2, tension: i % 2 ? 0 : 2 })), window: { summary: 's', notes: [] } },
    validation: { schema_ok: true, retries: 0 }, refusal: { detected: false, reason: null }, modelNote: 'test', sampleCount: 1,
  });
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-ERA DB round-trip + preservation', () => {
  it('computes, stores, and re-reads at least one era spanning the months', () => {
    const eras = refreshEras(db, THREAD);
    expect(eras.length).toBeGreaterThanOrEqual(1);
    expect(getEras(db, THREAD)).toEqual(eras);
    expect(eras[0].startMs).toBe(Date.UTC(2024, 0, 1)); // era starts at the first month's start
    expect(eras[0].stats).toHaveProperty('hostShareThem');
  });

  it('preserves an era name/summary across a recompute (matched by startMs)', () => {
    const eras = getEras(db, THREAD);
    eras[0].name = 'the opening';
    eras[0].summary = 'a quiet start';
    db.raw.prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, 'eras', 'all', 0, ?)`)
      .run(THREAD, JSON.stringify(eras));
    const after = refreshEras(db, THREAD);
    expect(after[0].name).toBe('the opening');
    expect(after[0].summary).toBe('a quiet start');
  });
});
