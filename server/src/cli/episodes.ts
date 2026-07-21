// Episodes CLI: `npx tsx server/src/cli/episodes.ts --thread N [--db between.db]`.
// Computes + upserts the L7 conflict-episode layer for a thread and prints a per-year summary.
// Deterministic (no model calls); safe to re-run — narrative_json survives refreshes.
import { openDb } from '../store/db';
import { refreshEpisodes, getEpisodes } from '../lenses/episodes';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) {
    console.error('usage: episodes.ts --thread N [--db between.db]');
    process.exit(2);
  }
  const threadId = Number(threadArg);

  const db = openDb(dbPath);
  try {
    const started = Date.now();
    const sum = refreshEpisodes(db, threadId);
    const eps = getEpisodes(db, threadId);

    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
    const years = new Map<number, typeof eps>();
    for (const e of eps) {
      const y = new Date(e.startMs).getUTCFullYear();
      if (!years.has(y)) years.set(y, []);
      years.get(y)!.push(e);
    }
    console.log(`thread ${threadId}: ${sum.total} episodes ` +
      `(+${sum.inserted} new, ~${sum.updated} updated, -${sum.removed} removed) → ${Date.now() - started}ms\n`);
    console.log('year | eps | them-initiated | them last word | repaired<24h | kid nearby');
    for (const [y, list] of [...years.entries()].sort((a, b) => a[0] - b[0])) {
      const themInit = list.filter((e) => e.initiator === 'them').length;
      const themLast = list.filter((e) => e.lastHostile === 'them').length;
      const repaired = list.filter((e) => e.repairedAtMs != null).length;
      const kid = list.filter((e) => e.kidNamed).length;
      console.log(
        `${y} | ${String(list.length).padStart(3)} | ${pct(themInit, list.length).padStart(6)} | ` +
        `${pct(themLast, list.length).padStart(6)} | ${pct(repaired, list.length).padStart(6)} | ` +
        `${pct(kid, list.length).padStart(6)}`,
      );
    }
    if (!db.getMeta('kid_names')) {
      console.log('\nnote: app_meta kid_names is not set — kid_named is 0 everywhere. ' +
        `Set it (names stay in the DB, never in code) to enable the kids lens.`);
    }
  } finally {
    db.close();
  }
}

main();
