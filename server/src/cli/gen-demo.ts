// Between — the DEMO ARCHIVE generator. Authors a FICTIONAL couple (Alex + Jordan) as a believable
// 26-month text thread, then emits the two demo artifacts a stranger can run the whole instrument on:
//
//   examples/demo-archive.xml — a valid SMS Backup & Restore (SyncTech) export: the human-readable
//                               "here is what your phone export looks like" showpiece.
//   examples/demo.db          — a pre-analyzed store (graph + per-message L1 emotion + episodes + eras
//                               + findings + calibration + a frozen First Reflection), built on demand.
//
// EVERYTHING here is fiction. No real person, number, or message appears. Numbers live in the
// 555-01xx test range. The narrative is a normal hard-but-loving relationship: warmth, friction,
// repair — never abuse, never crisis. The ledger-of-hands finding comes out EMPTY by construction
// (verified before write) and the power-balance gate lands on 'two_readings' (mutual), never 'support'.
//
// Determinism: one seeded mulberry32 PRNG drives every procedural choice; every timestamp derives from
// a fixed base epoch; every content date is a fixed literal. No Math.random, no Date.now in the output.
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from '../../test/fixtures/gen';
import { repoRoot } from '../config';
import { openDb, type BetweenDB } from '../store/db';
import { createAirlockStore } from '../airlock/store';
import { refreshEpisodes } from '../lenses/episodes';
import { refreshEras, getEras, setEraNameSummary } from '../lenses/eras';
import { refreshFindings, computeLedger } from '../lenses/findings';
import { applyCalibration } from '../lenses/calibrate';
import { recordL4SampleConfirmed, gateFor } from '../lenses/abuse';
import { freezeReflection } from '../lenses/render';
import { CLOSING_QUESTIONS, pickTemplate } from '../lenses/voiceTemplates';
import type { BiasLabel } from '../lenses/bias';
import type { Direction, GraphMessage, ResolvedGraph } from '../types';

// ── the authored message (ground truth for BOTH the .xml and the .db) ──────────
// dir 'outgoing' = Alex (owner); dir 'incoming' = Jordan (partner).
interface Authored {
  dir: Direction;
  ms: number;
  body: string;
  tension: number; // 0..3  (hostile bar is 2)
  warmth: number;  // 0..3  (warm/repair bar is 2)
  valence: number; // -1..1
}

// ── time constants (the arc runs 2022-01 → 2024-02, 26 months) ─────────────────
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// One PRNG for the whole run (fixed seed → byte-identical outputs every time).
const rng = mulberry32(0x5e77_1e);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
const chance = (p: number): boolean => rng() < p;

