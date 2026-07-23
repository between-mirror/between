// Between — P0-1 sandboxed subscription drain. The staging + copy-back are pure filesystem, so they
// are tested directly (no live `claude` spawn). The guarantees under test: the staged dir holds ONLY
// jobs + an empty results dir + the command + a hooks-off settings file — no DB, no data/, no archive —
// the spawn args restrict MCP/hooks/tools, and result files copy back for the normal (validated) ingest.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import type { ResolvedGraph, GraphMessage, Direction } from '../src/types';
import { planAnalysis } from '../src/airlock/plan';
import { ingestResults } from '../src/airlock/ingestResults';
import { createAirlockStore } from '../src/airlock/store';
import { airlockPaths, readJson, listJobFiles } from '../src/airlock/paths';
import {
  stageDrainSandbox, sandboxClaudeArgs, copyBackResults, sandboxSettings,
  SANDBOX_ALLOWED_TOOLS, SANDBOX_ALLOWED_SCOPED, SANDBOX_DENIED_TOOLS,
} from '../src/airlock/drainSandbox';
import type { JobFile } from '../src/airlock/types';

const OWNER = 1, THEM = 2, THREAD = 1;
const BASE = Date.UTC(2022, 6, 1, 9, 0, 0);

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
  for (let i = 0; i < n; i++) messages.push(msg(i % 2 === 0 ? 'outgoing' : 'incoming', BASE + i * 60_000, `Weekend plan note ${i}.`));
  return {
    sourceFile: { path: 'syn.xml', contentSha256: 'f'.repeat(64), importedAt: new Date(BASE).toISOString(), recordCount: n, kind: 'android_smsbackup' },
    contacts: [
      { tempId: OWNER, displayName: 'Me', primaryE164: '+15555550100', isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Robin', primaryE164: '+15555550123', isOwner: false, relationshipType: 'friend' },
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
function makeEnv(): Env {
  const tmp = mkdtempSync(join(tmpdir(), 'between-sandbox-'));
  const db = openDb(join(tmp, 'between.db'));
  db.bulkInsertGraph(buildGraph(60));
  return { tmp, db, airlock: join(tmp, 'airlock'), close() { db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('P0-1 sandboxed drain — staging isolation', () => {
  it('stages ONLY pending jobs + empty results + command + hooks-off settings; no DB/data/archive', () => {
    const env = makeEnv();
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const pending = listJobFiles(airlockPaths(env.airlock).jobsDir);
      expect(pending.length).toBeGreaterThan(0);

      const staged = stageDrainSandbox(env.airlock);
      try {
        // Every pending job is staged; results dir is empty.
        expect(staged.stagedJobs).toBe(pending.length);
        const stagedJobs = listJobFiles(staged.jobsDir);
        expect(stagedJobs.length).toBe(pending.length);
        expect(readdirSync(staged.resultsDir)).toHaveLength(0);

        // The command + settings are present; hooks are disabled and only Read/Write/Glob permitted.
        expect(existsSync(join(staged.sandboxDir, '.claude', 'commands', 'drain-jobs.md'))).toBe(true);
        const settings = readJson<ReturnType<typeof sandboxSettings>>(staged.settingsPath);
        expect(settings.hooks).toEqual({});
        // PATH-SCOPED grants (P0-1 hardening): read/list under airlock/, write only under airlock/results/.
        expect(settings.permissions.allow).toEqual([...SANDBOX_ALLOWED_SCOPED]);
        expect(settings.permissions.allow.some((a) => /^Write\(/.test(a))).toBe(true);
        expect(settings.permissions.allow).not.toContain('Write'); // never a bare, unscoped write grant
        expect(settings.permissions.deny).toContain('Bash');

        // CRITICAL: nothing in the sandbox is a database, the data/ tree, or the archive XML.
        const files = walk(staged.sandboxDir);
        for (const f of files) {
          expect(f).not.toMatch(/\.(db|sqlite|sqlite3|db-wal|db-shm)$/i);
          expect(f).not.toMatch(/\.xml$/i);
          expect(f.split(/[\\/]/)).not.toContain('data');
        }
        // The owner's real DB lives in the parent tmp dir, and did NOT come along.
        expect(existsSync(join(env.tmp, 'between.db'))).toBe(true);
        expect(existsSync(join(staged.sandboxDir, 'between.db'))).toBe(false);
      } finally {
        rmSync(staged.sandboxDir, { recursive: true, force: true });
      }
    } finally { env.close(); }
  });

  it('the spawn args turn MCP off, hooks off, and restrict the toolset', () => {
    const args = sandboxClaudeArgs('/tmp/sandbox-settings.json');
    expect(args.slice(0, 2)).toEqual(['-p', '/drain-jobs']);
    expect(args).toContain('--strict-mcp-config');
    const mcpIdx = args.indexOf('--mcp-config');
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(JSON.parse(args[mcpIdx + 1])).toEqual({ mcpServers: {} });
    expect(args).toContain('--settings');
    expect(args).toContain('--tools');
    for (const t of SANDBOX_ALLOWED_TOOLS) expect(args).toContain(t);
    // --allowedTools carries the PATH-SCOPED grants, not bare tool names.
    for (const t of SANDBOX_ALLOWED_SCOPED) expect(args).toContain(t);
    for (const t of SANDBOX_DENIED_TOOLS) expect(args).toContain(t);
    expect(args).toContain('--disallowedTools');
  });

  it('copies result files back into the real airlock for the normal validated ingest', () => {
    const env = makeEnv();
    try {
      planAnalysis(env.db, { threadId: THREAD, lens: 'l1_emotion', airlockDir: env.airlock });
      const staged = stageDrainSandbox(env.airlock);
      try {
        // Simulate what the sandboxed model writes: a schema-valid result per staged job that scores
        // every message in the window (exact L1 coverage, P1-7).
        for (const name of listJobFiles(staged.jobsDir)) {
          const jf = readJson<JobFile>(join(staged.jobsDir, name));
          const ids = [...jf.chunk.transcript.matchAll(/\[m(\d+)\]/g)].map((m) => `m${m[1]}`);
          writeFileSync(join(staged.resultsDir, name), JSON.stringify({
            job_id: jf.job_id, input_hash: jf.input_hash, status: 'done',
            result: { messages: ids.map((id) => ({ message_id: id, valence: 0, warmth: 0, tension: 0 })), window: { summary: 'ok', notes: [] } },
          }));
        }
        const copied = copyBackResults(staged, env.airlock);
        expect(copied).toBe(staged.stagedJobs);

        // The results are now in the REAL airlock; the normal ingest (with envelope + schema checks) runs.
        const summary = ingestResults(env.db, { airlockDir: env.airlock });
        expect(summary.ingested).toBe(staged.stagedJobs);
        expect(summary.quarantined).toBe(0);
        expect(createAirlockStore(env.db).jobStatusCountsForThread(THREAD).done).toBe(staged.stagedJobs);
      } finally {
        rmSync(staged.sandboxDir, { recursive: true, force: true });
      }
    } finally { env.close(); }
  });

  it('engine.ts imports nothing from the store/db layer (sole-writer guarantee holds after the sandbox wiring)', () => {
    const src = readFileSync(new URL('../src/airlock/engine.ts', import.meta.url), 'utf8');
    for (const l of src.split('\n').filter((x) => /^\s*import\b/.test(x))) {
      expect(l).not.toMatch(/store\/db|\.\.\/store|openDb/);
    }
    const sbx = readFileSync(new URL('../src/airlock/drainSandbox.ts', import.meta.url), 'utf8');
    for (const l of sbx.split('\n').filter((x) => /^\s*import\b/.test(x))) {
      expect(l).not.toMatch(/store\/db|\.\.\/store|openDb/);
    }
  });
});
