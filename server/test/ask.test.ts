// Between — T-ASK: S3 retriever. Structured filters (direction, tension, kid), FTS text match, and the
// insufficient-evidence path (empty → sufficient:false, so the UI shows the VOICE line, not a stretch).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import type { ResolvedGraph, Direction } from '../src/types';
import { seedThread } from './helpers/seed';
import { planAsk, RETRIEVAL_CAP } from '../src/lenses/ask';

const T0 = Date.UTC(2024, 0, 1, 12);

let tmpDir: string;
let db: BetweenDB;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-ask-'));
  db = openDb(join(tmpDir, 'test.db'));
  db.setMeta('kid_names', JSON.stringify(['Milo']));
  seedThread(db, [
    { dir: 'incoming', ms: T0, tension: 3, body: 'you never listen to me' },
    { dir: 'outgoing', ms: T0 + 60_000, tension: 0, body: 'I hear you, sorry' },
    { dir: 'incoming', ms: T0 + 120_000, tension: 0, body: 'Milo has a fever' },
    { dir: 'outgoing', ms: T0 + 180_000, tension: 2, body: 'stop it' },
    { dir: 'incoming', ms: T0 + 240_000, tension: 0, warmth: 2, body: 'love you' },
  ]);
});

afterAll(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

describe('T-ASK retriever', () => {
  it('filters by direction', () => {
    const p = planAsk(db, 1, '', { direction: 'them' });
    expect(p.count).toBe(3);
    expect(p.receipts.every((r) => r.dir === 'them')).toBe(true);
  });

  it('filters by tension bound', () => {
    const p = planAsk(db, 1, '', { minTension: 2 });
    expect(p.receipts.map((r) => r.tension).sort()).toEqual([2, 3]);
  });

  it('filters to kid-named messages when configured', () => {
    const p = planAsk(db, 1, '', { kidOnly: true });
    expect(p.count).toBe(1);
    expect(p.receipts[0].text).toContain('Milo');
  });

  it('matches free text via FTS', () => {
    const p = planAsk(db, 1, 'listen');
    expect(p.sufficient).toBe(true);
    expect(p.receipts.some((r) => r.text.includes('listen'))).toBe(true);
  });

  it('returns insufficient when nothing matches', () => {
    const p = planAsk(db, 1, 'zqxjkbrwv');
    expect(p.sufficient).toBe(false);
    expect(p.count).toBe(0);
  });
});

// ── P2-14 · unscored ≠ neutral ──────────────────────────────────────────────────
function unscoredGraph(): ResolvedGraph {
  const O = 1, T = 2, TH = 1, base = Date.UTC(2024, 2, 1, 12);
  const mk = (dir: Direction, i: number, body: string) => ({
    threadTempId: TH, senderContactTempId: dir === 'outgoing' ? O : T, direction: dir, kind: 'sms' as const,
    sentAtMs: base + i * 60_000, bodyText: body, isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: dir === 'outgoing' ? 2 : 1, rawMsgBox: null, dedupKey: `uns-${i}`,
    recipients: [{ contactTempId: dir === 'outgoing' ? T : O, role: 'to' as const }], attachments: [],
  });
  return {
    sourceFile: { path: 'u.xml', contentSha256: 'u'.repeat(64), importedAt: new Date(base).toISOString(), recordCount: 3, kind: 'android_smsbackup' },
    contacts: [
      { tempId: O, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: T, displayName: 'Sam', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: T, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Sam', firstSeenMs: base, lastSeenMs: base + 3 * 60_000 }],
    threads: [{ tempId: TH, participantSignature: 'sig-u', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: base, lastMs: base + 3 * 60_000, messageCount: 3 }],
    threadParticipants: [{ threadTempId: TH, contactTempId: O, role: 'owner' }, { threadTempId: TH, contactTempId: T, role: 'member' }],
    messages: [mk('outgoing', 0, 'good morning'), mk('incoming', 1, 'morning'), mk('outgoing', 2, 'coffee?')],
  };
}

describe('P2-14 unscored is not neutral', () => {
  it('a message with no L1 score carries null tension/warmth, never 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'between-ask-uns-'));
    const dbu = openDb(join(d, 'test.db'));
    try {
      dbu.bulkInsertGraph(unscoredGraph());
      const p = planAsk(dbu, 1, '', {});
      expect(p.receipts.length).toBe(3);
      for (const r of p.receipts) { expect(r.tension).toBeNull(); expect(r.warmth).toBeNull(); }
    } finally { dbu.close(); rmSync(d, { recursive: true, force: true }); }
  });
});

// ── P1-13 · honest truncation ───────────────────────────────────────────────────
describe('P1-13 honest truncation', () => {
  it('caps the match set and reports "500+" when the cap is exceeded', () => {
    const d = mkdtempSync(join(tmpdir(), 'between-ask-trunc-'));
    const dbt = openDb(join(d, 'test.db'));
    try {
      const msgs = Array.from({ length: RETRIEVAL_CAP + 5 }, (_u, i) => ({
        dir: (i % 2 === 0 ? 'outgoing' : 'incoming') as Direction, ms: T0 + i * 1000, body: `zephyrtoken note ${i}`,
      }));
      seedThread(dbt, msgs);
      const p = planAsk(dbt, 1, 'zephyrtoken');
      expect(p.truncated).toBe(true);
      expect(p.count).toBe(RETRIEVAL_CAP);
      expect(p.countLabel).toBe('500+');
    } finally { dbt.close(); rmSync(d, { recursive: true, force: true }); }
  });
});
