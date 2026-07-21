// Between — the read API server. Boots Fastify over the DB layer (store/db).
// buildServer(dbPath) opens the DB once, registers CORS + routes, and returns
// a configured (not-yet-listening) Fastify instance. The bottom block wires the
// tracked between.config.json and listens only when run as the entry point.
import Fastify from 'fastify';
import type { FastifyInstance, FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { openDb } from './store/db';
import { routes } from './api/routes';
import type { DataPaths } from './lib/dataPanel';
import { hardenAtRest } from './lib/atRest';

// The web dev server (Vite) origin — see docs/SPECS/app.md.
const WEB_ORIGIN = 'http://localhost:5273';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Is a configured bind address loopback (127.0.0.1 / ::1 / localhost)? 0.0.0.0 is NOT. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** Is an inbound Host header loopback (allowing an optional :port and IPv6 brackets)? DNS-rebinding
 *  defense: a browser tricked into resolving a public name to 127.0.0.1 still sends that name here. */
export function isLoopbackHostHeader(host: string): boolean {
  const m = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(host.trim().toLowerCase());
  if (!m) return false;
  let name = m[1];
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  return name === '127.0.0.1' || name === '::1' || name === 'localhost';
}

/** Whether this build serves its own static web assets (the future packaged app). In dev the web runs
 *  on Vite and reaches the API by proxy, so the per-install token is generated + accepted but NOT
 *  enforced (the dev flow stays usable). See docs/PRIVACY-INVARIANTS.md. */
export function servesStatic(): boolean {
  return process.env.BETWEEN_SERVE_STATIC === '1';
}

/**
 * Refuse to boot on a non-loopback bind (P0-6). Between is single-owner, local-first software with no
 * authentication on the read API — a non-loopback bind exposes a private archive to the network. Only
 * an explicit BETWEEN_DANGEROUS_HOST=1 overrides, and then only with a screaming warning.
 */
export function assertLoopbackBoot(host: string): void {
  if (isLoopbackHost(host)) return;
  if (process.env.BETWEEN_DANGEROUS_HOST === '1') {
    const bar = '='.repeat(72);
    console.warn(
      `\n${bar}\n`
      + `  ⚠  BETWEEN IS BINDING A NON-LOOPBACK ADDRESS: ${host}\n`
      + `  This exposes your private message archive to the network. The read API has\n`
      + `  NO authentication in front of it. Between is local-first, single-owner software.\n`
      + `  Only BETWEEN_DANGEROUS_HOST=1 allowed this boot. Unset it to stay safe.\n`
      + `${bar}\n`,
    );
    return;
  }
  throw new Error(
    `refusing to boot: api.host '${host}' is not loopback (127.0.0.1 / ::1 / localhost). A distributed `
    + `Between build must bind loopback only. Set BETWEEN_DANGEROUS_HOST=1 to override (not recommended).`,
  );
}

export function buildServer(dbPath: string): FastifyInstance {
  const db = openDb(dbPath);
  const app = Fastify({ logger: false });

  // Close the shared DB handle when the server closes (tests + graceful shutdown).
  app.addHook('onClose', async () => { db.close(); });

  // Per-install auth token (P0-6 plumbing): generated once on first boot, accepted via
  // `Authorization: Bearer <token>`. ENFORCED only when this build serves its own static assets
  // (servesStatic) — the packaged app. The dev-proxy flow does not send it and is not blocked.
  let authToken = db.getMeta('auth_token');
  if (!authToken) { authToken = randomBytes(24).toString('hex'); db.setMeta('auth_token', authToken); }

  // Sanitized error handler — never leak stack traces to clients.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400
      ? err.statusCode
      : 500;
    const message = status >= 500 ? 'Internal Server Error' : (err.message || 'Bad Request');
    reply.status(status).send({ error: message });
  });

  // Host/Origin gate (P0-6): the Host header must be loopback (DNS-rebinding defense); a present Origin
  // must match the local web origin. CORS sits on top of this. When the packaged build serves static
  // assets, the per-install token is additionally required.
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHostHeader(String(req.headers.host ?? ''))) {
      reply.status(403).send({ error: 'forbidden host' });
      return reply;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && origin !== WEB_ORIGIN) {
      reply.status(403).send({ error: 'forbidden origin' });
      return reply;
    }
    if (servesStatic() && String(req.headers.authorization ?? '') !== `Bearer ${authToken}`) {
      reply.status(401).send({ error: 'unauthorized' });
      return reply;
    }
    return undefined;
  });

  app.register(cors, { origin: WEB_ORIGIN });
  // The data-lifecycle panel needs to know where everything lives. Derived here from the one path the
  // server was given, so no client can ever name a folder for it to act on.
  const dataPaths: DataPaths = {
    dbPath,
    dataDir: join(dbPath, '..', 'data'),
    airlockDir: join(dbPath, '..', 'airlock'),
    exportsDir: join(dbPath, '..', 'data', 'exports'),
    backupsDir: join(dbPath, '..', 'backups'),
  };
  app.register(routes, { db, dataPaths });

  return app;
}

