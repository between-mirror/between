// Between — metrics facade + cache. The Overview reads getOrComputeMetrics; the CLI and the
// post-ingest warm use refreshMetrics. The cache lives in the `metrics` table (schema.sql §2.3
// stage 8): one row per thread, keyed metric_key='overview_bundle', period='all', start 0. The
// app is the sole SQLite writer (HANDOFF invariant 2), so writing this cache from the server
// process is allowed.
import type { BetweenDB } from '../store/db';
import type { MetricsBundle } from './contract';
import { computeMetrics } from './compute';

const METRIC_KEY = 'overview_bundle';
const PERIOD = 'all';
const PERIOD_START_MS = 0;

/** Read the cached bundle for a thread, or undefined on a miss / unparseable row. */
function readCached(db: BetweenDB, threadId: number): MetricsBundle | undefined {
  const row = db.raw
    .prepare(
      `SELECT value_json AS v FROM metrics
        WHERE thread_id = ? AND metric_key = ? AND period = ? AND period_start_ms = ?`,
    )
    .get(threadId, METRIC_KEY, PERIOD, PERIOD_START_MS) as { v: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.v) as MetricsBundle;
  } catch {
    return undefined; // corrupt cache → force recompute
  }
}

/** Compute the bundle and write it to the cache (overwriting any prior row for this thread). */
export function refreshMetrics(db: BetweenDB, threadId: number): MetricsBundle {
  const bundle = computeMetrics(db, threadId);
  db.raw
    .prepare(
      `INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(threadId, METRIC_KEY, PERIOD, PERIOD_START_MS, JSON.stringify(bundle));
  return bundle;
}

/** Read-through cache: return the cached bundle, else compute + cache it. */
export function getOrComputeMetrics(db: BetweenDB, threadId: number): MetricsBundle {
  return readCached(db, threadId) ?? refreshMetrics(db, threadId);
}

export { computeMetrics } from './compute';
export type { ComputeMetricsOptions } from './compute';
