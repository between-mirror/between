// Between — WhatsApp exported-chat importer.
//
// Emits the same RawRecord shape the SMS Backup & Restore parser emits, so everything downstream —
// normalize, identity resolution, threading, dedup, and every lens — is untouched. A new format is a
// new parser and nothing else; that is the whole point of putting it here rather than in the core.
//
// WhatsApp's export is a plain text file, and its format varies by phone locale in three ways that
// all matter:
//
//   [25/12/2021, 22:30:45] Alice: hello        ← bracketed, 24-hour, day-first
//   12/25/21, 10:30 PM - Alice: hello          ← dashed, 12-hour, month-first
//   [12/25/21, 10:30:45 PM] Alice: hello       ← bracketed, 12-hour, month-first
//
// Day-first versus month-first cannot be decided from a single line, and getting it wrong silently
// shifts an entire archive by up to eleven months — every era, every episode, every "what were we
// doing that spring" answer quietly wrong. So the order is INFERRED ACROSS THE WHOLE FILE (any first
// component above 12 proves day-first) and, when the file is genuinely ambiguous, the caller is told
// rather than guessed at.
//
// The other thing an export does not contain is who "you" are. There is no marker: your own messages
// look exactly like everyone else's, labelled with your own display name. Guessing would attribute
// half a relationship to the wrong person, so the owner's name is required, and when it is missing
// the parser reports the participants it found so the caller can ask.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import type { RawRecord } from '../../types';

export interface WhatsAppOptions {
  /** The display name WhatsApp used for the archive's owner. Required: it cannot be inferred. */
  ownerName?: string;
  /**
   * Force date interpretation when the file is ambiguous. Omit to infer.
   * 'dmy' = 25/12/2021, 'mdy' = 12/25/2021.
   */
  dateOrder?: 'dmy' | 'mdy';
}

export interface WhatsAppScan {
  participants: string[];
  messages: number;
  /** What the parser concluded about date order, and whether the file actually proved it. */
  dateOrder: 'dmy' | 'mdy';
  dateOrderProven: boolean;
  /** Lines that carried no sender — joins, encryption notices, "you were added". */
  systemLines: number;
  /** Messages whose body was a media placeholder rather than text. */
  mediaPlaceholders: number;
}

export class WhatsAppOwnerUnknown extends Error {
  constructor(public readonly participants: string[]) {
    super(
      `Cannot tell which participant is you. Pass ownerName as one of: ${participants.join(', ')}. `
      + 'A WhatsApp export contains no marker for the archive owner, and guessing would attribute '
      + 'half the conversation to the wrong person.',
    );
    this.name = 'WhatsAppOwnerUnknown';
  }
}

// A message line: an optional '[', the date, the time, an optional ']' or ' - ', then 'Sender: body'.
// Deliberately permissive about separators and strict about the shape, because a continuation line of
// a multi-line message must NOT match — it is body text and belongs to the message above it.
const LINE = new RegExp(
  '^\\u200e?\\[?'                                   // some exports prefix a LTR mark
  + '(\\d{1,4})[\\/.-](\\d{1,2})[\\/.-](\\d{2,4})'  // date, order undecided
  + ',?\\s+'
  + '(\\d{1,2}):(\\d{2})(?::(\\d{2}))?'             // time, seconds optional
  + '\\s*([APap][Mm]?\\.?[Mm]?)?'                   // AM/PM, optional
  + '\\s*\\]?\\s*(?:-\\s*)?'                        // ']' or ' - '
  + '(.*)$',                                        // remainder: "Sender: body" or a system notice
);

/** WhatsApp's media placeholders, across the locales that ship English strings. */
const MEDIA = /^(<Media omitted>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|GIF omitted|Contact card omitted)$/i;

interface Line {
  d1: number; d2: number; year: number;
  hour: number; minute: number; second: number;
  meridiem: string | null;
  rest: string;
}

function parseLines(text: string): { lines: Line[]; continuations: Map<number, string[]> } {
  const lines: Line[] = [];
  const continuations = new Map<number, string[]>();
  // Normalise newlines and strip the BOM some exports carry, or the very first message is lost.
  for (const raw of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const m = LINE.exec(raw);
    if (!m) {
      // A continuation of the previous message. Blank trailing lines are dropped; interior ones are
      // kept, because a paragraph break inside a message is part of what was said.
      if (lines.length > 0) {
        const idx = lines.length - 1;
        const arr = continuations.get(idx) ?? [];
        arr.push(raw);
        continuations.set(idx, arr);
      }
      continue;
    }
    lines.push({
      d1: Number(m[1]), d2: Number(m[2]), year: Number(m[3]),
      hour: Number(m[4]), minute: Number(m[5]), second: m[6] ? Number(m[6]) : 0,
      meridiem: m[7] ? m[7][0].toLowerCase() : null,
      rest: m[8] ?? '',
    });
  }
  return { lines, continuations };
}

/**
 * Decide day-first versus month-first across the WHOLE file.
 *
 * Any first component above 12 can only be a day, and any second component above 12 can only be a
 * month — one such line settles it for every other line. A file where neither ever exceeds 12 is
 * genuinely ambiguous (it happens: a short export inside one fortnight), and rather than silently
 * picking one, the caller is told the choice was not proven.
 */
function inferDateOrder(lines: Line[]): { order: 'dmy' | 'mdy'; proven: boolean } {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const l of lines) {
    if (l.d1 > 12) dayFirst++;
    if (l.d2 > 12) monthFirst++;
  }
  if (dayFirst > 0 && monthFirst === 0) return { order: 'dmy', proven: true };
  if (monthFirst > 0 && dayFirst === 0) return { order: 'mdy', proven: true };
  // Both, which means the file is internally inconsistent — or neither, which means it is short.
  // Day-first is the majority of the world and of WhatsApp's locales; it is a default, not a finding.
  return { order: 'dmy', proven: false };
}

