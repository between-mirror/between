// Eras CLI: `npx tsx server/src/cli/eras.ts --thread N [--db between.db]`.
// Computes + caches the F2 era layer (deterministic change-point segmentation) and prints each era's
// span + key boundary stats. Naming/summary is a separate render step (era_summary); this is the math.
import { openDb } from '../store/db';
import { refreshEras } from '../lenses/eras';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) {
    console.error('usage: eras.ts --thread N [--db between.db]');
    process.exit(2);
  }
  const threadId = Number(threadArg);
  const db = openDb(dbPath);
  try {
    const started = Date.now();
    const eras = refreshEras(db, threadId);
    const d = (ms: number) => new Date(ms).toISOString().slice(0, 7);
    const pc = (x: number) => `${(100 * x).toFixed(0)}%`;
    console.log(`thread ${threadId}: ${eras.length} eras → ${Date.now() - started}ms\n`);
    console.log('era span              | mo | vol/mo | her vol% | his host% | her host% | his recip | her-init% | repair(h)');
    eras.forEach((e, i) => {
      const s = e.stats;
      console.log(
        `${i + 1}. ${d(e.startMs)}→${d(e.endMs)} | ${String(e.months).padStart(2)} | ` +
        `${String(Math.round(s.volTotal)).padStart(6)} | ${pc(s.themVolShare).padStart(7)} | ` +
        `${pc(s.hostShareMe).padStart(8)} | ${pc(s.hostShareThem).padStart(8)} | ${pc(s.recipRate).padStart(8)} | ` +
        `${pc(s.themInitShare).padStart(8)} | ${s.repairLatencyH.toFixed(1).padStart(6)}`,
      );
    });
  } finally {
    db.close();
  }
}

main();
