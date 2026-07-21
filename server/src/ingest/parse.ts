// Streaming SAX parse of an SMS Backup & Restore XML file (GAMEPLAN §2.3 stage 1).
// Emits one RawRecord per <sms> and per <mms>. Must NOT DOM-parse, and must survive
// multi-MB base64 <part @data> without buffering whole element trees or retaining
// media bytes (the single most important streaming-safety rule here — see below).
import { createReadStream } from 'node:fs';
import { SaxesParser } from 'saxes';
import type { RawRecord, RawMms } from '../types';

export interface ParseStats {
  sms: number;
  mms: number;
}

export async function parseSmsBackup(
  xmlPath: string,
  onRecord: (rec: RawRecord) => void,
): Promise<ParseStats> {
  const stats: ParseStats = { sms: 0, mms: 0 };

  return new Promise<ParseStats>((resolve, reject) => {
    const parser = new SaxesParser();
    // Only one record is ever held at a time: the MMS currently being assembled
    // from its nested <part>/<addr> children. Everything else is emitted inline.
    let currentMms: RawMms | null = null;
    let settled = false;

    // Text (utf8) chunks: Node's StringDecoder joins multibyte/surrogate pairs
    // across chunk boundaries, so emoji never split mid-parse.
    const stream = createReadStream(xmlPath, { encoding: 'utf8' });

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(err);
    };

    parser.on('error', fail);

    parser.on('opentag', (tag) => {
      const name = tag.name;
      const attributes = tag.attributes as Record<string, string>;

      if (name === 'sms') {
        // SMS keeps everything in attributes and has no children — emit at once.
        onRecord({ kind: 'sms', attrs: { ...attributes } });
        stats.sms += 1;
        return;
      }

      if (name === 'mms') {
        currentMms = { kind: 'mms', attrs: { ...attributes }, parts: [], addrs: [] };
        return;
      }

      if (!currentMms) return;
      const mms = currentMms;

      if (name === 'part') {
        // CRITICAL memory rule: a single <part @data> can be several MB of base64.
        // saxes hands us the value once; we record only its LENGTH and drop the
        // string immediately so it can be GC'd. Media bytes are never persisted
        // (metadata-only; §6). _dataLen lets normalize derive an approximate size.
        const attrs: Record<string, string> = {};
        for (const key of Object.keys(attributes)) {
          if (key === 'data') {
            attrs._dataLen = String(attributes[key].length);
            attrs.data = '';
          } else {
            attrs[key] = attributes[key];
          }
        }
        mms.parts.push({ attrs });
        return;
      }

      if (name === 'addr') {
        mms.addrs.push({ attrs: { ...attributes } });
      }
    });

    parser.on('closetag', (tag) => {
      // Emit the MMS once its full <parts>/<addrs> subtree has been seen.
      if (tag.name === 'mms' && currentMms) {
        onRecord(currentMms);
        stats.mms += 1;
        currentMms = null;
      }
    });

    stream.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      try {
        // Stream is opened with utf8 encoding, so chunks arrive as strings;
        // toString() is a no-op there and only guards the Buffer type signature.
        parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      } catch (err) {
        fail(err as Error);
      }
    });
    stream.on('error', (err) => fail(err));
    stream.on('end', () => {
      if (settled) return;
      try {
        parser.close();
      } catch (err) {
        fail(err as Error);
        return;
      }
      if (settled) return;
      settled = true;
      resolve(stats);
    });
  });
}
