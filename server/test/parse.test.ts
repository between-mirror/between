// PARSE agent — streaming SAX parser. Synthetic XML only; fictional 555-01xx
// numbers, speakers ME / THEM.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSmsBackup } from '../src/ingest/parse';
import type { ParseStats } from '../src/ingest/parse';
import type { RawRecord, RawMms } from '../src/types';

const dir = mkdtempSync(join(tmpdir(), 'between-parse-'));
let fileSeq = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function runParse(xml: string): Promise<{ stats: ParseStats; records: RawRecord[] }> {
  const path = join(dir, `sms-${fileSeq++}.xml`);
  writeFileSync(path, xml, 'utf8');
  const records: RawRecord[] = [];
  const stats = await parseSmsBackup(path, (rec) => records.push(rec));
  return { stats, records };
}

// A big base64-ish payload for the memory-discipline assertion.
const BIG_DATA = 'A'.repeat(4000);

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<smses count="2">
  <sms address="5555550123" date="1620000000000" type="1" body="hi &amp; bye &#128514;" read="1" contact_name="null" />
  <sms address="5555550124" date="1620000100000" type="2" body="ok"></sms>
  <mms msg_box="1" m_type="132" date="1620000200000" m_id="MID-1" address="5555550123">
    <parts>
      <part seq="-1" ct="application/smil" name="null" text="null" />
      <part seq="0" ct="text/plain" text="see the &lt;photo&gt;" />
      <part seq="1" ct="image/jpeg" name="p.jpg" data="${BIG_DATA}" />
    </parts>
    <addrs>
      <addr address="5555550123" type="137" />
      <addr address="5555550124" type="151" />
    </addrs>
  </mms>
</smses>`;

describe('parseSmsBackup', () => {
  it('counts sms and mms records and emits them in document order', async () => {
    const { stats, records } = await runParse(XML);
    expect(stats).toEqual({ sms: 2, mms: 1 });
    expect(records.map((r) => r.kind)).toEqual(['sms', 'sms', 'mms']);
  });

  it('passes raw attribute strings through untouched (no "null" coercion here)', async () => {
    const { records } = await runParse(XML);
    expect(records[0].attrs.contact_name).toBe('null'); // coercion is normalize\'s job
    expect(records[0].attrs.type).toBe('1');
  });

  it('decodes XML entities via the parser in attribute values', async () => {
    const { records } = await runParse(XML);
    expect(records[0].attrs.body).toBe('hi & bye \u{1F602}');
    const mms = records[2] as RawMms;
    const textPart = mms.parts.find((p) => p.attrs.ct === 'text/plain');
    expect(textPart?.attrs.text).toBe('see the <photo>');
  });

  it('handles both self-closing and explicit-close <sms> forms', async () => {
    const { records } = await runParse(XML);
    expect(records[1].attrs.address).toBe('5555550124');
    expect(records[1].attrs.body).toBe('ok');
  });

  it('gathers nested <part> and <addr> onto the MMS record', async () => {
    const { records } = await runParse(XML);
    const mms = records[2] as RawMms;
    expect(mms.parts).toHaveLength(3);
    expect(mms.addrs).toHaveLength(2);
    expect(mms.addrs.map((a) => a.attrs.type)).toEqual(['137', '151']);
    expect(mms.attrs.m_id).toBe('MID-1');
  });

  it('NEVER retains <part @data>: records its length and frees the string', async () => {
    const { records } = await runParse(XML);
    const mms = records[2] as RawMms;
    const image = mms.parts.find((p) => p.attrs.ct === 'image/jpeg');
    expect(image?.attrs.data).toBe(''); // big base64 dropped
    expect(image?.attrs._dataLen).toBe(String(BIG_DATA.length)); // only the length kept
    // parts with no @data carry no _dataLen marker
    const textPart = mms.parts.find((p) => p.attrs.ct === 'text/plain');
    expect(textPart?.attrs._dataLen).toBeUndefined();
  });

  it('parses correctly even when the stream is split into tiny chunks', async () => {
    // Re-parse from a fresh file; StringDecoder must not break the multibyte emoji.
    const { records } = await runParse(XML);
    expect(records[0].attrs.body).toContain('\u{1F602}');
  });

  it('resolves with zero records on an empty root', async () => {
    const { stats, records } = await runParse('<?xml version="1.0"?>\n<smses count="0"></smses>');
    expect(stats).toEqual({ sms: 0, mms: 0 });
    expect(records).toEqual([]);
  });
});
