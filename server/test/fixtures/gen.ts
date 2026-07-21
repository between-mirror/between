// Between — synthetic SMS Backup & Restore XML generator (TESTING §1).
//
// Produces VALID SMS Backup & Restore (SyncTech) XML from a deterministic manifest,
// with ground-truth counts computed BY CONSTRUCTION (counted as records are emitted).
// This is the SOLE source of test fixtures — no real personal data ever appears here.
// All phone numbers live in the fictional 555-0100..555-0199 range (+1 555 555 01xx).
// Speakers are ME (owner) and THEM (the contacts).
//
// Determinism: a tiny mulberry32 PRNG seeded from spec.seed drives every "random"
// choice; timestamps derive from a fixed base epoch + deterministic increments.
// Nothing here calls Math.random or Date.now.
import { writeFileSync } from 'node:fs';
import type { ReactionKind } from '../../src/types';

// ── seeded PRNG (mulberry32) ────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── manifest types ──────────────────────────────────────────────────────────
export type AddressFormat = 'bare10' | 'e164' | 'dashed' | 'spaced';

export interface FixtureContact {
  name: string;
  addressFormat: AddressFormat;
  /** Give this person a SECOND number (same-person-two-numbers ground truth). */
  secondNumber?: boolean;
  secondFormat?: AddressFormat;
}

/** Toggles for planted features. Each emits a fixed, known set of records. */
export interface FixtureFeatures {
  basicSmsMms?: boolean;
  /**
   * Emit this many ordinary conversational messages, on top of whatever else is planted.
   *
   * For measuring behaviour at a size no hand-written fixture reaches. The demo archive is 787
   * messages; a real multi-year archive is tens of thousands, and an endpoint that is comfortable at
   * 787 can still be unusable at 50,000. Deterministic like everything else here: same seed, same
   * archive, byte for byte.
   *
   * The traffic is deliberately not uniform — it alternates speakers, drifts across days, and mixes
   * warm, neutral and hostile registers, so the episode clusterer has real work to do rather than one
   * undifferentiated run it can dismiss cheaply.
   */
  bulkMessages?: number;
  duplicatesAcrossFiles?: boolean;
  groupMms?: boolean;
  oneToOneMmsNoAddrs?: boolean;
  oversizedPart?: boolean;
  allTapbacks?: boolean;
  nonEnglishRun?: boolean;
  coverageHole?: boolean;
  emojiEntityTorture?: boolean;
  draftOutboxFailed?: boolean;
  samePersonTwoNumbers?: boolean;
  /** Emit a deliberately-wrong declared <smses count>. (T0.5 warns, not fails.) */
  wrongDeclaredCount?: boolean;
}

export interface FixtureSpec {
  seed: number;
  /** Owner's 4-digit line within 0100..0199 (e.g. "0100"). Defaults to "0100". */
  ownerLine?: string;
  ownerName?: string;
  region?: string;
  contacts: FixtureContact[];
  features: FixtureFeatures;
}

// ── expected (ground-truth) types ───────────────────────────────────────────
export interface FixtureFileExpected {
  label: string;
  xml: string;
  smsCount: number;
  mmsCount: number;
  totalRecords: number;
  reactionCount: number;
  declaredCount: number;
}

export interface FixtureExpected {
  smsCount: number; // <sms> elements in the primary xml
  mmsCount: number; // <mms> elements in the primary xml
  totalRecords: number; // sms + mms in the primary xml
  reactionCount: number; // reaction sms in the primary xml
  contacts: number; // distinct non-owner people that appear
  [k: string]: unknown;
}

export interface BuiltFixture {
  xml: string;
  expected: FixtureExpected;
}

// ── constants ───────────────────────────────────────────────────────────────
const AREA = '555';
const PREFIX = '555';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2019, 0, 1, 9, 0, 0); // 2019-01-01 09:00 UTC
const OVERSIZE_CHARS = 5 * 1024 * 1024 + 64; // > 5 MB single base64 attribute
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// verb (as it arrives in the SMS body) → normalized ReactionKind
export const REACTION_VERBS: ReadonlyArray<readonly [string, ReactionKind]> = [
  ['Liked', 'liked'],
  ['Loved', 'loved'],
  ['Emphasized', 'emphasized'],
  ['Laughed at', 'laughed'],
  ['Disliked', 'disliked'],
  ['Questioned', 'questioned'],
];

