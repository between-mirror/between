// Between Mirror — published screenshots must not carry metadata nobody looked at.
//
// Every image on the site and in the README is a real screenshot of the real application, taken on a
// real desktop. PNG encoders routinely attach ancillary text chunks — tEXt/iTXt/zTXt hold things like
// "Software", "Author", "Comment", and whatever the capture tool felt like recording; eXIf can carry
// a great deal more. None of it is visible in the picture, none of it is visible in review, and all
// of it ships to everyone who loads the page.
//
// A project whose entire argument is "your archive stays yours" cannot publish a file with an unread
// author field in it. So the chunk list is checked mechanically, the same way the site's egress is.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Ancillary chunks that carry human-authored or capture-environment text.
const FORBIDDEN = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);

function pngsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pngsUnder(p);
    return extname(p).toLowerCase() === '.png' ? [p] : [];
  });
}

/**
 * Walk the PNG chunk sequence and return every chunk type in file order.
 *
 * Throws rather than returning a short list if the walk does not end cleanly on IEND with the buffer
 * exactly consumed. Without that, three different malformations all returned "no text chunks found",
 * which reads identically to "clean": a truncated file, a bogus length field that desynchronises the
 * walk so it steps straight over a real tEXt, and metadata appended after IEND. "I could not read
 * this file" must not be reported as "this file is fine".
 */
function chunkTypes(buf: Buffer): string[] {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  const types: string[] = [];
  let at = 8;
  for (;;) {
    if (at + 12 > buf.length) throw new Error(`truncated: ${buf.length - at} byte(s) left, need >= 12`);
    const length = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    if (!/^[a-zA-Z]{4}$/.test(type)) throw new Error(`desynchronised at byte ${at}: chunk type ${JSON.stringify(type)}`);
    types.push(type);
    at += 12 + length;                       // length + type + data + CRC
    if (at > buf.length) throw new Error(`chunk ${type} at ${at - 12 - length} overruns the file`);
    if (type === 'IEND') break;
  }
  if (at !== buf.length) throw new Error(`${buf.length - at} byte(s) after IEND — appended metadata?`);
  return types;
}

const SITE_MEDIA = pngsUnder(join(ROOT, 'site/media'));
const DOCS_MEDIA = pngsUnder(join(ROOT, 'docs/media'));
const images = [...SITE_MEDIA, ...DOCS_MEDIA];

describe('published PNGs carry no unexamined metadata', () => {
  it('finds the published screenshots in BOTH directories', () => {
    // Asserted per directory. A single ">= 6" over the combined list was exactly satisfiable by one
    // directory alone: renaming site/media would leave the six in docs/media, the guard would pass,
    // and zero shipped site images would be checked — the precise failure the guard existed to catch.
    expect(SITE_MEDIA.length, 'no PNGs found under site/media').toBeGreaterThanOrEqual(6);
    expect(DOCS_MEDIA.length, 'no PNGs found under docs/media').toBeGreaterThanOrEqual(6);
  });

  it('rejects a malformed PNG instead of calling it clean', () => {
    // Each of these once returned "no forbidden chunks" — indistinguishable from a real pass.
    const ihdr = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(12)]);
    ihdr.writeUInt32BE(0, 8); ihdr.write('IEND', 12);
    expect(() => chunkTypes(ihdr.subarray(0, 16)), 'truncated file').toThrow(/truncated/);
    expect(() => chunkTypes(Buffer.concat([ihdr, Buffer.from('junk')])), 'bytes after IEND').toThrow(/after IEND/);
    expect(() => chunkTypes(Buffer.alloc(24)), 'not a PNG at all').toThrow(/bad signature/);
    expect(chunkTypes(ihdr), 'a minimal well-formed file still parses').toEqual(['IEND']);
  });

  it.each(images.map((p) => [p.slice(ROOT.length + 1).replace(/\\/g, '/'), p]))(
    '%s has no tEXt/iTXt/zTXt/eXIf chunk',
    (rel, abs) => {
      const found = chunkTypes(readFileSync(abs)).filter((t) => FORBIDDEN.has(t));
      expect(
        found,
        `${rel} carries ${found.join(', ')} — strip it (metadata nobody has read must not ship)`,
      ).toEqual([]);
    },
  );
});
