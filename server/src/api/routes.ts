// Between — read API routes (Fastify plugin) over the store/db layer.
// Phase 0: READ + light contact edits. All data access goes through BetweenDB;
// routes never touch SQLite directly.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import type { BetweenDB } from '../store/db';
import type { RelationshipType } from '../types';
import { getOrComputeMetrics } from '../metrics/index';
import { planAnalysis, loadRangeMessages } from '../airlock/plan';
import { drain } from '../airlock/engine';
import { ingestResults } from '../airlock/ingestResults';
import { createAirlockStore } from '../airlock/store';
import { defaultAirlockDir } from '../airlock/paths';
import { drainCompleteCopy } from '../airlock/voice';
import { getEmotionDaily, refreshEmotionDaily, hasEmotionDaily, emotionCoverage } from '../lenses/l1';
import { getTimezone, setTimezone, isValidTimeZone } from '../lib/localtime';
import { experimentalLensesEnabled, setExperimentalLenses } from '../lenses/experimental';
import { cloudSyncWarning } from '../lib/atRest';
import { runFirstReflection } from '../lenses/firstReflection';
import { computeTrajectory } from '../lenses/trajectory';
import { planAsk } from '../lenses/ask';
import { computeAmbient } from '../lenses/ambient';
import { getFindings, refreshFindings } from '../lenses/findings';
import { calibrationStatus } from '../lenses/calibration';
import { applyCalibration, sampleHoldout, biasLabelsFromMarks, type OwnerMark } from '../lenses/calibrate';
import { selectSampleEpisodes, isL4SampleConfirmed, recordL4SampleConfirmed } from '../lenses/abuse';
import { getEngineMode, setEngineMode, paidBatchAllowed, allowedEngines, mockAllowed, type EngineMode } from '../lenses/engineMode';
import { estimateReadCost } from '../lenses/readCost';
import type { BiasLabel } from '../lenses/bias';
import { getEpisodes, getEpisodeById } from '../lenses/episodes';
import type { EngineName } from '../airlock/types';
import {
  dataOverview, verifyIntegrity, backupNow, deleteImportedSources, purgeTransportFiles,
  deleteAllData, openDataFolder, readActionLog, type DataPaths,
} from '../lib/dataPanel';

/** Resolve the airlock dir from between.config.json (repo root), defaulting to repo-root/airlock. */
function resolveAirlockDir(): string {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  try {
    const cfg = JSON.parse(readFileSync(join(repoRoot, 'between.config.json'), 'utf8')) as { airlockDir?: unknown };
    if (typeof cfg.airlockDir === 'string' && cfg.airlockDir) {
      return isAbsolute(cfg.airlockDir) ? cfg.airlockDir : join(repoRoot, cfg.airlockDir);
    }
  } catch { /* fall back */ }
  return defaultAirlockDir();
}

/**
 * Server-side engine resolution + enforcement (P0-5). The server — not the client — decides which
 * engine may spawn inference. A missing/invalid engine is a 400; an engine outside the mode's allowed
 * set is a 403. There is no silent fallback to mock: mock exists only when BETWEEN_ALLOW_MOCK=1.
 */
function resolveRequestEngine(
  db: BetweenDB, v: unknown,
): { ok: true; engine: EngineName } | { ok: false; status: number; message: string } {
  if (typeof v !== 'string' || !v) {
    return { ok: false, status: 400, message: "body.engine is required ('ollama' | 'claude')" };
  }
  if (v !== 'ollama' && v !== 'claude' && v !== 'mock') {
    return { ok: false, status: 400, message: `unknown engine '${v}'` };
  }
  const mode = getEngineMode(db);
  const allowed = allowedEngines(mode, mockAllowed());
  if (!allowed.has(v)) {
    return { ok: false, status: 403, message: `engine '${v}' is not permitted in ${mode} mode` };
  }
  return { ok: true, engine: v };
}

export interface RoutesOptions {
  db: BetweenDB;
  /** Where the owner's data lives. Server-derived; never accepted from a client. */
  dataPaths?: DataPaths;
}

const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'partner', 'family', 'parent_child', 'friend', 'coworker', 'unknown',
];

