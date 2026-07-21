// Engine-tier routing: Ollama does the 'local' grunt and never clobbers the worthwhile
// reduce/render jobs (which belong to Claude/Fable).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engineForHint, drain } from '../src/airlock/engine';

describe('engineForHint (tier routing)', () => {
  it('local→ollama (grunt); claude/render→claude (worthwhile); unknown→mock', () => {
    expect(engineForHint('local')).toBe('ollama');
    expect(engineForHint('claude')).toBe('claude');
    expect(engineForHint('render')).toBe('claude');
    expect(engineForHint('nonsense')).toBe('mock');
  });
});

describe('drain only-filter — the tier guard', () => {
  function writeJob(dir: string, id: string, hint: string): void {
    const job = {
      job_id: id, input_hash: `sha256:${id}`,
      lens: hint === 'local' ? 'l1_emotion' : 'first_reflection_render',
      kind: hint === 'local' ? 'map' : 'render',
      engine_hint: hint, prompt_id: 'x', prompt_version: 1, instructions: 'x',
      chunk: { thread_id: 1, start_msg_id: 1, end_msg_id: 1, overlap_prefix_ids: [], transcript: '[m1] 2020-01-01 00:00 ME: hi' },
      output_schema: {}, rules: [],
    };
    writeFileSync(join(dir, 'jobs', `${id}.json`), JSON.stringify(job));
  }

  it('only=local: the mock drain reads the local job and leaves the render job pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'between-airlock-'));
    for (const d of ['jobs', 'results', 'archive']) mkdirSync(join(root, d), { recursive: true });
    writeJob(root, 'job_local1', 'local');
    writeJob(root, 'job_render1', 'render');
    try {
      const summary = await drain({ airlockDir: root, engine: 'mock', only: 'local' });
      expect(summary.processed).toBe(1);
      expect(existsSync(join(root, 'results', 'job_local1.json'))).toBe(true);
      expect(existsSync(join(root, 'results', 'job_render1.json'))).toBe(false); // worthwhile: untouched
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
