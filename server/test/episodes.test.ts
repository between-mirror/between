// Between — L7 conflict-episode layer tests (T7.x). Pure clustering tests run on synthetic
// EpisodeMsg arrays with hand-computed ground truth; the DB round-trip builds a small thread via
// db.bulkInsertGraph + airlock rows (synthetic 555-01xx actors only; no real personal data).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { createAirlockStore } from '../src/airlock/store';
import {
  clusterEpisodes, refreshEpisodes, getEpisodes, kidNameMatcher,
  MIN_HOSTILE, GAP_MS, REPAIR_WINDOW_MS, KID_PROXIMITY_MS,
} from '../src/lenses/episodes';
import type { EpisodeMsg } from '../src/lenses/episodes';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';

const H = 3_600_000;
const T0 = Date.UTC(2024, 0, 1, 12, 0, 0);

let autoId = 1;
function em(partial: Partial<EpisodeMsg> & { ms: number }): EpisodeMsg {
  return { id: autoId++, me: false, tension: 0, warmth: 0, kid: false, ...partial };
}

/** N hostile messages from `them`, one minute apart, starting at `ms`. */
function burst(ms: number, n: number, over: Partial<EpisodeMsg> = {}): EpisodeMsg[] {
  return Array.from({ length: n }, (_, i) => em({ ms: ms + i * 60_000, tension: 2, ...over }));
}

describe('T7.1 clustering: gaps split, spats are filtered', () => {
  it('splits clusters at > GAP_MS and drops clusters under MIN_HOSTILE', () => {
    const a = burst(T0, MIN_HOSTILE);                       // episode
    const b = burst(T0 + GAP_MS + 2 * H, MIN_HOSTILE - 1);  // spat — dropped
    const c = burst(T0 + 3 * GAP_MS, MIN_HOSTILE + 2);      // episode
    const eps = clusterEpisodes([...a, ...b, ...c]);
    expect(eps).toHaveLength(2);
    expect(eps[0].startMsgId).toBe(a[0].id);
    expect(eps[0].endMsgId).toBe(a[a.length - 1].id);
    expect(eps[1].startMsgId).toBe(c[0].id);
  });

  it('keeps one cluster while gaps stay within GAP_MS', () => {
    const msgs = [
      ...burst(T0, 3),
      ...burst(T0 + GAP_MS - 60_000, 3), // still inside the gap window → same episode
    ];
    const eps = clusterEpisodes(msgs);
    expect(eps).toHaveLength(1);
    expect(eps[0].hostileThem).toBe(6);
  });
});

describe('T7.2 per-side attribution', () => {
  it('attributes initiator, last word, hostile/severe counts by side, peak, span count', () => {
    const msgs: EpisodeMsg[] = [
      em({ ms: T0, me: false, tension: 3 }),            // them opens, severe
      em({ ms: T0 + 1 * 60_000, me: true, tension: 0 }),// quiet reply — inside span, not hostile
      em({ ms: T0 + 2 * 60_000, me: true, tension: 2 }),
      em({ ms: T0 + 3 * 60_000, me: false, tension: 2 }),
      em({ ms: T0 + 4 * 60_000, me: false, tension: 3 }),
      em({ ms: T0 + 5 * 60_000, me: false, tension: 2 }),
      em({ ms: T0 + 6 * 60_000, me: true, tension: 3 }),// me closes, severe
    ];
    const [e] = clusterEpisodes(msgs);
    expect(e.initiator).toBe('them');
    expect(e.lastHostile).toBe('me');
    expect(e.hostileThem).toBe(4);
    expect(e.hostileMe).toBe(2);
    expect(e.severeThem).toBe(2);
    expect(e.severeMe).toBe(1);
    expect(e.peakTension).toBe(3);
    expect(e.msgCount).toBe(7); // the quiet reply inside the span still counts
  });
});

