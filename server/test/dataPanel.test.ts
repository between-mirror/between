// Between Mirror — "Your data" (Era 1, v0.3.0).
//
// The tool holds the most sensitive data a consumer application can hold, and until now it offered no
// way to see where that data lives, check it is intact, copy it somewhere safe, or get rid of it. A
// promise that your archive stays on your machine is only half a promise if you cannot find it, and
// "your data stays with you" is worth very little if leaving is not one of the things you can do.
//
// Every action here is destructive-adjacent, so each one is tested for what it does AND for what it
// refuses to do.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type BetweenDB } from '../src/store/db';
import { ensureAirlock, airlockPaths } from '../src/airlock/paths';
import {
  dataOverview, verifyIntegrity, backupNow, deleteImportedSources,
  purgeTransportFiles, deleteAllData, readActionLog, DELETED_TABLES, type DataPaths,
} from '../src/lib/dataPanel';
import type { ResolvedGraph, GraphMessage } from '../src/types';

let root: string;
let db: BetweenDB;
let paths: DataPaths;

const BASE = Date.UTC(2024, 0, 1, 9, 0, 0);

function graph(sourcePath: string): ResolvedGraph {
  const messages: GraphMessage[] = Array.from({ length: 6 }, (_u, i) => ({
    threadTempId: 1, senderContactTempId: i % 2 === 0 ? 1 : 2,
    direction: (i % 2 === 0 ? 'outgoing' : 'incoming') as GraphMessage['direction'],
    kind: 'sms' as const, sentAtMs: BASE + i * 60_000, bodyText: `message ${i}`,
    isRead: true, isReaction: false, reactionKind: null, lang: 'en',
    rawType: i % 2 === 0 ? 2 : 1, rawMsgBox: null, dedupKey: `dp-${i}`,
    recipients: [{ contactTempId: i % 2 === 0 ? 2 : 1, role: 'to' as const }], attachments: [],
  }));
  return {
    sourceFile: { path: sourcePath, contentSha256: 'd'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: 6 },
    contacts: [
      { tempId: 1, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: 2, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [{ contactTempId: 2, rawValue: '+15555550123', normalizedE164: '+15555550123', kind: 'mobile', sourceContactName: 'Robin', firstSeenMs: BASE, lastSeenMs: BASE + 360_000 }],
    threads: [{ tempId: 1, participantSignature: 'sig', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: BASE, lastMs: BASE + 360_000, messageCount: 6 }],
    threadParticipants: [
      { threadTempId: 1, contactTempId: 1, role: 'owner' as const },
      { threadTempId: 1, contactTempId: 2, role: 'member' as const },
    ],
    messages,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'between-datapanel-'));
  const dbPath = join(root, 'between.db');
  const dataDir = join(root, 'data');
  const airlockDir = join(root, 'airlock');
  const exportsDir = join(dataDir, 'exports');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });
  ensureAirlock(airlockDir);
  paths = { dbPath, dataDir, airlockDir, exportsDir, backupsDir: join(root, 'backups') };

  const xml = join(dataDir, 'sms-20240101.xml');
  writeFileSync(xml, '<smses count="6"/>');

  db = openDb(dbPath);
  db.bulkInsertGraph(graph(xml));
});

afterEach(() => {
  try { db.close(); } catch { /* already closed by deleteAllData tests */ }
  rmSync(root, { recursive: true, force: true });
});

describe('the overview says where everything is', () => {
  it('reports the database, its size, the sources, and the folders', () => {
    const o = dataOverview(db, paths);
    expect(o.dbPath).toBe(paths.dbPath);
    expect(o.dbSizeBytes).toBeGreaterThan(0);
    expect(o.exportsDir).toBe(paths.exportsDir);
    expect(o.sources).toHaveLength(1);
    expect(o.sources[0].recordCount).toBe(6);
    expect(o.sources[0].present).toBe(true);
    expect(o.sources[0].sizeBytes).toBeGreaterThan(0);
    expect(o.messageCount).toBe(6);
  });

  it('says plainly when an imported source is no longer on disk', () => {
    // Deleting the XML yourself is a perfectly reasonable thing to have done. The panel must not
    // imply the file is still sitting there.
    rmSync(join(paths.dataDir, 'sms-20240101.xml'));
    const o = dataOverview(db, paths);
    expect(o.sources[0].present).toBe(false);
    expect(o.sources[0].sizeBytes).toBe(0);
  });

  it('counts the model transport files still on disk', () => {
    const p = airlockPaths(paths.airlockDir);
    writeFileSync(join(p.archiveDir, 'a.json'), '{}');
    writeFileSync(join(p.archiveDir, 'b.json'), '{}');
    expect(dataOverview(db, paths).transportFiles).toBe(2);
  });
});

describe('verify integrity', () => {
  it('reports an intact database honestly', () => {
    const r = verifyIntegrity(db);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('ok');
    expect(r.message).toMatch(/intact|no problems/i);
  });

  it('reports the raw result rather than a reassuring summary', () => {
    // Whatever SQLite says is what the owner is shown. This is their only copy.
    const r = verifyIntegrity(db);
    expect(typeof r.detail).toBe('string');
    expect(r.detail.length).toBeGreaterThan(0);
  });
});

