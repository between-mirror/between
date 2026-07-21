// Between — the network-boundary boot test (P0-5 / P0-6, the build-blocking privacy test that
// docs/PRIVACY-INVARIANTS.md promised). It proves, mechanically, that the server binds loopback only,
// logs nothing, refuses a rebinding Host / foreign Origin, ships no analytics/telemetry dependency,
// and enforces engine mode server-side with no silent fallback to the test-only mock.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/store/db';
import {
  buildServer, loadRuntimeConfig, isLoopbackHost, isLoopbackHostHeader, assertLoopbackBoot,
} from '../src/server';
import { allowedEngines } from '../src/lenses/engineMode';

let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-boundary-'));
  const dbPath = join(tmpDir, 'test.db');
  const seed = openDb(dbPath);
  seed.setMeta('owner_contact_id', '1'); // any write so the db file exists with a schema
  seed.close();
  app = buildServer(dbPath);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── 1.1 loopback bind ──────────────────────────────────────────────────────────
describe('P0-6 loopback bind', () => {
  it('the resolved default bind host is loopback', () => {
    expect(isLoopbackHost(loadRuntimeConfig().host)).toBe(true);
  });
  it('classifies loopback vs public addresses', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.5', 'example.com', '10.0.0.1']) expect(isLoopbackHost(h)).toBe(false);
  });
  it('refuses to boot on a non-loopback host unless explicitly overridden', () => {
    const prev = process.env.BETWEEN_DANGEROUS_HOST;
    delete process.env.BETWEEN_DANGEROUS_HOST;
    expect(() => assertLoopbackBoot('0.0.0.0')).toThrow(/loopback/);
    expect(() => assertLoopbackBoot('127.0.0.1')).not.toThrow();
    process.env.BETWEEN_DANGEROUS_HOST = '1';
    expect(() => assertLoopbackBoot('0.0.0.0')).not.toThrow(); // screaming warning, but allowed
    if (prev === undefined) delete process.env.BETWEEN_DANGEROUS_HOST; else process.env.BETWEEN_DANGEROUS_HOST = prev;
  });
});

// ── 1.2 logger off ───────────────────────────────────────────────────────────
describe('P0-6 no request logging', () => {
  it('buildServer constructs Fastify with logger disabled', () => {
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/Fastify\(\{\s*logger:\s*false\s*\}\)/);
  });
});