// ── the couple's voice — small, natural, lowercase texting pools ────────────────
// ── the phrase pools ─────────────────────────────────────────────────────────────────────────────
//
// SIZE IS A FEATURE HERE. These were about a quarter this long, which put 91 distinct sentences under
// 787 messages — every line repeating roughly nine times, and the five most recent "sorry" receipts in
// the Ask screenshot were the same sentence five times over.
//
// That is a real defect in a demo whose entire argument is "look at the actual words". A reader
// scrolling identical sentences concludes the archive is filler, and is then right to wonder what
// else is decorative. The pools are wide enough now that a screenful of receipts reads like a
// screenful of a life.
const LOGI = [
  'otw', '5 min out', 'running like 10 late, sorry', 'did you feed biscuit yet?',
  'can you grab milk on the way home?', 'what do you want for dinner?', 'at the store, need anything?',
  'in a meeting, call you after', 'traffic is insane rn', 'home in 20', 'leaving now',
  'parking here is a nightmare', 'the plumber comes at 3', "don't forget it's trash night",
  'biscuit needs a walk when you get back', 'fedex left a package on the porch', "i'll pick up dinner",
  'you want the usual from the thai place?', 'almost done at work', 'gonna hit the gym after',
  'we out of coffee again?', 'i took biscuit to the vet, all good', 'call me when you land',
  'just parked, walking in now', 'running to the pharmacy after work', 'did you lock the back door?',
  "i'm at the dentist, back around 4", 'can you start the dishwasher?', 'the wifi is out again',
  'landlord emailed about the radiator', 'grabbing coffee, want anything?', 'stuck on a call, sorry',
  'train is delayed again', "i'll be late, don't wait to eat", 'can you pick up my prescription?',
  'biscuit ate something in the yard, watching him', 'we need to book the flights this week',
  'my mom called, wants to do sunday', 'the car is making that noise again',
  'put the trash out already', 'is the heating bill due this week?', 'left my charger at your desk',
  'can you take biscuit out, running behind', 'the store was out of the good bread',
  'dropped the rent check off', 'appointment moved to thursday', "i'm heading home now",
  'do we have anything for lunch tomorrow?', 'battery about to die, call you later',
  'made too much pasta, bring tupperware', 'the sink is doing the slow thing again',
  'text me when you leave', 'got the tickets for saturday', "i'm outside whenever you're ready",
  'forgot my keys, are you home?', 'can you water the plants, forgot',
] as const;
const WARM = [
  'i love you', 'i love you so much', 'miss you already', 'cant wait to see you tonight',
  'you make me really happy', 'thinking about you today', 'good morning babe ☀️',
  'goodnight, love you ❤️', 'had the best day with you', 'so lucky to have you',
  'proud of you for today', 'thank you for today, it meant a lot', "you're my favorite person",
  'come home soon, i miss you', 'love waking up next to you',
  'hope today goes easy on you', 'just thought about you and smiled', "you're the best part of my day",
  'missing you a stupid amount today', 'thank you for being patient with me',
  'i really like our life', 'you looked beautiful this morning', "i'm glad it's you",
  'thinking about that trip we took', "you're so good at this, you know that?",
  'safe drive, text me when you get there', 'i appreciate everything you did today',
  'you handled that so well', "can't stop thinking about last night",
  'love you more than the dog, barely', 'cannot wait for the weekend with you',
  'thank you for listening earlier', "you're kind, even when it's hard",
  'i would pick you again', 'glad i get to come home to you',
] as const;
const PLAYFUL = [
  "lmaooo you're such a dork", 'haha stop it 😂', 'that meme killed me lol', "you're ridiculous, i love it",
  'biscuit did the zoomies again haha', 'ok that was actually funny lol', "you're lucky you're cute lol",
  'hahaha no way', 'sent you the dumbest video, watch it lol', 'biscuit photo incoming 🐶 haha',
  'absolutely not lmao', "i'm telling everyone you said that", "this is why we can't have nice things lol",
  'biscuit judged me for that one', "you're the worst 😂 (you're the best)",
  'ok chef 👨‍🍳 lol', 'i cannot believe you just said that hahaha',
  'the dog likes me more, admit it', 'crying laughing at this 😂', 'not you doing that again lol',
  'we are so bad at this haha', 'putting that on a t-shirt lmao',
] as const;
// mild peeves (tension 1) — NOT episodes; they give the calibration its low-end contrast.
const PEEVE = [
  'you forgot to text me back all day', "would've been nice to get a heads up",
  "kind of annoyed you didn't call", 'you left the dishes in the sink again btw',
  'i waited almost an hour, just saying', 'you said you\'d be home by 7',
  'the laundry has been sitting there two days', 'i asked you about this on monday',
  "you told me you'd handle the bill", 'a text would have taken five seconds',
  'i had to reschedule everything, again', "you didn't mention you were going out",
  'this keeps landing on me', "i'm the only one who notices the trash",
] as const;
// ordinary-fight lines (tension 2) — friction over time/money/chores/attention. never abuse.
const CONFLICT2 = [
  "you said you'd handle it and you just didn't", 'why is it always me doing everything around here',
  "i feel like you're not even listening to me", 'we cannot keep spending like this',
  'you were on your phone the entire dinner', "i'm so tired of feeling like an afterthought",
  "that's not what we agreed on and you know it", 'you keep saying you\'ll change and nothing changes',
  "i don't feel like a priority to you at all", 'this is the third time this month',
  "i shouldn't have to ask three times", 'you made that decision without me again',
  "i'm carrying all of this by myself", 'we said we would talk about money before spending it',
  "you're not even trying to see it from my side", 'every time i bring this up you shut down',
  "i don't know how to reach you lately", 'you promised me this would be different',
  'i feel invisible in my own house', "you're always too tired for me and never for anyone else",
] as const;
// heated but non-abusive (tension 3). deliberately contains NO violence/death language.
const CONFLICT3 = [
  "i am so angry i can't even talk right now", 'you never think about how any of this affects me',
  "i'm done having the exact same fight over and over", 'forget it. clearly none of this matters to you',
  "you always do this and honestly it's exhausting", "i'm so frustrated i could scream",
  "i am so tired of being the only one who cares", 'nothing i say gets through to you',
  "i can't keep doing this on my own", 'you have no idea how much this hurts',
  "i'm furious and i don't even know where to start", 'stop telling me how i feel',
  "i have nothing left to give this today",
] as const;
// de-escalation notices (tension 1) — matches the exit-signature 'named pause' pattern.
const NOTICE = [
  'i need some space right now, can we talk tomorrow', "i need a minute before i say something i regret",
  "let's come back to this tomorrow, i'm too heated", "i'm not leaving, i just need a break for tonight",
  "i'm going for a walk, i'll be back", 'can we pause this, i want to do it right',
  "i'm too upset to be fair to you right now", "let's both sleep and try again in the morning",
] as const;
// repairs (warmth 3) — EVERY line carries an apology keyword (sorry / my bad / i was wrong), so the
// side who repairs first is always attributed and both people visibly repair in the apology economics.
const REPAIR = [
  "i'm sorry. i shouldn't have said that", 'my bad, i was being defensive and it wasn\'t fair',
  'i was wrong, and you were right to be upset', "i'm sorry. can we start over? i hate fighting with you",
  "i'm sorry — i love you and i don't want to fight", 'my bad. i hear you, and i\'ll do better, i promise',
  'i\'m sorry i checked out earlier, i was overwhelmed', "i don't want to go to bed like this. i'm sorry",
  "i'm sorry for how i said it, i meant none of that", 'i was wrong to bring that up like that, sorry',
  "my bad for snapping. you didn't deserve it", "i'm sorry i made you feel alone in that",
  'i was wrong. i should have asked instead of assuming', "i'm sorry, i let it build instead of talking",
  'my bad — i heard you, i just got defensive', "i'm sorry i walked off. that wasn't fair to you",
] as const;
// warm reconnection after a fight (warmth 2, no apology keyword)
const RECONNECT = [
  'thank you for hearing me', 'i feel a lot better after talking', 'love you. always',
  'glad we talked it out', 'ok. truce — dinner and a movie?',
  "that was hard but i'm glad we did it", 'still on your team',
  'thanks for staying in it with me', 'we got there in the end',
  'i slept better knowing we sorted it', 'coffee? my treat, peace offering',
] as const;
// the era-3 recommitment (warmth 3)
const RECOMMIT = [
  'i booked us a session with a counselor for next week', "i don't want to lose this. lose us",
  'i choose you, even on the hard days', "let's actually try. really try this time",
  "i'm all in if you are", "i know this year's been hard. i still want it, with you",
  'you and me and biscuit. that\'s the whole plan',
] as const;

