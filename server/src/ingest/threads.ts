// Deterministic, order-independent signature for a set of non-owner contact temp-ids.
// One thread per distinct signature (schema: threads.participant_signature UNIQUE).
import { createHash } from 'node:crypto';

export function participantSignature(contactTempIds: number[]): string {
  const sorted = [...contactTempIds].sort((a, b) => a - b);
  return createHash('sha256').update(sorted.join('|')).digest('hex');
}
