// Between — Tier-1 metrics tests (Phase 1). Builds a small synthetic thread directly via
// db.bulkInsertGraph (no ingest/fixtures dependency) with hand-computed ground truth, then asserts
// computeMetrics against it. Synthetic 555-01xx actors only; no real personal data.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { computeMetrics, getOrComputeMetrics, refreshMetrics } from '../src/metrics/index';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';

const OWNER = 1;
const THEM = 2;
const THREAD = 1;

// Emoji built from code points so this source stays pure ASCII (no fragile invisible bytes).
const THUMB = String.fromCodePoint(0x1f44d);            // 👍
const HEART = String.fromCodePoint(0x2764, 0xfe0f);     // ❤ + VS16

// Deterministic UTC timestamps. Jan 1 2024 = Monday (dow 1), Jan 2 = Tuesday (2), Jan 4 = Thursday (4).
const D = (day: number, h: number, min: number) => Date.UTC(2024, 0, day, h, min, 0);
const M1 = D(1, 12, 0);
const M2 = D(1, 12, 5);
const M3 = D(1, 12, 15);
const M4 = D(1, 12, 20);
const M5 = D(2, 12, 0);
const M6 = D(2, 12, 10);
const M7 = D(4, 9, 0);
const M8 = D(4, 9, 3);
const M9 = D(4, 9, 5);

let dk = 0;
function msg(
  direction: Direction,
  t: number,
  body: string | null,
  lang: string | null,
  extra: Partial<GraphMessage> = {},
): GraphMessage {
  const outgoing = direction === 'outgoing';
  return {
    threadTempId: THREAD,
    senderContactTempId: outgoing ? OWNER : THEM,
    direction,
    kind: 'sms',
    sentAtMs: t,
    bodyText: body,
    isRead: true,
    isReaction: false,
    reactionKind: null,
    lang,
    rawType: outgoing ? 2 : 1,
    rawMsgBox: null,
    dedupKey: `m-${dk++}`,
    recipients: [{ contactTempId: outgoing ? THEM : OWNER, role: 'to' }],
    attachments: [],
    ...extra,
  };
}