// ── narrative assembly ─────────────────────────────────────────────────────────
// Authoring is MONTH-TARGETED: each month emits a near-constant number of messages for its era, so the
// per-month signals the era segmenter reads (volume, hostile share, reciprocation) are smooth WITHIN an
// era and shift sharply AT era boundaries — the arc segments into a handful of clean eras, not noise.
// Sessions are placed on random days with absolute timestamps; a final sort + de-collision pass leaves
// every message strictly time-ordered and uniquely stamped.
const msgs: Authored[] = [];

const logi = (): string => pick(LOGI);
const other = (d: Direction): Direction => (d === 'outgoing' ? 'incoming' : 'outgoing');

type Regime = 'era1' | 'era2' | 'era3' | 'recommit';
function regimeFor(mi: number): Regime {
  if (mi < 8) return 'era1';          // 2022-01 .. 2022-08  — new love
  if (mi < 18) return 'era2';         // 2022-09 .. 2023-06  — moving in, friction
  if (mi < 24) return 'era3';         // 2023-07 .. 2023-12  — the rough, distant patch
  return 'recommit';                  // 2024-01 .. 2024-02  — choosing each other again
}
// Per-month message target. era-3 and recommit share a LOW volume so they read as ONE low-contact era
// (the rough patch that ends in repair): the recommitment shows up as warmth, which is NOT a segmentation
// signal, so it lifts the mood without splitting off a spurious era.
function monthTarget(regime: Regime): number {
  return regime === 'era1' ? 34 : regime === 'era2' ? 28 : 16;
}

