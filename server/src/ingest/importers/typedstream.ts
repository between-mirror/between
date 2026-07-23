// Between — a minimal reader for Apple's typedstream (NSArchiver) format.
//
// It exists for one field. In a Mac `chat.db`, `message.text` is often NULL and the words live in
// `message.attributedBody`, an NSAttributedString serialised by NSArchiver. Without this, a large
// share of a modern iMessage archive imports as empty messages — which is worse than failing, because
// the rows are there, the counts look right, and the conversation is blank.
//
// SCOPE, deliberately narrow. This is not an NSArchiver implementation and does not try to be. It
// reads the stream far enough to recover the STRING CONTENTS in order, which is the only thing the
// caller wants; typed values it does not understand are skipped rather than interpreted. A full
// unarchiver would be more code, more attack surface for a hostile file, and no more correct for
// this purpose.
//
// NO DEPENDENCIES, on purpose. A privacy-first program should not take a supply-chain risk to parse
// a container format, particularly one it feeds untrusted bytes from someone else's disk.
//
// EVERYTHING IS HOSTILE INPUT. The file comes from a user's machine and may be truncated, corrupt,
// or crafted. Every read is bounds-checked, every length is sanity-checked against the remaining
// buffer, and the reader has a hard step budget so a malformed stream cannot spin. Failure returns
// null; it never throws and never loops.

/**
 * The archiver's signature, as Apple actually writes it.
 *
 * It is `streamtyped`, not `typedstream` — the format's name and its magic string are reversed with
 * respect to each other, which is a genuinely easy thing to get backwards. Getting it backwards
 * would have produced a reader that decoded this project's own fixtures perfectly and rejected every
 * real file on earth, with no test able to tell.
 */
const SIGNATURE = 'streamtyped';

