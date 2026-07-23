// Between — read API contract tests. Seeds a temp DB with a small hand-built
// ResolvedGraph (SYNTHETIC data only), then drives the Fastify app via inject().
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/store/db';
import { buildServer } from '../src/server';
import type { ResolvedGraph, ThreadSummary, MessageDTO, SearchHit, ContactSummary } from '../src/types';

// Synthetic actors: ME (owner) and THEM ("Sam"). No real personal data.
const OWNER_TEMP = 1;
const THEM_TEMP = 2;

// Ascending, deterministic synthetic timestamps.
const T1 = Date.UTC(2024, 0, 1, 12, 0, 0);
const T2 = T1 + 60_000;
const T3 = T2 + 60_000;

function buildGraph(): ResolvedGraph {
  return {
    sourceFile: {
      path: 'synthetic-archive.xml',
      contentSha256: 'a'.repeat(64),
      importedAt: new Date(T1).toISOString(),
      recordCount: 3,
      kind: 'android_smsbackup' as const,
    },
    contacts: [
      { tempId: OWNER_TEMP, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM_TEMP, displayName: 'Sam', primaryE164: '+15555550123', isOwner: false, relationshipType: 'friend' },
    ],
    identifiers: [
      {
        contactTempId: THEM_TEMP,
        rawValue: '+15555550123',
        normalizedE164: '+15555550123',
        kind: 'mobile',
        sourceContactName: 'Sam',
        firstSeenMs: T1,
        lastSeenMs: T3,
      },
    ],
    threads: [
      {
        tempId: 1,
        participantSignature: 'sig-sam',
        isGroup: false,
        title: null,
        coverageConfidence: 1.0,
        coverageNote: null,
        primaryLang: 'en',
        firstMs: T1,
        lastMs: T3,
        messageCount: 3,
      },
    ],
    threadParticipants: [
      { threadTempId: 1, contactTempId: OWNER_TEMP, role: 'owner' },
      { threadTempId: 1, contactTempId: THEM_TEMP, role: 'member' },
    ],
    messages: [
      {
        threadTempId: 1, senderContactTempId: OWNER_TEMP, direction: 'outgoing', kind: 'sms',
        sentAtMs: T1, bodyText: 'Do you like pineapple on pizza?', isRead: true, isReaction: false,
        reactionKind: null, lang: 'en', rawType: 2, rawMsgBox: null, dedupKey: 'msg-1',
        recipients: [{ contactTempId: THEM_TEMP, role: 'to' }], attachments: [],
      },
      {
        threadTempId: 1, senderContactTempId: THEM_TEMP, direction: 'incoming', kind: 'sms',
        sentAtMs: T2, bodyText: 'Absolutely not.', isRead: true, isReaction: false,
        reactionKind: null, lang: 'en', rawType: 1, rawMsgBox: null, dedupKey: 'msg-2',
        recipients: [{ contactTempId: OWNER_TEMP, role: 'to' }], attachments: [],
      },
      {
        threadTempId: 1, senderContactTempId: OWNER_TEMP, direction: 'outgoing', kind: 'sms',
        sentAtMs: T3, bodyText: 'Fair enough.', isRead: true, isReaction: false,
        reactionKind: null, lang: 'en', rawType: 2, rawMsgBox: null, dedupKey: 'msg-3',
        recipients: [{ contactTempId: THEM_TEMP, role: 'to' }], attachments: [],
      },
    ],
  };
}

