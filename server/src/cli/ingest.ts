// Ingest CLI: `npm run ingest -- <path-to-xml>`  (workflow agent: assemble may refine output).
//   --delete-source  after a VERIFIED ingest, delete the source XML (the most sensitive plaintext on
//                    disk once its contents are in the DB). Off by default; documented in DEPLOY.md.
import { rmSync } from 'node:fs';
import { ingestFile } from '../ingest/index';

async function main() {
  const xml = process.argv[2];
  if (!xml) {
    console.error('usage: ingest <path-to-sms-backup.xml> [--db between.db] [--region US] [--delete-source]');
    process.exit(2);
  }
  const dbFlag = process.argv.indexOf('--db');
  const regionFlag = process.argv.indexOf('--region');
  const dbPath = dbFlag > -1 ? process.argv[dbFlag + 1] : 'between.db';
  const region = regionFlag > -1 ? process.argv[regionFlag + 1] : 'US';
  const deleteSource = process.argv.includes('--delete-source');

  const start = Date.now();
  let last = 0;
  const result = await ingestFile(xml, {
    dbPath,
    region,
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
