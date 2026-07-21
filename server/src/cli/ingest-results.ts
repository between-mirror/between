// Ingest-results CLI: reconcile airlock/results/*.json into the DB (crash-resume, T2.6).
//   tsx src/cli/ingest-results.ts [--db between.db] [--airlock airlock]
// Called at launch (or by hand) to re-ingest any orphan results a prior run left behind. The app is
// the sole SQLite writer; there is no file watcher anywhere.
import { openDb } from '../store/db';
import { reconcile } from '../airlock/ingestResults';
import { refreshEmotionDaily } from '../lenses/l1';
import { defaultAirlockDir } from '../airlock/paths';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flag(argv, '--db') ?? 'between.db';
  const airlockDir = flag(argv, '--airlock') ?? defaultAirlockDir();

  const db = openDb(dbPath);
  try {
    const summary = reconcile(db, { airlockDir });
    for (const t of db.listThreads()) refreshEmotionDaily(db, t.id);
    console.log(
      `reconciled: ingested=${summary.ingested}  refused=${summary.refused}  ` +
        `errored=${summary.errored}  claims-dropped=${summary.claimsDropped}  unknown=${summary.unknown}`,
    );
  } finally {
    db.close();
  }
}

main();