function toMs(l: Line, order: 'dmy' | 'mdy'): number {
  const day = order === 'dmy' ? l.d1 : l.d2;
  const month = order === 'dmy' ? l.d2 : l.d1;
  const year = l.year < 100 ? 2000 + l.year : l.year;
  let hour = l.hour;
  if (l.meridiem === 'p' && hour < 12) hour += 12;
  if (l.meridiem === 'a' && hour === 12) hour = 0;
  // Local wall-clock time, read as UTC. The export carries no zone, and inventing one would shift
  // every hour-of-day statistic; archive health reports the offset as an assumption for this reason.
  return Date.UTC(year, month - 1, day, hour, l.minute, l.second);
}

/** Split "Sender: body" — only on the FIRST colon, since bodies contain colons constantly. */
function splitSender(rest: string): { sender: string; body: string } | null {
  const i = rest.indexOf(': ');
  if (i <= 0) return null;                 // a system notice: no sender
  const sender = rest.slice(0, i).trim();
  // A "sender" containing sentence punctuation is really a system line that happens to hold a colon
  // ("Messages to this chat and calls are now secured with end-to-end encryption: tap to learn more").
  if (!sender || sender.length > 60 || /[.!?]$/.test(sender)) return null;
  return { sender, body: rest.slice(i + 2) };
}

/** Read the single .txt out of a WhatsApp export, whether it arrives as .txt or .zip. */
export function readExport(path: string): string {
  if (!path.toLowerCase().endsWith('.zip')) return readFileSync(path, 'utf8');

  // A minimal ZIP reader rather than a dependency. A privacy-first program should not take on a
  // supply-chain risk to unpack a file format that node's own zlib already handles; WhatsApp exports
  // are stored (0) or deflated (8) and nothing else.
  const buf = readFileSync(path);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a ZIP file (no end-of-central-directory record).');
  const entries = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entries; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('Malformed ZIP central directory.');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (name.toLowerCase().endsWith('.txt')) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return raw.toString('utf8');
      if (method === 8) return inflateRawSync(raw).toString('utf8');
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('No .txt chat export found inside the ZIP.');
}

/** Participants and shape, without importing anything — so a caller can ask "which one is you?". */
export function scanWhatsApp(path: string, opts: WhatsAppOptions = {}): WhatsAppScan {
  const { lines } = parseLines(readExport(path));
  const inferred = inferDateOrder(lines);
  const order = opts.dateOrder ?? inferred.order;

  const participants = new Set<string>();
  let system = 0;
  let media = 0;
  for (const l of lines) {
    const s = splitSender(l.rest);
    if (!s) { system++; continue; }
    participants.add(s.sender);
    if (MEDIA.test(s.body.trim())) media++;
  }
  return {
    participants: [...participants].sort(),
    messages: lines.length - system,
    dateOrder: order,
    dateOrderProven: opts.dateOrder ? true : inferred.proven,
    systemLines: system,
    mediaPlaceholders: media,
  };
}

/**
 * Parse a WhatsApp export into RawRecords.
 *
 * @throws WhatsAppOwnerUnknown when ownerName is absent — see the note at the top of this file.
 */
export function parseWhatsApp(
  path: string,
  onRecord: (rec: RawRecord) => void,
  opts: WhatsAppOptions = {},
): WhatsAppScan {
  const text = readExport(path);
  const { lines, continuations } = parseLines(text);
  const scan = scanWhatsApp(path, opts);

  if (!opts.ownerName) throw new WhatsAppOwnerUnknown(scan.participants);
  if (!scan.participants.includes(opts.ownerName)) {
    throw new WhatsAppOwnerUnknown(scan.participants);
  }

  const order = opts.dateOrder ?? scan.dateOrder;

  // Threading is by CORRESPONDENT, not by author. The SMS convention the normalizer reads puts the
  // other party in `address` for both directions — so using the sender there split a single 1:1
  // conversation into two threads, one per person, and every per-thread number downstream would have
  // been computed over half a relationship.
  const others = scan.participants.filter((p) => p !== opts.ownerName);
  if (others.length > 1) {
    // A group export threads by a participant SET, which a flat "address" cannot express, and a wrong
    // thread structure corrupts every count built on it. Refused rather than imported approximately.
    throw new Error(
      `This looks like a group chat (${others.length} other participants: ${others.join(', ')}). `
      + 'Group exports are not supported yet: threading them correctly needs a participant set, not a '
      + 'single correspondent, and importing them approximately would put the wrong people in the '
      + 'wrong conversation. One-to-one exports work today.',
    );
  }
  const correspondent = others[0] ?? opts.ownerName;

  lines.forEach((l, i) => {
    const s = splitSender(l.rest);
    if (!s) return;                                  // system notice: never a message

    const extra = continuations.get(i);
    const body = extra && extra.length
      ? [s.body, ...extra].join('\n').replace(/\n+$/, '')
      : s.body;

    const mine = s.sender === opts.ownerName;
    onRecord({
      kind: 'sms',
      attrs: {
        // 2 = sent, 1 = inbox, matching the SMS Backup & Restore convention the normalizer reads.
        type: mine ? '2' : '1',
        date: String(toMs(l, order)),
        // The correspondent, not the author — see the note above. A display name is the only
        // identifier an export carries (there are no numbers), and it flows through identity
        // resolution the same way a number does.
        address: correspondent,
        contact_name: correspondent,
        body: MEDIA.test(body.trim()) ? '' : body,
        read: '1',
      },
    });
  });

  return scan;
}
