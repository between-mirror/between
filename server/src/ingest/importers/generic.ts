// Between — the generic normalized importer (CSV / JSON / JSONL).
//
// This one exists so that adding a format does not mean touching this repository at all. Anything a
// person can get into four columns — when, who, which direction, what was said — can be imported,
// which covers Telegram exports, Signal desktop dumps, a spreadsheet someone typed by hand, and the
// long tail of formats nobody here will ever have a fixture for.
//
// It emits the same RawRecord shape as every other importer, so the analytical core does not learn
// about it and cannot be broken by it.
//
// The columns, all case-insensitive, with common aliases:
//
//   timestamp | date | sent_at | time     ISO-8601, or epoch seconds/milliseconds
//   sender    | from | author | name      display name or number
//   direction | dir                       in/out, incoming/outgoing, sent/received, me/them, 0/1
//   body      | text | message | content  the words
//
// Direction may be omitted IF an owner name is given, in which case sender == owner means outgoing.
// One of the two must be present: without either, every message would be attributed to one side, and
// a one-sided archive is not a small error — it is the shape of a broken restore, and archive health
// will (correctly) flag the whole import as suspect.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { RawRecord } from '../../types';

export interface GenericOptions {
  /** When rows carry no direction column, the sender matching this name is the archive owner. */
  ownerName?: string;
}

export interface GenericScan {
  rows: number;
  skipped: number;
  senders: string[];
  /** Problems worth telling a person about, capped so a broken file does not print a novel. */
  problems: string[];
}

const FIELDS = {
  timestamp: ['timestamp', 'date', 'sent_at', 'sentat', 'time', 'datetime'],
  sender: ['sender', 'from', 'author', 'name', 'contact'],
  direction: ['direction', 'dir', 'type'],
  body: ['body', 'text', 'message', 'content'],
};

