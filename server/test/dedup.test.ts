// Unit tests for the dedup key + participant signature (agent ASSEMBLE). Synthetic data only:
// fictional 555-0100..555-0199 numbers, neutral body text. No PARSE/CLASSIFY dependency.
import { describe, it, expect } from 'vitest';
import { computeDedupKey } from '../src/ingest/dedup';
import { participantSignature } from '../src/ingest/threads';
import type { NormalizedMessage } from '../src/types';

function sms(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'sms',
    direction: 'incoming',
    sentAtMs: 1_600_000_000_000,
    bodyText: 'see you at five',
    isRead: true,
    isReaction: false,
    reactionKind: null,
    lang: 'en',
    rawType: 1,
    rawMsgBox: null,
    addresses: [{ raw: '5550101', e164: '+15555550101', role: 'from' }],
    contactNameHint: null,
    attachments: [],
    mmsMId: null,
    partCount: 0,
    sourceFileId: 0,
    ...over,
  };
}

function mms(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'mms',
    direction: 'incoming',
    sentAtMs: 1_600_000_000_000,
    bodyText: 'a photo',
    isRead: true,
    isReaction: false,
    reactionKind: null,
    lang: null,
    rawType: null,
    rawMsgBox: 1,
    addresses: [
      { raw: '5550100', e164: '+15555550100', role: 'from' },
      { raw: '5550101', e164: '+15555550101', role: 'to' },
    ],
    contactNameHint: null,
    attachments: [],
    mmsMId: null,
    partCount: 2,
    sourceFileId: 0,
    ...over,
  };
}

describe('computeDedupKey — SMS', () => {
  it('is deterministic and stable for identical messages', () => {
    expect(computeDedupKey(sms())).toBe(computeDedupKey(sms()));
  });

  it('keys on the normalized e164, not the raw formatting', () => {
    const bare = sms({ addresses: [{ raw: '5550101', e164: '+15555550101', role: 'from' }] });
    const formatted = sms({ addresses: [{ raw: '+1 (555) 555-0101', e164: '+15555550101', role: 'from' }] });
    expect(computeDedupKey(bare)).toBe(computeDedupKey(formatted));
  });

  it('falls back to the raw string when e164 is null', () => {
    const a = sms({ addresses: [{ raw: '262966', e164: null, role: 'from' }] });
    const b = sms({ addresses: [{ raw: '262966', e164: null, role: 'from' }] });
    const c = sms({ addresses: [{ raw: '365070', e164: null, role: 'from' }] });
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
    expect(computeDedupKey(a)).not.toBe(computeDedupKey(c));
  });

  it('changes when body, timestamp, or type differ', () => {
    const base = computeDedupKey(sms());
    expect(computeDedupKey(sms({ bodyText: 'different' }))).not.toBe(base);
    expect(computeDedupKey(sms({ sentAtMs: 1_600_000_000_001 }))).not.toBe(base);
    expect(computeDedupKey(sms({ rawType: 2 }))).not.toBe(base);
  });

  it('distinguishes a null body from an empty string', () => {
    expect(computeDedupKey(sms({ bodyText: null }))).not.toBe(computeDedupKey(sms({ bodyText: '' })));
  });
});

describe('computeDedupKey — MMS', () => {
  it('prefers m_id: same m_id collapses regardless of other fields', () => {
    const a = mms({ mmsMId: 'urn-mid-1', sentAtMs: 1, bodyText: 'x', partCount: 1 });
    const b = mms({ mmsMId: 'urn-mid-1', sentAtMs: 999, bodyText: 'totally other', partCount: 9 });
    expect(computeDedupKey(a)).toBe(computeDedupKey(b));
  });

  it('different m_id → different key', () => {
    expect(computeDedupKey(mms({ mmsMId: 'urn-mid-1' }))).not.toBe(
      computeDedupKey(mms({ mmsMId: 'urn-mid-2' })),
    );
  });

  it('without m_id, participant order does not matter', () => {
    const forward = mms({
      mmsMId: null,
      addresses: [
        { raw: '5550100', e164: '+15555550100', role: 'from' },
        { raw: '5550101', e164: '+15555550101', role: 'to' },
      ],
    });
    const reversed = mms({
      mmsMId: null,
      addresses: [
        { raw: '5550101', e164: '+15555550101', role: 'to' },
        { raw: '5550100', e164: '+15555550100', role: 'from' },
      ],
    });
    expect(computeDedupKey(forward)).toBe(computeDedupKey(reversed));
  });

  it('without m_id, msg_box / body / partCount all participate', () => {
    const base = computeDedupKey(mms({ mmsMId: null }));
    expect(computeDedupKey(mms({ mmsMId: null, rawMsgBox: 2 }))).not.toBe(base);
    expect(computeDedupKey(mms({ mmsMId: null, bodyText: 'other' }))).not.toBe(base);
    expect(computeDedupKey(mms({ mmsMId: null, partCount: 3 }))).not.toBe(base);
  });

  it('never collides with a same-timestamp SMS', () => {
    expect(computeDedupKey(mms({ mmsMId: null }))).not.toBe(computeDedupKey(sms()));
  });
});

describe('participantSignature', () => {
  it('is order-independent', () => {
    expect(participantSignature([3, 1, 2])).toBe(participantSignature([1, 2, 3]));
  });

  it('distinguishes different participant sets', () => {
    expect(participantSignature([1, 2])).not.toBe(participantSignature([1, 3]));
  });

  it('is stable for the empty set and single member', () => {
    expect(participantSignature([])).toBe(participantSignature([]));
    expect(participantSignature([7])).toBe(participantSignature([7]));
    expect(participantSignature([])).not.toBe(participantSignature([7]));
  });
});