/** Append one message with an explicit absolute timestamp. */
function emit(dir: Direction, ms: number, m: { body: string; tension: number; warmth: number; valence: number }): void {
  msgs.push({ dir, ms, ...m });
}

/** One casual message appropriate to the era (drives volume, warmth, "i love you", playful rates). */
function casual(regime: Regime, dir: Direction, ms: number): void {
  const r = rng();
  if (regime === 'era1') {
    if (r < 0.42) emit(dir, ms, { body: pick(WARM), tension: 0, warmth: 3, valence: 0.6 });
    else if (r < 0.66) emit(dir, ms, { body: pick(PLAYFUL), tension: 0, warmth: 2, valence: 0.4 });
    else emit(dir, ms, { body: logi(), tension: 0, warmth: 0, valence: 0.05 });
  } else if (regime === 'era2') {
    if (r < 0.16) emit(dir, ms, { body: pick(WARM), tension: 0, warmth: 3, valence: 0.55 });
    else if (r < 0.30) emit(dir, ms, { body: pick(PLAYFUL), tension: 0, warmth: 2, valence: 0.35 });
    else if (r < 0.42) emit(dir, ms, { body: pick(PEEVE), tension: 1, warmth: 0, valence: -0.15 });
    else emit(dir, ms, { body: logi(), tension: 0, warmth: 0, valence: 0.0 });
  } else if (regime === 'era3') {
    if (r < 0.09) emit(dir, ms, { body: pick(WARM), tension: 0, warmth: 3, valence: 0.5 });
    else if (r < 0.16) emit(dir, ms, { body: pick(PLAYFUL), tension: 0, warmth: 2, valence: 0.3 });
    else if (r < 0.34) emit(dir, ms, { body: pick(PEEVE), tension: 1, warmth: 0, valence: -0.2 });
    else emit(dir, ms, { body: logi(), tension: 0, warmth: 0, valence: -0.02 });
  } else {
    if (r < 0.42) emit(dir, ms, { body: pick(RECOMMIT), tension: 0, warmth: 3, valence: 0.7 });
    else if (r < 0.64) emit(dir, ms, { body: pick(WARM), tension: 0, warmth: 3, valence: 0.6 });
    else if (r < 0.80) emit(dir, ms, { body: pick(RECONNECT), tension: 0, warmth: 2, valence: 0.45 });
    else emit(dir, ms, { body: logi(), tension: 0, warmth: 0, valence: 0.1 });
  }
}

/** One short burst of alternating texts on `dayStart`; returns how many messages it emitted. */
function chatterSession(dayStart: number, regime: Regime): number {
  const evening = chance(0.45);
  let ms = dayStart + (evening ? 18 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 3)) * HOUR + Math.floor(rng() * 40) * MIN;
  let dir: Direction = chance(0.5) ? 'outgoing' : 'incoming';
  const n = regime === 'era3' ? 1 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 3); // 1..3 quiet / 2..4 else
  for (let i = 0; i < n; i++) {
    casual(regime, dir, ms);
    ms += (2 + Math.floor(rng() * 11)) * MIN;
    dir = other(dir);
  }
  return n;
}

interface EpisodeSpec {
  y: number; mo: number; d: number;        // fixed calendar date
  initiator: Direction;                     // who throws the first hard message
  heat: number;                             // alternating hostile messages (>= 5 clears the episode bar)
  repairFirst: Direction;                   // who says sorry first afterwards
  ownerNotice?: boolean;                    // Alex names a pause before the partner's last line (a soft exit)
}

