// Ingest CLI: `npm run ingest -- <path-to-xml>`  (workflow agent: assemble may refine output).
//   --delete-source  after a VERIFIED ingest, delete the source XML (the most sensitive plaintext on
//                    disk once its contents are in the DB). Off by default; documented in DEPLOY.md.
import { rmSync } from 'node:fs';
import { ingestFile } from '../ingest/index';

async function main() {
  const xml = process.argv[2];
  if (!xml) {
    console.error([
      'usage: ingest <file> [--db between.db] [--region US] [--owner "Your Name"] [--delete-source]',
      '',
      'Formats, chosen by extension:',
      '  .xml            Android SMS Backup & Restore',
      '  .txt / .zip     WhatsApp exported chat   (needs --owner)',
      '  .csv/.json/.jsonl  generic normalized     (needs --owner unless it has a direction column)',
      '  .db / .sqlite   iMessage chat.db COPY    (needs --importers-beta, and --conversation',
      '                  <id> when the file holds more than one, which every real one does)',
      '',
      '--importers-beta opts in to an importer that has never been run against a real export. Today',
      'that is iMessage: built and tested, but every fixture behind it is synthetic, because the only',
      'real chat.db files in existence are somebody\'s own messages. It reads the file and writes',
      'nothing to it. Point it at a COPY, never at ~/Library/Messages/chat.db.',
      '',
      '--owner is the display name YOU appear under in the export. It cannot be inferred: an export',
      'carries no marker for its own owner, and guessing would attribute half the conversation to the',
      'wrong person.',
    ].join('\n'));
    process.exit(2);
  }
  const dbFlag = process.argv.indexOf('--db');
  const regionFlag = process.argv.indexOf('--region');
  const dbPath = dbFlag > -1 ? process.argv[dbFlag + 1] : 'between.db';
  const region = regionFlag > -1 ? process.argv[regionFlag + 1] : 'US';
  const deleteSource = process.argv.includes('--delete-source');
  const ownerFlag = process.argv.indexOf('--owner');
  const ownerName = ownerFlag > -1 ? process.argv[ownerFlag + 1] : undefined;
  const orderFlag = process.argv.indexOf('--date-order');
  const dateOrder = orderFlag > -1 ? process.argv[orderFlag + 1] as 'dmy' | 'mdy' : undefined;
  // A chat.db holds every conversation on the Mac, so the importer refuses to guess which one is
  // meant and names this flag in the refusal. The flag did not exist: the error told the reader to
  // re-run with something no code accepted, and no real multi-conversation file could be imported
  // by any path in the product.
  const convFlag = process.argv.indexOf('--conversation');
  const conversation = convFlag > -1 ? process.argv[convFlag + 1] : undefined;

  const start = Date.now();
  let last = 0;
  const result = await ingestFile(xml, {
    dbPath,
    region,
    ownerName,
    dateOrder,
    conversation,
    importersBeta: process.argv.includes('--importers-beta'),
    onProgress: (p) => {
      const now = Date.now();
      if (now - last > 200) {
        process.stdout.write(`\r  ${p.stage}: ${p.parsed.toLocaleString()}${p.total ? ' / ' + p.total.toLocaleString() : ''}      `);
        last = now;
      }
    },
  });
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s → ${dbPath}`);

  if (deleteSource) {
    // Only after a result came back — the plaintext archive is redundant once its messages are in the DB.
    if (result && typeof result === 'object') {
      try { rmSync(xml, { force: true }); console.log(`Deleted source XML (--delete-source): ${xml}`); }
      catch (e) { console.warn(`Could not delete source XML: ${(e as Error).message}`); }
    } else {
      console.warn('Not deleting source XML: ingest did not report a result.');
    }
  }
}

main().catch((e) => {
  console.error('\nIngest failed:', e);
  process.exit(1);
});
