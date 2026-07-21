// Between Mirror — thread-level model coverage, wired to the surface (Era 1, v0.3.0).
//
// The number was already computed and already honest. It just didn't gate anything: /emotion reported
// coverage and the river drew the model layer regardless. These tests pin the contract the UI needs —
// the exact field names, and modelComplete flipping at the floor in both directions.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type BetweenDB } from '../src/store/db';
import { createAirlockStore } from '../src/airlock/store';
import { emotionCoverage, L1_COVERAGE_FLOOR } from '../src/lenses/l1';
import type { ResolvedGraph, GraphMessage } from '../src/types';

let tmp: string;
let db: BetweenDB;

const BASE = Date.UTC(2024, 0, 1, 9, 0, 0);

function graph(n: number): ResolvedGraph {
  const messages: GraphMessage[] = Array.from({ length: n }, (_u, i) => ({
    threadTempId: 1, senderContactTempId: i % 2 === 0 ? 1 : 2,
    direction: (i % 2 === 0 ? 'outgoing' : 'incoming') as GraphMessage['direction'],
    kind: 'sms' as const, sentAtMs: BASE + i * 60_000, bodyText: `a message number ${i}`,
    isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: i % 2 === 0 ? 2 : 1, rawMsgBox: null, dedupKey: `cov-${i}`,
    recipients: [{ contactTempId: i % 2 === 0 ? 2 : 1, role: 'to' as const }], attachments: [],
  }));
  return {
    sourceFile: { path: 'syn.xml', contentSha256: 'c'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: n },
    contacts: [
      { tempId: 1, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: 2, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: 2, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Robin', firstSeenMs: BASE, lastSeenMs: BASE + n * 60_000 }],
    threads: [{ tempId: 1, participantSignature: 'sig', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: BASE, lastMs: BASE + n * 60_000, messageCount: n }],
    threadParticipants: [
      { threadTempId: 1, contactTempId: 1, role: 'owner' as const },
      { threadTempId: 1, contactTempId: 2, role: 'member' as const },
    ],
    messages,
  };
}

/** A drained L1 window covering exactly `k` of the thread's messages — what a partial drain leaves
 *  behind. Scores live in airlock results, not a table of their own, so this seeds the real path. */
function scoreMessages(k: number, opts: { refused?: number; errored?: number } = {}): void {
  const ids = (db.raw.prepare('SELECT id FROM messages WHERE thread_id = 1 ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const store = createAirlockStore(db);
  const chunk = { thread_id: 1, start_msg_id: ids[0], end_msg_id: ids[ids.length - 1], overlap_prefix_ids: [], member_ids: [1, 2] };

  if (k > 0) {
    const jobId = 'job-scored';
    const inputHash = `sha256:${'a'.repeat(64)}`;
    store.insertJob({ id: jobId, inputHash, lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 1, chunkRef: chunk, promptId: 'l1-emotion', promptVersion: 1 });
    store.upsertResult({
      inputHash, jobId, lens: 'l1_emotion',
      result: {
        messages: ids.slice(0, k).map((id) => ({ message_id: `m${id}`, valence: 0.1, warmth: 1, tension: 0 })),
        window: { summary: 'a stretch', notes: [] },
      },
      validation: null, refusal: null, modelNote: null, sampleCount: 0,
    });
    store.setJobStatus(jobId, 'done', null);
  }

  // Refusals and errors are windows, not messages: they are why coverage is short, and the surface
  // has to be able to say so rather than presenting a thin river as a calm one.
  for (let i = 0; i < (opts.refused ?? 0); i++) {
    const id = `job-refused-${i}`;
    store.insertJob({ id, inputHash: `sha256:${'b'.repeat(63)}${i}`, lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 1, chunkRef: chunk, promptId: 'l1-emotion', promptVersion: 1 });
    store.setJobStatus(id, 'refused', 'declined');
  }
  for (let i = 0; i < (opts.errored ?? 0); i++) {
    const id = `job-errored-${i}`;
    store.insertJob({ id, inputHash: `sha256:${'c'.repeat(63)}${i}`, lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 1, chunkRef: chunk, promptId: 'l1-emotion', promptVersion: 1 });
    store.setJobStatus(id, 'error', 'boom');
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'between-cov-'));
  db = openDb(join(tmp, 'test.db'));
  db.bulkInsertGraph(graph(100));
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('the coverage floor', () => {
  it('is 95%', () => {
    expect(L1_COVERAGE_FLOOR).toBe(0.95);
  });

  it('94 of 100 scored → NOT model-complete', () => {
    scoreMessages(94);
    const c = emotionCoverage(db, 1);
    expect(c.eligibleMessages).toBe(100);
    expect(c.scoredMessages).toBe(94);
    expect(c.coveragePct).toBe(94);
    expect(c.modelComplete).toBe(false);
  });

  it('96 of 100 scored → model-complete', () => {
    scoreMessages(96);
    const c = emotionCoverage(db, 1);
    expect(c.scoredMessages).toBe(96);
    expect(c.coveragePct).toBe(96);
    expect(c.modelComplete).toBe(true);
  });

  it('exactly at the floor counts as complete', () => {
    scoreMessages(95);
    expect(emotionCoverage(db, 1).modelComplete).toBe(true);
  });

  it('an undrained thread is 0%, not complete, and does not divide by zero', () => {
    const c = emotionCoverage(db, 1);
    expect(c.scoredMessages).toBe(0);
    expect(c.coveragePct).toBe(0);
    expect(c.modelComplete).toBe(false);
  });

  it('reports refused and errored windows rather than absorbing them', () => {
    const c = emotionCoverage(db, 1);
    expect(c).toHaveProperty('refusedWindows');
    expect(c).toHaveProperty('erroredWindows');
    expect(typeof c.refusedWindows).toBe('number');
    expect(typeof c.erroredWindows).toBe('number');
  });

  it('rounds the percentage without ever rounding up to complete', () => {
    // 949/1000 would print as 95% but is below the floor. Printing "95%" beside a deterministic river
    // is confusing; claiming completeness because of a rounding artifact is worse. The flag reads the
    // exact ratio, never the rounded one.
    scoreMessages(94);
    const c = emotionCoverage(db, 1);
    expect(c.coverage).toBeLessThan(L1_COVERAGE_FLOOR);
    expect(c.modelComplete).toBe(false);
  });
});

// Found by the pre-v0.3.0 adversarial review: the refused/errored counts came from every lens's jobs,
// so a declined episode-patterns or render job made the river say "1 stretch was declined — those
// messages are still here to read yourself" beside 100% emotion coverage. The sentence is about the
// EMOTION pass; counting anything else makes it a false explanation of a number that is not short.
describe('the window counts are about the emotion pass, and nothing else', () => {
  it('a refused job from another lens does not count against L1 coverage', () => {
    scoreMessages(100);
    const store = createAirlockStore(db);
    const ids = (db.raw.prepare('SELECT id FROM messages WHERE thread_id = 1 ORDER BY id').all() as { id: number }[]).map((r) => r.id);
    const chunk = { thread_id: 1, start_msg_id: ids[0], end_msg_id: ids[ids.length - 1], overlap_prefix_ids: [], member_ids: [1, 2] };
    store.insertJob({
      id: 'job-other-lens', inputHash: `sha256:${'e'.repeat(64)}`, lens: 'l4_episode_patterns',
      kind: 'map', engineHint: 'local', priority: 1, chunkRef: chunk, promptId: 'l4', promptVersion: 1,
    });
    store.setJobStatus('job-other-lens', 'refused', 'declined');

    const c = emotionCoverage(db, 1);
    expect(c.modelComplete).toBe(true);
    expect(c.refusedWindows, 'a non-L1 refusal is being blamed on emotion coverage').toBe(0);
  });
});
