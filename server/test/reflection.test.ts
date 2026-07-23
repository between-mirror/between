// Between — First Reflection tests (docs/TESTING.md §4, T2.10). Synthetic data only; the mock engine
// stands in for a real drain. Exercises the gates (evidence floor, grief) with the VERBATIM VOICE
// decline copy, the full gated pipeline (reduce → render → freeze) with the evidence contract, and
// the frozen/dated invariant (regeneration inserts a new row, never a mutation).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';
import { planAnalysis } from '../src/airlock/plan';
import { drain } from '../src/airlock/engine';
import { ingestResults } from '../src/airlock/ingestResults';
import { createAirlockStore } from '../src/airlock/store';
import {
  runFirstReflection, gateFirstReflection, reduceWindowsInRange, EVIDENCE_FLOOR,
} from '../src/lenses/firstReflection';
import { DECLINE_BELOW_FLOOR, FIRST_REFLECTION_FOOTER, griefBanner } from '../src/airlock/voice';

const OWNER = 1;
const THEM = 2;
const THREAD = 1;
const BASE = Date.UTC(2021, 2, 1, 9, 0, 0);

let dk = 0;
function msg(dir: Direction, t: number, body: string): GraphMessage {
  const out = dir === 'outgoing';
  return {
    threadTempId: THREAD, senderContactTempId: out ? OWNER : THEM, direction: dir, kind: 'sms',
    sentAtMs: t, bodyText: body, isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: out ? 2 : 1, rawMsgBox: null, dedupKey: `syn-${dk++}`,
    recipients: [{ contactTempId: out ? THEM : OWNER, role: 'to' }], attachments: [],
  };
}

function buildGraph(n: number): ResolvedGraph {
  const messages: GraphMessage[] = [];
  for (let i = 0; i < n; i++) {
    const dir: Direction = i % 2 === 0 ? 'outgoing' : 'incoming';
    messages.push(msg(dir, BASE + i * 60_000, `A note about our week together, number ${i}.`));
  }
  return {
    sourceFile: { path: 'syn.xml', contentSha256: 'd'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: n, kind: 'android_smsbackup' },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: THEM, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Robin', firstSeenMs: BASE, lastSeenMs: BASE + n * 60_000 }],
    threads: [{ tempId: THREAD, participantSignature: 'sig-robin', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: BASE, lastMs: BASE + n * 60_000, messageCount: n }],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages,
  };
}

