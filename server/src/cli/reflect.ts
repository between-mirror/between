// Reflect CLI — generate a First Reflection (gated reduce → render → post-validate → freeze).
//
// This is the WORTHWHILE-inference tier, not grunt: the reduce (findings) and render (the letter)
// want Claude/Fable, not the local model. Default engine is 'claude'. Requires L1 emotion results
// to already exist for the range (run `npm run drain` first, on Ollama).
//
//   npx tsx server/src/cli/reflect.ts --thread N [--from ms] [--to ms] [--engine claude|ollama|mock]
//   (on Windows use npx, not `npm run` — npm drops --flags after --)
//
//   npx tsx server/src/cli/reflect.ts --thread 25 --engine claude    # the intended path (Claude/Fable prose)
//   npx tsx server/src/cli/reflect.ts --thread 25 --engine ollama    # local-only draft (lower prose quality)
import { openDb } from '../store/db';
import { runFirstReflection } from '../lenses/firstReflection';
import { defaultAirlockDir } from '../airlock/paths';
import { loadConfig } from '../config';
import type { EngineName } from '../airlock/types';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}
function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cfg = loadConfig();
  const threadId = Number(flag(argv, '--thread'));
  if (!Number.isInteger(threadId)) {
    console.error('usage: reflect --thread N [--from ms] [--to ms] [--engine claude|ollama|mock]');
    process.exit(2);
  }
  const engineArg = flag(argv, '--engine') ?? 'claude';
  const engine: EngineName = engineArg === 'ollama' ? 'ollama' : engineArg === 'mock' ? 'mock' : 'claude';

  const db = openDb(flag(argv, '--db') ?? cfg.dbPath);
  try {
    const out = await runFirstReflection(db, {
      threadId,
      fromMs: num(flag(argv, '--from')),
      toMs: num(flag(argv, '--to')),
      engine,
      airlockDir: flag(argv, '--airlock') ?? cfg.airlockDir ?? defaultAirlockDir(),
    });
    if (out.status === 'declined') {
      console.log(`\ndeclined (${out.reason}):\n${out.copy}`);
    } else {
      console.log(`\n${out.contentMd}\n`);
      console.log(`[reflection #${out.reflectionId} · ${out.droppedSentences} unreceipted sentence(s) dropped]`);
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('reflect failed:', e);
  process.exit(1);
});
