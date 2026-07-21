// Export CLI: `npx tsx server/src/cli/export.ts --thread N [--from ms] [--to ms] [--pack|--ledger] [--db between.db]`.
// Writes a record-grade verbatim export (or a conversation packet) to data/exports/ (git-ignored). No model
// calls — assembles only what is already in the DB.
//   --ledger  a record-grade export of exactly the ledger-of-hands moments (physical + death-wish
//             disclosures, both sides), verbatim and SHA-256-chained — the document you hand a person.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../store/db';
import { writeExport, buildExport } from '../lenses/exports';
import { buildTherapyPack } from '../lenses/therapyPack';
import { getFindings, computeFindings } from '../lenses/findings';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flagValue(argv, '--db') ?? 'between.db';
  const threadArg = flagValue(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) {
    console.error('usage: export.ts --thread N [--from ms] [--to ms] [--pack] [--db between.db]');
    process.exit(2);
  }
  const id = Number(threadArg);
  const from = flagValue(argv, '--from');
  const to = flagValue(argv, '--to');
  const outDir = join(process.cwd(), 'data', 'exports');
  const stamp = new Date().toISOString();

  const db = openDb(dbPath);
  try {
    if (argv.includes('--pack')) {
      const pack = buildTherapyPack(db, id, { generatedAt: stamp });
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `conversation-packet-t${id}.md`);
      writeFileSync(path, pack.markdown, 'utf8');
      console.log(`conversation packet → ${path}  (${pack.reflections} reflection(s), ${pack.episodeNotes} episode note(s))`);
    } else if (argv.includes('--ledger')) {
      const f = getFindings(db, id) ?? computeFindings(db, id);
      const ids = f.ledger.entries.map((e) => e.id);
      const res = buildExport(db, id, { kind: 'ledger', ids, label: 'the ledger of hands (physical + death-wish disclosures)', generatedAt: stamp });
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `export-t${id}-ledger-${res.sha256.slice(0, 12)}.md`);
      const note = `\n> Selection: every message flagged as a physical-harm or death-wish disclosure (${res.messageCount} of them, both sides), in time order.\n> These are keyword disclosures — admissions, threats, and accusations mixed — not adjudicated facts. Verbatim below; judge them yourself.\n`;
      writeFileSync(path, res.markdown.replace('\n---\n\n\n', `\n---\n${note}\n`), 'utf8');
      console.log(`ledger export → ${path}  (${res.messageCount} messages, sha ${res.sha256.slice(0, 12)})`);
    } else {
      const path = writeExport(db, id, {
        fromMs: from ? Number(from) : null, toMs: to ? Number(to) : null,
        kind: from || to ? 'range' : 'timeline', generatedAt: stamp,
      }, outDir);
      console.log(`export → ${path}`);
    }
  } finally {
    db.close();
  }
}

main();
