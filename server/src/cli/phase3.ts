// Phase-3 warm CLI: `npx tsx server/src/cli/phase3.ts --thread N [--db between.db]`.
// Materializes every deterministic derived layer for a thread — episodes (F1), eras (F2), the growth
// series (L11), and kid proximity (L9) — so the surfaces read instantly. Idempotent; no model calls.
import { openDb } from '../store/db';
import { refreshEpisodes } from '../lenses/episodes';
import { refreshEras } from '../lenses/eras';
import { refreshGrowth } from '../lenses/growth';
import { refreshKids } from '../lenses/kids';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) {
    console.error('usage: phase3.ts --thread N [--db between.db]');
    process.exit(2);
  }
  const id = Number(threadArg);
  const db = openDb(dbPath);
  try {
    const started = Date.now();
    const ep = refreshEpisodes(db, id);      // F1 first — eras/kids read episodes
    const eras = refreshEras(db, id);
    const growth = refreshGrowth(db, id);
    const kids = refreshKids(db, id);
    console.log(`thread ${id} — derived layers materialized in ${Date.now() - started}ms:`);
    console.log(`  episodes (F1): ${ep.total}`);
    console.log(`  eras (F2):     ${eras.length}`);
    console.log(`  growth (L11):  ${growth.length} quarters`);
    console.log(`  kids (L9):     ${kids.configured ? `${kids.totalKidEpisodes} kid-nearby episodes` : 'unconfigured (set app_meta kid_names)'}`);
  } finally {
    db.close();
  }
}

main();
