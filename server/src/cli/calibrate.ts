// Calibration CLI (Phase 5 P2, dev/headless path): `calibrate.ts --thread N --labels labels.json [--db between.db]`.
// labels.json is a BiasLabel[] — each { dir: 'ME'|'THEM', tension: <model tension>, label: benign|joke|mild|harsh|cruel|skip }.
// Derives this owner's thresholds + self-report-bias verdict and persists both app_meta keys, so the
// gate/findings/pack stop running on shipped defaults and the self-lenient defence goes live.
import { readFileSync } from 'node:fs';
import { openDb } from '../store/db';
import { applyCalibration } from '../lenses/calibrate';
import type { BiasLabel } from '../lenses/bias';

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; }

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flag(argv, '--db') ?? 'between.db';
  const thread = Number(flag(argv, '--thread'));
  const labelsPath = flag(argv, '--labels');
  if (!Number.isInteger(thread) || !labelsPath) { console.error('usage: calibrate.ts --thread N --labels labels.json [--db between.db]'); process.exit(2); }
  let labels: BiasLabel[];
  try { labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as BiasLabel[]; }
  catch (e) { console.error(`could not read labels: ${e instanceof Error ? e.message : e}`); process.exit(2); return; }
  if (!Array.isArray(labels) || !labels.length) { console.error('labels file must be a non-empty BiasLabel[] array'); process.exit(2); }

  const db = openDb(dbPath);
  try {
    const { bias, thresholds } = applyCalibration(db, labels);
    console.log(`\ncalibrated thread ${thread} from ${labels.length} labels:`);
    console.log(`  thresholds: hostile ≥ ${thresholds.hostile_tension}, severe ≥ ${thresholds.severe_tension}`);
    console.log(`  self-report: ${bias.verdict} (leniency ${bias.leniencyBias}, gate bump +${bias.gateThresholdBump})`);
    console.log(`  ${bias.note}`);
    if (bias.verdict === 'self_lenient') console.log('  → the power-balance gate now needs MORE one-directional evidence before taking a side.');
  } finally { db.close(); }
}

main();