/** A conflict episode: a cluster of >=5 hostile messages within ~an hour, then repair within a day. */
function emitEpisode(spec: EpisodeSpec): void {
  let ms = Date.UTC(spec.y, spec.mo, spec.d, 0, 0, 0) + (19 + Math.floor(rng() * 2)) * HOUR + Math.floor(rng() * 30) * MIN;
  const step = () => { ms += (3 + Math.floor(rng() * 10)) * MIN; };
  let dir = spec.initiator;
  let lastHostile = ms;
  const jab = (d: Direction) => {
    const severe = chance(0.35);
    emit(d, ms, { body: severe ? pick(CONFLICT3) : pick(CONFLICT2), tension: severe ? 3 : 2, warmth: 0, valence: severe ? -0.6 : -0.4 });
    lastHostile = ms; step();
  };
  for (let i = 0; i < spec.heat; i++) { jab(dir); dir = other(dir); }
  if (spec.ownerNotice) {
    // Alex names a pause (his last word in the span), then the partner lands one final line.
    emit('outgoing', ms, { body: pick(NOTICE), tension: 1, warmth: 0, valence: -0.1 }); step();
    jab('incoming');
  }
  // Repair — first apology from the designated side, then a warm answer from the other. The whole block
  // sits gapH (2..16) hours after the LAST hostile message, always < 24h (the repair window).
  const gapH = chance(0.5) ? 2 + Math.floor(rng() * 4) : 13 + Math.floor(rng() * 4);
  let rms = lastHostile + gapH * HOUR + Math.floor(rng() * 20) * MIN;
  const rstep = () => { rms += (4 + Math.floor(rng() * 8)) * MIN; };
  emit(spec.repairFirst, rms, { body: pick(REPAIR), tension: 0, warmth: 3, valence: 0.6 }); rstep();
  emit(other(spec.repairFirst), rms, { body: pick(REPAIR), tension: 0, warmth: 3, valence: 0.6 }); rstep();
  emit(spec.repairFirst, rms, { body: pick(RECONNECT), tension: 0, warmth: 2, valence: 0.45 });
}

// The fixed conflict calendar — symmetric between the two, spread across eras 2 and 3.
const EPISODES: EpisodeSpec[] = [
  { y: 2022, mo: 9, d: 14, initiator: 'incoming', heat: 6, repairFirst: 'outgoing' }, // Oct: unpacking/chores
  { y: 2022, mo: 11, d: 3, initiator: 'outgoing', heat: 7, repairFirst: 'incoming' }, // Dec: holiday budget
  { y: 2023, mo: 0, d: 20, initiator: 'incoming', heat: 6, repairFirst: 'incoming', ownerNotice: true }, // Jan: in-laws
  { y: 2023, mo: 2, d: 11, initiator: 'outgoing', heat: 8, repairFirst: 'outgoing' }, // Mar: working late
  { y: 2023, mo: 4, d: 6, initiator: 'incoming', heat: 6, repairFirst: 'incoming' },  // May: phone at dinner
  { y: 2023, mo: 7, d: 19, initiator: 'outgoing', heat: 7, repairFirst: 'outgoing', ownerNotice: true }, // Aug: distant
  { y: 2023, mo: 10, d: 2, initiator: 'incoming', heat: 6, repairFirst: 'outgoing' }, // Nov: same fight again
  { y: 2024, mo: 0, d: 13, initiator: 'outgoing', heat: 6, repairFirst: 'incoming' }, // Jan: the turn toward repair
];

/** Author the whole arc, month by month, at a near-constant per-era volume. */
function authorArc(): void {
  for (let mi = 0; mi <= 25; mi++) {
    const y = 2022 + Math.floor(mi / 12);
    const mo = mi % 12;
    const monthStart = Date.UTC(y, mo, 1, 0, 0, 0);
    const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const regime = regimeFor(mi);
    const target = monthTarget(regime) + Math.floor(rng() * 7) - 3; // ±3 jitter
    let emitted = 0;
    for (let guard = 0; emitted < target && guard < 300; guard++) {
      const day = monthStart + Math.floor(rng() * daysInMonth) * DAY;
      emitted += chatterSession(day, regime);
    }
    const ep = EPISODES.find((e) => e.y === y && e.mo === mo);
    if (ep) emitEpisode(ep);
  }
}

