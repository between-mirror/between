// Unit tests for the canonical dedup key + participant signature. Synthetic data only: fictional
// 555-0100..555-0199 numbers, neutral body text.
//
// The key decides what counts as "the same message", so these tests are written as the two failures
// it can have, not as a tour of its fields. Merging two real messages quietly shrinks someone's
// archive; failing to merge one message seen twice quietly doubles it. Both look like a working
// program from the outside.
import { describe, it, expect } from 'vitest';
import { computeDedupKey, keyBatch, normalizeBody, timeBucket } from '../src/ingest/dedup';
import { participantSignature } from '../src/ingest/threads';

const T = Date.UTC(2021, 4, 10, 9, 0, 0);
const ALICE = '+15555550101';

interface Row { counterpart: string; direction: string; sentAtMs: number; bodyText: string | null }
const row = (over: Partial<Row> = {}): Row => ({
  counterpart: ALICE, direction: 'incoming', sentAtMs: T, bodyText: 'see you at five', ...over,
});

/** The batch keyer is the real entry point — occurrence indices only exist across a whole file. */
const keys = (rows: Row[]): string[] => keyBatch(rows, (r) => r);

describe('the canonical key — what must converge', () => {
  it('is deterministic for the same message', () => {
    expect(keys([row()])[0]).toBe(keys([row()])[0]);
  });

  it('collapses one message recorded twice in the same file', () => {
    // Overlapping backups concatenated into one export. Same counterpart, same instant, same words.
    const [a, b] = keys([row(), row()]);
    expect(a).toBe(b);
  });

  it('ignores sub-minute precision, so two formats agree on one message', () => {
    // The whole reason the key changed. An SMS backup records milliseconds; a WhatsApp export
    // prints whole minutes. The old key hashed the exact millisecond and an Android type code, so
    // the same message from two sources shared no component and the archive silently doubled.
    const fromSms = keys([row({ sentAtMs: T + 41_000 })])[0];
    const fromWhatsApp = keys([row({ sentAtMs: T })])[0];
    expect(fromSms).toBe(fromWhatsApp);
  });

  it('reads the same words through different encodings and line endings', () => {
    const composed = keys([row({ bodyText: 'café  au   lait' })])[0];
    const decomposed = keys([row({ bodyText: 'café au lait\r\n' })])[0];
    expect(composed).toBe(decomposed);
  });
});

describe('the canonical key — what must NOT converge', () => {
  it('keeps two real messages that share a minute and a word', () => {
    // Saying "ok" twice is two messages. This is the failure that would never be noticed: no error,
    // no warning, just an archive slightly smaller than the life it came from.
    const [a, b] = keys([
      row({ bodyText: 'ok', sentAtMs: T + 1_000 }),
      row({ bodyText: 'ok', sentAtMs: T + 5_000 }),
    ]);
    expect(a).not.toBe(b);
  });

  it('separates the two directions', () => {
    expect(keys([row({ direction: 'incoming' })])[0])
      .not.toBe(keys([row({ direction: 'outgoing' })])[0]);
  });

  it('separates two people who said the same thing at the same moment', () => {
    expect(keys([row({ counterpart: ALICE })])[0])
      .not.toBe(keys([row({ counterpart: '+15555550102' })])[0]);
  });

  it('separates a message that crossed the minute boundary', () => {
    expect(keys([row()])[0]).not.toBe(keys([row({ sentAtMs: T + 60_000 })])[0]);
  });

  it('does not let case-folding eat a distinct message', () => {
    // Normalization exists to survive encodings, not to decide that "ok" and "OK" are one message.
    expect(keys([row({ bodyText: 'ok' })])[0]).not.toBe(keys([row({ bodyText: 'OK' })])[0]);
  });

  it('numbers three same-minute repeats independently of the order they arrive in', () => {
    const forward = keys([
      row({ bodyText: 'ok', sentAtMs: T + 1_000 }),
      row({ bodyText: 'ok', sentAtMs: T + 2_000 }),
      row({ bodyText: 'ok', sentAtMs: T + 3_000 }),
    ]);
    const shuffled = keys([
      row({ bodyText: 'ok', sentAtMs: T + 3_000 }),
      row({ bodyText: 'ok', sentAtMs: T + 1_000 }),
      row({ bodyText: 'ok', sentAtMs: T + 2_000 }),
    ]);
    expect(new Set(forward).size).toBe(3);
    // A second backup listing them in another order must still produce the same three keys.
    expect([...forward].sort()).toEqual([...shuffled].sort());
  });
});

describe('the pieces', () => {
  it('normalizeBody collapses whitespace without folding case or dropping content', () => {
    expect(normalizeBody('  a   b \n c  ')).toBe('a b c');
    expect(normalizeBody(null)).toBe('');
    expect(normalizeBody('Ok')).toBe('Ok');
  });

  it('timeBucket floors to the minute', () => {
    expect(timeBucket(T)).toBe(timeBucket(T + 59_999));
    expect(timeBucket(T)).not.toBe(timeBucket(T + 60_000));
  });

  it('computeDedupKey separates occurrences', () => {
    const base = { counterpart: ALICE, direction: 'incoming', sentAtMs: T, bodyText: 'ok' };
    expect(computeDedupKey({ ...base, occurrence: 0 }))
      .not.toBe(computeDedupKey({ ...base, occurrence: 1 }));
  });
});

describe('participantSignature', () => {
  it('is order-independent', () => {
    expect(participantSignature(['+15555550103', '+15555550101', '+15555550102']))
      .toBe(participantSignature(['+15555550101', '+15555550102', '+15555550103']));
  });

  it('distinguishes different participant sets', () => {
    expect(participantSignature(['+15555550101', '+15555550102']))
      .not.toBe(participantSignature(['+15555550101', '+15555550103']));
  });

  it('is stable for the empty set and single member', () => {
    expect(participantSignature([])).toBe(participantSignature([]));
    expect(participantSignature(['+15555550107'])).toBe(participantSignature(['+15555550107']));
    expect(participantSignature([])).not.toBe(participantSignature(['+15555550107']));
  });

  it('keys on the address, not on a per-file temp id', () => {
    // The bug this replaced: temp-ids are handed out in first-encounter order within one file, so
    // two backups of the same phone numbered the same people differently and the second import
    // collided on threads.participant_signature and aborted.
    expect(participantSignature(['+15555550101'])).toBe(participantSignature(['+15555550101']));
    expect(participantSignature(['1'])).not.toBe(participantSignature(['+15555550101']));
  });
});
