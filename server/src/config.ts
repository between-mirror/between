// Between — config loader. Reads between.config.json from the repo root, merged with defaults.
// Non-personal, tracked config only (paths, ports, engine tiers, Ollama). Personalization lives
// in the DB (Addendum B.1). Paths resolve relative to the repo root so CLIs work from any cwd.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';

export interface BetweenConfig {
  dbPath: string;
  airlockDir: string;
  dataDir: string;
  api: { port: number; host: string };
  ingest: { sessionGapMinutes: number; batchSize: number; nonEnglishSuppressThreshold: number; coverageMinConfidence: number };
  defaultRegion: string;
  ollama: { model: string; url: string; numCtx: number };
  /** engine_hint → engine tier. local = grunt (Ollama); claude/render = worthwhile (Claude/Fable). */
  engines: Record<string, string>;
}

const DEFAULTS: BetweenConfig = {
  dbPath: 'between.db',
  airlockDir: 'airlock',
  dataDir: 'data',
  api: { port: 5274, host: '127.0.0.1' },
  ingest: { sessionGapMinutes: 60, batchSize: 5000, nonEnglishSuppressThreshold: 0.35, coverageMinConfidence: 0.5 },
  defaultRegion: 'US',
  ollama: { model: 'llama3.1', url: 'http://127.0.0.1:11434', numCtx: 8192 },
  engines: { local: 'ollama', claude: 'claude', render: 'claude' },
};

/** Repo root — this file lives at server/src/config.ts. */
export function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

export function loadConfig(): BetweenConfig {
  let raw: Partial<BetweenConfig> = {};
  try {
    raw = JSON.parse(readFileSync(join(repoRoot(), 'between.config.json'), 'utf8')) as Partial<BetweenConfig>;
  } catch { /* fall back to defaults */ }
  const cfg: BetweenConfig = {
    ...DEFAULTS,
    ...raw,
    api: { ...DEFAULTS.api, ...(raw.api ?? {}) },
    ingest: { ...DEFAULTS.ingest, ...(raw.ingest ?? {}) },
    ollama: { ...DEFAULTS.ollama, ...(raw.ollama ?? {}) },
    engines: { ...DEFAULTS.engines, ...(raw.engines ?? {}) },
  };
  const abs = (p: string) => (isAbsolute(p) ? p : join(repoRoot(), p));
  // BETWEEN_DB overrides the configured db without editing config (used by `demo:serve` to open
  // examples/demo.db without touching the owner's own between.db). Non-destructive.
  cfg.dbPath = abs(process.env.BETWEEN_DB ?? cfg.dbPath);
  cfg.airlockDir = abs(cfg.airlockDir);
  cfg.dataDir = abs(cfg.dataDir);
  return cfg;
}