describe('T7.3 repair attribution', () => {
  it('finds the first warm message within the window and records who sent it', () => {
    const fight = burst(T0, MIN_HOSTILE);
    const end = fight[fight.length - 1].ms;
    const msgs = [
      ...fight,
      em({ ms: end + 2 * H, me: true, warmth: 1 }),   // not warm enough
      em({ ms: end + 3 * H, me: false, warmth: 2 }),  // repair — them
      em({ ms: end + 4 * H, me: true, warmth: 3 }),   // later warmth ignored
    ];
    const [e] = clusterEpisodes(msgs);
    expect(e.repairedAtMs).toBe(end + 3 * H);
    expect(e.repairedBy).toBe('them');
  });

  it('returns null when no warm message lands inside the window', () => {
    const fight = burst(T0, MIN_HOSTILE);
    const end = fight[fight.length - 1].ms;
    const msgs = [...fight, em({ ms: end + REPAIR_WINDOW_MS + H, warmth: 3 })];
    const [e] = clusterEpisodes(msgs);
    expect(e.repairedAtMs).toBeNull();
    expect(e.repairedBy).toBeNull();
  });
});

describe('T7.4 kid proximity', () => {
  it('flags a kid named inside the span and within ±KID_PROXIMITY_MS, not beyond', () => {
    const inside = burst(T0, MIN_HOSTILE);
    inside[2] = { ...inside[2], kid: true };
    expect(clusterEpisodes(inside)[0].kidNamed).toBe(true);

    const fight = burst(T0, MIN_HOSTILE);
    const end = fight[fight.length - 1].ms;
    const near = [...fight, em({ ms: end + KID_PROXIMITY_MS - 60_000, kid: true })];
    expect(clusterEpisodes(near)[0].kidNamed).toBe(true);

    const far = [...fight, em({ ms: end + KID_PROXIMITY_MS + H, kid: true })];
    expect(clusterEpisodes(far)[0].kidNamed).toBe(false);
  });
});

// ── DB round-trip ──────────────────────────────────────────────────────────
const OWNER = 1, THEM = 2, THREAD = 1;
let dk = 0;
function msg(direction: Direction, t: number, body: string): GraphMessage {
  const outgoing = direction === 'outgoing';
  return {
    threadTempId: THREAD,
    senderContactTempId: outgoing ? OWNER : THEM,
    direction, kind: 'sms', sentAtMs: t, bodyText: body,
    isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: outgoing ? 2 : 1, rawMsgBox: null, dedupKey: `e-${dk++}`,
    recipients: [{ contactTempId: outgoing ? THEM : OWNER, role: 'to' }],
    attachments: [],
  };
}

function buildGraph(times: number[]): ResolvedGraph {
  return {
    sourceFile: {
      path: 'synthetic-episodes.xml', contentSha256: 'c'.repeat(64),
      importedAt: new Date(T0).toISOString(), recordCount: times.length,
      kind: 'android_smsbackup' as const,
    },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Sam', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{
      contactTempId: THEM, rawValue: '+15555550123', normalizedE164: '+15555550123',
      kind: 'mobile', sourceContactName: 'Sam', firstSeenMs: times[0], lastSeenMs: times[times.length - 1],
    }],
    threads: [{
      tempId: THREAD, participantSignature: 'sig-episodes', isGroup: false, title: null,
      coverageConfidence: 1, coverageNote: null, primaryLang: 'en',
      firstMs: times[0], lastMs: times[times.length - 1], messageCount: times.length,
    }],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages: [
      msg('incoming', times[0], 'warm hello'),
      msg('incoming', times[1], 'angry one'),   // hostile burst: them,them,me,them,them
      msg('incoming', times[2], 'angry two about Casey'),
      msg('outgoing', times[3], 'angry back'),
      msg('incoming', times[4], 'angry three'),
      msg('incoming', times[5], 'angry four'),
      msg('outgoing', times[6], 'sorry, that got away from us'), // repair (me)
      msg('incoming', times[7], 'isolated grumble'),             // spat — below MIN_HOSTILE
    ],
  };
}