describe('back up now', () => {
  it('writes a timestamped copy that opens as a real database', async () => {
    const r = await backupNow(db, paths, new Date(Date.UTC(2026, 6, 21, 3, 4, 5)));
    expect(existsSync(r.path)).toBe(true);
    expect(r.path).toContain('2026-07-21');
    expect(r.sizeBytes).toBeGreaterThan(0);

    const copy = openDb(r.path);
    try {
      expect((copy.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(6);
    } finally { copy.close(); }
  });

  it('leaves the original untouched and still usable', async () => {
    await backupNow(db, paths, new Date());
    expect((db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(6);
  });

  it('never overwrites an existing backup', async () => {
    const when = new Date(Date.UTC(2026, 6, 21, 3, 4, 5));
    const a = await backupNow(db, paths, when);
    const b = await backupNow(db, paths, when);
    expect(b.path).not.toBe(a.path);
    expect(existsSync(a.path)).toBe(true);
  });
});

describe('delete the imported source XML', () => {
  it('removes the files and reports what went, with the messages kept', () => {
    const r = deleteImportedSources(db, paths);
    expect(r.deleted).toBe(1);
    expect(r.freedBytes).toBeGreaterThan(0);
    expect(existsSync(join(paths.dataDir, 'sms-20240101.xml'))).toBe(false);
    // The archive is ingested; deleting the source is tidying, not losing.
    expect((db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(6);
    expect(r.message).toMatch(/6 messages|still here|kept/i);
  });

  it('is safe to run twice', () => {
    deleteImportedSources(db, paths);
    const again = deleteImportedSources(db, paths);
    expect(again.deleted).toBe(0);
  });

  it('never deletes anything outside the known data folder', () => {
    // A source_files row is just a path string. If a database were ever handed over with a doctored
    // row, "delete my imported XML" must not become "delete that file over there".
    const outside = join(root, 'not-mine.xml');
    writeFileSync(outside, 'someone else’s file');
    db.raw.prepare('UPDATE source_files SET path = ? WHERE id = 1').run(outside);
    const r = deleteImportedSources(db, paths);
    expect(existsSync(outside)).toBe(true);
    expect(r.deleted).toBe(0);
    expect(r.skippedOutside).toBe(1);
  });
});

describe('purge the model transport files', () => {
  it('removes archived and quarantined transport now, regardless of age', () => {
    const p = airlockPaths(paths.airlockDir);
    writeFileSync(join(p.archiveDir, 'fresh.json'), '{}');
    writeFileSync(join(p.quarantineDir, 'bad.json'), '{}');
    const r = purgeTransportFiles(paths);
    expect(r.removed).toBe(2);
    expect(readdirSync(p.archiveDir)).toHaveLength(0);
    expect(readdirSync(p.quarantineDir)).toHaveLength(0);
  });

  it('leaves pending work alone — purging is not cancelling', () => {
    const p = airlockPaths(paths.airlockDir);
    writeFileSync(join(p.jobsDir, 'pending.json'), '{}');
    purgeTransportFiles(paths);
    expect(existsSync(join(p.jobsDir, 'pending.json'))).toBe(true);
  });
});

describe('delete everything', () => {
  it('refuses without the typed confirmation', () => {
    const r = deleteAllData(db, paths, 'yes');
    expect(r.ok).toBe(false);
    expect((db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(6);
  });

  it('refuses a near miss — this is the last thing standing between the owner and an empty archive', () => {
    for (const wrong of ['', 'Delete ', 'del', 'DELETE ALL', 'delete.']) {
      expect(deleteAllData(db, paths, wrong).ok).toBe(false);
    }
    expect((db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(6);
  });

  it('accepts the exact word, and then nothing is left', () => {
    const p = airlockPaths(paths.airlockDir);
    writeFileSync(join(p.archiveDir, 'a.json'), '{}');
    writeFileSync(join(paths.exportsDir, 'export.txt'), 'verbatim');

    const r = deleteAllData(db, paths, 'delete');
    expect(r.ok).toBe(true);

    expect((db.raw.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n).toBe(0);
    expect((db.raw.prepare('SELECT count(*) n FROM contacts').get() as { n: number }).n).toBe(0);
    expect((db.raw.prepare('SELECT count(*) n FROM threads').get() as { n: number }).n).toBe(0);
    expect(existsSync(join(paths.dataDir, 'sms-20240101.xml'))).toBe(false);
    expect(existsSync(join(paths.exportsDir, 'export.txt'))).toBe(false);
    expect(readdirSync(p.archiveDir)).toHaveLength(0);
  });

  it('accepts the word with surrounding whitespace but not a different word', () => {
    expect(deleteAllData(db, paths, '  delete  ').ok).toBe(true);
  });
});

describe('the panel keeps a plain-language log', () => {
  it('records what was done, in words rather than codes', () => {
    verifyIntegrity(db);
    deleteImportedSources(db, paths);
    const log = readActionLog(db);
    expect(log.length).toBeGreaterThanOrEqual(2);
    for (const e of log) {
      expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message).not.toMatch(/[A-Z_]{4,}|null|undefined|\{|\}/);   // no codes, no debug spill
    }
  });

  it('keeps the newest first and does not grow without bound', () => {
    for (let i = 0; i < 60; i++) verifyIntegrity(db);
    const log = readActionLog(db);
    expect(log.length).toBeLessThanOrEqual(50);
    expect(Date.parse(log[0].at)).toBeGreaterThanOrEqual(Date.parse(log[log.length - 1].at));
  });
});

// ── the endpoints ────────────────────────────────────────────────────────────
// The functions above are the behaviour; these prove the wiring, including that the typed
// confirmation is checked SERVER-side. A confirmation that only exists in the client is not a
// confirmation — it is a speed bump in someone else's browser.
describe('the endpoints', () => {
  it('serves the overview with its log, and refuses delete-all without the word', async () => {
    const { buildServer } = await import('../src/server');
    const app = buildServer(paths.dbPath);
    try {
      await app.ready();

      const overview = await app.inject({ method: 'GET', url: '/api/data/overview' });
      expect(overview.statusCode).toBe(200);
      const body = overview.json() as { dbPath: string; sources: unknown[]; log: unknown[] };
      expect(body.dbPath).toContain('between.db');
      expect(Array.isArray(body.log)).toBe(true);

      const integrity = await app.inject({ method: 'POST', url: '/api/data/integrity' });
      expect(integrity.statusCode).toBe(200);
      expect((integrity.json() as { ok: boolean }).ok).toBe(true);

      const refused = await app.inject({
        method: 'POST', url: '/api/data/delete-all', payload: { confirmation: 'DELETE' },
      });
      expect(refused.statusCode).toBe(400);
      expect((refused.json() as { ok: boolean }).ok).toBe(false);

      const missing = await app.inject({ method: 'POST', url: '/api/data/delete-all', payload: {} });
      expect(missing.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ── what "delete everything" has to mean ─────────────────────────────────────
// Found by the pre-v0.3.0 adversarial review, and the reason this file now reads raw bytes rather
// than row counts. Two ways the old implementation left the archive on disk while reporting success:
//
//   1. SQLite runs in WAL mode. DELETE + VACUUM without a checkpoint leaves message bodies, names and
//      numbers sitting in `between.db-wal` — and the message told the owner to delete `between.db`,
//      naming the one file that no longer held anything.
//   2. The table list contained four names that are not tables (they are metric_keys), and the
//      per-table try/catch swallowed the misses in silence. Meanwhile the real `metrics` table was
//      absent from the list entirely — and it stores 120-character verbatim previews of the longest
//      messages, plus each party's most-used words.
//
// A row count cannot see either failure. Only the bytes can.
describe('delete everything leaves nothing on disk', () => {
  const PHRASE = 'message 3';   // body text seeded by graph() above

  function fileHas(path: string, needle: string): boolean {
    if (!existsSync(path)) return false;
    return readFileSync(path).includes(Buffer.from(needle, 'utf8'));
  }

  it('the phrase really is in the database before we start (the test would be vacuous otherwise)', () => {
    db.raw.pragma('wal_checkpoint(TRUNCATE)');
    const anywhere = [paths.dbPath, `${paths.dbPath}-wal`].some((p) => fileHas(p, PHRASE));
    expect(anywhere).toBe(true);
  });

  it('removes message text from the database AND its write-ahead log', () => {
    deleteAllData(db, paths, 'delete');
    for (const p of [paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`]) {
      expect(fileHas(p, PHRASE), `message text still present in ${p}`).toBe(false);
    }
  });

  it('names every leftover file it cannot delete itself, not just the .db', () => {
    const r = deleteAllData(db, paths, 'delete');
    expect(r.message).toContain('-wal');
  });

  it('clears the derived metrics, which hold verbatim message previews', () => {
    db.raw.prepare(
      `INSERT INTO metrics (thread_id, metric_key, period, period_start_ms, value_json)
       VALUES (1, 'ambient', 'all', 0, ?)`,
    ).run(JSON.stringify({ longestMessages: [{ preview: 'message 3 verbatim preview' }] }));
    deleteAllData(db, paths, 'delete');
    expect((db.raw.prepare('SELECT count(*) n FROM metrics').get() as { n: number }).n).toBe(0);
  });

  it('every name in the delete list is a real table — a typo must fail, not vanish', () => {
    // Four entries in the original list were metric_keys, not tables. The per-table catch hid that,
    // so the list looked twice as thorough as it was.
    const real = new Set(
      (db.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[])
        .map((r) => r.name),
    );
    for (const t of DELETED_TABLES) expect(real.has(t), `${t} is not a table in this schema`).toBe(true);
  });

  it('deletes the backups too — a backup of the archive is still the archive', async () => {
    const b = await backupNow(db, paths, new Date(Date.UTC(2026, 6, 21)));
    expect(existsSync(b.path)).toBe(true);
    const r = deleteAllData(db, paths, 'delete');
    expect(existsSync(b.path), 'a full unencrypted copy survived "delete everything"').toBe(false);
    expect(r.message).toMatch(/backup/i);
  });
});