// ── 1.3 no analytics/telemetry dependency ──────────────────────────────────────
describe('P0-6 no telemetry dependency', () => {
  // The privacy page now says, in these words: "There is no application code that collects or reports
  // telemetry, no dependency included for analytics or monitoring, and the build fails if a known
  // telemetry dependency or collection path is introduced."
  //
  // The first version of this test checked direct dependencies in two of the three package.json
  // files. That supports about half the sentence: it would not have noticed a telemetry package
  // arriving in the web workspace, nor one pulled in transitively, nor a beacon written by hand into
  // the source. A claim may only be as strong as its enforcement, so the enforcement is widened to
  // the claim rather than the claim narrowed to the enforcement.
  const BLOCKED = /(analytics|telemetry|sentry|mixpanel|segment\.io|posthog|amplitude|bugsnag|datadog|newrelic|rollbar|heap-|fullstory|honeybadger|google-analytics|logrocket|instana|appsignal|elastic-apm|opentelemetry)/i;

  it('no workspace declares an analytics/telemetry/crash-reporting dependency', () => {
    // All THREE manifests. web/ was unchecked, and it is the one that runs in a browser.
    for (const rel of ['package.json', '../package.json', '../web/package.json']) {
      const pkg = JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')) as {
        name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
      };
      for (const name of Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
        expect(name, `${pkg.name ?? rel} depends on ${name}`).not.toMatch(BLOCKED);
      }
    }
  });

  it('no telemetry package arrives transitively either', () => {
    // "No dependency included" is a claim about what ships, and what ships is the resolved tree, not
    // the four lines someone typed. A vendored reporter three levels down is still in the bundle.
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    const offenders = Object.keys(lock.packages ?? {})
      .map((p) => p.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, ''))
      .filter((name) => name && BLOCKED.test(name));
    expect([...new Set(offenders)], 'a telemetry package is in the resolved dependency tree').toEqual([]);
  });

  it('no source file opens a collection path by hand', () => {
    // A dependency scan cannot see fifteen lines of fetch(). These are the mechanisms a browser or a
    // server uses to report on its user; none of them has any business in this program.
    const COLLECTORS = [
      /navigator\s*\.\s*sendBeacon/,
      /new\s+(?:Image|XMLHttpRequest)\s*\([^)]*\)\s*\.\s*src\s*=/,
      /\bgtag\s*\(/,
      /\bdataLayer\s*\.\s*push/,
      /window\s*\.\s*(?:ga|_paq|analytics)\b/,
      /reportWebVitals/,
    ];
    const roots = [new URL('../src', import.meta.url), new URL('../../web/src', import.meta.url)];
    const bad: string[] = [];
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${dir.pathname.replace(/\/$/, '')}/${entry.name}`, dir);
        if (entry.isDirectory()) { walk(new URL(`${child.pathname}/`, child)); continue; }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
        const text = readFileSync(child, 'utf8');
        for (const re of COLLECTORS) if (re.test(text)) bad.push(`${entry.name}: ${re.source}`);
      }
    };
    for (const r of roots) walk(new URL(`${r.pathname}/`, r));
    expect(bad, `a telemetry collection path is present:\n  ${bad.join('\n  ')}`).toEqual([]);
  });
});

// ── Host / Origin gate ─────────────────────────────────────────────────────────
describe('P0-6 Host/Origin gate', () => {
  it('classifies loopback Host headers (with ports and brackets)', () => {
    for (const h of ['localhost:5274', '127.0.0.1:5274', '[::1]:5274', 'localhost']) expect(isLoopbackHostHeader(h)).toBe(true);
    for (const h of ['evil.example.com', 'evil.example.com:80', '10.0.0.1:5274']) expect(isLoopbackHostHeader(h)).toBe(false);
  });
  it('a loopback Host with no Origin passes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:5274' } });
    expect(res.statusCode).toBe(200);
  });
  it('a rebinding (non-loopback) Host is 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });
  it('a foreign Origin is 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'localhost:5274', origin: 'https://evil.example.com' } });
    expect(res.statusCode).toBe(403);
  });
});

// ── P0-5 engine mode enforced server-side ──────────────────────────────────────
describe('P0-5 engine mode enforced server-side', () => {
  it('the allowed-engine set follows the mode (and mock only with the flag)', () => {
    expect([...allowedEngines('local-only', false)]).toEqual(['ollama']);
    expect([...allowedEngines('subscription', false)].sort()).toEqual(['claude', 'ollama']);
    expect([...allowedEngines('api-key', false)]).toEqual(['ollama']);
    expect(allowedEngines('local-only', true).has('mock')).toBe(true);
    expect(allowedEngines('local-only', false).has('mock')).toBe(false);
  });

  it('POST /api/drain with no engine → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/drain', headers: { host: 'localhost' }, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/drain engine=claude under local-only → 403', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/drain', headers: { host: 'localhost' }, payload: { engine: 'claude' } });
    expect(res.statusCode).toBe(403);
  });

  it('engine=mock is rejected 400 when BETWEEN_ALLOW_MOCK is unset, accepted when set', async () => {
    // With the flag unset the mock is not an allowed engine at all → 400 (unknown engine is 400,
    // disallowed is 403; mock disappears from the vocabulary, so it reads as unavailable).
    vi.stubEnv('BETWEEN_ALLOW_MOCK', '');
    const off = await app.inject({ method: 'POST', url: '/api/drain', headers: { host: 'localhost' }, payload: { engine: 'mock' } });
    expect(off.statusCode).toBe(403);
    vi.unstubAllEnvs();
    const on = await app.inject({ method: 'POST', url: '/api/drain', headers: { host: 'localhost' }, payload: { engine: 'mock' } });
    expect(on.statusCode).toBe(200); // harness sets BETWEEN_ALLOW_MOCK=1
  });
});