// ── XML rendering (mirrors server/test/fixtures/gen.ts primitives; SMS-only, byte-shape identical) ──
const OWNER_LINE = '0100';   // Alex
const PARTNER_LINE = '0142'; // Jordan
const AREA = '555';
const PREFIX = '555';
const partnerAddress = `+1${AREA}${PREFIX}${PARTNER_LINE}`; // built from parts: no literal 10-digit run
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function readableDate(ms: number): string {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${p2(h12)}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${ampm}`;
}
function renderSms(m: Authored): string {
  const type = m.dir === 'outgoing' ? 2 : 1; // 2=sent (Alex), 1=received (Jordan)
  return (
    `  <sms protocol="0" address="${escapeXml(partnerAddress)}" date="${m.ms}" type="${type}"` +
    ` subject="null" body="${escapeXml(m.body)}" toa="null" sc_toa="null" service_center="null"` +
    ` read="1" status="-1" locked="0" date_sent="0" sub_id="1"` +
    ` readable_date="${escapeXml(readableDate(m.ms))}" contact_name="Jordan" />`
  );
}
function renderArchiveXml(all: Authored[]): string {
  const backupDate = all.reduce((a, m) => (m.ms > a ? m.ms : a), all[0].ms);
  const header =
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n` +
    `<!--File Created By Between demo generator — FICTIONAL couple (Alex & Jordan), no real data-->\n` +
    `<smses count="${all.length}" backup_set="demo0000" backup_date="${backupDate}" type="full">`;
  return header + '\n' + all.map(renderSms).join('\n') + '\n</smses>\n';
}

// ── DB build (mirrors server/test/helpers/seed.ts: graph + one covering L1 result) ─────────────────
const THREAD = 1;
const OWNER = 1; // Alex
const THEM = 2;  // Jordan

function seedGraph(db: BetweenDB, all: Authored[]): number[] {
  const t0 = all[0].ms;
  const tn = all[all.length - 1].ms;
  const graph: ResolvedGraph = {
    sourceFile: {
      path: 'demo-archive.xml',
      contentSha256: 'demo'.padEnd(64, '0'),
      importedAt: new Date(t0).toISOString(),
      recordCount: all.length,
    },
    contacts: [
      { tempId: OWNER, displayName: 'Alex', primaryE164: `+1${AREA}${PREFIX}${OWNER_LINE}`, isOwner: true, relationshipType: 'unknown' },
      { tempId: THEM, displayName: 'Jordan', primaryE164: partnerAddress, isOwner: false, relationshipType: 'partner' },
    ],
    identifiers: [
      { contactTempId: THEM, rawValue: partnerAddress, normalizedE164: partnerAddress, kind: 'mobile', sourceContactName: 'Jordan', firstSeenMs: t0, lastSeenMs: tn },
    ],
    threads: [
      { tempId: THREAD, participantSignature: 'demo-alex-jordan', isGroup: false, title: null, coverageConfidence: 1, coverageNote: null, primaryLang: 'en', firstMs: t0, lastMs: tn, messageCount: all.length },
    ],
    threadParticipants: [
      { threadTempId: THREAD, contactTempId: OWNER, role: 'owner' },
      { threadTempId: THREAD, contactTempId: THEM, role: 'member' },
    ],
    messages: all.map((m, i): GraphMessage => {
      const out = m.dir === 'outgoing';
      return {
        threadTempId: THREAD, senderContactTempId: out ? OWNER : THEM, direction: m.dir, kind: 'sms',
        sentAtMs: m.ms, bodyText: m.body, isRead: true, isReaction: false, reactionKind: null, lang: 'en',
        rawType: out ? 2 : 1, rawMsgBox: null, dedupKey: `demo-${i}`,
        recipients: [{ contactTempId: out ? THEM : OWNER, role: 'to' }], attachments: [],
      };
    }),
  };
  db.bulkInsertGraph(graph);
  const ids = (db.raw
    .prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY sent_at_ms ASC, id ASC')
    .all(THREAD) as { id: number }[]).map((r) => r.id);

  // One L1 result covering every message, with the AUTHORED emotion scores — exactly what the ingest
  // + airlock path would leave behind after a full L1 drain (here the "model" read == the ground truth).
  const store = createAirlockStore(db);
  const jid = 'job_demo_l1';
  const ih = 'hash_demo_l1';
  store.insertJob({
    id: jid, inputHash: ih, lens: 'l1_emotion', kind: 'map', engineHint: 'local', priority: 0,
    chunkRef: { thread_id: THREAD, start_msg_id: ids[0], end_msg_id: ids[ids.length - 1], overlap_prefix_ids: [], member_ids: ids },
    promptId: 'l1-emotion', promptVersion: 1,
  });
  store.upsertResult({
    inputHash: ih, jobId: jid, lens: 'l1_emotion',
    result: {
      messages: ids.map((id, i) => ({ message_id: `m${id}`, valence: all[i].valence, warmth: all[i].warmth, tension: all[i].tension })),
      window: { summary: 'demo', notes: [] },
    },
    validation: { schema_ok: true, retries: 0 }, refusal: { detected: false, reason: null }, modelNote: 'demo', sampleCount: 1,
  });
  return ids;
}

