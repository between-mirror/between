// Between — the iMessage importer (Mac chat.db).
//
// Everything here is synthetic and says so. The test bed builds a real-schema chat.db with real
// Apple epochs and real typedstream bytes, because the alternative — developing against an actual
// chat.db — means somebody's real messages, and none of those are ever in this repository.
//
// What that buys and what it does not: these tests prove the importer handles every SHAPE the format
// takes, including the ones easy to get wrong. They cannot prove it handles a real export, because
// both sides were written here. That is why it ships labelled unverified and asks for volunteers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawRecord } from '../src/types';
import {
  parseIMessage, scanIMessage, appleDateToMs, isTapback,
  UNREADABLE, UNSENT, IMessageGroupRefused, IMessageLivePathRefused, IMessageConversationRequired,
} from '../src/ingest/importers/imessage';
import { bodyFromAttributedBody, readTypedStreamStrings } from '../src/ingest/importers/typedstream';
import { ingestFile } from '../src/ingest/index';
import { openDb } from '../src/store/db';
import {
  writeChatDb, attributedBody, attributedBodyEmpty, attributedBodyCorrupt, APPLE_EPOCH_MS,
} from './fixtures/chatdb';
import { classifyReaction } from '../src/ingest/classify';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'between-imsg-')); });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

let seq = 0;
const dbPath = (): string => join(dir, `chat-${seq++}.db`);

const attrs = (r: RawRecord): Record<string, string> => (r as { attrs: Record<string, string> }).attrs;
function collect(path: string): RawRecord[] {
  const out: RawRecord[] = [];
  parseIMessage(path, (r) => out.push(r));
  return out;
}

const T = Date.UTC(2023, 4, 10, 9, 0, 0);

describe('the two Apple epochs', () => {
  it('reads nanoseconds, which is what macOS 10.13 and later write', () => {
    const p = dbPath();
    writeChatDb(p, { epoch: 'nanos', messages: [{ ms: T, fromMe: false, text: 'morning' }] });
    expect(Number(attrs(collect(p)[0]).date)).toBe(T);
  });

  it('reads seconds, which is what older machines wrote', () => {
    // The same integer means two dates a thousand-fold apart. Guessing wrong does not look like an
    // error — it looks like a conversation that happened in 1971, or in the year 33000.
    const p = dbPath();
    writeChatDb(p, { epoch: 'seconds', messages: [{ ms: T, fromMe: false, text: 'morning' }] });
    expect(Number(attrs(collect(p)[0]).date)).toBe(T);
  });

  it('reads a database from before the Edit/Unsend columns existed', () => {
    // `date_edited` and `date_retracted` arrived with macOS 13 in 2022. The read selected them
    // unconditionally, so every older chat.db died on `no such column: m.date_retracted` — a raw
    // SqliteError, before one row was read, with no importer-authored explanation.
    //
    // The seconds epoch is pre-2017, so a file old enough to use it cannot possibly carry the
    // Ventura columns: the "reads seconds" test above passed only because the fixture always wrote
    // today's schema. That branch was unreachable on any real archive.
    const p = dbPath();
    writeChatDb(p, {
      preVentura: true, epoch: 'seconds',
      messages: [{ ms: T, fromMe: false, text: 'morning' }],
    });
    const recs = collect(p);
    expect(recs).toHaveLength(1);
    expect(attrs(recs[0]).body).toBe('morning');
    expect(Number(attrs(recs[0]).date)).toBe(T);
  });

  it('keeps two messages that land on the same second', () => {
    // A pre-High-Sierra chat.db stores whole SECONDS, so any two messages sent in the same second
    // arrive at the identical millisecond. The dedup ranking needs something that tells apart two
    // rows sharing an instant and a body; every other importer supplies a source id and this one
    // supplied none, so the second "ok" was dropped and reported to the owner as a duplicate. The
    // guid is the file's own answer to which message is which.
    const p = dbPath();
    writeChatDb(p, {
      epoch: 'seconds',
      messages: [
        { ms: T, fromMe: true, text: 'ok' },
        { ms: T + 400, fromMe: true, text: 'ok' },
      ],
    });
    const recs = collect(p);
    expect(recs).toHaveLength(2);
    expect(new Set(recs.map((r) => attrs(r).native_id)).size).toBe(2);
  });

  it('converts each encoding directly, and treats zero as absent', () => {
    expect(appleDateToMs(0)).toBe(0);                          // absent, not 2001-01-01

    // The same instant, written both ways, at a magnitude a real message actually has.
    const seconds = (T - APPLE_EPOCH_MS) / 1000;
    const nanos = BigInt(T - APPLE_EPOCH_MS) * 1_000_000n;
    expect(appleDateToMs(seconds)).toBe(T);
    expect(appleDateToMs(nanos)).toBe(T);

    // The detection is by magnitude, and the two clusters are twelve orders of magnitude apart:
    // a 2023 date is ~7e8 as seconds and ~7e17 as nanoseconds. The only values that could be read
    // either way sit within about a second of 2001-01-01, which is not a date a message has.
    expect(seconds).toBeLessThan(1e12);
    expect(Number(nanos)).toBeGreaterThan(1e12);
  });

  it('reports which encoding a file used', () => {
    const p = dbPath();
    writeChatDb(p, { epoch: 'seconds', messages: [{ ms: T, fromMe: false, text: 'x' }] });
    expect(scanIMessage(p).epoch).toBe('seconds');
  });
});