interface Env { tmp: string; db: BetweenDB; airlock: string; close(): void }
function makeEnv(n: number): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'between-reflect-'));
  const db = openDb(join(tmp, 'test.db'));
  db.bulkInsertGraph(buildGraph(n));
  return { tmp, db, airlock: join(tmp, 'airlock'), close() { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

/** Plan + drain + ingest L1 so reduce material exists. */
async function seedL1(env: Env): Promise<void> {
  planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
  await drain({ airlockDir: env.airlock, engine: 'mock' });
  ingestResults(env.db, { airlockDir: env.airlock });
}

describe('T2.10 First Reflection gates', () => {
  it('below the evidence floor → the VOICE decline copy, no reflection stored', async () => {
    const env = makeEnv(EVIDENCE_FLOOR - 10); // 140 substantive < 150
    try {
      const gate = gateFirstReflection(env.db, THREAD);
      expect(gate.ok).toBe(false);
      const outcome = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      expect(outcome).toEqual({ status: 'declined', reason: 'below_floor', copy: DECLINE_BELOW_FLOOR });
      expect(DECLINE_BELOW_FLOOR).toBe("There isn't enough here yet for an honest reading. A longer range would say more.");
      const store = createAirlockStore(env.db);
      expect(store.listReflections(THREAD)).toHaveLength(0);
    } finally { env.close(); }
  });

  it('grief-marked contact → reflection suppressed, remembrance banner returned', async () => {
    const env = makeEnv(200);
    try {
      env.db.updateContact(THEM, { isDeceased: true });
      const outcome = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      expect(outcome.status).toBe('declined');
      if (outcome.status === 'declined' && outcome.reason === 'grief') {
        expect(outcome.copy).toBe(griefBanner('Robin'));
      } else {
        throw new Error('expected grief decline');
      }
      const store = createAirlockStore(env.db);
      expect(store.listReflections(THREAD)).toHaveLength(0);
    } finally { env.close(); }
  });
});

describe('First Reflection — full gated pipeline (reduce → render → freeze)', () => {
  it('produces a frozen, dated, evidence-grounded reading via the mock engine', async () => {
    const env = makeEnv(200);
    try {
      await seedL1(env);
      const outcome = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      expect(outcome.status).toBe('created');
      if (outcome.status !== 'created') throw new Error('expected created');

      expect(outcome.title).toBe('A first reading');
      expect(outcome.contentMd).toContain(FIRST_REFLECTION_FOOTER);
      expect(outcome.contentMd).toContain('Generated ');
      expect(outcome.droppedSentences).toBe(0);

      // Every surviving claim's evidence resolves to a real message row (invariant 1).
      const ids = Object.values(outcome.evidence).flat();
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const row = env.db.raw.prepare('SELECT 1 FROM messages WHERE id = ?').get(Number(id.slice(1)));
        expect(row).toBeDefined();
      }

      // The row is frozen in `reflections`, lens = first_reflection.
      const store = createAirlockStore(env.db);
      const rows = store.listReflections(THREAD, 'first_reflection');
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(outcome.reflectionId);
    } finally { env.close(); }
  });

  it('is frozen: regeneration inserts a new dated row and never mutates the prior one', async () => {
    const env = makeEnv(200);
    try {
      await seedL1(env);
      const first = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      if (first.status !== 'created') throw new Error('expected created');

      const store = createAirlockStore(env.db);
      const beforeRow = store.listReflections(THREAD, 'first_reflection')[0];
      const beforeContent = beforeRow.content_md;

      const second = await runFirstReflection(env.db, { threadId: THREAD, airlockDir: env.airlock, engine: 'mock' });
      if (second.status !== 'created') throw new Error('expected created');

      const rows = store.listReflections(THREAD, 'first_reflection');
      expect(rows).toHaveLength(2);
      expect(second.reflectionId).not.toBe(first.reflectionId);
      // The prior reflection is untouched.
      const priorStill = rows.find((r) => r.id === first.reflectionId);
      expect(priorStill?.content_md).toBe(beforeContent);
    } finally { env.close(); }
  });
});

describe('First Reflection — range-scoped reduce material', () => {
  // Regression: buildReduceMaterial once pulled ALL of a thread's L1 windows regardless of the
  // reflection's [fromMs, toMs]. On a fully-drained thread that is ~3k windows / ~1.65M tokens —
  // over the model context window — so an in-app range reflection would blow the budget. The reduce
  // must only see windows whose OWN messages fall inside the range.
  it('a range-scoped reduce includes only windows whose own messages fall in [fromMs, toMs]', async () => {
    const N = 200; // ~4 tiled L1 windows (own-span ≈ 55 msgs each)
    const env = makeEnv(N);
    try {
      await seedL1(env);

      // Whole-thread reduce sees every window (the prior, unscoped behavior).
      const full = reduceWindowsInRange(env.db, THREAD, null, null);
      expect(full.length).toBeGreaterThan(1);

      // A range covering only the first stretch (messages at BASE .. BASE+54min).
      const fromMs = BASE;
      const toMs = BASE + 54 * 60_000;
      const scoped = reduceWindowsInRange(env.db, THREAD, fromMs, toMs);

      // Filtering happened: strictly fewer windows than the whole thread, but not empty.
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.length).toBeLessThan(full.length);

      const timeOf = env.db.raw.prepare('SELECT sent_at_ms AS ms FROM messages WHERE id = ?');
      const ownIds = (w: (typeof scoped)[number]): number[] => {
        const prefix = new Set(w.chunk.overlap_prefix_ids);
        return w.chunk.member_ids.filter((id) => !prefix.has(id));
      };
      const inRange = (id: number): boolean => {
        const ms = (timeOf.get(id) as { ms: number }).ms;
        return ms >= fromMs && ms <= toMs;
      };

      // Soundness: every selected window has at least one OWN message inside the range.
      for (const w of scoped) expect(ownIds(w).some(inRange)).toBe(true);

      // Completeness: every in-range message is covered by exactly one selected window's own span
      // (own-spans tile the thread) — nothing in range is dropped from the reduce.
      const covered = new Set<number>();
      for (const w of scoped) for (const id of ownIds(w)) covered.add(id);
      const inRangeIds = env.db.raw
        .prepare(
          "SELECT id FROM messages WHERE thread_id = ? AND is_reaction = 0"
          + " AND trim(coalesce(body_text,'')) != '' AND sent_at_ms BETWEEN ? AND ?",
        )
        .all(THREAD, fromMs, toMs) as { id: number }[];
      expect(inRangeIds.length).toBeGreaterThan(0);
      for (const { id } of inRangeIds) expect(covered.has(id)).toBe(true);

      // A boundary window whose own content is out of range is excluded even though its overlap
      // prefix dips into the range — proving we key on own messages, not the carried prefix.
      const excluded = full.filter((w) => !scoped.some((s) => s.inputHash === w.inputHash));
      expect(excluded.length).toBeGreaterThan(0);
      for (const w of excluded) expect(ownIds(w).some(inRange)).toBe(false);
    } finally { env.close(); }
  });
});
