// Deterministic, order-independent signature for the set of non-owner participants in a thread.
// One thread per distinct signature (schema: threads.participant_signature UNIQUE).
//
// The keys are the contacts' NATURAL keys — E.164 where it resolved, else the raw address — and
// never their temp-ids. Temp-ids are handed out in first-encounter order within a single file, so
// two backups of the same phone number the same two people differently depending on who happened to
// text first. A signature built on them is a signature on the order the file was written in: the
// second import of an overlapping backup either collided on this UNIQUE column and aborted the whole
// import, or landed the same conversation in a second thread. Both were possible; the first is what
// actually happened.
import { createHash } from 'node:crypto';

/**
 * A participant key with its role encoded as data, not as a string prefix a source can imitate.
 * Generic import identifiers are arbitrary strings, including strings beginning with `self:`.
 * Serializing the tuple keeps an ordinary participant and an owner-only thread in disjoint spaces.
 */
export function memberParticipantKey(naturalKey: string): string {
  return JSON.stringify(['member', naturalKey]);
}

export function selfParticipantKey(naturalKey: string): string {
  return JSON.stringify(['self', naturalKey]);
}

/** One unambiguous value for a sorted participant set, also used by message dedup. */
export function participantSetKey(contactKeys: string[]): string {
  return JSON.stringify([...contactKeys].sort());
}

export function participantSignature(contactKeys: string[]): string {
  return createHash('sha256').update(participantSetKey(contactKeys)).digest('hex');
}
