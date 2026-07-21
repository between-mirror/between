// L4 checkpoint CLI: `npx tsx server/src/cli/abuse.ts --thread N [--db between.db]`.
// Shows the power-balance gate view (per-era directional shares + current stance) and selects the
// ~10 most severe episodes for the owner sample-and-agree pass. It does NOT drain stage-2 — per
// guardrail 8, the full per-episode read runs only after the owner confirms thresholds on the sample.
import { openDb } from '../store/db';
import { refreshEras } from '../lenses/eras';
import { refreshEpisodes } from '../lenses/episodes';
import { buildEraAggregates, powerBalanceGate, selectSampleEpisodes } from '../lenses/abuse';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}
const d = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const pc = (x: number) => `${(100 * x).toFixed(0)}%`;

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) {
    console.error('usage: abuse.ts --thread N [--db between.db]');
    process.exit(2);
  }
  const id = Number(threadArg);
  const db = openDb(dbPath);
  try {
    refreshEpisodes(db, id);
    refreshEras(db, id);
    const aggs = buildEraAggregates(db, id);
    const gate = powerBalanceGate(aggs);
    const hasL4 = aggs.some((a) => a.coerciveMe + a.coerciveThem > 0);

    console.log(`thread ${id} — power-balance gate (stage-2 ${hasL4 ? 'drained' : 'NOT drained — coercive shares are placeholders'})\n`);
    console.log('era span         | eps | severe→her | init→her | coercive→her | gate');
    gate.eras.forEach((e, i) => {
      const a = aggs[i];
      console.log(
        `${d(a.startMs)}→${d(a.endMs)} | ${String(a.episodes).padStart(3)} | ` +
        `${pc(e.shares.severe).padStart(8)} | ${pc(e.shares.init).padStart(6)} | ` +
        `${(hasL4 ? pc(e.shares.coercive) : '—').padStart(10)} | ${e.frame}${e.direction ? ` (${e.direction})` : ''}`,
      );
    });
    console.log(`\nstance: ${gate.stance.frame}${gate.stance.direction ? ` toward ${gate.stance.direction}` : ''} (confidence ${gate.stance.confidence.toFixed(2)})`);
    if (!hasL4) console.log('(no era can trip to a support frame until the stage-2 drain supplies coercive-marker evidence.)');

    console.log('\n── sample-and-agree candidates (top 10 by severity) — owner reviews these before the full drain ──');
    for (const e of selectSampleEpisodes(db, id, 10)) {
      console.log(`  ${new Date(e.startMs).toISOString().slice(0, 10)}  severe her ${e.severeThem}/me ${e.severeMe}  init:${e.initiator}  peak ${e.peakTension}${e.kidNamed ? '  (kid nearby)' : ''}`);
    }
  } finally {
    db.close();
  }
}

main();
