// Between — T-CALIBRATE: the self-report-bias defence must be LIVE, not dead code. Proves that a
// self-lenient labeler (soft on their own hard messages, harsh on the partner's) actually raises the
// power-balance gate threshold above the 0.66 default — the guardrail for a next owner who is less
// introspective than the tool's author. Before this wiring, computeSelfReportBias had zero callers and
// the bump was always 0.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { seedThread } from './helpers/seed';
import { applyCalibration, deriveThresholds, sampleHoldout, biasLabelsFromMarks } from '../src/lenses/calibrate';
import { calibrationStatus } from '../src/lenses/calibration';
import type { BiasLabel } from '../src/lenses/bias';

let tmpDir: string;
let db: BetweenDB;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'between-cal-'));
  db = openDb(join(tmpDir, 'test.db'));
  seedThread(db, [{ dir: 'incoming', ms: Date.UTC(2024, 0, 1), tension: 3, body: 'seed' }]); // just to make thread 1 exist
});
afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

// A self-lenient owner: their OWN high-tension messages get labeled gently (benign/mild),
// the partner's identical-tension messages get labeled cruel/harsh.
function selfLenient(): BiasLabel[] {
  const rows: BiasLabel[] = [];
  for (let i = 0; i < 10; i++) rows.push({ dir: 'ME', tension: 3, label: i < 8 ? 'benign' : 'mild' });
  for (let i = 0; i < 10; i++) rows.push({ dir: 'THEM', tension: 3, label: i < 8 ? 'cruel' : 'harsh' });
  return rows;
}

describe('T-CALIBRATE', () => {
  it('starts UNcalibrated on an empty db — direction must read as provisional', () => {
    const s = calibrationStatus(db);
    expect(s.calibrated).toBe(false);
    expect(s.note).toMatch(/NOT yet calibrated/i);
  });

  it('a self-lenient calibration writes both meta keys and RAISES the gate threshold above 0.66', () => {
    const { bias } = applyCalibration(db, selfLenient());
    expect(bias.verdict).toBe('self_lenient');
    expect(bias.gateThresholdBump).toBeGreaterThan(0);           // the defence actually engaged

    // the exact reader the gate uses (abuse.gateFor) computes 0.66 + bump
    const stored = JSON.parse(db.getMeta('self_report_bias')!) as { gateThresholdBump: number };
    expect(0.66 + stored.gateThresholdBump).toBeGreaterThan(0.66);

    const s = calibrationStatus(db);
    expect(s.calibrated).toBe(true);                              // both keys now present
  });

  it('derives per-owner thresholds from the labels rather than shipping the developer’s defaults', () => {
    const t = deriveThresholds(selfLenient());
    expect(t.hostile_tension).toBeGreaterThanOrEqual(1);
    expect(t.severe_tension).toBeGreaterThan(t.hostile_tension - 1);
    expect(db.getMeta('calibration')).toBeNull();                // deriveThresholds is pure — no write
  });

  it('the blind hold-out never leaks the model score, and covers both sides', () => {
    // richer fixture: both directions, spread of tension
    const d2 = openDb(join(tmpDir, 'holdout.db'));
    seedThread(d2, [
      { dir: 'outgoing', ms: Date.UTC(2024, 0, 1), tension: 3, body: 'you are impossible' },
      { dir: 'incoming', ms: Date.UTC(2024, 0, 2), tension: 3, body: 'i hate you' },
      { dir: 'outgoing', ms: Date.UTC(2024, 0, 3), tension: 0, body: 'ok love you' },
      { dir: 'incoming', ms: Date.UTC(2024, 0, 4), tension: 1, body: 'fine' },
      { dir: 'outgoing', ms: Date.UTC(2024, 0, 5), tension: 2, body: 'stop it' },
      { dir: 'incoming', ms: Date.UTC(2024, 0, 6), tension: 2, body: 'no you stop' },
    ]);
    const sample = sampleHoldout(d2, 1, 4);
    expect(sample.length).toBeLessThanOrEqual(4);
    expect(sample.length).toBeGreaterThan(0);
    for (const it of sample) {
      expect(it).toHaveProperty('id'); expect(it).toHaveProperty('dir'); expect(it).toHaveProperty('text');
      expect(it).not.toHaveProperty('tension');                  // the anti-anchoring guarantee
    }
    expect(new Set(sample.map((s) => s.dir)).size).toBe(2);      // both ME and THEM present

    // marks rejoin to the model tension + direction server-side
    const marks = sample.map((s) => ({ id: s.id, label: 'mild' }));
    const labels = biasLabelsFromMarks(d2, 1, marks);
    expect(labels.length).toBe(sample.length);
    for (const l of labels) { expect(['ME', 'THEM']).toContain(l.dir); expect(typeof l.tension).toBe('number'); }
    d2.close();
  });
});