// ── small helpers ───────────────────────────────────────────────────────────
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
function tenDigits(line4: string): string {
  return AREA + PREFIX + line4; // e.g. "555" + "555" + "0101" = "5555550101"
}
function formatAddress(line4: string, fmt: AddressFormat): string {
  const ten = tenDigits(line4);
  switch (fmt) {
    case 'bare10':
      return ten;
    case 'e164':
      return '+1' + ten;
    case 'dashed':
      return `${AREA}-${PREFIX}-${line4}`;
    case 'spaced':
      return `${AREA} ${PREFIX} ${line4}`;
  }
}
// Escape for a double-quoted XML attribute value. (Single quotes are safe inside "..".)
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function readableDate(ms: number): string {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${p2(h12)}:${p2(
    d.getUTCMinutes(),
  )}:${p2(d.getUTCSeconds())} ${ampm}`;
}
// Deterministic base64-alphabet blob of exactly `n` chars (no XML-special chars).
function makeBase64(n: number): string {
  const block = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const reps = Math.ceil(n / block.length);
  return block.repeat(reps).slice(0, n);
}

// ── record field shapes ─────────────────────────────────────────────────────
interface SmsFields {
  address: string;
  date: number;
  type: number; // 1=recv 2=sent 3=draft 4=outbox 5=failed 6=queued
  body: string | null; // decoded text; null => literal "null"
  rawBodyXml?: string; // verbatim body attribute value (entity/torture path)
  read?: number;
  dateSent?: number;
  status?: number;
  contactName?: string | null;
}
interface PartSpec {
  seq: number;
  ct: string;
  cl?: string;
  cid?: string;
  name?: string;
  chset?: string;
  text?: string | null;
  rawTextXml?: string;
  data?: string; // base64 media
}
interface AddrSpec {
  address: string;
  type: number; // 137=from 151=to 130=cc 129=bcc
}
interface MmsFields {
  address: string; // envelope address (~-joined for groups)
  date: number;
  msgBox: number; // 1=in 2=out 3=draft 4=outbox
  mType: number; // 128=out 132=in
  mId?: string | null;
  read?: number;
  dateSent?: number;
  contactName?: string | null;
  textOnly?: number;
  parts: PartSpec[];
  addrs?: AddrSpec[]; // omitted => no <addrs> block (1:1 fallback)
}

// ── renderers (pure — identical fields ⇒ byte-identical output) ─────────────
function renderSms(f: SmsFields): string {
  const bodyVal =
    f.rawBodyXml !== undefined ? f.rawBodyXml : f.body === null ? 'null' : escapeXml(f.body);
  const cn = f.contactName == null ? 'null' : escapeXml(f.contactName);
  const read = f.read ?? 1;
  const status = f.status ?? -1;
  const dateSent = f.dateSent ?? 0;
  return (
    `  <sms protocol="0" address="${escapeXml(f.address)}" date="${f.date}" type="${f.type}"` +
    ` subject="null" body="${bodyVal}" toa="null" sc_toa="null" service_center="null"` +
    ` read="${read}" status="${status}" locked="0" date_sent="${dateSent}" sub_id="1"` +
    ` readable_date="${escapeXml(readableDate(f.date))}" contact_name="${cn}" />`
  );
}

function renderPart(p: PartSpec): string {
  const chset = p.chset ?? (p.ct.startsWith('text/') ? '106' : 'null');
  const cl = p.cl ?? 'null';
  const cid = p.cid ?? 'null';
  const name = p.name ?? 'null';
  const textVal =
    p.rawTextXml !== undefined ? p.rawTextXml : p.text == null ? 'null' : escapeXml(p.text);
  let s =
    `    <part seq="${p.seq}" ct="${escapeXml(p.ct)}" name="${escapeXml(name)}" chset="${chset}"` +
    ` cd="null" fn="null" cid="${escapeXml(cid)}" cl="${escapeXml(cl)}" ctt_s="null" ctt_t="null"` +
    ` text="${textVal}"`;
  if (p.data !== undefined) s += ` data="${p.data}"`;
  s += ` />`;
  return s;
}

function renderAddr(a: AddrSpec): string {
  return `    <addr address="${escapeXml(a.address)}" type="${a.type}" charset="106" />`;
}

function renderMms(f: MmsFields): string {
  const cn = f.contactName == null ? 'null' : escapeXml(f.contactName);
  const read = f.read ?? 1;
  const dateSent = f.dateSent ?? 0;
  const mId = f.mId == null ? 'null' : escapeXml(f.mId);
  const mSize = f.parts.reduce((n, p) => n + (p.data?.length ?? p.text?.length ?? 0), 0);
  const out: string[] = [];
  out.push(
    `  <mms date="${f.date}" ct_t="application/vnd.wap.multipart.related" msg_box="${f.msgBox}"` +
      ` rr="null" sub="null" read_status="null" address="${escapeXml(f.address)}" m_id="${mId}"` +
      ` read="${read}" m_size="${mSize}" m_type="${f.mType}" sub_id="1" date_sent="${dateSent}"` +
      ` readable_date="${escapeXml(readableDate(f.date))}" contact_name="${cn}" seen="1"` +
      ` text_only="${f.textOnly ?? 0}">`,
  );
  out.push(`   <parts>`);
  for (const p of f.parts) out.push(renderPart(p));
  out.push(`   </parts>`);
  if (f.addrs) {
    out.push(`   <addrs>`);
    for (const a of f.addrs) out.push(renderAddr(a));
    out.push(`   </addrs>`);
  }
  out.push(`  </mms>`);
  return out.join('\n');
}

// Standard SMIL part (seq=-1) whose text is nested XML (escaped by renderPart).
function smilPart(refs: string[]): PartSpec {
  const body =
    `<smil><head><layout><root-layout/></layout></head><body>` +
    refs.map((r) => `<par dur="5000ms"><text src="${r}" region="Text" /></par>`).join('') +
    `</body></smil>`;
  return { seq: -1, ct: 'application/smil', cl: 'smil.xml', cid: '<smil>', name: 'smil.xml', text: body, chset: 'null' };
}

// ── resolved contact + per-file accumulator ─────────────────────────────────
interface ResolvedContact {
  index: number;
  name: string;
  line4: string;
  format: AddressFormat;
  address: string;
  secondLine4?: string;
  secondFormat?: AddressFormat;
  secondAddress?: string;
}
interface FileAcc {
  label: string;
  records: string[];
  sms: number;
  mms: number;
  reaction: number;
  dates: number[];
  declaredOverride?: number;
}

// ── the builder ─────────────────────────────────────────────────────────────
class Builder {
  private rng: () => number;
  private spec: FixtureSpec;
  private contacts: ResolvedContact[] = [];
  private lineCounter = 101; // contact primary lines: 0101..
  private secondCounter = 150; // second numbers: 0150..
  private files = new Map<string, FileAcc>();
  private touchedContacts = new Set<number>();
  private addresses = new Set<string>();
  private midCounter = 1;
  private fclock = BASE;
  private meta: Record<string, unknown> = {};
  owner: ResolvedContact;
  backupSet: string;

  constructor(spec: FixtureSpec) {
    this.spec = spec;
    this.rng = mulberry32(spec.seed);
    const ownerLine = spec.ownerLine ?? '0100';
    this.owner = {
      index: -1,
      name: spec.ownerName ?? 'Me',
      line4: ownerLine,
      format: 'e164',
      address: formatAddress(ownerLine, 'e164'),
    };
    this.backupSet = (Math.imul(spec.seed ^ 0x9e3779b9, 2654435761) >>> 0).toString(16).padStart(8, '0');
    this.file('main'); // primary file always exists
  }

  private file(label: string): FileAcc {
    let f = this.files.get(label);
    if (!f) {
      f = { label, records: [], sms: 0, mms: 0, reaction: 0, dates: [] };
      this.files.set(label, f);
    }
    return f;
  }

  private jitter(max = 30_000): number {
    return Math.floor(this.rng() * max);
  }
  private featureBase(): number {
    const b = this.fclock;
    this.fclock += 60 * DAY;
    return b;
  }
  private nextMid(): string {
    return `mid-${this.spec.seed}-${this.midCounter++}`;
  }

  ensureContact(i: number): ResolvedContact {
    while (this.contacts.length <= i) {
      const idx = this.contacts.length;
      const src = this.spec.contacts[idx];
      const name = src?.name ?? `Person${idx + 1}`;
      const format = src?.addressFormat ?? (['bare10', 'e164', 'dashed', 'spaced'] as AddressFormat[])[idx % 4];
      const line4 = pad4(this.lineCounter++);
      const c: ResolvedContact = { index: idx, name, line4, format, address: formatAddress(line4, format) };
      if (src?.secondNumber) this.assignSecond(c, src.secondFormat);
      this.contacts.push(c);
    }
    return this.contacts[i];
  }
  private assignSecond(c: ResolvedContact, fmt?: AddressFormat): void {
    if (c.secondAddress) return;
    const s4 = pad4(this.secondCounter++);
    c.secondLine4 = s4;
    c.secondFormat = fmt ?? 'bare10';
    c.secondAddress = formatAddress(s4, c.secondFormat);
  }
  private touch(c: ResolvedContact): void {
    this.touchedContacts.add(c.index);
    this.addresses.add(c.address);
  }

  private pushSms(file: FileAcc, f: SmsFields, isReaction = false): void {
    file.records.push(renderSms(f));
    file.sms++;
    file.dates.push(f.date);
    if (isReaction) file.reaction++;
  }
  private pushMms(file: FileAcc, f: MmsFields): void {
    file.records.push(renderMms(f));
    file.mms++;
    file.dates.push(f.date);
  }

  // ── feature emitters ──────────────────────────────────────────────────────
  /**
   * N ordinary messages between the owner and the first contact, spread across real calendar time.
   * Bodies come from fixed registers chosen by the seeded PRNG, so the archive is reproducible and
   * contains genuine hostile clusters with repairs after them — the shape the episode lens looks for.
   */
  private emitBulk(n: number): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);

    const WARM = [
      'thinking about you today', 'that made me laugh, thank you', 'miss you',
      'proud of you for that', 'safe travels, text me when you land', 'love you',
    ];
    const NEUTRAL = [
      'can you grab milk on the way home', 'running late, maybe 20 min',
      'what time is the thing tomorrow', 'ok', 'sounds good', 'call me when you can',
      'did you see the mail came', 'im at the store, need anything',
    ];
    const HOSTILE = [
      'you always do this', 'i cant talk to you when youre like this',
      'thats not what i said and you know it', 'forget it, im done',
      'you never listen to a word i say', 'dont bother',
    ];
    const REPAIR = [
      'im sorry, that came out wrong', 'i didnt mean that', 'can we start over',
      'youre right, i was being unfair',
    ];

    let t = this.featureBase();
    for (let i = 0; i < n; i++) {
      const r = this.rng();
      // ~8% of messages sit inside a hostile burst; a repair usually follows one.
      const inBurst = (i % 137) < 11;
      const pool = inBurst
        ? (r < 0.8 ? HOSTILE : REPAIR)
        : (r < 0.25 ? WARM : NEUTRAL);
      const body = pool[Math.floor(this.rng() * pool.length)];
      this.pushSms(main, {
        address: c0.address,
        contactName: c0.name,
        type: i % 2 === 0 ? 2 : 1,
        body,
        date: t,
        read: 1,
      });
      // Bursts are minutes apart; ordinary traffic spreads over hours, so the archive covers years.
      t += (inBurst ? 2 * MIN : 3 * HOUR) + this.jitter();
    }
  }

  private emitBasic(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    const c1 = this.ensureContact(1);
    this.touch(c0);
    this.touch(c1);

    let t = this.featureBase();
    const bodies0 = [
      'Morning! Are we still on for later?',
      'Yes, see you at the usual spot.',
      'Bringing the photos I mentioned.',
      'Perfect, looking forward to it.',
      'Running about five minutes behind.',
      'No worries at all, take your time.',
    ];
    bodies0.forEach((b, i) => {
      const outgoing = i % 2 === 0;
      this.pushSms(main, {
        address: c0.address,
        contactName: c0.name,
        type: outgoing ? 2 : 1,
        body: b,
        date: t,
        read: 1,
      });
      t += 7 * MIN + this.jitter();
    });
    // outgoing 1:1 MMS with a text part, a small image, a SMIL part, and <addrs>
    this.pushMms(main, {
      address: c0.address,
      date: t,
      msgBox: 2,
      mType: 128,
      mId: this.nextMid(),
      contactName: c0.name,
      parts: [
        smilPart(['text_0.txt', 'image_0.jpg']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Here is the picture from Saturday.' },
        { seq: 1, ct: 'image/jpeg', cl: 'image_0.jpg', cid: '<image_0>', name: 'image_0.jpg', data: makeBase64(2048) },
      ],
      addrs: [
        { address: this.owner.address, type: 137 },
        { address: c0.address, type: 151 },
      ],
    });
    t += 3 * HOUR;

    let t1 = this.featureBase();
    const bodies1 = [
      'Did the package arrive yet?',
      'It did, thanks for checking in.',
      'Great, let me know how it works out.',
      'Will do, talk soon.',
    ];
    bodies1.forEach((b, i) => {
      const outgoing = i % 2 === 0;
      this.pushSms(main, {
        address: c1.address,
        contactName: c1.name,
        type: outgoing ? 2 : 1,
        body: b,
        date: t1,
        read: 1,
      });
      t1 += 11 * MIN + this.jitter();
    });
    // incoming 1:1 MMS, text-only, with <addrs>
    this.pushMms(main, {
      address: c1.address,
      date: t1,
      msgBox: 1,
      mType: 132,
      mId: this.nextMid(),
      contactName: c1.name,
      textOnly: 1,
      parts: [
        smilPart(['text_0.txt']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Sharing the note we talked about.' },
      ],
      addrs: [
        { address: c1.address, type: 137 },
        { address: this.owner.address, type: 151 },
      ],
    });
  }

  private emitGroupMms(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    const c1 = this.ensureContact(1);
    const c2 = this.ensureContact(2);
    [c0, c1, c2].forEach((c) => this.touch(c));
    let t = this.featureBase();

    const groupAddr = `${c0.address}~${c1.address}~${c2.address}`;
    // incoming group MMS: sender=c0(137), owner(151), c1(151), c2(130 cc)
    this.pushMms(main, {
      address: groupAddr,
      date: t,
      msgBox: 1,
      mType: 132,
      mId: this.nextMid(),
      contactName: c0.name,
      textOnly: 1,
      parts: [
        smilPart(['text_0.txt']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Are we all set for the weekend plan?' },
      ],
      addrs: [
        { address: c0.address, type: 137 },
        { address: this.owner.address, type: 151 },
        { address: c1.address, type: 151 },
        { address: c2.address, type: 130 },
      ],
    });
    t += 4 * HOUR;
    // outgoing group MMS: sender=owner(137), c0(151), c1(151), small image
    this.pushMms(main, {
      address: `${c0.address}~${c1.address}`,
      date: t,
      msgBox: 2,
      mType: 128,
      mId: this.nextMid(),
      contactName: 'null',
      parts: [
        smilPart(['text_0.txt', 'image_0.jpg']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Sounds good, here is the map.' },
        { seq: 1, ct: 'image/jpeg', cl: 'image_0.jpg', cid: '<image_0>', name: 'image_0.jpg', data: makeBase64(1536) },
      ],
      addrs: [
        { address: this.owner.address, type: 137 },
        { address: c0.address, type: 151 },
        { address: c1.address, type: 151 },
      ],
    });

    this.meta.groupMms = {
      count: 2,
      participants: [c0.address, c1.address, c2.address],
      ownerAddress: this.owner.address,
      roles: { from: 137, to: 151, cc: 130 },
      groupEnvelope: groupAddr,
    };
  }

  private emitOneToOneMmsNoAddrs(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();
    // incoming, multi-part text (ordered concat), NO <addrs>
    this.pushMms(main, {
      address: c0.address,
      date: t,
      msgBox: 1,
      mType: 132,
      mId: this.nextMid(),
      contactName: c0.name,
      textOnly: 1,
      parts: [
        smilPart(['text_0.txt', 'text_1.txt']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'First half of the message. ' },
        { seq: 1, ct: 'text/plain', cl: 'text_1.txt', cid: '<text_1>', text: 'Second half of the message.' },
      ],
      // no addrs -> downstream must fall back to envelope address
    });
    t += 2 * HOUR;
    // outgoing, image + text, NO <addrs>
    this.pushMms(main, {
      address: c0.address,
      date: t,
      msgBox: 2,
      mType: 128,
      mId: this.nextMid(),
      contactName: c0.name,
      parts: [
        smilPart(['text_0.txt', 'image_0.jpg']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Got it, here is mine.' },
        { seq: 1, ct: 'image/jpeg', cl: 'image_0.jpg', cid: '<image_0>', name: 'image_0.jpg', data: makeBase64(1024) },
      ],
    });
    this.meta.oneToOneMmsNoAddrs = { count: 2, multiPartText: 'First half of the message. Second half of the message.' };
  }

  private emitOversizedPart(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    const t = this.featureBase();
    const blob = makeBase64(OVERSIZE_CHARS);
    this.pushMms(main, {
      address: c0.address,
      date: t,
      msgBox: 1,
      mType: 132,
      mId: this.nextMid(),
      contactName: c0.name,
      parts: [
        smilPart(['text_0.txt', 'image_big.jpg']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Check out this huge photo.' },
        { seq: 1, ct: 'image/jpeg', cl: 'image_big.jpg', cid: '<image_big>', name: 'image_big.jpg', data: blob },
      ],
      addrs: [
        { address: c0.address, type: 137 },
        { address: this.owner.address, type: 151 },
      ],
    });
    this.meta.oversizedPartBytes = blob.length;
  }

  private emitTapbacks(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();
    // one normal outgoing message so the thread is not only reactions
    this.pushSms(main, { address: c0.address, contactName: c0.name, type: 2, body: 'What did you think of the plan?', date: t });
    t += 5 * MIN;
    const originals = ['the plan', 'your idea', 'that photo', 'the joke', 'the schedule', 'your question'];
    const kinds: ReactionKind[] = [];
    REACTION_VERBS.forEach(([verb, kind], i) => {
      // reactions arrive as literal incoming SMS quoting the original text
      this.pushSms(
        main,
        { address: c0.address, contactName: c0.name, type: 1, body: `${verb} "${originals[i]}"`, date: t },
        true,
      );
      kinds.push(kind);
      t += 3 * MIN + this.jitter();
    });
    this.meta.tapbacks = { count: kinds.length, kinds };
  }

  private emitNonEnglish(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();
    const msgs: { body: string; out: boolean }[] = [
      { body: 'Hola, ¿cómo estás hoy? Espero que todo vaya muy bien contigo.', out: false },
      { body: 'Muchas gracias por tu ayuda, me alegro mucho de verte pronto.', out: true },
      { body: "Bonjour, comment ça va aujourd'hui? J'espère que tu passes une belle journée.", out: false },
      { body: 'Merci beaucoup pour ton message, je te réponds dès que possible.', out: true },
      { body: "Let's meet mañana at the café, ¿te parece bien around noon?", out: false },
    ];
    msgs.forEach((m) => {
      this.pushSms(main, { address: c0.address, contactName: c0.name, type: m.out ? 2 : 1, body: m.body, date: t });
      t += 9 * MIN + this.jitter();
    });
    this.meta.nonEnglish = {
      address: c0.address,
      contactIndex: c0.index,
      messageCount: msgs.length,
      langs: ['es', 'fr'],
      codeSwitch: true,
    };
  }

  private emitCoverageHole(): void {
    const main = this.file('main');
    const quiet = this.ensureContact(0);
    const active = this.ensureContact(1);
    this.touch(quiet);
    this.touch(active);
    const base = this.featureBase();

    // Quiet thread: a dense early run, then abrupt SMS-silence (iMessage-shaped gap).
    let qt = base;
    let lastDense = qt;
    for (let i = 0; i < 8; i++) {
      const out = i % 2 === 0;
      this.pushSms(main, { address: quiet.address, contactName: quiet.name, type: out ? 2 : 1, body: `Quiet-thread message ${i + 1}.`, date: qt });
      lastDense = qt;
      qt += 2 * HOUR + this.jitter();
    }
    const resumeStart = base + 300 * DAY;
    let rt = resumeStart;
    for (let i = 0; i < 2; i++) {
      const out = i % 2 === 0;
      this.pushSms(main, { address: quiet.address, contactName: quiet.name, type: out ? 2 : 1, body: `Quiet-thread resumes ${i + 1}.`, date: rt });
      rt += 3 * HOUR;
    }

    // Active thread: messages spread across the FULL span (spans the quiet gap).
    for (let i = 0; i < 10; i++) {
      const out = i % 2 === 0;
      const at = base + i * 30 * DAY + this.jitter();
      this.pushSms(main, { address: active.address, contactName: active.name, type: out ? 2 : 1, body: `Active-thread message ${i + 1}.`, date: at });
    }

    this.meta.coverageHole = {
      quietContactIndex: quiet.index,
      quietAddress: quiet.address,
      activeContactIndex: active.index,
      activeAddress: active.address,
      gapStartMs: lastDense,
      gapEndMs: resumeStart,
      gapDays: 300,
    };
  }

  private emitEmojiTorture(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();

    const FAMILY = '👨‍👩‍👧'; // family ZWJ sequence
    const LAUGH = '\u{1F602}'; // 😂
    // Body #1: raw numeric entity + literal surrogate ZWJ family + nested escaped XML + escaped quotes.
    const rawBodyXml = `Crying &#128514; and family ${FAMILY}, note: &lt;task pri=&quot;high&quot;&gt;call &amp; text&lt;/task&gt;`;
    const decoded = `Crying ${LAUGH} and family ${FAMILY}, note: <task pri="high">call & text</task>`;
    this.pushSms(main, { address: c0.address, contactName: c0.name, type: 1, body: null, rawBodyXml, date: t });
    t += 4 * MIN;

    // Body #2: pure emoji via surrogate pairs (passes through the normal escaper untouched).
    const emojiBody = `Party \u{1F389}\u{1F389} and a laugh ${LAUGH} then a rocket \u{1F680}`;
    this.pushSms(main, { address: c0.address, contactName: c0.name, type: 2, body: emojiBody, date: t });
    t += 4 * MIN;

    // Body #3: the LITERAL 4-char string "null" as genuine text (coercion torture).
    this.pushSms(main, { address: c0.address, contactName: c0.name, type: 1, body: null, rawBodyXml: 'null', date: t });

    this.meta.emojiTorture = {
      tortureRawXmlBody: rawBodyXml,
      tortureDecoded: decoded,
      emojiBody,
      hasLiteralNullBody: true,
      count: 3,
    };
  }

  private emitDraftOutboxFailed(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();
    const byType: Record<number, number> = {};
    const emit = (type: number, body: string, read: number, dateSent: number) => {
      this.pushSms(main, { address: c0.address, contactName: c0.name, type, body, date: t, read, dateSent });
      byType[type] = (byType[type] ?? 0) + 1;
      t += 6 * MIN + this.jitter();
    };
    emit(1, 'A normal received message for contrast.', 1, t - 1000);
    emit(2, 'A normal sent message for contrast.', 1, t - 500);
    emit(3, 'An unsent draft sitting in the box.', 0, 0); // draft, date_sent=0
    emit(4, 'A message stuck in the outbox.', 0, 0); // outbox, date_sent=0
    emit(5, 'A message that failed to send.', 0, 0); // failed
    this.meta.draftOutboxFailed = { byType, draft: 3, outbox: 4, failed: 5 };
  }

  private emitSamePersonTwoNumbers(): void {
    const main = this.file('main');
    const c0 = this.ensureContact(0);
    this.assignSecond(c0, this.spec.contacts[0]?.secondFormat);
    this.touch(c0);
    this.addresses.add(c0.secondAddress!);
    let t = this.featureBase();
    // Three messages from the primary number, labeled with the person's name.
    for (let i = 0; i < 3; i++) {
      const out = i % 2 === 0;
      this.pushSms(main, { address: c0.address, contactName: c0.name, type: out ? 2 : 1, body: `From my first number, msg ${i + 1}.`, date: t });
      t += 8 * MIN + this.jitter();
    }
    // Three from the SECOND number — same name hint (a plausible merge on name).
    for (let i = 0; i < 3; i++) {
      const out = i % 2 === 0;
      this.pushSms(main, { address: c0.secondAddress!, contactName: c0.name, type: out ? 2 : 1, body: `Switched to my second number, msg ${i + 1}.`, date: t });
      t += 8 * MIN + this.jitter();
    }
    // One from the second number with a MISSING contact_name (never key identity on name).
    this.pushSms(main, { address: c0.secondAddress!, contactName: null, type: 1, body: 'Still me, no name attached this time.', date: t });

    this.meta.samePersonTwoNumbers = {
      name: c0.name,
      contactIndex: c0.index,
      addresses: [c0.address, c0.secondAddress!],
    };
  }

  private emitDuplicatesAcrossFiles(): void {
    const main = this.file('main'); // this is "file A"
    const overlap = this.file('overlap'); // this is "file A'"
    const c0 = this.ensureContact(0);
    this.touch(c0);
    let t = this.featureBase();

    // Six record templates. Rendered identically into whichever file they belong to,
    // so duplicate copies are byte-identical (⇒ identical dedup_key downstream).
    const sms = (type: number, body: string): SmsFields => {
      const f: SmsFields = { address: c0.address, contactName: c0.name, type, body, date: t };
      t += 13 * MIN;
      return f;
    };
    const r1 = sms(2, 'Overlap test message one.');
    const r2 = sms(1, 'Overlap test message two.');
    const r3 = sms(2, 'Overlap test message three.');
    const r4mms: MmsFields = {
      address: c0.address,
      date: t,
      msgBox: 1,
      mType: 132,
      mId: this.nextMid(), // shared m_id ⇒ MMS dedup anchor
      contactName: c0.name,
      textOnly: 1,
      parts: [
        smilPart(['text_0.txt']),
        { seq: 0, ct: 'text/plain', cl: 'text_0.txt', cid: '<text_0>', text: 'Overlap test MMS four.' },
      ],
      addrs: [
        { address: c0.address, type: 137 },
        { address: this.owner.address, type: 151 },
      ],
    };
    t += 13 * MIN;
    const r5 = sms(1, 'Overlap test message five.');
    const r6 = sms(2, 'Overlap test message six.');

    // File A: r1, r2, r3, r4
    this.pushSms(main, r1);
    this.pushSms(main, r2);
    this.pushSms(main, r3);
    this.pushMms(main, r4mms);
    // File A': r3, r4, r5, r6  (r3 + r4 are exact duplicates of file A)
    this.pushSms(overlap, r3);
    this.pushMms(overlap, r4mms);
    this.pushSms(overlap, r5);
    this.pushSms(overlap, r6);

    this.meta.duplicatesAcrossFiles = {
      files: ['main', 'overlap'],
      uniqueRecords: 6, // r1..r6
      crossFileDuplicates: 2, // r3, r4 copied into overlap
      overlapDuplicateBodies: ['Overlap test message three.', 'Overlap test MMS four.'],
      sharedMmsMId: r4mms.mId,
    };
  }

  // ── assemble ──────────────────────────────────────────────────────────────
  build(): BuiltFixture {
    const feat = this.spec.features;
    if (feat.basicSmsMms) this.emitBasic();
    if (feat.allTapbacks) this.emitTapbacks();
    if (feat.groupMms) this.emitGroupMms();
    if (feat.oneToOneMmsNoAddrs) this.emitOneToOneMmsNoAddrs();
    if (feat.oversizedPart) this.emitOversizedPart();
    if (feat.nonEnglishRun) this.emitNonEnglish();
    if (feat.coverageHole) this.emitCoverageHole();
    if (feat.emojiEntityTorture) this.emitEmojiTorture();
    if (feat.draftOutboxFailed) this.emitDraftOutboxFailed();
    if (feat.samePersonTwoNumbers) this.emitSamePersonTwoNumbers();
    if (feat.duplicatesAcrossFiles) this.emitDuplicatesAcrossFiles();
    if (feat.bulkMessages) this.emitBulk(feat.bulkMessages);

    const main = this.file('main');
    if (feat.wrongDeclaredCount) main.declaredOverride = main.sms + main.mms + 7;

    const filesExpected: FixtureFileExpected[] = [];
    for (const f of this.files.values()) {
      const total = f.sms + f.mms;
      const declared = f.declaredOverride ?? total;
      filesExpected.push({
        label: f.label,
        xml: this.toXml(f),
        smsCount: f.sms,
        mmsCount: f.mms,
        totalRecords: total,
        reactionCount: f.reaction,
        declaredCount: declared,
      });
    }
    const primary = filesExpected.find((f) => f.label === 'main') ?? filesExpected[0];

    // Spread planted metadata FIRST so the canonical fields below always win.
    const expected: FixtureExpected = {
      ...this.meta,
      smsCount: primary.smsCount,
      mmsCount: primary.mmsCount,
      totalRecords: primary.totalRecords,
      reactionCount: primary.reactionCount,
      contacts: this.touchedContacts.size,
      declaredCount: primary.declaredCount,
      distinctAddresses: this.addresses.size,
      ownerAddress: this.owner.address,
      ownerName: this.owner.name,
      region: this.spec.region ?? 'US',
      seed: this.spec.seed,
      files: filesExpected,
      uniqueRecords:
        (this.meta.duplicatesAcrossFiles as { uniqueRecords?: number } | undefined)?.uniqueRecords ??
        filesExpected.reduce((n, f) => n + f.totalRecords, 0),
    };

    return { xml: primary.xml, expected };
  }

  private toXml(f: FileAcc): string {
    const total = f.sms + f.mms;
    const declared = f.declaredOverride ?? total;
    const backupDate = f.dates.length ? f.dates.reduce((a, b) => (b > a ? b : a), f.dates[0]) : BASE;
    const header =
      `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
      `<!--File Created By Between synthetic fixture generator (seed ${this.spec.seed}, file ${f.label})-->\n` +
      `<smses count="${declared}" backup_set="${this.backupSet}" backup_date="${backupDate}" type="full">`;
    return header + '\n' + f.records.join('\n') + '\n</smses>\n';
  }
}

// ── public API ──────────────────────────────────────────────────────────────
export function buildFixture(spec: FixtureSpec): BuiltFixture {
  return new Builder(spec).build();
}

export function writeFixtureXml(spec: FixtureSpec, path: string): void {
  const { xml } = buildFixture(spec);
  writeFileSync(path, xml, 'utf8');
}

// ── canonical scenarios ─────────────────────────────────────────────────────
export const SCENARIOS: Record<string, FixtureSpec> = {
  basic: {
    seed: 1001,
    ownerName: 'Me',
    contacts: [
      { name: 'Robin', addressFormat: 'e164' },
      { name: 'Jamie', addressFormat: 'bare10' },
    ],
    features: { basicSmsMms: true },
  },

  duplicatesAcrossFiles: {
    seed: 1002,
    contacts: [{ name: 'Robin', addressFormat: 'dashed' }],
    features: { duplicatesAcrossFiles: true },
  },

  groupMms: {
    seed: 1003,
    contacts: [
      { name: 'Robin', addressFormat: 'e164' },
      { name: 'Jamie', addressFormat: 'spaced' },
      { name: 'Casey', addressFormat: 'dashed' },
    ],
    features: { groupMms: true },
  },

  oneToOneMms: {
    seed: 1004,
    contacts: [{ name: 'Robin', addressFormat: 'e164' }],
    features: { oneToOneMmsNoAddrs: true },
  },

  oversizedPart: {
    seed: 1005,
    contacts: [{ name: 'Robin', addressFormat: 'e164' }],
    features: { oversizedPart: true },
  },

  tapbacks: {
    seed: 1006,
    contacts: [{ name: 'Robin', addressFormat: 'e164' }],
    features: { allTapbacks: true },
  },

  nonEnglish: {
    seed: 1007,
    contacts: [{ name: 'Mateo', addressFormat: 'bare10' }],
    features: { nonEnglishRun: true },
  },

  coverageHole: {
    seed: 1008,
    contacts: [
      { name: 'Robin', addressFormat: 'e164' },
      { name: 'Jamie', addressFormat: 'bare10' },
    ],
    features: { coverageHole: true },
  },

  emojiTorture: {
    seed: 1009,
    contacts: [{ name: 'Robin', addressFormat: 'e164' }],
    features: { emojiEntityTorture: true },
  },

  draftOutboxFailed: {
    seed: 1010,
    contacts: [{ name: 'Robin', addressFormat: 'e164' }],
    features: { draftOutboxFailed: true },
  },

  samePersonTwoNumbers: {
    seed: 1011,
    contacts: [{ name: 'Alex', addressFormat: 'e164', secondNumber: true, secondFormat: 'bare10' }],
    features: { samePersonTwoNumbers: true },
  },

  // A single archive that exercises every planted feature at once (except the
  // oversized part, kept out so the everyday scenario stays lightweight).
  everything: {
    seed: 2000,
    ownerName: 'Me',
    contacts: [
      { name: 'Robin', addressFormat: 'e164' },
      { name: 'Jamie', addressFormat: 'bare10' },
      { name: 'Casey', addressFormat: 'dashed' },
      { name: 'Alex', addressFormat: 'spaced', secondNumber: true, secondFormat: 'bare10' },
      { name: 'Mateo', addressFormat: 'e164' },
    ],
    features: {
      basicSmsMms: true,
      allTapbacks: true,
      groupMms: true,
      oneToOneMmsNoAddrs: true,
      nonEnglishRun: true,
      coverageHole: true,
      emojiEntityTorture: true,
      draftOutboxFailed: true,
      samePersonTwoNumbers: true,
      duplicatesAcrossFiles: true,
      wrongDeclaredCount: true,
    },
  },
};
