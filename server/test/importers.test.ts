// Between — the WhatsApp and generic importers.
//
// Both emit the same RawRecord shape the SMS parser emits, so the interesting failures are all in the
// parsing: a date order that silently shifts an archive by months, a continuation line becoming its
// own message, a system notice becoming a message from a person who does not exist, and a body with a
// comma in it being cut in half.
//
// Every fixture is synthetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { RawRecord } from '../src/types';
import { parseWhatsApp, scanWhatsApp, readExport, WhatsAppOwnerUnknown } from '../src/ingest/importers/whatsapp';
import { parseGeneric, parseCsv } from '../src/ingest/importers/generic';
import { ingestFile } from '../src/ingest/index';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'between-import-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function write(name: string, content: string | Buffer): string {
  const p = join(dir, `${seq++}-${name}`);
  writeFileSync(p, content);
  return p;
}

function collect(fn: (emit: (r: RawRecord) => void) => unknown): RawRecord[] {
  const out: RawRecord[] = [];
  fn((r) => out.push(r));
  return out;
}

const attrs = (r: RawRecord): Record<string, string> => (r as { attrs: Record<string, string> }).attrs;

describe('WhatsApp export', () => {
  it('reads the bracketed 24-hour day-first form', () => {
    const p = write('chat.txt', [
      '[25/12/2021, 22:30:45] Alice: happy christmas',
      '[26/12/2021, 09:05:00] Bob: you too',
    ].join('\n'));

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Bob' }));
    expect(recs).toHaveLength(2);
    expect(attrs(recs[0]).type).toBe('1');                       // Alice → incoming
    expect(attrs(recs[1]).type).toBe('2');                       // Bob is the owner → outgoing
    expect(Number(attrs(recs[0]).date)).toBe(Date.UTC(2021, 11, 25, 22, 30, 45));
    expect(attrs(recs[0]).body).toBe('happy christmas');
  });

  it('reads the dashed 12-hour month-first form', () => {
    const p = write('chat.txt', [
      '12/25/21, 10:30 PM - Alice: evening',
      '12/25/21, 11:05 AM - Bob: morning',
    ].join('\n'));

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Bob' }));
    expect(Number(attrs(recs[0]).date)).toBe(Date.UTC(2021, 11, 25, 22, 30, 0));
    expect(Number(attrs(recs[1]).date)).toBe(Date.UTC(2021, 11, 25, 11, 5, 0));
  });

  it('infers day-first from a day above twelve, anywhere in the file', () => {
    // This is the whole ballgame. One line proves the order for every other line, and getting it
    // wrong shifts an archive by up to eleven months — quietly, since every date stays valid.
    const p = write('chat.txt', [
      '[01/02/2021, 10:00:00] Alice: ambiguous on its own',
      '[25/02/2021, 10:00:00] Alice: but this one can only be a day',
    ].join('\n'));

    const scan = scanWhatsApp(p);
    expect(scan.dateOrder).toBe('dmy');
    expect(scan.dateOrderProven).toBe(true);

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Alice' }));
    expect(Number(attrs(recs[0]).date)).toBe(Date.UTC(2021, 1, 1, 10, 0, 0));  // 1 February
  });

  it('infers month-first the same way, from a month-position above twelve', () => {
    const p = write('chat.txt', [
      '[01/02/2021, 10:00:00] Alice: ambiguous',
      '[02/25/2021, 10:00:00] Alice: only a month can be first here',
    ].join('\n'));
    const scan = scanWhatsApp(p);
    expect(scan.dateOrder).toBe('mdy');
    expect(scan.dateOrderProven).toBe(true);
  });

  it('admits when the file never proves an order', () => {
    // A short export inside one fortnight is genuinely ambiguous. It still parses — but it says the
    // choice was a default, so a caller can warn rather than present a shifted archive as fact.
    const p = write('chat.txt', '[01/02/2021, 10:00:00] Alice: hello');
    const scan = scanWhatsApp(p);
    expect(scan.dateOrderProven).toBe(false);
  });

  it('keeps a multi-line message whole instead of inventing new ones', () => {
    const p = write('chat.txt', [
      '[25/12/2021, 22:30:45] Alice: first line',
      'second line',
      'third line',
      '[25/12/2021, 22:31:00] Bob: reply',
    ].join('\n'));

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Bob' }));
    expect(recs).toHaveLength(2);
    expect(attrs(recs[0]).body).toBe('first line\nsecond line\nthird line');
  });

  it('does not turn system notices into messages from a person', () => {
    // "Messages and calls are end-to-end encrypted" has a colon in it and would otherwise become a
    // message from a contact called "Messages and calls are end-to-end encrypted".
    const p = write('chat.txt', [
      '[25/12/2021, 22:00:00] Messages and calls are end-to-end encrypted. Tap to learn more.',
      '[25/12/2021, 22:30:45] Alice: a real message',
      '[25/12/2021, 22:31:00] Bob created this group',
    ].join('\n'));

    const scan = scanWhatsApp(p);
    expect(scan.participants).toEqual(['Alice']);
    expect(scan.systemLines).toBe(2);

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Alice' }));
    expect(recs).toHaveLength(1);
  });

  it('splits sender from body on the first colon only', () => {
    const p = write('chat.txt', '[25/12/2021, 22:30:45] Alice: the time is 10:30: be there');
    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Alice' }));
    expect(attrs(recs[0]).body).toBe('the time is 10:30: be there');
  });

  it('empties media placeholders rather than importing them as things someone said', () => {
    const p = write('chat.txt', [
      '[25/12/2021, 22:30:45] Alice: <Media omitted>',
      '[25/12/2021, 22:31:00] Alice: real words',
    ].join('\n'));
    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Alice' }));
    expect(attrs(recs[0]).body).toBe('');
    expect(attrs(recs[1]).body).toBe('real words');
    expect(scanWhatsApp(p).mediaPlaceholders).toBe(1);
  });

  it('refuses to guess which participant is the owner', () => {
    // An export carries no marker for "you". Guessing attributes half a relationship to the wrong
    // person, and every directional number downstream inherits the error.
    const p = write('chat.txt', [
      '[25/12/2021, 22:30:45] Alice: hi',
      '[25/12/2021, 22:31:00] Bob: hello',
    ].join('\n'));

    expect(() => parseWhatsApp(p, () => {})).toThrow(WhatsAppOwnerUnknown);
    try {
      parseWhatsApp(p, () => {});
    } catch (e) {
      expect((e as WhatsAppOwnerUnknown).participants).toEqual(['Alice', 'Bob']);
    }
    // And a name that is not in the file is refused too, rather than silently importing everything
    // as incoming.
    expect(() => parseWhatsApp(p, () => {}, { ownerName: 'Carol' })).toThrow(WhatsAppOwnerUnknown);
  });

  it('addresses every message to the correspondent, so a 1:1 chat is ONE thread', () => {
    // The bug this exists for: `address` was the AUTHOR, and threading is by correspondent. A two
    // person conversation imported as two threads, one per person, and every per-thread number —
    // every era, episode, reply time, hostile share — was then computed over half a relationship.
    // Caught only by running a real import and noticing "threads: 2".
    const p = write('chat.txt', [
      '[25/12/2021, 22:30:45] Alice: hers',
      '[25/12/2021, 22:31:00] Bob: his',
    ].join('\n'));

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Bob' }));
    const addresses = new Set(recs.map((r) => attrs(r).address));
    expect(addresses, 'both directions must share one correspondent').toEqual(new Set(['Alice']));
    expect(attrs(recs[0]).type).toBe('1');
    expect(attrs(recs[1]).type).toBe('2');
  });

  it('refuses a group export rather than threading it wrongly', () => {
    // A group threads by a participant SET, which a single `address` cannot express. Importing it
    // approximately would put the wrong people in the wrong conversation, silently.
    const p = write('group.txt', [
      '[25/12/2021, 22:30:45] Alice: one',
      '[25/12/2021, 22:31:00] Carol: two',
      '[25/12/2021, 22:32:00] Bob: three',
    ].join('\n'));

    expect(() => parseWhatsApp(p, () => {}, { ownerName: 'Bob' })).toThrow(/group/i);
  });

  it('reads a .zip export without taking on a zip dependency', () => {
    // Built by hand so the test proves the reader, not a library. Deflated, which is what WhatsApp
    // actually produces.
    const inner = '[25/12/2021, 22:30:45] Alice: from inside a zip\n';
    const name = Buffer.from('_chat.txt');
    const data = deflateRawSync(Buffer.from(inner, 'utf8'));
    const crc = 0;                                   // not verified by the reader
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(inner.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(inner.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);

    const localBlock = Buffer.concat([local, name, data]);
    const centralBlock = Buffer.concat([central, name]);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralBlock.length, 12); eocd.writeUInt32LE(localBlock.length, 16);
    eocd.writeUInt16LE(0, 20);

    const p = write('export.zip', Buffer.concat([localBlock, centralBlock, eocd]));
    expect(readExport(p)).toContain('from inside a zip');

    const recs = collect((emit) => parseWhatsApp(p, emit, { ownerName: 'Alice' }));
    expect(recs).toHaveLength(1);
  });
});