class Cursor {
  constructor(readonly buf: Buffer, public pos = 0) {}
  get done(): boolean { return this.pos >= this.buf.length; }
  get remaining(): number { return this.buf.length - this.pos; }
  byte(): number {
    if (this.pos >= this.buf.length) throw new RangeError('past end');
    return this.buf[this.pos++];
  }
  take(n: number): Buffer {
    if (n < 0 || n > this.remaining) throw new RangeError('past end');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/**
 * typedstream's variable-length integer.
 *
 * A single byte carries values under 0x80. 0x81/0x82/0x84 introduce a 2-, 4- or 8-byte little-endian
 * value; 0x80 is the "nil"/absent marker. Anything ≥ 0x80 that is not one of those is not a length,
 * and the caller treats it as a signal to stop rather than guessing.
 */
function readInt(c: Cursor): number | null {
  const b = c.byte();
  if (b < 0x80) return b;
  if (b === 0x81) return c.take(2).readUInt16LE(0);
  if (b === 0x82) return c.take(4).readUInt32LE(0);       // 3-byte forms do not appear in practice
  if (b === 0x83) return c.take(4).readUInt32LE(0);
  if (b === 0x84) return Number(c.take(8).readBigUInt64LE(0));
  return null;
}

/**
 * Recover the string contents of a typedstream blob, in order.
 *
 * Returns null when the buffer is not a typedstream at all — which is different from a typedstream
 * that contains no strings, and the caller needs to tell those apart to count unreadable messages
 * honestly rather than reporting every empty message as a decode failure.
 */
export function readTypedStreamStrings(buf: Buffer, opts: { maxSteps?: number } = {}): string[] | null {
  if (buf.length < SIGNATURE.length + 3) return null;

  const c = new Cursor(buf);
  try {
    // Header: a version byte, the signature as a length-prefixed string, then the system version —
    // which is a variable-length int (0x81 0xe8 0x03 = 1000 on the files this was written against),
    // not a single byte.
    c.byte();                                   // streamer version (4 in every file seen)
    const sigLen = readInt(c);
    if (sigLen == null || sigLen !== SIGNATURE.length) return null;
    if (c.take(sigLen).toString('latin1') !== SIGNATURE) return null;
    if (readInt(c) == null) return null;         // system version
  } catch {
    return null;
  }

  const out: string[] = [];
  // A hostile or truncated blob must not be able to spin. The budget is generous next to any real
  // message and still bounded.
  const budget = opts.maxSteps ?? 200_000;
  let steps = 0;

  while (!c.done && steps++ < budget) {
    let b: number;
    try { b = c.byte(); } catch { break; }

    // 0x2B ('+') introduces a length-prefixed byte string — the only thing being looked for. In a
    // typedstream these carry both class names and string contents; the caller sorts them out,
    // because deciding here would mean modelling the class graph this reader deliberately does not.
    if (b !== 0x2B) continue;

    let len: number | null;
    try { len = readInt(c); } catch { break; }
    if (len == null || len < 0 || len > c.remaining) continue;   // not a length: keep scanning

    let bytes: Buffer;
    try { bytes = c.take(len); } catch { break; }
    // Apple writes these as UTF-8. Bytes that are not valid UTF-8 come back with replacement
    // characters rather than throwing, and a run made only of those is not text.
    const s = bytes.toString('utf8');
    if (s.length > 0 && !/^�+$/.test(s)) out.push(s);
  }

  return out;
}

/**
 * Class and attribute names that appear as strings in an NSAttributedString but are not the message.
 *
 * Matching on a known list rather than "the longest string" or "the first string": both of those
 * heuristics silently pick an attribute name on some real messages, and a wrong body is worse than
 * no body because nothing downstream can tell it is wrong.
 */
const NOT_BODY = new Set([
  'NSString', 'NSMutableString', 'NSObject', 'NSAttributedString', 'NSMutableAttributedString',
  'NSDictionary', 'NSMutableDictionary', 'NSArray', 'NSMutableArray', 'NSNumber', 'NSValue',
  'NSData', 'NSMutableData', 'NSDate', 'NSURL', 'NSUUID', 'NSFont', 'NSColor',
  'NSParagraphStyle', 'NSMutableParagraphStyle', 'NSTextAttachment', 'NSShadow', 'NSNull',
  'NSSet', 'NSMutableSet', 'NSIndexSet', 'NSMutableIndexSet', 'NSDecimalNumber', 'NSError',
  'NSCharacterSet', 'NSLocale', 'NSTimeZone', 'NSCalendar',
  'IMMessagePartAttributes',
]);

/**
 * Attribute keys are namespaced single identifiers — `__kIMMessagePartAttributeName` and its
 * siblings. Metadata is matched on that SHAPE (and on the exact class names above), never on a
 * leading substring of the text.
 *
 * This was `/^(__kIM|NS[A-Z]|kIM)/`, tested against the message body itself, and it destroyed real
 * messages: "NSFW", "NSW next week?", "NSA is at it again", "NSAIDs make me sick" all begin
 * NS+capital, so the words were discarded as metadata and the row imported as `[unreadable
 * message]` — then counted in `unreadable`, the number that is supposed to mean the bytes could not
 * be decoded. It could, and they were thrown away. A filter for metadata must not be able to match
 * a sentence: an attribute key is one token with no whitespace, and a class name is a name we know.
 */
const ATTRIBUTE_KEY = /^_*kIM[A-Za-z0-9]*$/;

/**
 * The message body from an `attributedBody` blob, or null when there is nothing readable in it.
 *
 * Null is the honest answer for a blob this reader cannot make sense of, and the caller turns it
 * into a counted `[unreadable message]` rather than an empty one — the count is the honesty.
 */
export function bodyFromAttributedBody(buf: Buffer): string | null {
  const strings = readTypedStreamStrings(buf);
  if (strings == null) return null;

  for (const s of strings) {
    const t = s.trim();
    if (!t) continue;
    if (NOT_BODY.has(t) || ATTRIBUTE_KEY.test(t)) continue;
    return s;
  }
  return null;
}