// app_meta keys backing the onboarding surface (personalization lives in the DB).
const META_ONBOARDING = 'onboarding';
const META_REGION = 'region';
const META_OWNER = 'owner_contact_id';

/** Coerce a query/param value to a finite integer, or undefined if not parseable. */
function toInt(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Parse a required numeric :id path param; reply 400 and return undefined if bad. */
function parseId(value: unknown, reply: FastifyReply): number | undefined {
  const id = toInt(value);
  if (id == null) {
    reply.status(400).send({ error: 'Invalid id' });
    return undefined;
  }
  return id;
}

export async function routes(app: FastifyInstance, opts: RoutesOptions): Promise<void> {
  const { db, dataPaths } = opts;

  // ── health ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true }));

  // ── contacts ────────────────────────────────────────────────────────────────
  app.get('/api/contacts', async () => db.listContacts());

  // ── threads ────────────────────────────────────────────────────────────────
  app.get('/api/threads', async () => db.listThreads());

  app.get('/api/threads/:id', async (request, reply) => {
    const { id: rawId } = request.params as { id?: string };
    const id = parseId(rawId, reply);
    if (id == null) return;
    const thread = db.getThread(id);
    if (!thread) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    return thread;
  });

  app.get('/api/threads/:id/messages', async (request, reply) => {
    const { id: rawId } = request.params as { id?: string };
    const id = parseId(rawId, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    const q = request.query as {
      before?: string; after?: string; limit?: string; order?: string;
    };
    const order = q.order === 'asc' ? 'asc' : q.order === 'desc' ? 'desc' : undefined;
    return db.getMessages(id, {
      beforeMs: toInt(q.before),
      afterMs: toInt(q.after),
      limit: toInt(q.limit),
      order,
    });
  });

  app.get('/api/threads/:id/moments', async (request, reply) => {
    const { id: rawId } = request.params as { id?: string };
    const id = parseId(rawId, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    return db.getMoments(id);
  });

  // ── Tier-1 metrics (Phase 1) — read-through cached overview bundle for the Overview visuals. ──
  app.get('/api/threads/:id/metrics', async (request, reply) => {
    const { id: rawId } = request.params as { id?: string };
    const id = parseId(rawId, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    return getOrComputeMetrics(db, id);
  });

  // ── search ────────────────────────────────────────────────────────────────
  app.get('/api/search', async (request) => {
    const q = request.query as { q?: string; threadId?: string; limit?: string };
    const query = typeof q.q === 'string' ? q.q.trim() : '';
    if (!query) return [];
    return db.searchMessages(query, {
      threadId: toInt(q.threadId),
      limit: toInt(q.limit),
    });
  });

  // ── contact edits (light, Phase 0) ──────────────────────────────────────────
  app.post('/api/contacts/:id', async (request, reply) => {
    const { id: rawId } = request.params as { id?: string };
    const id = parseId(rawId, reply);
    if (id == null) return;

    const body = (request.body ?? {}) as {
      displayName?: unknown;
      relationshipType?: unknown;
      isDeceased?: unknown;
      deceasedSince?: unknown;
    };

    const patch: Partial<{
      displayName: string;
      relationshipType: RelationshipType;
      isDeceased: boolean;
      deceasedSince: string | null;
    }> = {};

    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string') {
        reply.status(400).send({ error: 'displayName must be a string' });
        return;
      }
      patch.displayName = body.displayName;
    }
    if (body.relationshipType !== undefined) {
      if (!RELATIONSHIP_TYPES.includes(body.relationshipType as RelationshipType)) {
        reply.status(400).send({ error: 'invalid relationshipType' });
        return;
      }
      patch.relationshipType = body.relationshipType as RelationshipType;
    }
    if (body.isDeceased !== undefined) {
      if (typeof body.isDeceased !== 'boolean') {
        reply.status(400).send({ error: 'isDeceased must be a boolean' });
        return;
      }
      patch.isDeceased = body.isDeceased;
    }
    if (body.deceasedSince !== undefined) {
      if (body.deceasedSince !== null && typeof body.deceasedSince !== 'string') {
        reply.status(400).send({ error: 'deceasedSince must be a string or null' });
        return;
      }
      patch.deceasedSince = body.deceasedSince as string | null;
    }

    db.updateContact(id, patch);
    return { ok: true };
  });

  // ── onboarding / region / owner meta ────────────────────────────────────────
  app.get('/api/meta/onboarding', async () => {
    const rawOnboarding = db.getMeta(META_ONBOARDING);
    let onboarding: unknown = null;
    if (rawOnboarding != null) {
      try { onboarding = JSON.parse(rawOnboarding); }
      catch { onboarding = rawOnboarding; }
    }
    // The awe-reveal ("N years. N messages. N people.") needs the archive's real scale — without these
    // a freshly-ingested stranger sees "0 years, 0 messages, 0 people". Compute them from the store.
    const agg = db.raw
      .prepare("SELECT COUNT(*) AS n, MIN(sent_at_ms) AS firstMs, MAX(sent_at_ms) AS lastMs FROM messages WHERE is_reaction = 0")
      .get() as { n: number; firstMs: number | null; lastMs: number | null };
    const people = (db.raw.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n;
    return {
      onboarding,
      region: db.getMeta(META_REGION),
      ownerContactId: toInt(db.getMeta(META_OWNER)) ?? null,
      messageCount: agg.n,
      firstMs: agg.firstMs,
      lastMs: agg.lastMs,
      contactCount: people,
    };
  });

  app.post('/api/meta/onboarding', async (request) => {
    const body = (request.body ?? {}) as {
      onboarding?: unknown;
      region?: unknown;
      ownerContactId?: unknown;
    };
    if (body.onboarding !== undefined) {
      db.setMeta(META_ONBOARDING, JSON.stringify(body.onboarding));
    }
    if (body.region !== undefined) {
      db.setMeta(META_REGION, String(body.region));
    }
    if (body.ownerContactId !== undefined) {
      db.setMeta(META_OWNER, String(body.ownerContactId));
    }
    return { ok: true };
  });

  // ── Phase 2: the airlock (plan → drain → ingest), L1 emotion, First Reflection ──

  // Plan an L1 analysis for a thread/range. dryRun → estimate only (capacity honesty, T2.9).
  app.post('/api/threads/:id/analyze', async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    const body = (request.body ?? {}) as { lens?: unknown; fromMs?: unknown; toMs?: unknown; dryRun?: unknown };
    const lens = body.lens === undefined ? 'l1_emotion' : body.lens;
    if (lens !== 'l1_emotion') {
      reply.status(400).send({ error: 'analyze supports lens "l1_emotion" (reflection uses /reflect)' });
      return;
    }
    return planAnalysis(db, {
      threadId: id,
      lens: 'l1_emotion',
      fromMs: toInt(body.fromMs) ?? null,
      toMs: toInt(body.toMs) ?? null,
      dryRun: body.dryRun === true,
      airlockDir: resolveAirlockDir(),
    });
  });

  // Drain pending jobs with an engine, await, then ingest into the DB (sole writer) + warm L1.
  app.post('/api/drain', async (request, reply) => {
    const body = (request.body ?? {}) as { engine?: unknown };
    const picked = resolveRequestEngine(db, body.engine);
    if (!picked.ok) { reply.status(picked.status).send({ error: picked.message }); return; }
    const engine = picked.engine;
    const airlockDir = resolveAirlockDir();
    const summary = await drain({ airlockDir, engine });
    const ingest = ingestResults(db, { airlockDir });
    for (const t of db.listThreads()) refreshEmotionDaily(db, t.id);
    return { summary, ingest, copy: drainCompleteCopy(ingest.ingested, 0) };
  });

  // Per-thread analysis state: job status counts + L1 emotion daily series.
  app.get('/api/threads/:id/analysis', async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    const store = createAirlockStore(db);
    return {
      jobStatusCounts: store.jobStatusCountsForThread(id),
      hasL1: hasEmotionDaily(db, id),
      emotionDaily: getEmotionDaily(db, id),
      coverage: emotionCoverage(db, id),
    };
  });

  // Run the First Reflection (gated reduce → render → freeze). Returns decline copy when gated.
  app.post('/api/threads/:id/reflect', async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    const body = (request.body ?? {}) as { fromMs?: unknown; toMs?: unknown; engine?: unknown };
    const picked = resolveRequestEngine(db, body.engine);
    if (!picked.ok) { reply.status(picked.status).send({ error: picked.message }); return; }
    return runFirstReflection(db, {
      threadId: id,
      fromMs: toInt(body.fromMs) ?? null,
      toMs: toInt(body.toMs) ?? null,
      engine: picked.engine,
      airlockDir: resolveAirlockDir(),
    });
  });

  // The final insight layer (A–E): ledger of hands, kids framing, apology economics,
  // exit signature, wearing-down. Deterministic; served from the metrics cache, recomputed on miss.
  app.get('/api/threads/:id/findings', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    return getFindings(db, id) ?? refreshFindings(db, id);
  });

  // Calibration status — whether THIS owner has tuned the tool to themselves (P2). The UI uses this to
  // caveat any directional read as provisional until calibration is done.
  app.get('/api/threads/:id/calibration', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    return calibrationStatus(db);
  });

  // The blind hold-out the owner labels (P2). Deliberately omits the model's tension so the owner
  // can't anchor to it — the server rejoins the score on submit.
  app.get('/api/threads/:id/calibration/sample', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const n = toInt((request.query as { n?: string }).n) ?? 40;
    return sampleHoldout(db, id, Math.max(10, Math.min(80, n)));
  });

  // Apply the owner's blind marks (P2): rejoin each to the model's tension server-side, derive the
  // thresholds + self-report-bias, and persist both. The only sanctioned writer of those app_meta keys.
  app.post('/api/threads/:id/calibrate', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const body = request.body as { marks?: unknown; labels?: unknown };
    if (Array.isArray(body?.marks) && body.marks.length) {
      return applyCalibration(db, biasLabelsFromMarks(db, id, body.marks as OwnerMark[]));
    }
    if (Array.isArray(body?.labels) && body.labels.length) {   // direct BiasLabel[] path (CLI/headless)
      return applyCalibration(db, body.labels as BiasLabel[]);
    }
    reply.status(400).send({ error: 'body.marks (owner {id,label}[]) or body.labels (BiasLabel[]) required, non-empty' });
  });

  // The sample-and-agree checkpoint (guardrail 8): the top-severe episodes the owner reviews before
  // the full L4 drain, and whether they've confirmed. The abuse lens will not speak a support frame,
  // and the full drain will not run, until confirmation is recorded.
  app.get('/api/threads/:id/l4/sample', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const sample = selectSampleEpisodes(db, id, 10).map((e) => ({
      id: e.id, startMs: e.startMs, endMs: e.endMs, severeMe: e.severeMe, severeThem: e.severeThem,
      initiator: e.initiator, peakTension: e.peakTension, kidNamed: e.kidNamed,
    }));
    return { confirmed: isL4SampleConfirmed(db, id), sample };
  });

  app.post('/api/threads/:id/l4/confirm', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const grades = (request.body as { grades?: unknown })?.grades;
    if (!Array.isArray(grades) || !grades.length) {
      reply.status(400).send({ error: "body.grades must be a non-empty array of 'fair'|'overstated'|'understated'" });
      return;
    }
    return recordL4SampleConfirmed(db, id, grades as string[], new Date().toISOString());
  });

  // Engine mode (app-wide, P3): whether Between may spend money / send text off-device, and how.
  // Fail-safe default is 'local-only'. Honored by the paid Batch path (a local-only owner can't
  // accidentally bill). GET reports the mode + whether paid inference is permitted.
  app.get('/api/engine-mode', async () => {
    const mode = getEngineMode(db);
    return { mode, paidBatchAllowed: paidBatchAllowed(mode) };
  });
  app.put('/api/engine-mode', async (request, reply) => {
    const mode = (request.body as { mode?: unknown })?.mode;
    if (mode !== 'local-only' && mode !== 'subscription' && mode !== 'api-key') {
      reply.status(400).send({ error: "body.mode must be 'local-only' | 'subscription' | 'api-key'" });
      return;
    }
    const set = setEngineMode(db, mode as EngineMode);
    return { mode: set, paidBatchAllowed: paidBatchAllowed(set) };
  });

  // Experimental interpretive layer (P1-11): the L4 abuse stage-2, the power-balance support frame, and
  // the other-side / findings readings are experimental, text-only, and NOT externally validated — OFF by
  // default. The owner opts in here with sober consent. The deterministic findings A–E counts are always
  // available regardless.
  // At-rest posture (P1-12): a cloud-sync warning for the web to surface as a banner, when the working
  // directory looks synced. null when it looks local-only.
  app.get('/api/at-rest', async () => ({ syncWarning: cloudSyncWarning(resolveAirlockDir()) }));

  app.get('/api/experimental-lenses', async () => ({ enabled: experimentalLensesEnabled(db) }));
  app.put('/api/experimental-lenses', async (request, reply) => {
    const on = (request.body as { enabled?: unknown })?.enabled;
    if (typeof on !== 'boolean') { reply.status(400).send({ error: 'body.enabled must be a boolean' }); return; }
    return { enabled: setExperimentalLenses(db, on) };
  });

  // Owner timezone (P2-14): day-level surfaces (the river, the heatmap, busiest day/hour) bucket by
  // the owner's LIVED clock, not UTC. Onboarding posts Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Settings can edit it. Changing it recomputes the cached day-level metrics (the river) for every thread.
  app.get('/api/timezone', async () => ({ timezone: getTimezone(db) }));
  app.put('/api/timezone', async (request, reply) => {
    const tz = (request.body as { timezone?: unknown })?.timezone;
    if (!isValidTimeZone(tz)) {
      reply.status(400).send({ error: 'body.timezone must be a valid IANA zone (e.g. America/Los_Angeles)' });
      return;
    }
    const set = setTimezone(db, tz);
    for (const t of db.listThreads()) refreshEmotionDaily(db, t.id);
    return { timezone: set };
  });

  // Frozen, dated reflections for a thread (immutable; regeneration is a new row).
  app.get('/api/threads/:id/reflections', async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return;
    if (!db.getThread(id)) {
      reply.status(404).send({ error: 'Thread not found' });
      return;
    }
    const lens = (request.query as { lens?: string }).lens;
    const rows = (lens === 'all'
      ? db.raw.prepare('SELECT * FROM reflections WHERE thread_id = ? ORDER BY generated_at DESC').all(id)
      : db.raw.prepare('SELECT * FROM reflections WHERE thread_id = ? AND lens = ? ORDER BY generated_at DESC').all(id, lens ?? 'first_reflection')) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      let evidence: unknown = {};
      try { evidence = JSON.parse(r.evidence_json as string); } catch { evidence = {}; }
      return {
        id: r.id, lens: r.lens,
        rangeStartMs: r.range_start_ms, rangeEndMs: r.range_end_ms,
        contentMd: r.content_md, evidence,
        promptVersion: r.prompt_version, modelNote: r.model_note, generatedAt: r.generated_at,
      };
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2 UI adapters — the same airlock logic, exposed in the web client's
  // dialect (web/src/lib/api.ts). Thin delegations over the tested functions
  // above; the canonical routes (/analyze, /drain, /analysis, /reflect) remain
  // for the CLIs and tests. The app is still the sole writer and never auto-drains.
  // ───────────────────────────────────────────────────────────────────────────
  const griefThread = (id: number): boolean => {
    const row = db.raw
      .prepare(
        `SELECT max(c.is_deceased) AS g FROM thread_participants tp
           JOIN contacts c ON c.id = tp.contact_id
          WHERE tp.thread_id = ? AND tp.role != 'owner'`,
      )
      .get(id) as { g: number | null } | undefined;
    return !!(row && row.g);
  };
  const statusCounts = (id: number): Record<string, number> =>
    (createAirlockStore(db).jobStatusCountsForThread(id) ?? {}) as Record<string, number>;
  const drainStatus = (id: number, lens: 'l1_emotion' | 'first_reflection') => {
    const c = statusCounts(id);
    const total = Object.values(c).reduce((a, b) => a + (b || 0), 0);
    const remaining = (c.pending ?? 0) + (c.claimed ?? 0) + (c.running ?? 0);
    return {
      threadId: id, lens, total, done: c.done ?? 0, cached: 0, remaining,
      errored: c.error ?? 0, refused: c.refused ?? 0, etaSeconds: null,
      drainsRemaining: remaining > 0 ? Math.ceil(remaining / 20) : 0,
      updatedAt: new Date().toISOString(),
    };
  };
  const planToDto = (
    id: number, lens: 'l1_emotion' | 'first_reflection',
    outcome: ReturnType<typeof planAnalysis>, belowFloor: boolean, substantiveCount: number,
  ) => {
    const e = outcome.estimate;
    return {
      lens, threadId: id, rangeStartMs: outcome.fromMs, rangeEndMs: outcome.toMs,
      substantiveCount, windowCount: e.windowCount, newCount: e.toRun, cachedCount: e.cached,
      drainCount: e.drains, timeEstimateText: e.timeEstimate, belowFloor, griefMode: griefThread(id),
      cost: estimateReadCost(db, lens, e.toRun),
    };
  };
  const requireThread = (request: { params: unknown }, reply: FastifyReply): number | undefined => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return undefined;
    if (!db.getThread(id)) { reply.status(404).send({ error: 'Thread not found' }); return undefined; }
    return id;
  };

  // L1 emotion series for the river (available:false until a drain has run).
  app.get('/api/threads/:id/emotion', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const points = getEmotionDaily(db, id);
    const c = statusCounts(id);
    // Thread-level coverage travels WITH the series, not beside it. The client cannot honestly decide
    // which layer to draw without it, and a client that has to make a second request to find out will
    // eventually draw the model layer while that request is still in flight (P1-7).
    const cov = emotionCoverage(db, id);
    return {
      threadId: id,
      available: points.length > 0,
      scoredWindows: c.done ?? 0,
      totalWindows: Object.values(c).reduce((a, b) => a + (b || 0), 0),
      refusedWindows: cov.refusedWindows,
      erroredWindows: cov.erroredWindows,
      eligibleMessages: cov.eligibleMessages,
      scoredMessages: cov.scoredMessages,
      coveragePct: cov.coveragePct,
      modelComplete: cov.modelComplete,
      daily: points.map((p) => ({ date: p.date, count: p.count, warmth: p.warmth01, tension: p.tension01, valence: p.valence })),
      generatedAt: null,
    };
  });

  // S1 trajectory: the honest two-metric story (arrives vs answered) + era bands + deluge strip.
  // Pure server aggregation from messages + L1 scores + eras; no model calls.
  app.get('/api/threads/:id/trajectory', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    return computeTrajectory(db, id);
  });

  // Ambient/baseline stats — the just-interesting descriptive layer (rhythm, cadence, word maps).
  app.get('/api/threads/:id/ambient', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    return computeAmbient(db, id, { tzOffsetHours: toInt((request.query as { tz?: string }).tz) });
  });

  // S2 episode explorer: the episode list, and one episode with the words underneath (receipts).
  app.get('/api/threads/:id/episodes', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    return getEpisodes(db, id);
  });
  app.get('/api/episodes/:id', async (request, reply) => {
    const eid = parseId((request.params as { id?: string }).id, reply);
    if (eid == null) return;
    const e = getEpisodeById(db, eid);
    if (!e) { reply.status(404).send({ error: 'Episode not found' }); return; }
    const messages = db.getMessages(e.threadId, { afterMs: e.startMs - 1, beforeMs: e.endMs + 1, limit: 2000, order: 'asc' });
    return { episode: e, messages };
  });

  // S3 ask-anything, v1: deterministic retriever → receipt set (synthesis is a separate model job).
  app.post('/api/threads/:id/ask/plan', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const b = (request.body ?? {}) as { query?: unknown; filters?: unknown };
    const f = (b.filters ?? {}) as Record<string, unknown>;
    return planAsk(db, id, typeof b.query === 'string' ? b.query : '', {
      fromMs: toInt(f.fromMs) ?? null,
      toMs: toInt(f.toMs) ?? null,
      direction: f.direction === 'me' || f.direction === 'them' ? f.direction : undefined,
      minTension: toInt(f.minTension),
      maxTension: toInt(f.maxTension),
      minWarmth: toInt(f.minWarmth),
      kidOnly: f.kidOnly === true,
      limit: toInt(f.limit),
    });
  });

  // Capacity estimate for an L1 read (no work done — capacity honesty).
  app.post('/api/threads/:id/analysis/plan', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const b = (request.body ?? {}) as { rangeStartMs?: unknown; rangeEndMs?: unknown };
    const outcome = planAnalysis(db, {
      threadId: id, lens: 'l1_emotion', fromMs: toInt(b.rangeStartMs) ?? null, toMs: toInt(b.rangeEndMs) ?? null,
      dryRun: true, airlockDir: resolveAirlockDir(),
    });
    return planToDto(id, 'l1_emotion', outcome, false, 0);
  });

  // Commit an L1 run: materialize jobs. The drain runs externally (/drain-jobs or Ollama).
  app.post('/api/threads/:id/analysis/run', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const b = (request.body ?? {}) as { rangeStartMs?: unknown; rangeEndMs?: unknown };
    planAnalysis(db, {
      threadId: id, lens: 'l1_emotion', fromMs: toInt(b.rangeStartMs) ?? null, toMs: toInt(b.rangeEndMs) ?? null,
      dryRun: false, airlockDir: resolveAirlockDir(),
    });
    return drainStatus(id, 'l1_emotion');
  });

  // Honest drain status (job counts). No mutation.
  app.get('/api/threads/:id/analysis/status', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const lens = (request.query as { lens?: string }).lens === 'first_reflection' ? 'first_reflection' : 'l1_emotion';
    return drainStatus(id, lens);
  });

  // Ingest whatever the (external) drain wrote; the app is the sole writer. Awaited.
  app.post('/api/threads/:id/analysis/ingest', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const airlockDir = resolveAirlockDir();
    const ing = ingestResults(db, { airlockDir });
    refreshEmotionDaily(db, id);
    return { status: drainStatus(id, 'l1_emotion'), newCount: ing.ingested, cachedCount: 0 };
  });

  // Reflection estimate + gate (floor / grief) for the Session read-invite.
  app.post('/api/threads/:id/reflections/plan', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const b = (request.body ?? {}) as { rangeStartMs?: unknown; rangeEndMs?: unknown };
    const fromMs = toInt(b.rangeStartMs) ?? null;
    const toMs = toInt(b.rangeEndMs) ?? null;
    const substantive = loadRangeMessages(db, id, fromMs, toMs).length;
    const outcome = planAnalysis(db, { threadId: id, lens: 'l1_emotion', fromMs, toMs, dryRun: true, airlockDir: resolveAirlockDir() });
    return planToDto(id, 'first_reflection', outcome, substantive < 150, substantive);
  });

  // Commit a reflection run (reduce → render). Needs an engine to actually read.
  app.post('/api/threads/:id/reflections/run', async (request, reply) => {
    const id = requireThread(request, reply);
    if (id == null) return;
    const b = (request.body ?? {}) as { rangeStartMs?: unknown; rangeEndMs?: unknown; engine?: unknown };
    const picked = resolveRequestEngine(db, b.engine);
    if (!picked.ok) { reply.status(picked.status).send({ error: picked.message }); return; }
    await runFirstReflection(db, {
      threadId: id, fromMs: toInt(b.rangeStartMs) ?? null, toMs: toInt(b.rangeEndMs) ?? null,
      engine: picked.engine, airlockDir: resolveAirlockDir(),
    });
    return drainStatus(id, 'first_reflection');
  });

  // A single frozen reflection by id, with claims mapped from the evidence map.
  app.get('/api/reflections/:id', async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, reply);
    if (id == null) return;
    const row = db.raw.prepare('SELECT * FROM reflections WHERE id = ?').get(id) as
      | { id: number; thread_id: number; lens: string; range_start_ms: number; range_end_ms: number;
          content_md: string; evidence_json: string; prompt_version: number; model_note: string | null; generated_at: string }
      | undefined;
    if (!row) { reply.status(404).send({ error: 'Reflection not found' }); return; }
    let evidence: Record<string, unknown> = {};
    try { evidence = JSON.parse(row.evidence_json) as Record<string, unknown>; } catch { evidence = {}; }
    const claims = Object.entries(evidence).map(([fragment, ids], i) => ({
      id: `c${i}`,
      fragment,
      evidenceIds: (Array.isArray(ids) ? ids : []).map((x) => Number(String(x).replace(/^m/, ''))).filter((n) => Number.isFinite(n)),
      confidence: null,
    }));
    return {
      id: row.id, threadId: row.thread_id, lens: row.lens,
      rangeStartMs: row.range_start_ms, rangeEndMs: row.range_end_ms,
      generatedAt: row.generated_at, promptVersion: row.prompt_version,
      title: null, contentMd: row.content_md, modelNote: row.model_note, claims,
    };
  });

  // Receipt resolution — messages by id (invariant 1 drill).
  app.get('/api/messages', async (request) => {
    const ids = String((request.query as { ids?: string }).ids ?? '')
      .split(',').map((s) => toInt(s)).filter((n): n is number => n != null);
    if (ids.length === 0) return [];
    const ph = ids.map(() => '?').join(',');
    const rows = db.raw.prepare(
      `SELECT m.id, m.direction, m.kind, m.sent_at_ms AS sentAtMs, m.body_text AS bodyText,
              m.is_reaction AS isReaction, m.reaction_kind AS reactionKind, c.display_name AS senderName,
              (SELECT count(*) FROM attachments a WHERE a.message_id = m.id AND a.is_smil = 0) AS attachmentCount
         FROM messages m LEFT JOIN contacts c ON c.id = m.sender_contact_id
        WHERE m.id IN (${ph})`,
    ).all(...ids) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ ...r, isReaction: !!r.isReaction }));
  });

  // "That's not right" — record a suppression/correction override (§5.3).
  app.post('/api/overrides', async (request) => {
    const b = (request.body ?? {}) as { targetKind?: unknown; targetRef?: unknown; action?: unknown; note?: unknown };
    const kind = b.targetKind === 'message' || b.targetKind === 'merge' ? b.targetKind : 'claim';
    const action = b.action === 'correct' ? 'correct' : 'suppress';
    db.raw.prepare('INSERT INTO overrides (target_kind, target_ref, action, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, String(b.targetRef ?? ''), action, typeof b.note === 'string' ? b.note : null, new Date().toISOString());
    return { ok: true };
  });
  // ── "Your data" — the lifecycle panel (Era 1) ─────────────────────────────
  // Every path these act on is server-derived (see buildServer). None of them takes a location from
  // the client: this is a fixed set of operations on Between's own folders, not a remote file manager.
  if (dataPaths) {
    app.get('/api/data/overview', async () => ({
      ...dataOverview(db, dataPaths),
      log: readActionLog(db),
    }));

    app.post('/api/data/integrity', async () => verifyIntegrity(db));

    app.post('/api/data/backup', async (_req, reply) => {
      try {
        return await backupNow(db, dataPaths);
      } catch (e) {
        reply.status(500);
        return { path: '', sizeBytes: 0, message: `The backup could not be written: ${e instanceof Error ? e.message : 'unknown problem'}. Nothing was changed.` };
      }
    });

    app.post('/api/data/sources/delete', async () => deleteImportedSources(db, dataPaths));

    app.post('/api/data/transport/purge', async () => purgeTransportFiles(dataPaths, db));

    app.post('/api/data/open-folder', async () => openDataFolder(dataPaths));

    // Double-confirmed in the UI; the typed word is checked here too, because a confirmation that
    // only exists in the client is not a confirmation.
    app.post('/api/data/delete-all', async (request, reply) => {
      const b = (request.body ?? {}) as { confirmation?: unknown };
      const result = deleteAllData(db, dataPaths, typeof b.confirmation === 'string' ? b.confirmation : '');
      if (!result.ok) reply.status(400);
      return result;
    });
  }
}