describe('the generic normalized importer', () => {
  it('reads CSV with a direction column', () => {
    const p = write('m.csv', [
      'timestamp,sender,direction,body',
      '2021-12-25T22:30:00Z,Alice,in,hello',
      '2021-12-25T22:31:00Z,Bob,out,hi back',
    ].join('\n'));

    const recs = collect((emit) => parseGeneric(p, emit));
    expect(recs).toHaveLength(2);
    expect(attrs(recs[0]).type).toBe('1');
    expect(attrs(recs[1]).type).toBe('2');
    expect(Number(attrs(recs[0]).date)).toBe(Date.parse('2021-12-25T22:30:00Z'));
  });

  it('does not cut a body in half at a comma', () => {
    // The messages most worth reading are the long ones with punctuation in them, and a naive split
    // would corrupt exactly those, quietly.
    const p = write('m.csv', [
      'timestamp,sender,direction,body',
      '2021-12-25T22:30:00Z,Alice,in,"first, second, and ""quoted"" too"',
    ].join('\n'));
    const recs = collect((emit) => parseGeneric(p, emit));
    expect(attrs(recs[0]).body).toBe('first, second, and "quoted" too');
  });

  it('keeps a newline inside a quoted CSV field', () => {
    const p = write('m.csv', 'timestamp,sender,direction,body\n2021-12-25T22:30:00Z,Alice,in,"line one\nline two"\n');
    const recs = collect((emit) => parseGeneric(p, emit));
    expect(attrs(recs[0]).body).toBe('line one\nline two');
  });

  it('accepts column aliases, case-insensitively', () => {
    const p = write('m.csv', [
      'Date,From,Dir,Text',
      '2021-12-25T22:30:00Z,Alice,received,hello',
    ].join('\n'));
    const recs = collect((emit) => parseGeneric(p, emit));
    expect(recs).toHaveLength(1);
    expect(attrs(recs[0]).type).toBe('1');
  });

  it('derives direction from ownerName when there is no direction column', () => {
    const p = write('m.json', JSON.stringify([
      { timestamp: '2021-12-25T22:30:00Z', sender: 'Alice', body: 'hi' },
      { timestamp: '2021-12-25T22:31:00Z', sender: 'Bob', body: 'hello' },
    ]));
    const recs = collect((emit) => parseGeneric(p, emit, { ownerName: 'Bob' }));
    expect(attrs(recs[0]).type).toBe('1');
    expect(attrs(recs[1]).type).toBe('2');
  });

  it('refuses a row it cannot attribute rather than guessing', () => {
    // Defaulting would make every message incoming, which is the exact shape of a broken restore —
    // and archive health would then correctly flag the whole import as one-sided.
    const p = write('m.json', JSON.stringify([{ timestamp: '2021-12-25T22:30:00Z', sender: 'Alice', body: 'hi' }]));
    const scan = parseGeneric(p, () => {});
    expect(scan.rows).toBe(0);
    expect(scan.skipped).toBe(1);
    expect(scan.problems.join(' ')).toMatch(/ownerName/);
  });

  it('refuses an ambiguous bare date instead of shifting the archive by months', () => {
    const p = write('m.csv', ['timestamp,sender,direction,body', '01/02/2021,Alice,in,hello'].join('\n'));
    const scan = parseGeneric(p, () => {});
    expect(scan.rows).toBe(0);
    expect(scan.problems.join(' ')).toMatch(/unambiguous/);
  });

  it('reads epoch seconds and milliseconds, telling them apart by magnitude', () => {
    const p = write('m.csv', [
      'timestamp,sender,direction,body',
      '1640471400,Alice,in,seconds',
      '1640471400000,Alice,in,millis',
    ].join('\n'));
    const recs = collect((emit) => parseGeneric(p, emit));
    expect(Number(attrs(recs[0]).date)).toBe(1640471400000);
    expect(Number(attrs(recs[1]).date)).toBe(1640471400000);
  });

  it('reads JSONL and the common wrapper objects', () => {
    const jsonl = write('m.jsonl', [
      JSON.stringify({ timestamp: '2021-12-25T22:30:00Z', sender: 'A', direction: 'in', body: 'x' }),
      JSON.stringify({ timestamp: '2021-12-25T22:31:00Z', sender: 'B', direction: 'out', body: 'y' }),
    ].join('\n'));
    expect(collect((emit) => parseGeneric(jsonl, emit))).toHaveLength(2);

    const wrapped = write('m.json', JSON.stringify({
      messages: [{ timestamp: '2021-12-25T22:30:00Z', sender: 'A', direction: 'in', body: 'x' }],
    }));
    expect(collect((emit) => parseGeneric(wrapped, emit))).toHaveLength(1);
  });

  it('reports the rows it could not read rather than importing short in silence', async () => {
    // parseGeneric already counted these and said why; ingestFile discarded the whole report, so a
    // file half of which had unreadable dates imported as a smaller archive with nothing anywhere
    // saying how much never arrived.
    const p = write('partly-unreadable.csv', [
      'timestamp,sender,direction,body',
      '2021-12-25T22:30:00Z,Alice,in,readable',
      '01/02/2021,Alice,in,ambiguous date',
      'not-a-date-at-all,Alice,in,worse',
    ].join('\n'));
    const dbFile = join(dir, `unread-${Date.now()}.db`);
    const res = await ingestFile(p, { dbPath: dbFile, region: 'US' });
    expect(res.messageRows).toBe(1);
    expect(res.unreadableRows).toBe(2);
    expect(res.unreadableWhy?.join(' ')).toMatch(/timestamp|unambiguous/i);
  });

  it('parses CSV rows into a header-keyed object', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('')).toEqual([]);
  });
});