// ── entry point: read config, open DB, listen ──────────────────────────────
interface ApiRuntimeConfig { port: number; host: string; dbPath: string; }

export function loadRuntimeConfig(): ApiRuntimeConfig {
  // Repo root holds between.config.json (this file lives at server/src/server.ts).
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  let port = 5274;
  let host = '127.0.0.1';
  let dbPath = 'between.db';
  try {
    const raw = readFileSync(join(repoRoot, 'between.config.json'), 'utf8');
    const cfg = JSON.parse(raw) as {
      dbPath?: unknown;
      api?: { port?: unknown; host?: unknown };
    };
    const cfgPort = Number(cfg.api?.port);
    if (Number.isFinite(cfgPort) && cfgPort > 0) port = Math.trunc(cfgPort);
    if (typeof cfg.api?.host === 'string' && cfg.api.host) host = cfg.api.host;
    if (typeof cfg.dbPath === 'string' && cfg.dbPath) dbPath = cfg.dbPath;
  } catch {
    // Missing/malformed config → fall back to defaults.
  }
  // BETWEEN_DB overrides the configured db without editing config (used by `demo:serve` to open
  // examples/demo.db without touching the owner's own between.db). Non-destructive.
  if (process.env.BETWEEN_DB) dbPath = process.env.BETWEEN_DB;
  const resolvedDb = isAbsolute(dbPath) ? dbPath : join(repoRoot, dbPath);
  return { port, host, dbPath: resolvedDb };
}

const isEntryPoint = !!process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const { port, host, dbPath } = loadRuntimeConfig();
  assertLoopbackBoot(host);

  // At-rest hardening (P1-12): owner-only ACLs, cloud-sync warning, drained-plaintext retention.
  const dataDir = join(dbPath, '..', 'data');
  const airlockDir = join(dbPath, '..', 'airlock');
  const atRest = hardenAtRest({ dbPath, dataDir, airlockDir });
  if (atRest.retentionRemoved > 0) console.log(`At-rest: removed ${atRest.retentionRemoved} drained airlock plaintext file(s) past retention.`);
  const failedAcls = atRest.aclResults.filter((r) => !r.ok);
  if (failedAcls.length) console.warn(`At-rest: could not tighten ACLs on ${failedAcls.length} path(s) (best-effort; not fatal).`);
  if (atRest.syncWarning) console.warn(`\n⚠ ${atRest.syncWarning}\n`);

  const app = buildServer(dbPath);
  const mockState = process.env.BETWEEN_ALLOW_MOCK === '1' ? 'ENABLED (dev/test only)' : 'disabled';
  console.log(`Between API — mock engine ${mockState}; static-serving ${servesStatic() ? 'on (token enforced)' : 'off (dev proxy)'}`);
  app.listen({ port, host })
    .then((addr) => { console.log(`Between API on ${addr}`); })
    .catch((e) => { console.error(e); process.exit(1); });
}
