// PARSE agent — record normalization. Synthetic data only; fictional 555-01xx
// numbers, speakers ME / THEM.
import { describe, it, expect } from 'vitest';
import { normalizeRecord, normalizeNumber } from '../src/ingest/normalize';
import type { NormalizeCtx } from '../src/ingest/normalize';
import type { RawRecord } from '../src/types';

const ctx: NormalizeCtx = { region: 'US', sourceFileId: 7 };

const sms = (attrs: Record<string, string>): RawRecord => ({ kind: 'sms', attrs });
const mms = (
  attrs: Record<string, string>,
  parts: Array<Record<string, string>> = [],
  addrs: Array<Record<string, string>> = [],
): RawRecord => ({
  kind: 'mms',
  attrs,
  parts: parts.map((p) => ({ attrs: p })),
  addrs: addrs.map((a) => ({ attrs: a })),
});

describe('normalizeRecord — SMS', () => {
  it('coerces literal "null" and empty strings to real null on every field', () => {
    const m = normalizeRecord(
      sms({ address: 'null', body: 'null', date: 'null', type: 'null', read: 'null', contact_name: 'null' }),
      ctx,
    );
    expect(m.bodyText).toBeNull();
    expect(m.isRead).toBeNull();
    expect(m.contactNameHint).toBeNull();
    expect(m.rawType).toBeNull();
    expect(m.addresses).toEqual([]); // null address ⇒ no counterparty
    expect(m.sentAtMs).toBe(0);
    expect(m.direction).toBe('other');
  });

  it('maps @type to direction (1/2/3 → incoming/outgoing/draft; 4/5/6 → other)', () => {
    const dir = (t: string) => normalizeRecord(sms({ type: t, address: '5555550123', date: '1' }), ctx).direction;
    expect(dir('1')).toBe('incoming');
    expect(dir('2')).toBe('outgoing');
    expect(dir('3')).toBe('draft');
    expect(dir('4')).toBe('other');
    expect(dir('5')).toBe('other');
    expect(dir('6')).toBe('other');
  });

  it('derives the address role from direction and keeps the raw value', () => {
    const inbound = normalizeRecord(sms({ type: '1', address: '5555550123', date: '1' }), ctx);
    expect(inbound.addresses).toEqual([{ raw: '5555550123', e164: '+15555550123', role: 'from' }]);
    const outbound = normalizeRecord(sms({ type: '2', address: '5555550123', date: '1' }), ctx);
    expect(outbound.addresses[0].role).toBe('to');
  });

  it('reads @read=="1" as read and preserves raw @type', () => {
    const m = normalizeRecord(sms({ type: '1', address: '5555550123', date: '1', read: '1' }), ctx);
    expect(m.isRead).toBe(true);
    expect(m.rawType).toBe(1);
    expect(normalizeRecord(sms({ type: '1', address: '5555550123', date: '1', read: '0' }), ctx).isRead).toBe(false);
  });

  it('treats @date as epoch ms but scales a bare 10-digit seconds value', () => {
    expect(normalizeRecord(sms({ date: '1620000000000', address: '5555550123', type: '1' }), ctx).sentAtMs)
      .toBe(1620000000000);
    expect(normalizeRecord(sms({ date: '1620000000', address: '5555550123', type: '1' }), ctx).sentAtMs)
      .toBe(1620000000000);
  });

  it('runs the reaction + language classifiers on the body', () => {
    const reaction = normalizeRecord(sms({ type: '1', address: '5555550123', date: '1', body: 'Loved "the plan"' }), ctx);
    expect(reaction.isReaction).toBe(true);
    expect(reaction.reactionKind).toBe('loved');

    const spanish = normalizeRecord(
      sms({ type: '1', address: '5555550123', date: '1', body: 'Hola, ¿cómo estás? Nos vemos mañana en la casa' }),
      ctx,
    );
    expect(spanish.lang).toBe('es');
    expect(spanish.isReaction).toBe(false);
  });
});

