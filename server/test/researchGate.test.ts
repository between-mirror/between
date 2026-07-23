// Between — the research gate on the interpretive layer.
//
// This is the layer most easily misread as a neutral verdict — in a custody fight, or by someone
// profiling the partner they are already controlling. It is off, and the thing these tests protect
// is that "off" means something stronger than a default: it cannot be turned on from inside the
// application, by any request the app can make on its own behalf.
//
// It is also NOT removed. Era 5's clinician panel has to be able to run the thing it is being asked
// to evaluate, and "we deleted it" is a different claim from "it is off".
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/store/db';
import { buildServer } from '../src/server';
import {
  experimentalLensesEnabled, researchModeFlag, researchModeFromConfig,
  researchConsentRecorded, recordResearchConsent,
  RESEARCH_CONSENT, RESEARCH_ENV,
} from '../src/lenses/experimental';

const root = mkdtempSync(join(tmpdir(), 'between-research-'));
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let seq = 0;
let dbPath: string;
beforeEach(() => {
  dbPath = join(root, `r${seq++}.db`);
  delete process.env[RESEARCH_ENV];
});
afterEach(() => { delete process.env[RESEARCH_ENV]; });

describe('the gate is off, and cannot be opened from the app', () => {
  it('is off with no flag set', () => {
    const db = openDb(dbPath);
    expect(researchModeFlag()).toBe(false);
    expect(experimentalLensesEnabled(db)).toBe(false);
    db.close();
  });

  it('serves no route that can turn it on', async () => {
    // It used to be a PUT. A gate an ordinary build can flip is a gate a bug can flip, and the
    // claim in STATUS described a Settings control that had never been built.
    const db = openDb(dbPath);
    db.close();
    const app: FastifyInstance = buildServer(dbPath);
    await app.ready();
    try {
      for (const method of ['PUT', 'POST', 'PATCH'] as const) {
        const res = await app.inject({
          method, url: '/api/experimental-lenses',
          headers: { host: '127.0.0.1:5274', 'content-type': 'application/json' },
          payload: { enabled: true },
        });
        expect(res.statusCode, `${method} must not be routed`).toBe(404);
      }
      const get = await app.inject({
        method: 'GET', url: '/api/experimental-lenses', headers: { host: '127.0.0.1:5274' },
      });
      expect(get.statusCode).toBe(200);
      expect((get.json() as { enabled: boolean }).enabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a flag alone does not run anything against an archive', () => {
    // The flag is a decision about a process. Whether an unvalidated reading may be written about
    // the specific person in this archive is a different decision, and it is recorded separately.
    process.env[RESEARCH_ENV] = '1';
    const db = openDb(dbPath);
    expect(researchModeFlag()).toBe(true);
    expect(researchConsentRecorded(db)).toBe(false);
    expect(experimentalLensesEnabled(db)).toBe(false);
    db.close();
  });

  it('runs only once both the flag and the acknowledgement are in place', () => {
    process.env[RESEARCH_ENV] = '1';
    const db = openDb(dbPath);
    recordResearchConsent(db);
    expect(experimentalLensesEnabled(db)).toBe(true);
    db.close();
  });

  it('an acknowledgement without the flag still runs nothing', () => {
    const db = openDb(dbPath);
    recordResearchConsent(db);
    expect(experimentalLensesEnabled(db)).toBe(false);
    db.close();
  });

  it('opens for an environment variable', () => {
    expect(researchModeFlag()).toBe(false);
    process.env[RESEARCH_ENV] = '1';
    expect(researchModeFlag()).toBe(true);
  });

  it('opens for a hand-written line in between.config.json, and for nothing near it', () => {
    // The documented door for an evaluator, exercised through the same function the lenses call.
    // A documented way in that nothing tests is how a gate quietly stops being one.
    const on = join(root, 'on.config.json');
    writeFileSync(on, JSON.stringify({ dbPath: 'x.db', researchInterpretiveLayer: true }));
    expect(researchModeFromConfig(on)).toBe(true);

    // Only the literal true. A string, a 1, or a typo'd key leaves it shut.
    for (const cfg of [
      { researchInterpretiveLayer: 'true' },
      { researchInterpretiveLayer: 1 },
      { researchInterpretivelayer: true },
      {},
    ]) {
      const off = join(root, `off-${seq++}.config.json`);
      writeFileSync(off, JSON.stringify(cfg));
      expect(researchModeFromConfig(off), JSON.stringify(cfg)).toBe(false);
    }

    // A missing or unreadable config is not an activation.
    expect(researchModeFromConfig(join(root, 'nope.config.json'))).toBe(false);
  });
});

describe('what an evaluator is told before it runs', () => {
  it('names itself a research preview and refuses to claim validation', () => {
    expect(RESEARCH_CONSENT).toMatch(/Research preview — not validated/);
    expect(RESEARCH_CONSENT).toMatch(/No clinician has evaluated them/);
    // The two situations where it is most tempting and most dangerous are named, not softened.
    expect(RESEARCH_CONSENT).toMatch(/custody/i);
    expect(RESEARCH_CONSENT.toLowerCase()).toContain('not a diagnosis');
  });

  it('does not promise numbers that do not exist', () => {
    expect(RESEARCH_CONSENT).toMatch(/no published false-positive or false-negative numbers/i);
  });
});