function buildGraph(): ResolvedGraph {
  return {
    sourceFile: {
      path: 'synthetic-metrics.xml',
      contentSha256: 'b'.repeat(64),
      importedAt: new Date(M1).toISOString(),
      recordCount: 9,
    },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Sam', primaryE164: '+15555550123', isOwner: false, relationshipType: 'friend' },
    ],
    identifiers: [
      {
        contactTempId: THEM, rawValue: '+15555550123', normalizedE164: '+15555550123',
        kind: 'mobile', sourceContactName: 'Sam', firstSeenMs: M1, lastSeenMs: M9,
      },
    ],
    threads: [
      {
        tempId: THREAD, participantSignature: 'sig-sam', isGroup: false, title: null,
        coverageConfidence: 0.9, coverageNote: 'partial coverage', primaryLang: 'en',
        firstMs: M1, lastMs: M9, messageCount: 9,
      },
    ],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages: [
      msg('outgoing', M1, 'I love this, thank you so much!', 'en'),
      msg('incoming', M2, 'Absolutely wonderful, so happy!', 'en'),
      msg('outgoing', M3, 'Great, see you then', 'en'),
      msg('incoming', M4, `Sounds good ${THUMB}`, 'en'),
      msg('incoming', M5, 'Hola como estas', 'es'),
      msg('outgoing', M6, 'Muy bien gracias', 'es'),
      msg('outgoing', M7, 'Morning! how are you?', 'en'),
      msg('incoming', M8, `good thanks ${THUMB}${HEART}`, null),
      // A tapback reaction — must be excluded from every metric.
      msg('incoming', M9, 'Liked "Sounds good"', null, { isReaction: true, reactionKind: 'liked' }),
    ],
  };
}

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-metrics-'));
  db = openDb(join(tmpDir, 'test.db'));
  db.bulkInsertGraph(buildGraph());
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeMetrics — Tier-1 bundle', () => {
  const bundle = () => computeMetrics(db, THREAD, { sessionGapMinutes: 60 });

  it('excludes reactions from totals and reports direction split + sentShare', () => {
    // The DB physically holds 9 messages; metrics count only the 8 non-reaction rows.
    const stored = (db.raw.prepare('SELECT count(*) n FROM messages WHERE thread_id = ?').get(THREAD) as { n: number }).n;
    expect(stored).toBe(9);

    const s = bundle().summary;
    expect(s.totalMessages).toBe(8);
    expect(s.outCount).toBe(4);
    expect(s.inCount).toBe(4);
    expect(s.sentShare).toBe(0.5);
    expect(s.firstMs).toBe(M1);
    expect(s.lastMs).toBe(M8); // reaction M9 is later but excluded
  });

  it('buckets messages into UTC days with correct counts', () => {
    const daily = bundle().daily;
    expect(daily.map((d) => d.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-04']);

    expect(daily[0]).toMatchObject({ count: 4, outCount: 2, inCount: 2, englishShare: 1 });
    expect(daily[1]).toMatchObject({ count: 2, outCount: 1, inCount: 1 });
    expect(daily[2]).toMatchObject({ count: 2, outCount: 1, inCount: 1, englishShare: 1 });
  });

  it('gates lexicon sentiment on English: the all-Spanish day yields null sentiment / 0 share', () => {
    const b = bundle();
    const spanishDay = b.daily[1];
    expect(spanishDay.date).toBe('2024-01-02');
    expect(spanishDay.sentiment).toBeNull();
    expect(spanishDay.englishShare).toBe(0);
    expect(spanishDay.warmth).toBe(0);
    expect(spanishDay.tension).toBe(0);

    // Day 1 is all-English & positive.
    const engDay = b.daily[0];
    expect(engDay.sentiment).not.toBeNull();
    expect(engDay.sentiment as number).toBeGreaterThan(0);
    expect(engDay.warmth).toBeGreaterThan(0);

    // Overall English share (6 of 8) clears 0.5 → sentiment is trustworthy.
    expect(b.sentimentAvailable).toBe(true);
  });

  it('segments sessions at the 60-minute gap and attributes initiations', () => {
    const s = bundle().summary;
    expect(s.sessions).toBe(3);
    expect(s.initiations).toEqual({ you: 2, them: 1 });
    expect(s.avgSessionMessages).toBeCloseTo(8 / 3, 10);
  });

  it('honors a session-gap override', () => {
    // A gap larger than the whole span collapses everything into one session opened by the owner.
    const s = computeMetrics(db, THREAD, { sessionGapMinutes: 10_000 }).summary;
    expect(s.sessions).toBe(1);
    expect(s.initiations).toEqual({ you: 1, them: 0 });
  });

  it('computes cross-party reply latency (median + p90) on a hand-built exchange', () => {
    const { you, them } = bundle().summary.replyLatency;
    // you replied at +10 min twice → median & p90 = 10.
    expect(you.medianMinutes).toBe(10);
    expect(you.p90Minutes).toBe(10);
    // them replied at +5, +5, +3 → sorted [3,5,5] → median 5, p90 5.
    expect(them.medianMinutes).toBe(5);
    expect(them.p90Minutes).toBe(5);
  });

  it('computes words-per-message, question share, we-ratio, and late-night share', () => {
    const s = bundle().summary;
    expect(s.avgWordsPerMessage.you).toBeCloseTo(4.5, 10);   // 18 words / 4 msgs
    expect(s.avgWordsPerMessage.them).toBeCloseTo(3.25, 10); // 13 words / 4 msgs
    expect(s.questionShare.you).toBeCloseTo(0.25, 10);       // only "how are you?"
    expect(s.questionShare.them).toBe(0);
    expect(s.weRatio).toBe(0);        // pronouns present (i, you) but no we-token → 0, not null
    expect(s.lateNightShare).toBe(0); // nothing in 00:00–04:59 UTC
  });

  it('builds a top-emoji fingerprint (count desc)', () => {
    expect(bundle().summary.topEmoji).toEqual([
      { emoji: THUMB, count: 2 },
      { emoji: HEART, count: 1 },
    ]);
  });

  it('measures active days, longest streak and longest silence', () => {
    const s = bundle().summary;
    expect(s.activeDays).toBe(3);          // Jan 1, 2, 4
    expect(s.longestStreakDays).toBe(2);   // Jan 1–2 consecutive
    expect(s.longestSilenceDays).toBe(1);  // Jan 3 silent between Jan 2 and Jan 4
  });

  it('emits a full 7x24 heatmap whose cells sum to the message total', () => {
    const b = bundle();
    expect(b.hourDay).toHaveLength(168);
    const sum = b.hourDay.reduce((acc, c) => acc + c.count, 0);
    expect(sum).toBe(8);
    // Monday 12:00 UTC held the four Jan-1 messages.
    const mon12 = b.hourDay.find((c) => c.dow === 1 && c.hour === 12);
    expect(mon12?.count).toBe(4);
  });

  it('carries thread coverage into the bundle', () => {
    const b = bundle();
    expect(b.threadId).toBe(THREAD);
    expect(b.coverageConfidence).toBe(0.9);
    expect(b.coverageNote).toBe('partial coverage');
  });
});

describe('getOrComputeMetrics — cache', () => {
  it('writes the overview bundle to the metrics table and reads it back on a hit', () => {
    // Force a cold cache for this thread, then read through.
    db.raw.prepare('DELETE FROM metrics WHERE thread_id = ?').run(THREAD);

    const first = getOrComputeMetrics(db, THREAD);
    const cachedRow = db.raw
      .prepare(
        `SELECT value_json AS v FROM metrics
          WHERE thread_id = ? AND metric_key = 'overview_bundle' AND period = 'all' AND period_start_ms = 0`,
      )
      .get(THREAD) as { v: string } | undefined;
    expect(cachedRow).toBeDefined();

    // A second call returns the identical cached object (same generatedAt, byte-for-byte).
    const second = getOrComputeMetrics(db, THREAD);
    expect(second).toEqual(first);
    expect(JSON.parse(cachedRow!.v)).toEqual(first);
  });

  it('refreshMetrics overwrites the cache in place (single row per thread)', () => {
    refreshMetrics(db, THREAD);
    refreshMetrics(db, THREAD);
    const rows = (db.raw
      .prepare('SELECT count(*) n FROM metrics WHERE thread_id = ? AND metric_key = ?')
      .get(THREAD, 'overview_bundle') as { n: number }).n;
    expect(rows).toBe(1);
  });
});