let tmpDir: string;
let db: BetweenDB;
let msgIds: number[];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-episodes-'));
  db = openDb(join(tmpDir, 'test.db'));
  const times = [
    T0, T0 + 10 * 60_000, T0 + 12 * 60_000, T0 + 14 * 60_000, T0 + 16 * 60_000,
    T0 + 18 * 60_000, T0 + 2 * H, T0 + 30 * H,
  ];
  db.bulkInsertGraph(buildGraph(times));
  msgIds = (db.raw.prepare('SELECT id FROM messages ORDER BY sent_at_ms ASC').all() as { id: number }[])
    .map((r) => r.id);

  // One L1 result covering the whole thread (airlock rows exactly as ingest writes them).
  const store = createAirlockStore(db);
  store.insertJob({
    id: 'job_test_episodes01', inputHash: 'hash_episodes01', lens: 'l1_emotion', kind: 'map',
    engineHint: 'local', priority: 0,
    chunkRef: {
      thread_id: THREAD, start_msg_id: msgIds[0], end_msg_id: msgIds[msgIds.length - 1],
      overlap_prefix_ids: [], member_ids: msgIds,
    },
    promptId: 'l1-emotion', promptVersion: 1,
  });
  const l1 = (i: number, valence: number, warmth: number, tension: number) =>
    ({ message_id: `m${msgIds[i]}`, valence, warmth, tension });
  store.upsertResult({
    inputHash: 'hash_episodes01', jobId: 'job_test_episodes01', lens: 'l1_emotion',
    result: {
      messages: [
        l1(0, 0.8, 2, 0),
        l1(1, -0.8, 0, 2), l1(2, -0.9, 0, 3), l1(3, -0.7, 0, 2), l1(4, -0.8, 0, 2), l1(5, -0.6, 0, 2),
        l1(6, 0.6, 2, 0),
        l1(7, -0.5, 0, 2),
      ],
      window: { summary: 'synthetic', notes: [] },
    },
    validation: { schema_ok: true, retries: 0 },
    refusal: { detected: false, reason: null },
    modelNote: 'test', sampleCount: 1,
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('T7.5 refreshEpisodes round-trip', () => {
  it('computes, stores, and re-reads the episode with kid + repair attribution', () => {
    db.setMeta('kid_names', JSON.stringify(['Casey']));
    const sum = refreshEpisodes(db, THREAD);
    expect(sum).toMatchObject({ total: 1, inserted: 1, updated: 0, removed: 0 });

    const [e] = getEpisodes(db, THREAD);
    expect(e.startMsgId).toBe(msgIds[1]);
    expect(e.endMsgId).toBe(msgIds[5]);
    expect(e.msgCount).toBe(5);
    expect(e.hostileThem).toBe(4);
    expect(e.hostileMe).toBe(1);
    expect(e.severeThem).toBe(1);
    expect(e.initiator).toBe('them');
    expect(e.lastHostile).toBe('them');
    expect(e.kidNamed).toBe(true);       // 'Casey' named inside the span
    expect(e.repairedBy).toBe('me');     // the apology 2h after the last hostile msg
    expect(e.narrative).toBeNull();
  });

  it('preserves narrative_json across a refresh and keeps identity stable', () => {
    const [before] = getEpisodes(db, THREAD);
    db.raw.prepare('UPDATE episodes SET narrative_json = ? WHERE id = ?')
      .run(JSON.stringify({ title: 'a hard morning' }), before.id);

    const sum = refreshEpisodes(db, THREAD);
    expect(sum).toMatchObject({ total: 1, inserted: 0, updated: 1, removed: 0 });

    const [after] = getEpisodes(db, THREAD);
    expect(after.id).toBe(before.id); // natural key held → same row
    expect(after.narrative).toEqual({ title: 'a hard morning' });
  });
});

describe('T7.6 kid names stay personalization', () => {
  it('matcher is null when unset and word-bounded when set', () => {
    const fresh = openDb(join(tmpDir, 'fresh.db'));
    try {
      expect(kidNameMatcher(fresh)).toBeNull();          // unconfigured → no matching
      fresh.setMeta('kid_names', JSON.stringify(['Sky']));
      const re = kidNameMatcher(fresh)!;
      expect(re.test('is Sky asleep?')).toBe(true);
      expect(re.test('the sky is clear')).toBe(true);    // case-insensitive by design
      expect(re.test('skylight repair')).toBe(false);    // word boundary holds
    } finally {
      fresh.close();
    }
  });
});