describe('the words, wherever they are kept', () => {
  it('takes the text column when it is populated', () => {
    const p = dbPath();
    writeChatDb(p, { messages: [{ ms: T, fromMe: true, text: 'in the text column' }] });
    expect(attrs(collect(p)[0]).body).toBe('in the text column');
  });

  it('decodes attributedBody when text is null, which is the modern default', () => {
    // Without this, a large share of a modern archive imports as empty messages — and that is worse
    // than failing, because the rows are there, the counts look right, and the conversation is blank.
    const p = dbPath();
    writeChatDb(p, {
      messages: [{ ms: T, fromMe: false, text: null, attributedBody: attributedBody('inside the blob') }],
    });
    expect(attrs(collect(p)[0]).body).toBe('inside the blob');
  });

  it('skips the class names and attribute keys wrapped around the words', () => {
    // A real attributedBody carries NSMutableAttributedString, NSDictionary and
    // __kIMMessagePartAttributeName as strings too. "First string" and "longest string" both pick
    // one of those on some real messages, and a wrong body is worse than none.
    const decoded = bodyFromAttributedBody(attributedBody('the actual words'));
    expect(decoded).toBe('the actual words');
  });

  it('keeps a message whose own words start like an Apple attribute key', () => {
    // The metadata filter was a PREFIX regex — /^(__kIM|NS[A-Z]|kIM)/ — tested against the message
    // itself, so an ordinary text that happens to begin with those letters was thrown away as
    // metadata and stored as [unreadable message]. Two harms at once: the words are destroyed, and
    // they are then counted in `unreadable`, the number whose whole job is to mean "we could not
    // recover this". These are all things people type.
    for (const text of [
      'NSFW', 'NSW next week?', 'NSA is at it again', 'NSAIDs make me sick', 'kIM is her nickname',
    ]) {
      expect(bodyFromAttributedBody(attributedBody(text))).toBe(text);
    }
  });

  it('still skips the metadata identifiers themselves', () => {
    // The filter has to keep doing its job: these are single namespaced identifiers, not sentences.
    for (const meta of ['__kIMMessagePartAttributeName', 'kIMFileTransferGUIDAttributeName']) {
      expect(bodyFromAttributedBody(attributedBody(meta))).toBeNull();
    }
  });

  it('reads a body containing emoji and accents unchanged', () => {
    const text = 'café 🌧 naïve — done';
    expect(bodyFromAttributedBody(attributedBody(text))).toBe(text);
  });

  it('reads a body longer than a single-byte length prefix', () => {
    // The length is a variable-length int; anything over 127 bytes takes the two-byte form, and a
    // reader that only handles the short form truncates every long message in the archive.
    const text = 'x'.repeat(900);
    expect(bodyFromAttributedBody(attributedBody(text))).toBe(text);
  });
});