let tmpDir: string;
let dbPath: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-api-'));
  dbPath = join(tmpDir, 'test.db');
  // Seed via a separate DB handle, then close so the server opens the same file.
  const seed = openDb(dbPath);
  seed.bulkInsertGraph(buildGraph());
  seed.close();

  app = buildServer(dbPath);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('a reading says what its own span could not see', () => {
  // Its own database. The shared seed above is asserted on message-for-message by half this file,
  // and this suite has to plant a hole in the archive to have anything to report.
  let gapApp: FastifyInstance;
  let gapDbPath: string;
  const FAR = T1 + 400 * 86_400_000;

  beforeAll(async () => {
    gapDbPath = join(tmpDir, 'gap.db');
    const db = openDb(gapDbPath);
    db.bulkInsertGraph(buildGraph());
    // One message a year out, so the months between are genuinely absent from the archive rather
    // than merely outside the reading's range.
    db.raw.prepare(
      `INSERT INTO messages (thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                             is_reaction, source_file_id, source_kind, dedup_key)
       VALUES (1, 2, 'incoming', 'sms', ?, 'much later', 0, 1, 'android_smsbackup', 'span-caveat-probe')`,
    ).run(FAR);
    db.close();
    gapApp = buildServer(gapDbPath);
    await gapApp.ready();
  });

  afterAll(async () => { await gapApp.close(); });

  /** The caveat is computed at read time, never frozen with the prose. */
  const freeze = (rangeStartMs: number, rangeEndMs: number): number => {
    const db = openDb(gapDbPath);
    const info = db.raw.prepare(
      `INSERT INTO reflections (thread_id, lens, range_start_ms, range_end_ms, content_md,
                                evidence_json, prompt_version, generated_at)
       VALUES (1, 'first_reflection', ?, ?, 'A reading.', '{}', 1, ?)`,
    ).run(rangeStartMs, rangeEndMs, new Date(T1).toISOString());
    db.close();
    return Number(info.lastInsertRowid);
  };

  it('carries no caveat when the span it covers is continuous', async () => {
    const id = freeze(T1, T3);
    const res = await gapApp.inject({ method: 'GET', url: `/api/reflections/${id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { spanCaveat: string | null }).spanCaveat).toBeNull();
  });

  it('names the missing months when the span has a hole in it', async () => {
    const id = freeze(T1, FAR);
    const res = await gapApp.inject({ method: 'GET', url: `/api/reflections/${id}` });
    const caveat = (res.json() as { spanCaveat: string | null }).spanCaveat;
    expect(caveat).toContain('months with no messages at all');
    expect(caveat).toContain('missing from the reading');
  });

  it('fires on a whole-thread reading, which is the only kind the app can produce', async () => {
    // firstReflection writes range 0/0 for a reading with no range, and the Analyze panel never
    // sends one. Treating 0 as a real timestamp made `to <= from` true, so this caveat was computed,
    // returned null, and rendered nothing on every reading a user could actually generate.
    const id = freeze(0, 0);
    const res = await gapApp.inject({ method: 'GET', url: `/api/reflections/${id}` });
    const caveat = (res.json() as { spanCaveat: string | null }).spanCaveat;
    expect(caveat, 'a whole-thread reading over a holed archive must carry the caveat').toBeTruthy();
    expect(caveat).toContain('months with no messages at all');
  });
});

describe('read API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/threads returns the thread with correct counts and displayName', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(200);
    const threads = res.json() as ThreadSummary[];
    expect(threads).toHaveLength(1);
    const t = threads[0];
    expect(t.displayName).toBe('Sam');
    expect(t.messageCount).toBe(3);
    expect(t.sentCount).toBe(2);     // two outgoing, non-reaction
    expect(t.receivedCount).toBe(1); // one incoming, non-reaction
  });

  it('GET /api/threads/:id returns the thread; 404 when missing', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/threads/1' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as ThreadSummary).id).toBe(1);

    const missing = await app.inject({ method: 'GET', url: '/api/threads/999' });
    expect(missing.statusCode).toBe(404);

    const bad = await app.inject({ method: 'GET', url: '/api/threads/notanumber' });
    expect(bad.statusCode).toBe(400);
  });

  it('GET /api/threads/:id/messages returns messages newest-first', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/threads/1/messages' });
    expect(res.statusCode).toBe(200);
    const msgs = res.json() as MessageDTO[];
    expect(msgs).toHaveLength(3);
    expect(msgs[0].sentAtMs).toBe(T3);
    expect(msgs[1].sentAtMs).toBe(T2);
    expect(msgs[2].sentAtMs).toBe(T1);
    // strictly descending
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i - 1].sentAtMs).toBeGreaterThan(msgs[i].sentAtMs);
    }
  });

  it('GET /api/threads/:id/messages supports ascending order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/threads/1/messages?order=asc' });
    const msgs = res.json() as MessageDTO[];
    expect(msgs[0].sentAtMs).toBe(T1);
    expect(msgs[msgs.length - 1].sentAtMs).toBe(T3);
  });

  it('GET /api/search finds a planted word', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=pineapple' });
    expect(res.statusCode).toBe(200);
    const hits = res.json() as SearchHit[];
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].threadName).toBe('Sam');
    expect(hits[0].snippet.toLowerCase()).toContain('pineapple');
  });

  it('GET /api/search returns [] for empty query', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/search?q=' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /api/contacts/:id updates relationship_type', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/api/contacts/${THEM_TEMP}`,
      payload: { relationshipType: 'partner' },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json()).toEqual({ ok: true });

    const list = await app.inject({ method: 'GET', url: '/api/contacts' });
    const contacts = list.json() as ContactSummary[];
    const sam = contacts.find((c) => c.id === THEM_TEMP);
    expect(sam).toBeDefined();
    expect(sam!.relationshipType).toBe('partner');
  });

  it('POST /api/contacts/:id rejects an invalid relationshipType', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/contacts/${THEM_TEMP}`,
      payload: { relationshipType: 'nemesis' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET/POST /api/meta/onboarding round-trips state', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/meta/onboarding' });
    // toMatchObject: the response also carries archive-scale fields (messageCount/first/last/contactCount)
    // for the awe-reveal; this test only cares about the onboarding/region/owner round-trip.
    // ownerContactId is already set: an import that can identify the archive owner now records
    // them, because archive health reads that key to tell the owner apart from the people they
    // talk to, and it used to be written only by this endpoint — so a CLI-built archive had none
    // and the group-contamination warning fired on every conversation in it.
    expect(before.json()).toMatchObject({ onboarding: null, region: null });
    expect(before.json().ownerContactId).toBe(OWNER_TEMP);

    const post = await app.inject({
      method: 'POST',
      url: '/api/meta/onboarding',
      payload: { onboarding: { completed: true, step: 3 }, region: 'US', ownerContactId: OWNER_TEMP },
    });
    expect(post.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: '/api/meta/onboarding' });
    expect(after.json()).toMatchObject({
      onboarding: { completed: true, step: 3 },
      region: 'US',
      ownerContactId: OWNER_TEMP,
    });
  });
});
