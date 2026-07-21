// Unit tests for identity resolution (agent ASSEMBLE). Synthetic data only: fictional
// 555-0100..555-0199 numbers, synthetic labels. No PARSE/CLASSIFY dependency.
import { describe, it, expect } from 'vitest';
import { resolveIdentities } from '../src/ingest/identity';
import type { NormalizedMessage, NormalizedAddress } from '../src/types';

function nm(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    kind: 'sms',
    direction: 'incoming',
    sentAtMs: 1000,
    bodyText: 'hi',
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

const addr = (raw: string, e164: string | null, role: NormalizedAddress['role'] = 'from'): NormalizedAddress => ({
  raw,
  e164,
  role,
});

describe('resolveIdentities — clustering', () => {
  it('merges the same person under two number formats into one contact', () => {
    const r = resolveIdentities(
      [
        nm({ sentAtMs: 100, addresses: [addr('5550101', '+15555550101')], contactNameHint: 'Alias-One' }),
        nm({ sentAtMs: 200, addresses: [addr('+15555550101', '+15555550101')], contactNameHint: 'Alias-Two' }),
      ],
      'US',
    );
    expect(r.contacts.length).toBe(1);
    expect(r.identifiers.length).toBe(2); // two distinct raw values, one contact
    const cid = r.contacts[0].tempId;
    expect(r.identifiers.every((i) => i.contactTempId === cid)).toBe(true);
    expect(r.contacts[0].primaryE164).toBe('+15555550101');
    expect(r.contactIdByAddress.get('5550101')).toBe(cid);
    expect(r.contactIdByAddress.get('+15555550101')).toBe(cid);
  });

  it('uses the most-recent non-null contactNameHint as the display name', () => {
    const r = resolveIdentities(
      [
        nm({ sentAtMs: 100, contactNameHint: 'Alias-One' }),
        nm({ sentAtMs: 300, contactNameHint: 'Alias-Latest' }),
        nm({ sentAtMs: 200, contactNameHint: null }), // null never overrides
      ],
      'US',
    );
    expect(r.contacts[0].displayName).toBe('Alias-Latest');
  });

  it('tracks first/last seen and identifier kind per raw value', () => {
    const r = resolveIdentities(
      [
        nm({ sentAtMs: 500, addresses: [addr('5550105', '+15555550105')] }),
        nm({ sentAtMs: 100, addresses: [addr('5550105', '+15555550105')] }),
        nm({ sentAtMs: 900, addresses: [addr('5550105', '+15555550105')] }),
      ],
      'US',
    );
    const id = r.identifiers.find((i) => i.rawValue === '5550105')!;
    expect(id.firstSeenMs).toBe(100);
    expect(id.lastSeenMs).toBe(900);
    expect(id.normalizedE164).toBe('+15555550105');
    expect(id.kind).toBe('mobile');
  });

  it('classifies shortcodes and emails by kind', () => {
    const r = resolveIdentities(
      [
        nm({ addresses: [addr('262966', null)] }),
        nm({ addresses: [addr('reflection@example.com', null)] }),
      ],
      'US',
    );
    expect(r.identifiers.find((i) => i.rawValue === '262966')!.kind).toBe('shortcode');
    expect(r.identifiers.find((i) => i.rawValue === 'reflection@example.com')!.kind).toBe('email');
  });
});

describe('resolveIdentities — owner detection', () => {
  it('flags the address present across the most distinct participant-sets', () => {
    const owner = ['5550100', '+15555550100'] as const;
    const r = resolveIdentities(
      [
        nm({
          kind: 'mms',
          sentAtMs: 100,
          addresses: [addr('5550101', '+15555550101', 'from'), addr(owner[0], owner[1], 'to')],
        }),
        nm({
          kind: 'mms',
          sentAtMs: 200,
          addresses: [addr('5550102', '+15555550102', 'from'), addr(owner[0], owner[1], 'to')],
        }),
      ],
      'US',
    );
    expect(r.contacts.length).toBe(3);
    expect(r.ownerTempId).not.toBeNull();
    const owners = r.contacts.filter((c) => c.isOwner);
    expect(owners.length).toBe(1);
    expect(owners[0].tempId).toBe(r.ownerTempId);
    expect(owners[0].primaryE164).toBe('+15555550100');
  });

  it('leaves the owner undecided when no address dominates (SMS-only archive)', () => {
    const r = resolveIdentities(
      [
        nm({ sentAtMs: 100, addresses: [addr('5550101', '+15555550101')] }),
        nm({ sentAtMs: 200, addresses: [addr('5550102', '+15555550102')] }),
      ],
      'US',
    );
    expect(r.contacts.length).toBe(2);
    expect(r.ownerTempId).toBeNull();
    expect(r.contacts.some((c) => c.isOwner)).toBe(false);
  });

  it('returns empty results for no messages', () => {
    const r = resolveIdentities([], 'US');
    expect(r.contacts).toEqual([]);
    expect(r.identifiers).toEqual([]);
    expect(r.ownerTempId).toBeNull();
    expect(r.contactIdByAddress.size).toBe(0);
  });
});