describe('what cannot be read is counted, never dropped', () => {
  it('marks an undecodable blob rather than importing an empty message', () => {
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: null, attributedBody: attributedBodyCorrupt() },
        { ms: T + 60_000, fromMe: true, text: 'this one is fine' },
      ],
    });
    const recs = collect(p);
    expect(recs).toHaveLength(2);                       // the unreadable row is still a row
    expect(attrs(recs[0]).body).toBe(UNREADABLE);
    expect(scanIMessage(p).unreadable).toBe(1);
  });

  it('does not call an attachment-only message unreadable', () => {
    // No text and no blob is an attachment. Empty is the truth there; counting it as a decode
    // failure would inflate the number that is supposed to mean "words we could not recover".
    const p = dbPath();
    writeChatDb(p, { messages: [{ ms: T, fromMe: false, text: null, attributedBody: null }] });
    expect(scanIMessage(p).unreadable).toBe(0);
    expect(attrs(collect(p)[0]).body).toBe('');
  });

  it('does not call a decodable-but-empty blob unreadable', () => {
    const p = dbPath();
    writeChatDb(p, {
      messages: [{ ms: T, fromMe: false, text: null, attributedBody: attributedBodyEmpty() }],
    });
    expect(attrs(collect(p)[0]).body).toBe(UNREADABLE);
    expect(scanIMessage(p).unreadable).toBe(1);
  });

  it('keeps an unsent message as a marker, so the gap is visible', () => {
    const p = dbPath();
    writeChatDb(p, {
      messages: [{ ms: T, fromMe: true, text: null, dateRetracted: 1 }],
    });
    expect(attrs(collect(p)[0]).body).toBe(UNSENT);
    expect(scanIMessage(p).unsent).toBe(1);
  });
});

describe('tapbacks ride the reaction model that already exists', () => {
  it('renders a tapback in the shape the classifier already recognises', () => {
    // iPhone→Android relays deliver these as literal SMS reading `Loved "…"`, and classify.ts has
    // read that shape since v0.1. Same path, one notion of what a reaction is.
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'dinner at eight' },
        { ms: T + 1000, fromMe: true, associatedMessageType: 2000, associatedGuid: 'SYN-0-' + T },
      ],
    });
    const recs = collect(p);
    expect(recs).toHaveLength(2);
    const reaction = classifyReaction(attrs(recs[1]).body);
    expect(reaction.isReaction).toBe(true);
    expect(reaction.kind).toBe('loved');
    expect(scanIMessage(p).tapbacks).toBe(1);
  });

  it('resolves the prefixed guid form Apple actually writes', () => {
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'the original' },
        { ms: T + 1000, fromMe: true, associatedMessageType: 2001, associatedGuid: `p:0/SYN-0-${T}` },
      ],
    });
    expect(attrs(collect(p)[1]).body).toContain('the original');
  });

  it('keeps the newer sticker and emoji tapbacks instead of dropping them', () => {
    // 2006 and 2007 are the sticker and any-emoji reactions (iOS 18+). They were not in the verb
    // table, so they fell through the `if (!verb) continue` written for REMOVALS and vanished — a
    // real event in the conversation, silently absent, on the newest archives the beta most wants.
    // Which emoji it was is not recoverable from the type, so the verb says only that they reacted.
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'the original' },
        { ms: T + 1000, fromMe: true, associatedMessageType: 2006, associatedGuid: `SYN-0-${T}` },
        { ms: T + 2000, fromMe: true, associatedMessageType: 2007, associatedGuid: `SYN-0-${T}` },
      ],
    });
    const recs = collect(p);
    expect(recs).toHaveLength(3);
    for (const rec of [recs[1], recs[2]]) {
      const body = attrs(rec).body;
      expect(body).toContain('the original');
      expect(classifyReaction(body).isReaction).toBe(true);
    }
  });

  it('resolves the bp: guid form as well as p:0/', () => {
    // The doc comment names both shapes; the code stripped a prefix only when it found a slash, so
    // `bp:<guid>` never resolved and the reaction recorded an empty quotation.
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'the original' },
        { ms: T + 1000, fromMe: true, associatedMessageType: 2000, associatedGuid: `bp:SYN-0-${T}` },
      ],
    });
    expect(attrs(collect(p)[1]).body).toContain('the original');
  });

  it('drops a tapback REMOVAL, which is the absence of a reaction, not a message', () => {
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'the original' },
        { ms: T + 1000, fromMe: true, associatedMessageType: 3000, associatedGuid: `SYN-0-${T}` },
      ],
    });
    expect(collect(p)).toHaveLength(1);
  });

  it('knows the tapback range', () => {
    expect(isTapback(1999)).toBe(false);
    expect(isTapback(2000)).toBe(true);
    expect(isTapback(3007)).toBe(true);
    expect(isTapback(3008)).toBe(false);
  });
});

