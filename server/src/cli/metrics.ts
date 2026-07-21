// Metrics warm CLI: `tsx src/cli/metrics.ts --db between.db [--thread N | --all]`.
// Recomputes and caches the Tier-1 overview bundle, printing per-thread timing. Default (no
// --thread / --all) warms every thread. Useful after ingest or a metrics-code change.
import { openDb } from '../store/db';
import { refreshMetrics } from '../metrics/index';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');

  const db = openDb(dbPath);
  try {
    let ids: number[];
    if (threadArg !== undefined) {
      const id = Number(threadArg);
      if (!Number.isInteger(id)) {
        console.error(`invalid --thread value: ${threadArg}`);
        process.exit(2);
      }
      ids = [id];
    } else {
      // --all (or default): every thread in the store.
      ids = db.listThreads().map((t) => t.id);
    }

    if (ids.length === 0) {
      console.log('No threads to warm.');
      return;
    }

    let totalMs = 0;
    for (const id of ids) {
      const start = Date.now();
      const bundle = refreshMetrics(db, id);
      const ms = Date.now() - start;
      totalMs += ms;
      console.log(
        `thread ${id}: ${bundle.summary.totalMessages.toLocaleString()} msgs, ` +
          `${bundle.daily.length} active days, ${bundle.summary.sessions} sessions → ${ms}ms`,
      );
    }
    console.log(`\nWarmed ${ids.length} thread(s) in ${totalMs}ms → ${dbPath}`);
  } finally {
    db.close();
  }
}

main();