describe('normalizeRecord — MMS', () => {
  it('concatenates text/plain parts in order and skips the SMIL layout part', () => {
    const m = normalizeRecord(
      mms({ msg_box: '1', date: '1' }, [
        { seq: '-1', ct: 'application/smil', name: 'null', text: 'null' },
        { seq: '0', ct: 'text/plain', text: 'Hello ' },
        { seq: '1', ct: 'text/plain', text: 'world' },
      ]),
      ctx,
    );
    expect(m.bodyText).toBe('Hello world');
    expect(m.partCount).toBe(3);
  });

  it('records non-text parts as attachments (SMIL flagged) with sizes from _dataLen', () => {
    const m = normalizeRecord(
      mms({ msg_box: '1', date: '1' }, [
        { seq: '-1', ct: 'application/smil' },
        { seq: '0', ct: 'text/plain', text: 'caption' },
        { seq: '1', ct: 'image/jpeg', name: 'pic.jpg', _dataLen: '1000', data: '' },
      ]),
      ctx,
    );
    expect(m.attachments).toHaveLength(2);
    const smil = m.attachments.find((a) => a.isSmil);
    const image = m.attachments.find((a) => !a.isSmil);
    expect(smil).toMatchObject({ mimeType: 'application/smil', isSmil: true, sizeBytes: null, sha256: null });
    expect(image).toMatchObject({
      mimeType: 'image/jpeg',
      filename: 'pic.jpg',
      isSmil: false,
      sizeBytes: 750, // floor(1000 * 3 / 4)
      sha256: null,
    });
    expect(m.bodyText).toBe('caption');
  });

  it('resolves attachment filename via name || cl || fn', () => {
    const byCl = normalizeRecord(
      mms({ msg_box: '1', date: '1' }, [{ seq: '0', ct: 'image/png', name: 'null', cl: 'shot.png' }]),
      ctx,
    );
    expect(byCl.attachments[0].filename).toBe('shot.png');
    const byFn = normalizeRecord(
      mms({ msg_box: '1', date: '1' }, [{ seq: '0', ct: 'image/png', name: 'null', cl: 'null', fn: 'fallback.png' }]),
      ctx,
    );
    expect(byFn.attachments[0].filename).toBe('fallback.png');
  });

  it('maps <addr @type> to roles (137/151/130/129 → from/to/cc/bcc)', () => {
    const m = normalizeRecord(
      mms({ msg_box: '1', date: '1' }, [], [
        { address: '5555550123', type: '137' },
        { address: '5555550124', type: '151' },
        { address: '5555550125', type: '130' },
        { address: '5555550126', type: '129' },
      ]),
      ctx,
    );
    expect(m.addresses.map((x) => x.role)).toEqual(['from', 'to', 'cc', 'bcc']);
    expect(m.addresses[0]).toEqual({ raw: '5555550123', e164: '+15555550123', role: 'from' });
  });

  it('falls back to the envelope address when <addrs> is absent (1:1 and ~-split group)', () => {
    const oneToOne = normalizeRecord(mms({ msg_box: '2', date: '1', address: '5555550123' }), ctx);
    expect(oneToOne.addresses).toEqual([{ raw: '5555550123', e164: '+15555550123', role: 'to' }]);

    const group = normalizeRecord(mms({ msg_box: '1', date: '1', address: '5555550123~5555550124' }), ctx);
    expect(group.addresses.map((a) => a.raw)).toEqual(['5555550123', '5555550124']);
    expect(group.addresses.every((a) => a.role === 'from')).toBe(true); // incoming
  });

  it('derives direction from @msg_box, cross-checking @m_type when ambiguous', () => {
    expect(normalizeRecord(mms({ msg_box: '1', date: '1' }), ctx).direction).toBe('incoming');
    expect(normalizeRecord(mms({ msg_box: '2', date: '1' }), ctx).direction).toBe('outgoing');
    // msg_box absent/ambiguous → fall back to m_type (128=out, 132=in)
    expect(normalizeRecord(mms({ m_type: '128', date: '1' }), ctx).direction).toBe('outgoing');
    expect(normalizeRecord(mms({ m_type: '132', date: '1' }), ctx).direction).toBe('incoming');
    expect(normalizeRecord(mms({ date: '1' }), ctx).direction).toBe('other');
  });

  it('carries mmsMId, contactNameHint and never sets rawType', () => {
    const m = normalizeRecord(mms({ msg_box: '1', date: '1', m_id: 'MID-123', contact_name: 'THEM' }), ctx);
    expect(m.mmsMId).toBe('MID-123');
    expect(m.contactNameHint).toBe('THEM');
    expect(m.rawType).toBeNull();
    expect(m.rawMsgBox).toBe(1);
  });
});

describe('normalizeNumber', () => {
  it('resolves bare 10-digit and +1 forms to the same E.164 (mobile)', () => {
    const bare = normalizeNumber('5555550123', 'US');
    const e164 = normalizeNumber('+15555550123', 'US');
    const formatted = normalizeNumber('(555) 555-0123', 'US');
    expect(bare).toEqual({ e164: '+15555550123', kind: 'mobile' });
    expect(e164.e164).toBe('+15555550123');
    expect(formatted.e164).toBe('+15555550123');
    expect(bare.e164).toBe(e164.e164);
  });

  it('classifies emails, shortcodes, aliases, and empty input', () => {
    expect(normalizeNumber('them@example.com', 'US')).toEqual({ e164: null, kind: 'email' });
    expect(normalizeNumber('22000', 'US')).toEqual({ e164: null, kind: 'shortcode' });
    expect(normalizeNumber('262966', 'US')).toEqual({ e164: null, kind: 'shortcode' }); // 6 digits
    expect(normalizeNumber('SUPPORT', 'US')).toEqual({ e164: null, kind: 'alias' });
    expect(normalizeNumber('', 'US')).toEqual({ e164: null, kind: 'alias' });
  });

  it('returns a null e164 for numbers that cannot form a valid length', () => {
    expect(normalizeNumber('5550101', 'US')).toEqual({ e164: null, kind: 'mobile' }); // 7 digits, no area code
  });
});
