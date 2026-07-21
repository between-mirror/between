// Drain CLI — run an engine over pending airlock jobs, then (awaited) ingest results into the DB.
//
// Tiering (the point): Ollama does the GRUNT work — the 'local'-hint per-message classification —
// and by default touches nothing else. The worthwhile reduce/render jobs ('claude'/'render') are
// left for Claude/Fable and are NEVER clobbered by the local model. The app is the sole DB writer
// and ingests on awaited completion (never a file watcher).
//
//   npx tsx server/src/cli/drain.ts [--engine ollama|claude|mock] [--tier local] [--loop]
//        [--include-worthwhile] [--model llama3.1] [--url http://127.0.0.1:11434] [--batch 20]
//        [--minutes M] [--db between.db]
//   --minutes M: a TRANCHE time budget — keep looping until the budget is spent, then stop with jobs
//                left pending (resumable). Use it to run a long archive in predictable overnight chunks:
//                  npx tsx server/src/cli/drain.ts --loop --minutes 720 --model qwen2.5:14b
//   (--only/--all are accepted aliases; on Windows use npx, not `npm run` — npm drops --flags after --)
//
//   npx tsx server/src/cli/drain.ts --loop         # Ollama drains the local grunt, looping to empty
//   npx tsx server/src/cli/drain.ts --engine mock  # deterministic (tests / plumbing)
//
//   --engine batch: ALTERNATIVE grunt tier — submit the pending L1 jobs to Anthropic's Message
//     Batches API (Haiku) instead of the local model. Paid API (needs ANTHROPIC_API_KEY), ~1h vs
//     weeks, guaranteed to finish in ≤24h. Sends transcript text to the API (media never sent).
//       npx tsx server/src/cli/drain.ts --engine batch --dry-run     # cost/token estimate only
//       npx tsx server/src/cli/drain.ts --engine batch --cap 35       # refuse to submit if est. > $35
//       npx tsx server/src/cli/drain.ts --engine batch               # submit + poll + collect
//       npx tsx server/src/cli/drain.ts --engine batch --collect <id># resume collecting a submitted batch
//   A paid Batch run also requires engine mode 'api-key' (PUT /api/engine-mode) unless --force is passed.
import { openDb } from '../store/db';
import { drain } from '../airlock/engine';
import { ingestResults } from '../airlock/ingestResults';
import { refreshEmotionDaily } from '../lenses/l1';
import { drainCompleteCopy } from '../airlock/voice';
import { defaultAirlockDir, existsSync, join, writeJsonAtomic, readJson } from '../airlock/paths';
import { rmSync } from 'node:fs';
import { estimateBatch, pendingBatchJobs, submitBatch, collectBatch, DEFAULT_BATCH_MODEL } from '../airlock/batch';
import { getEngineMode, paidBatchAllowed } from '../lenses/engineMode';
import { loadConfig } from '../config';
import type { EngineName } from '../airlock/types';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const dbPath = flag(argv, '--db') ?? cfg.dbPath;
  const airlockDir = flag(argv, '--airlock') ?? cfg.airlockDir ?? defaultAirlockDir();

  const engineArg = flag(argv, '--engine') ?? 'ollama'; // workstation default = local grunt
  if (engineArg === 'batch') {
    await runBatch(argv, dbPath, airlockDir);
    return;
  }
  const engine: EngineName = engineArg === 'claude' ? 'claude' : engineArg === 'mock' ? 'mock' : 'ollama';

  // Grunt guard: with Ollama, default to the 'local' tier only, unless overridden.
  // (npm run eats --only/--all as its own config; --tier/--loop are the safe names.)
  let only = flag(argv, '--tier') ?? flag(argv, '--only');
  if (only == null && engine === 'ollama' && !argv.includes('--include-worthwhile')) only = 'local';

  const all = argv.includes('--loop') || argv.includes('--all');
  const batch = Number(flag(argv, '--batch') ?? '20');
  const model = flag(argv, '--model') ?? cfg.ollama.model;
  const url = flag(argv, '--url') ?? cfg.ollama.url;
  const minutesRaw = Number(flag(argv, '--minutes'));
  const budgetMs = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw * 60000 : null;
  const numCtx = Number(flag(argv, '--num-ctx')) || cfg.ollama.numCtx;

  const db = openDb(dbPath);
  try {
    const startMs = Date.now();
    let round = 0;
    let totalProcessed = 0;
    let totalIngested = 0;
    let stoppedForTime = false;
    for (;;) {
      const summary = await drain({
        airlockDir, engine, only: only ?? undefined,
        batchSize: Number.isFinite(batch) ? batch : 20,
        ollamaModel: model, ollamaUrl: url, ollamaNumCtx: numCtx,
      });
      const ingest = ingestResults(db, { airlockDir });
      round++;
      totalProcessed += summary.processed;
      totalIngested += ingest.ingested;
      // Progressive river: refresh the L1 emotion series each round so the UI fills DURING a long
      // tranche, not only when the whole run finishes. Cheap for threads with no results.
      for (const t of db.listThreads()) refreshEmotionDaily(db, t.id);
      const elapsedMin = (Date.now() - startMs) / 60000;
      console.log(
        `round ${round}: engine=${summary.engine}${only ? ` only=${only}` : ''} ` +
          `processed=${summary.processed} errored=${summary.errored} refused=${summary.refused} ` +
          `remaining=${summary.remaining} | ingested=${ingest.ingested} claims-dropped=${ingest.claimsDropped} ` +
          `| elapsed=${elapsedMin.toFixed(1)}m`,
      );
      if (!all || summary.processed === 0 || summary.remaining === 0) break;
      if (budgetMs != null && Date.now() - startMs >= budgetMs) { stoppedForTime = true; break; }
    }
    const elapsedMin = (Date.now() - startMs) / 60000;
    if (stoppedForTime) {
      console.log(
        `\n(tranche time budget reached — ~${Math.round(elapsedMin)}m of ${minutesRaw}m. ` +
          `Remaining jobs stay pending; rerun the same command to continue.)`,
      );
    }
    console.log(`\ntotal: processed=${totalProcessed} ingested=${totalIngested} in ${elapsedMin.toFixed(1)}m`);
    console.log(drainCompleteCopy(totalIngested, 0));
  } finally {
    db.close();
  }
}

