// Between — the owner's engine mode (Phase 5 P3). One app-wide preference deciding whether Between may
// spend money / send message text to a model, and how. The fail-safe DEFAULT is 'local-only': the whole
// deterministic surface works, the local grunt runs if a local model is present, and the prose tier
// declines cleanly (DECLINE_NO_ENGINE) — nothing bills and nothing egresses until the owner explicitly
// opts in. This preference is honored, not just recorded (see runBatch): a 'local-only' owner cannot
// accidentally trigger a paid Batch run. (The bias detector was once dead code; this one must not be.)
import type { BetweenDB } from '../store/db';

export type EngineMode = 'local-only' | 'subscription' | 'api-key';
const MODES = new Set<EngineMode>(['local-only', 'subscription', 'api-key']);
const KEY = 'engine_mode';

/** The owner's mode, defaulting to the safe 'local-only' when unset/invalid. */
export function getEngineMode(db: BetweenDB): EngineMode {
  const raw = db.getMeta(KEY);
  return raw && MODES.has(raw as EngineMode) ? (raw as EngineMode) : 'local-only';
}

export function setEngineMode(db: BetweenDB, mode: EngineMode): EngineMode {
  if (!MODES.has(mode)) throw new Error(`invalid engine mode: ${mode}`);
  db.setMeta(KEY, mode);
  return mode;
}

/** Whether paid, off-device inference (the Anthropic Batch API / an API key) is permitted in this mode.
 *  'api-key' allows it; 'local-only' and 'subscription' do not (subscription runs interactively, never a
 *  headless paid batch). Callers gate real spend on this. */
export function paidBatchAllowed(mode: EngineMode): boolean {
  return mode === 'api-key';
}

/** The request engines the server is allowed to spawn for a given mode (P0-5). Prose runs on the local
 *  grunt (local-only, api-key) or local+Claude subscription (subscription); the paid Batch grunt is
 *  CLI-only and separately gated, so it is never a server-request engine. Mock is a test-only engine,
 *  present only when BETWEEN_ALLOW_MOCK=1. */
export type RequestEngine = 'ollama' | 'claude' | 'mock';
export function allowedEngines(mode: EngineMode, allowMock: boolean): Set<RequestEngine> {
  const base: RequestEngine[] = mode === 'subscription' ? ['ollama', 'claude'] : ['ollama'];
  if (allowMock) base.push('mock');
  return new Set(base);
}

/** The mock engine is available ONLY when the harness opts in. Production never sets this env var. */
export function mockAllowed(): boolean {
  return process.env.BETWEEN_ALLOW_MOCK === '1';
}