/** A blind, honest, BALANCED calibration label set drawn from the authored thread — labeled the same
 *  way on both sides (every hard message called hard), so the self-report verdict is 'balanced' and the
 *  derived thresholds land on the shipped defaults (hostile 2 / severe 3). */
function calibrationLabels(all: Authored[]): BiasLabel[] {
  const labels: BiasLabel[] = [];
  const labelFor = (t: number): string => (t >= 3 ? 'cruel' : t === 2 ? 'harsh' : t === 1 ? 'joke' : 'benign');
  // Every message the model scored tension>=1 (both sides), plus a light spread of calm ones for contrast.
  let benignN = 0;
  for (const m of all) {
    const dir: 'ME' | 'THEM' = m.dir === 'outgoing' ? 'ME' : 'THEM';
    if (m.tension >= 1) labels.push({ dir, tension: m.tension, label: labelFor(m.tension) });
    else if (benignN++ % 14 === 0) labels.push({ dir, tension: 0, label: 'benign' });
  }
  return labels;
}

// The demo's fixed "generation date" — used for every dated, reproducible artifact below.
const DEMO_DATE = '2024-02-15';
// A curated arc of names, assigned in chronological order to however many eras the change-point
// segmentation finds (1–6). Every one reads as a real season — no "Chapter N" placeholders in the demo.
const ERA_NAMES = ['New love', 'Building a life', 'The friction of close quarters', 'A quieter, harder stretch', 'Rough patch, then choosing in', 'Finding the way back'];

// A short, hand-written First Reflection in the VOICE register (mirror not verdict; strengths-first;
// one observation held as two readings). Cites two real messages as receipts.
//
// The closing question is NOT hand-written: it is drawn from the authored template set the real
// renderer uses (docs/VOICE.md §6b), selected by the same deterministic content hash. The demo is what
// a stranger looks at before deciding whether to trust this with their own years, so it has to show
// what the product actually produces — a bespoke closing line here would be showing them a reading the
// software cannot write.
function reflectionMd(): string {
  const body = [
    'You two built something with real warmth in it. In the early months it is everywhere — the good-mornings, the "miss you already," the small proud notes on each other\'s hard days.',
    'Even later, when the load of a shared life got heavier and the arguments got sharper, the thing that stands out is not the friction. It is how often one of you turned back first. After the hardest nights there is almost always a hand out the next morning — sometimes yours, sometimes theirs — an "i\'m sorry, i hate fighting with you" that lands and gets met.',
    'One thing worth sitting with: the fights tend to circle the same few things — time, money, feeling unseen — returning rather than resolving. That could read as being stuck, or as two people who keep choosing to stay at the table.',
  ];
  return [...body, pickTemplate(CLOSING_QUESTIONS, body.join('\n'))].join('\n\n');
}

