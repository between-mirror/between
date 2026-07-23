// Between — the research-mode CLI.
//
// The interpretive layer is a research preview that no clinician has evaluated, and switching it on
// used to be an HTTP call the app could make on its own behalf. It now takes two deliberate acts, in
// this order, because they answer two different questions:
//
//   1. A flag — `"researchInterpretiveLayer": true` in between.config.json, or
//      BETWEEN_RESEARCH_LAYER=1 in the environment. That is a decision about a process.
//   2. An acknowledgement, recorded here, per database. That is a decision about an ARCHIVE — about
//      whether an unvalidated reading may be written about the specific person in it — and it is
//      not the same decision.
//
// Neither is reachable from a page, and the consent text is printed in full at the point of the
// second act rather than folded behind a checkbox someone clicks past.
//
// Usage:
//   npx tsx server/src/cli/research-mode.ts --status
//   npx tsx server/src/cli/research-mode.ts --acknowledge [--db <path>]
//   npx tsx server/src/cli/research-mode.ts --withdraw    [--db <path>]
import { openDb } from '../store/db';
import { loadConfig } from '../config';
import {
  researchModeFlag, researchConsentRecorded, recordResearchConsent,
  RESEARCH_CONSENT, RESEARCH_ENV, RESEARCH_CONFIG_KEY,
} from '../lenses/experimental';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function main(): void {
  const dbPath = arg('db') ?? loadConfig().dbPath;
  const flag = researchModeFlag();

  if (has('status') || process.argv.length <= 2) {
    const db = openDb(dbPath);
    const consented = researchConsentRecorded(db);
    db.close();
    console.log('');
    console.log('  Research interpretive layer');
    console.log(`    flag          : ${flag ? 'ON' : 'off'}  (${RESEARCH_CONFIG_KEY} in between.config.json, or ${RESEARCH_ENV}=1)`);
    console.log(`    acknowledged  : ${consented ? 'yes' : 'no'}  (this archive: ${dbPath})`);
    console.log(`    readings run  : ${flag && consented ? 'YES' : 'no'}`);
    if (flag && !consented) {
      console.log('');
      console.log('    The flag is set but this archive has not been acknowledged, so nothing');
      console.log('    interpretive will run. Read the terms with --acknowledge.');
    }
    console.log('');
    return;
  }

  if (has('withdraw')) {
    const db = openDb(dbPath);
    db.setMeta('research_layer_consent', '0');
    db.close();
    console.log('\n  Withdrawn. Interpretive readings will not run against this archive.\n');
    return;
  }

  if (has('acknowledge')) {
    if (!flag) {
      console.error('');
      console.error('  Research mode is not switched on, so there is nothing to acknowledge.');
      console.error(`  Set "${RESEARCH_CONFIG_KEY}": true in between.config.json, or ${RESEARCH_ENV}=1.`);
      console.error('');
      process.exitCode = 1;
      return;
    }
    console.log('');
    console.log(RESEARCH_CONSENT);
    console.log('');
    if (!has('yes')) {
      console.log('  Nothing has been recorded. If you have read the above and still want the');
      console.log('  interpretive layer to run against this archive, re-run with --yes.');
      console.log('');
      process.exitCode = 2;
      return;
    }
    const db = openDb(dbPath);
    recordResearchConsent(db);
    db.close();
    console.log(`  Recorded for ${dbPath}. Withdraw at any time with --withdraw.`);
    console.log('');
    return;
  }

  console.error('\n  Usage: research-mode.ts --status | --acknowledge [--yes] | --withdraw [--db <path>]\n');
  process.exitCode = 1;
}

main();
