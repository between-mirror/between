// Between — turning the research interpretive layer on inside a test.
//
// It takes two acts in the product and it takes two here, deliberately: a test helper that could
// open the gate more easily than a real operator can would be testing a gate that does not exist.
//   - the flag, a decision about a process
//   - the acknowledgement, a decision about an archive
import type { BetweenDB } from '../../src/store/db';
import { recordResearchConsent, RESEARCH_ENV } from '../../src/lenses/experimental';

/** Switch research mode on for this process and acknowledge it for this archive. */
export function enableResearchLayer(db: BetweenDB): void {
  process.env[RESEARCH_ENV] = '1';
  recordResearchConsent(db);
}

/** Withdraw the acknowledgement, leaving the flag alone — the ordinary "it is off" state. */
export function withdrawResearchConsent(db: BetweenDB): void {
  db.setMeta('research_layer_consent', '0');
}

/** Clear the process flag. Call in afterAll so one suite cannot leak the gate into another. */
export function clearResearchFlag(): void {
  delete process.env[RESEARCH_ENV];
}