/** Batch API grunt path: estimate | submit+poll+collect | resume-collect. Kept out of the round-loop
 *  above because a batch is a single submit-and-await, not incremental rounds. */
async function runBatch(argv: string[], dbPath: string, airlockDir: string): Promise<void> {
  const model = flag(argv, '--model') ?? DEFAULT_BATCH_MODEL;
  const only = argv.includes('--include-worthwhile') ? undefined : 'local';
  const collectId = flag(argv, '--collect');
  const statePath = join(airlockDir, 'batch-state.json');
  // A hard dollar ceiling on a paid run — the institutionalized "$30→$44 lesson". A Batch submit is
  // atomic (there is no mid-run meter to stop), so the cap is a PRE-SUBMIT gate: refuse to bill past it.
  const capRaw = flag(argv, '--cap');
  const capUsd = capRaw != null && Number.isFinite(Number(capRaw)) ? Number(capRaw) : null;

  if (argv.includes('--dry-run')) {
    const e = estimateBatch(pendingBatchJobs(airlockDir, only), model);
    console.log(
      `Batch estimate (${e.model}): ${e.count} windows · ~${(e.inTokens / 1e6).toFixed(1)}M in + ` +
        `~${(e.outTokens / 1e6).toFixed(1)}M out · standard ≈ $${e.costStandardUsd.toFixed(2)} · ` +
        `BATCH (50% off) ≈ $${e.costBatchUsd.toFixed(2)}` +
        (capUsd != null ? ` · cap $${capUsd.toFixed(2)} → ${e.costBatchUsd <= capUsd ? 'within budget' : 'OVER BUDGET'}` : ''),
    );
    console.log('(dry run — nothing submitted, no API key needed)');
    return;
  }

  const db = openDb(dbPath);
  try {
    let batchId = collectId;
    if (!batchId) {
      if (existsSync(statePath) && !argv.includes('--resubmit')) {
        const st = readJson<{ batchId: string }>(statePath);
        console.error(
          `A batch is already in flight (${st.batchId}). Resume with:  --engine batch --collect ${st.batchId}\n` +
            `(or pass --resubmit to start a new one — that would bill again).`,
        );
        process.exit(2);
      }
      const mode = getEngineMode(db);
      if (!paidBatchAllowed(mode) && !argv.includes('--force')) {
        console.error(
          `Refusing to submit a paid Batch run: engine mode is '${mode}', which does not permit off-device paid inference.\n` +
            `Switch to api-key mode first (PUT /api/engine-mode {"mode":"api-key"}), or pass --force to override for this run.`,
        );
        process.exit(2);
      }
      const jobs = pendingBatchJobs(airlockDir, only);
      if (jobs.length === 0) {
        console.log('Nothing to submit — no pending local jobs.');
        return;
      }
      const e = estimateBatch(jobs, model);
      if (capUsd != null && e.costBatchUsd > capUsd) {
        console.error(
          `Refusing to submit: estimated batch cost ≈ $${e.costBatchUsd.toFixed(2)} exceeds your --cap $${capUsd.toFixed(2)}.\n` +
            `Raise the cap (--cap ${Math.ceil(e.costBatchUsd)}) to proceed, or narrow the range so fewer windows are read. Nothing was billed.`,
        );
        process.exit(2);
      }
      console.log(`Submitting ${jobs.length} windows to the Batch API (${model}) ≈ $${e.costBatchUsd.toFixed(2)} (batch price)…`);
      const sub = await submitBatch(jobs, model);
      batchId = sub.batchId;
      writeJsonAtomic(statePath, { batchId, model, count: sub.count, submittedAt: new Date().toISOString() });
      console.log(
        `Batch submitted: ${batchId} (${sub.count} requests). Polling — usually ~1h, up to 24h. ` +
          `Safe to leave running; resume anytime with:  --engine batch --collect ${batchId}`,
      );
    }
    const summary = await collectBatch(batchId, airlockDir, model, {
      onStatus: (s, c) => console.log(`  status=${s}${c ? ` ${JSON.stringify(c)}` : ''}`),
      db,
    });
    console.log(`\ncollected: done=${summary.done} errored=${summary.errored} refused=${summary.refused} written=${summary.written}`);
    const ingest = ingestResults(db, { airlockDir });
    for (const t of db.listThreads()) refreshEmotionDaily(db, t.id);
    console.log(`ingested=${ingest.ingested} claims-dropped=${ingest.claimsDropped}`);
    try { if (existsSync(statePath)) rmSync(statePath, { force: true }); } catch { /* ignore */ }
    console.log(drainCompleteCopy(ingest.ingested, 0));
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('drain failed:', e);
  process.exit(1);
});