describe('a real chat.db holds every conversation on the Mac', () => {
  // The defect this whole block exists for: participants were read database-wide, so `isGroup` was
  // true for any real file and the importer refused every archive it was built for — saying "group
  // chat" as the reason. Twenty-three tests passed because every fixture had exactly one chat.
  const twoPeople = () => {
    const p = dbPath();
    writeChatDb(p, {
      chatIdentifier: '+15550100',
      participants: ['+15550100'],
      messages: [{ ms: T, fromMe: false, text: 'from the partner' }],
      alsoChats: [{
        chatIdentifier: '+15550999',
        participants: ['+15550999'],
        messages: [{ ms: T + 60_000, fromMe: false, text: 'from the dentist' }],
      }],
    });
    return p;
  };

  it('does not call two one-to-one conversations a group', () => {
    const p = twoPeople();
    const scan = scanIMessage(p);
    expect(scan.conversations.sort()).toEqual(['+15550100', '+15550999']);
    expect(scan.isGroup).toBe(false);
  });

  it('asks which conversation instead of guessing, and names them', () => {
    const p = twoPeople();
    expect(() => collect(p)).toThrow(IMessageConversationRequired);
    try { collect(p); } catch (e) {
      expect((e as Error).message).toContain('+15550100');
      expect((e as Error).message).toContain('+15550999');
    }
  });

  it('can actually be imported end to end, which is what the flag it names is for', async () => {
    // parseIMessage took a `conversation` option, but ingestFile never passed one and no CLI flag
    // set it — so the refusal above fired for every real chat.db and told the reader to re-run with
    // `--conversation <id>`, which existed nowhere in the product. The importer the beta flag exists
    // to collect volunteer reports on could not read a single real file by any route.
    const p = twoPeople();
    const db = join(dir, `ingest-${seq++}.db`);
    const res = await ingestFile(p, {
      dbPath: db, region: 'US', importersBeta: true, conversation: '+15550100',
    });
    expect(res.messageRows).toBeGreaterThan(0);
    const store = openDb(db);
    try {
      const n = store.raw.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
      expect(n.n).toBe(1);
    } finally { store.close(); }
  });

  it('imports a SECOND conversation out of the same file', async () => {
    // A chat.db is imported one conversation at a time, and the skip-if-already-imported check was
    // keyed on the file's hash — so the first conversation went in and every later one reported
    // "alreadyImported", zero rows, exit 0, with no way to get the rest. The flag that finally made
    // a real chat.db importable would have made all but one of its conversations unreachable.
    const p = twoPeople();
    const db = join(dir, `both-${seq++}.db`);
    const first = await ingestFile(p, {
      dbPath: db, region: 'US', importersBeta: true, conversation: '+15550100',
    });
    const second = await ingestFile(p, {
      dbPath: db, region: 'US', importersBeta: true, conversation: '+15550999',
    });
    expect(first.messageRows).toBeGreaterThan(0);
    expect(second.alreadyImported).toBe(false);
    expect(second.messageRows).toBeGreaterThan(0);

    const store = openDb(db);
    try {
      const n = store.raw.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
      expect(n.n, 'both conversations, kept apart').toBe(2);
    } finally { store.close(); }
  });

  it('prefers an exact conversation identifier over a group that merely contains it', () => {
    // pickConversation tested identifier and handles in one pass, so the FIRST conversation
    // matching either won. Asking for a one-to-one chat by the identifier the refusal itself
    // printed could select a group that happens to include that person — and the import was then
    // refused for being a group, naming a conversation the reader did not ask for.
    const p = dbPath();
    writeChatDb(p, {
      chatIdentifier: 'chat-group', participants: ['+15550100', '+15550777'],
      messages: [{ ms: T, fromMe: false, text: 'in the group' }],
      alsoChats: [{
        chatIdentifier: '+15550100', participants: ['+15550100'],
        messages: [{ ms: T + 1000, fromMe: false, text: 'just us' }],
      }],
    });
    const scan = scanIMessage(p, '+15550100');
    expect(scan.isGroup, 'the one-to-one chat, not the group containing them').toBe(false);
    expect(scan.participants).toEqual(['+15550100']);
  });

  it('imports only the conversation asked for', () => {
    // The quiet half of the same defect: with the refusal bypassed, every message in the file was
    // attributed to one correspondent — another person's words filed under your partner's name and
    // quoted back as a receipt.
    const p = twoPeople();
    const out: RawRecord[] = [];
    parseIMessage(p, (r) => out.push(r), { conversation: '+15550100' });
    expect(out).toHaveLength(1);
    expect(attrs(out[0]).body).toBe('from the partner');
    expect(attrs(out[0]).address).toBe('+15550100');
  });

  it('treats one person reachable at two handles as one conversation, not a group', () => {
    // The ordinary iMessage case: a phone number and an Apple ID for the same person, which the
    // Mac stores as two chat rows.
    const p = dbPath();
    writeChatDb(p, {
      chatIdentifier: 'partner@example.com',
      participants: ['partner@example.com'],
      messages: [{ ms: T, fromMe: false, text: 'over apple id' }],
    });
    const scan = scanIMessage(p);
    expect(scan.isGroup).toBe(false);
    expect(scan.participants).toEqual(['partner@example.com']);
  });

  it('counts a message joined to two chat rows once', () => {
    const p = dbPath();
    writeChatDb(p, { messages: [{ ms: T, fromMe: false, text: 'once' }] });
    const db = new (require('better-sqlite3'))(p);
    // The same message relayed over SMS and iMessage is joined to both chats.
    db.prepare(`INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES ('SMS;-;+15550100;x', 45, '+15550100', 'SMS')`).run();
    const chat2 = db.prepare(`SELECT ROWID AS id FROM chat WHERE service_name = 'SMS'`).get() as { id: number };
    db.prepare(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, 1)`).run(chat2.id);
    db.prepare(`INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, 1, 0)`).run(chat2.id);
    db.close();

    expect(collect(p)).toHaveLength(1);
  });
});

describe('what it refuses', () => {
  it('refuses a group chat rather than putting the wrong people together', () => {
    const p = dbPath();
    writeChatDb(p, {
      participants: ['+15550100', '+15550111'],
      messages: [{ ms: T, fromMe: false, text: 'hello both' }],
    });
    expect(() => collect(p)).toThrow(IMessageGroupRefused);
    expect(scanIMessage(p).isGroup).toBe(true);
  });

  it('refuses the live Messages database', () => {
    // It is WAL-journaled and held open by another process; reading it underneath a running app can
    // block it or return a torn view, and a database this program does not own is not one it touches.
    // `/Users/you`, not a plausible name: publishedTree.test.ts scans every publishable file for a
    // real local path, and a privacy guard going red over a test fixture is how a privacy guard gets
    // widened or skipped.
    const live = join('C:', 'Users', 'you', 'Library', 'Messages', 'chat.db');
    expect(() => scanIMessage(live)).toThrow(IMessageLivePathRefused);
    expect(() => scanIMessage('/Users/you/Library/Messages/chat.db')).toThrow(IMessageLivePathRefused);

    // A relative path from inside the folder is the same file. The guard used to test the raw
    // argument string, so `cd ~/Library/Messages && ingest chat.db` walked straight through it.
    expect(() => scanIMessage(join('Library', 'Messages', 'chat.db'))).toThrow(IMessageLivePathRefused);
  });

  it('reads a copy that merely has a similar name', () => {
    const p = join(dir, 'chat.db-copy-for-between.db');
    writeChatDb(p, { messages: [{ ms: T, fromMe: false, text: 'from a copy' }] });
    expect(attrs(collect(p)[0]).body).toBe('from a copy');
  });
});

describe('the threading bug that shipped once already', () => {
  it('gives both directions the same correspondent', () => {
    // The WhatsApp importer put the message's AUTHOR in `address`, so a two-person conversation
    // imported as two threads and every per-thread number was computed over half a relationship.
    // Twenty-one tests passed while that was true.
    const p = dbPath();
    writeChatDb(p, {
      messages: [
        { ms: T, fromMe: false, text: 'theirs' },
        { ms: T + 60_000, fromMe: true, text: 'mine' },
      ],
    });
    const recs = collect(p);
    expect(attrs(recs[0]).address).toBe(attrs(recs[1]).address);
    expect(attrs(recs[0]).type).toBe('1');
    expect(attrs(recs[1]).type).toBe('2');
  });
});

describe('the decoder refuses what is not a typedstream', () => {
  it('returns null for arbitrary bytes rather than inventing strings', () => {
    expect(readTypedStreamStrings(Buffer.from('not a typedstream at all'))).toBeNull();
    expect(readTypedStreamStrings(Buffer.alloc(0))).toBeNull();
    expect(bodyFromAttributedBody(attributedBodyCorrupt())).toBeNull();
  });

  it('terminates on a blob whose declared lengths are nonsense', () => {
    // Hostile input: the file comes off someone else's disk and may be crafted. A reader that can
    // be made to spin is a denial of service against the person importing their own archive.
    const header = Buffer.concat([
      Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped', 'latin1'), Buffer.from([0x81, 0xE8, 0x03]),
    ]);
    const junk = Buffer.alloc(4096, 0x2B);            // every byte claims to introduce a string
    const out = readTypedStreamStrings(Buffer.concat([header, junk]));
    expect(Array.isArray(out)).toBe(true);
  });
});