function pick(row: Record<string, unknown>, names: string[]): string | null {
  const lower = new Map(Object.entries(row).map(([k, v]) => [k.trim().toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n);
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

/**
 * Timestamps, in the three shapes a normalized export actually uses.
 *
 * Epoch seconds and epoch milliseconds are told apart by magnitude: a value below ~10^11 as
 * milliseconds would be 1973, and as seconds is a plausible date, so it is seconds. Getting this
 * wrong puts an entire archive in the wrong decade, which is obvious — the dangerous errors are the
 * ones that shift things by months, and that is why a bare ambiguous date is refused below.
 */
function toMs(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return n < 1e11 ? n * 1000 : n;
  }
  // Anything else must be unambiguous to Date.parse — which means ISO-8601 in practice. A bare
  // "01/02/2021" is refused rather than guessed at: day-first and month-first are both common, the
  // file does not say which, and a silent eleven-month shift corrupts every era and episode.
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(raw)) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const OUTGOING = new Set(['out', 'outgoing', 'sent', 'me', 'self', 'you', '2', 'true']);
const INCOMING = new Set(['in', 'incoming', 'received', 'them', 'other', '1', 'false']);

/**
 * A small, correct CSV reader: quoted fields, embedded commas, embedded newlines, and "" escapes.
 *
 * Splitting on commas would corrupt exactly the messages most worth reading — the long ones, with
 * punctuation in them — and would do it quietly.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }   // "" is a literal quote
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

function readRows(path: string, text: string): Record<string, unknown>[] {
  const lower = path.toLowerCase();

  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return parseCsv(text);

  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  // Tolerate the common wrapper shapes rather than making a person reshape their file by hand.
  for (const key of ['messages', 'data', 'items', 'rows']) {
    const v = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  throw new Error('JSON must be an array of messages, or an object with a messages/data/items/rows array.');
}

export function parseGeneric(
  path: string,
  onRecord: (rec: RawRecord) => void,
  opts: GenericOptions = {},
): GenericScan {
  const text = readFileSync(path, 'utf8');
  const rows = readRows(path, text);
  const problems: string[] = [];
  const senders = new Set<string>();
  let emitted = 0;
  let skipped = 0;
  let unnamed = 0;

  /**
   * The identity used when the file names nobody at all.
   *
   * A file carrying only timestamp / direction / body is a shape this importer accepts, and it
   * leaves the people in it unnamed. The fallback used to be the literal strings 'owner' and
   * 'other', which are the same two strings in EVERY such file — so two unrelated people's exports
   * resolved to the same participants and merged into one thread, split by direction rather than by
   * person. Two strangers' histories became one relationship, and every number computed over it was
   * computed over both.
   *
   * Scoping the identity to the file's own contents fixes both halves. It is derived from the bytes,
   * so re-importing the same export converges exactly as before; it differs between files, so two
   * exports never silently become one conversation. And it is ONE identity per file rather than one
   * per direction, because the counterpart in a two-party conversation is the same person whichever
   * way a given message went.
   *
   * What this deliberately does not do is abort. The previous release refused these files outright
   * (by accident — a UNIQUE constraint, not a check), and refusing is not better than importing a
   * conversation whose participant nobody named.
   */
  const scope = `unnamed:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

  // The correspondent, decided once for the whole file. Threading is by who the conversation is WITH,
  // not by who wrote each line — putting the author in `address` splits one conversation into one
  // thread per person, and every per-thread number is then computed over half of it.
  //
  // Two passes, because the correspondent cannot be known until every sender has been seen.
  const noteEarly = (m: string): void => { if (problems.length < 10) problems.push(m); };
  const allSenders = new Set<string>();
  for (const r of rows) { const s = pick(r, FIELDS.sender); if (s) allSenders.add(s); }
  const others = [...allSenders].filter((s) => s !== opts.ownerName);
  const correspondent = others.length === 1 ? others[0] : null;
  if (others.length > 1) {
    noteEarly(`${others.length} other participants (${others.slice(0, 4).join(', ')}…) — messages will be `
      + 'threaded per person. A group conversation needs a participant set, which this format cannot express.');
  }

  const note = (msg: string): void => { if (problems.length < 10) problems.push(msg); };

  rows.forEach((row, i) => {
    const rawTs = pick(row, FIELDS.timestamp);
    const sender = pick(row, FIELDS.sender);
    const body = pick(row, FIELDS.body) ?? '';
    const dirRaw = pick(row, FIELDS.direction);

    if (!rawTs) { skipped++; note(`row ${i + 2}: no timestamp column`); return; }
    const ms = toMs(rawTs);
    if (ms == null) {
      skipped++;
      note(`row ${i + 2}: "${rawTs}" is not an unambiguous timestamp — use ISO-8601 (2021-12-25T22:30:00Z) or epoch`);
      return;
    }

    let outgoing: boolean | null = null;
    if (dirRaw) {
      const d = dirRaw.toLowerCase();
      if (OUTGOING.has(d)) outgoing = true;
      else if (INCOMING.has(d)) outgoing = false;
      else { skipped++; note(`row ${i + 2}: direction "${dirRaw}" not understood`); return; }
    } else if (opts.ownerName && sender) {
      outgoing = sender === opts.ownerName;
    } else {
      skipped++;
      note(`row ${i + 2}: no direction column and no ownerName given — cannot tell who sent this`);
      return;
    }

    if (sender) senders.add(sender);
    if (!correspondent && !sender) unnamed++;
    onRecord({
      kind: 'sms',
      attrs: {
        type: outgoing ? '2' : '1',
        date: String(ms),
        address: correspondent ?? sender ?? scope,
        contact_name: correspondent ?? sender ?? '',
        body,
        read: '1',
      },
    });
    emitted++;
  });

  if (unnamed > 0) {
    note(`${unnamed} rows name no sender, so this file's conversation is identified by the file `
      + 'itself. It will not merge with another export of the same conversation — add a sender '
      + 'column if you want them to converge.');
  }

  return { rows: emitted, skipped, senders: [...senders].sort(), problems };
}