function main(): void {
  const outFlag = process.argv.indexOf('--out');
  const outArg = outFlag > -1 ? process.argv[outFlag + 1] : 'examples';
  const outDir = join(repoRoot(), outArg);
  mkdirSync(outDir, { recursive: true });

  // 1. Author the narrative, then put it in strict time order with a unique stamp per message (sessions
  //    were placed on random days, so sort + nudge any collision forward — keeps ids ↔ scores aligned).
  authorArc();
  msgs.sort((a, b) => a.ms - b.ms);
  let prev = -Infinity;
  for (const m of msgs) { if (m.ms <= prev) m.ms = prev + 1000; prev = m.ms; }

  // 2. Emit the human-readable XML showpiece.
  const xmlPath = join(outDir, 'demo-archive.xml');
  writeFileSync(xmlPath, renderArchiveXml(msgs), 'utf8');

  // 3. Build the pre-analyzed DB from scratch.
  const dbPath = join(outDir, 'demo.db');
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  const db = openDb(dbPath);

  const ids = seedGraph(db, msgs);
  refreshEpisodes(db, THREAD);
  refreshEras(db, THREAD);

  // Name the eras in chronological order (worthwhile-tier naming; makes the exit-signature readable).
  const computedEras = getEras(db, THREAD);
  computedEras.forEach((e, i) => setEraNameSummary(db, THREAD, e.startMs, ERA_NAMES[i] ?? `Chapter ${i + 1}`, ''));

  const findings = refreshFindings(db, THREAD);

  // Balanced, honest calibration → thresholds + self-report verdict on file (calibrates the demo owner).
  const cal = applyCalibration(db, calibrationLabels(msgs));

  // The L4 sample-and-agree hard-stop, recorded as three 'fair' grades (demo owner agreed with the read).
  recordL4SampleConfirmed(db, THREAD, ['fair', 'fair', 'fair'], DEMO_DATE);

  // Freeze ONE First Reflection, citing two real receipts (a warm "miss you" and a repair "i'm sorry").
  const warmId = ids[msgs.findIndex((m) => m.warmth === 3 && m.dir === 'incoming')];
  const repairId = ids[msgs.findIndex((m) => /i'm sorry/i.test(m.body))];
  freezeReflection(
    db, THREAD, 'first_reflection', reflectionMd(),
    { 'the good-mornings, the "miss you already"': [`m${warmId}`], 'an "i\'m sorry, i hate fighting with you"': [`m${repairId}`] },
    msgs[0].ms, msgs[msgs.length - 1].ms, 'demo', DEMO_DATE,
  );

  // 4. SAFETY SELF-CHECK (fail loud before anyone sees the demo).
  const ledger = computeLedger(db, THREAD);
  const gate = gateFor(db, THREAD);
  const safe =
    ledger.byDir.physical.me === 0 && ledger.byDir.physical.them === 0 &&
    ledger.byDir.death_wish.me === 0 && ledger.byDir.death_wish.them === 0 &&
    gate.stance.frame === 'two_readings';

  // 5. Print the summary.
  const eras = getEras(db, THREAD);
  const epCount = (db.raw.prepare('SELECT count(*) AS n FROM episodes WHERE thread_id = ?').get(THREAD) as { n: number }).n;
  const span = `${new Date(msgs[0].ms).toISOString().slice(0, 10)} → ${new Date(msgs[msgs.length - 1].ms).toISOString().slice(0, 10)}`;

  db.raw.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  console.log('\n── Between demo archive ─────────────────────────────────────────');
  console.log(`  messages     : ${msgs.length}`);
  console.log(`  span         : ${span}`);
  console.log(`  episodes     : ${epCount}`);
  console.log(`  eras         : ${eras.length}  [${eras.map((e) => e.name ?? '—').join(' · ')}]`);
  console.log(`  calibration  : hostile=${cal.thresholds.hostile_tension} severe=${cal.thresholds.severe_tension}  verdict=${cal.bias.verdict}`);
  console.log('  ledger byDir : ' +
    `physical you ${ledger.byDir.physical.me}·her ${ledger.byDir.physical.them}  ` +
    `death-wish you ${ledger.byDir.death_wish.me}·her ${ledger.byDir.death_wish.them}`);
  console.log(`  gate stance  : frame=${gate.stance.frame} direction=${gate.stance.direction ?? 'none'} confidence=${gate.stance.confidence.toFixed(2)}`);
  console.log(`  apology 1st  : you ${findings.apology.firstRepairAfterPeak.me} · her ${findings.apology.firstRepairAfterPeak.them} · none ${findings.apology.firstRepairAfterPeak.none}`);
  console.log(`  files        : ${xmlPath}`);
  console.log(`                 ${dbPath}`);
  console.log(`  SAFETY       : ${safe ? 'PASS — empty ledger, two_readings gate' : 'FAIL'}`);
  console.log('─────────────────────────────────────────────────────────────────\n');

  if (!safe) { console.error('SAFETY SELF-CHECK FAILED — refusing to ship this demo.'); process.exit(1); }
}

main();
