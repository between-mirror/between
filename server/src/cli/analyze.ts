// Analyze CLI: plan airlock jobs for a thread/range/lens and print the capacity estimate.
//   tsx src/cli/analyze.ts --thread N [--lens l1_emotion] [--from ms] [--to ms]
//                          [--dry-run] [--db between.db] [--airlock airlock]
// Dry-run shows the estimate WITHOUT writing jobs (capacity honesty, T2.9). Otherwise it also
// materializes airlock/jobs/<id>.json + jobs/_manifest.json and inserts the pending job rows.
import { openDb } from '../store/db';
import { planAnalysis } from '../airlock/plan';
import { defaultAirlockDir } from '../airlock/paths';
import type { LensId } from '../airlock/types';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}
function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flag(argv, '--db') ?? 'between.db';
  const airlockDir = flag(argv, '--airlock') ?? defaultAirlockDir();
  const threadArg = flag(argv, '--thread');
  const lens = (flag(argv, '--lens') ?? 'l1_emotion') as LensId;
  const dryRun = argv.includes('--dry-run');

  const threadId = Number(threadArg);
  if (!Number.isInteger(threadId)) {
    console.error('usage: analyze --thread N [--lens l1_emotion] [--from ms] [--to ms] [--dry-run]');
    process.exit(2);
  }

  const db = openDb(dbPath);
  try {
    const outcome = planAnalysis(db, {
      threadId,
      lens,
      fromMs: num(flag(argv, '--from')),
      toMs: num(flag(argv, '--to')),
      dryRun,
      airlockDir,
    });
    const e = outcome.estimate;
    console.log(e.copy);
    console.log(
      `\n  windows=${e.windowCount}  remembered=${e.cached}  to-read=${e.toRun}  ` +
        `drains≈${e.drains}  ${e.timeEstimate}`,
    );
    if (outcome.materialized) {
      console.log(`\nWrote ${outcome.jobIds.length} job(s) → ${airlockDir}/jobs`);
    } else if (!dryRun) {
      console.log('\nNothing to do — every window is already remembered.');
    } else {
      console.log('\n(dry run — no jobs written)');
    }
  } finally {
    db.close();
  }
}

main();
