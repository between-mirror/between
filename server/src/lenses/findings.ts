// Between — the final insight layer (A–E). Deterministic reads that answer harder, more personal
// questions than the dynamics suite: what the hands did, how the kids were framed, what an apology
// bought, how the owner learned to leave a fight, and whether the man in the thread was worn flat.
// No model calls; every number is counted from L1 scores + episodes + the raw words.
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { getEpisodes } from './episodes';
import { getEras } from './eras';
import { calibrationFor, calibrationStatus } from './calibration';
import { gateFor } from './abuse';

const H = 3_600_000;

interface FMsg { id: number; ms: number; me: boolean; body: string; tension: number; warmth: number }

function loadMsgs(db: BetweenDB, threadId: number): FMsg[] {
  const scores = emotionByMessage(db, threadId);
  const rows = db.raw
    .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages
              WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
              ORDER BY sent_at_ms ASC, id ASC`)
    .all(threadId) as { id: number; ms: number; dir: string; body: string }[];
  return rows.map((r) => {
    const s = scores.get(r.id);
    return { id: r.id, ms: r.ms, me: r.dir === 'outgoing' || r.dir === 'draft', body: r.body ?? '', tension: s?.tension ?? 0, warmth: s?.warmth ?? 0 };
  });
}
const clean = (t: string, n = 200) => { const s = t.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// ── A. The ledger of hands ────────────────────────────────────────────────────
// Partner-directed physical harm — admissions, threats, accusations. Deliberately conservative:
// "hurt" is excluded (it reads as emotional far more often than physical); "him" as an object is
// excluded because between these two it almost always means a son, not either partner; "her own"
// is excluded so accusations about her hitting the CHILDREN don't count as partner violence. The
// residual is still keyword disclosure, not adjudicated fact — the reading weighs, it does not tally.
const PHYSICAL = /\b(i (?:hit|slapped|shoved|grabbed|choked|punched|kicked|strangled) (?:you|her)\b|(?:hit|slap(?:ped)?|stab|stabbed|punch|choke|shove|strangle|beat) (?:you|me|your face|my face)\b|(?:hit|punch|choke|shove|strangle|beat) her(?!\s+own)\b|i'?m sorry i (?:hit|slapped|shoved|grabbed|choked)\b|you (?:hit|slapped|shoved|choked|grabbed|punched|strangled) me\b)/i;
const DEATHWISH = /\b(kill your ?self|kill my ?self|hope you (?:die|fucking die|choke)|go (?:die|kill yourself)|die alone|why don'?t you (?:die|kill)|should have died|wish (?:you|i) (?:were|was) dead|want to (?:die|not be here)|end my life)\b/i;

export interface LedgerEntry { id: number; ms: number; date: string; dir: 'me' | 'them'; category: 'physical' | 'death_wish'; text: string }
export interface Ledger { entries: LedgerEntry[]; byDir: { physical: { me: number; them: number }; death_wish: { me: number; them: number } } }

export function computeLedger(db: BetweenDB, threadId: number): Ledger {
  const entries: LedgerEntry[] = [];
  for (const m of loadMsgs(db, threadId)) {
    const category: LedgerEntry['category'] | null = PHYSICAL.test(m.body) ? 'physical' : DEATHWISH.test(m.body) ? 'death_wish' : null;
    if (category) entries.push({ id: m.id, ms: m.ms, date: iso(m.ms), dir: m.me ? 'me' : 'them', category, text: clean(m.body) });
  }
  const byDir = { physical: { me: 0, them: 0 }, death_wish: { me: 0, them: 0 } };
  for (const e of entries) byDir[e.category][e.dir]++;
  return { entries, byDir };
}

// ── B. Kids in the crossfire ──────────────────────────────────────────────────
const MYKIDS = /\bmy (?:kids?|children|son|daughter|boys|girls)\b/i;
const OURKIDS = /\bour (?:kids?|children|son|daughter|boys|girls)\b/i;

export interface KidsFraming {
  total: { myMe: number; ourMe: number; myThem: number; ourThem: number };
  byYear: { year: number; myMe: number; ourMe: number; myThem: number; ourThem: number }[];
}
export function computeKidsFraming(db: BetweenDB, threadId: number): KidsFraming {
  const total = { myMe: 0, ourMe: 0, myThem: 0, ourThem: 0 };
  const years = new Map<number, { myMe: number; ourMe: number; myThem: number; ourThem: number }>();
  for (const m of loadMsgs(db, threadId)) {
    const my = MYKIDS.test(m.body), our = OURKIDS.test(m.body);
    if (!my && !our) continue;
    const y = new Date(m.ms).getUTCFullYear();
    const g = years.get(y) ?? { myMe: 0, ourMe: 0, myThem: 0, ourThem: 0 };
    if (my) { if (m.me) { total.myMe++; g.myMe++; } else { total.myThem++; g.myThem++; } }
    if (our) { if (m.me) { total.ourMe++; g.ourMe++; } else { total.ourThem++; g.ourThem++; } }
    years.set(y, g);
  }
  return { total, byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })) };
}

// ── C. The apology economics ──────────────────────────────────────────────────
const APOLOGY = /\b(sorry|i apologi[sz]e|my bad|i was wrong|forgive me|didn'?t mean (?:it|that))\b/i;

export interface ApologyEconomics {
  firstRepairAfterPeak: { me: number; them: number; none: number }; // per episode, who repairs first
  metWithFire: { me: { total: number; rejected: number; rate: number }; them: { total: number; rejected: number; rate: number } };
}
export function computeApologyEconomics(db: BetweenDB, threadId: number): ApologyEconomics {
  const cal = calibrationFor(db);
  const msgs = loadMsgs(db, threadId);
  const eps = getEpisodes(db, threadId);

  // who repairs first after each episode's last hostile message (within 24h)
  const firstRepairAfterPeak = { me: 0, them: 0, none: 0 };
  let mi = 0;
  for (const e of eps) {
    let found: 'me' | 'them' | null = null;
    for (const m of msgs) {
      if (m.ms <= e.endMs) continue;
      if (m.ms > e.endMs + 24 * H) break;
      if (APOLOGY.test(m.body)) { found = m.me ? 'me' : 'them'; break; }
    }
    if (found) firstRepairAfterPeak[found]++; else firstRepairAfterPeak.none++;
  }

  // apology met with fire: an apology whose next cross-side reply within 2h is hostile
  const met = { me: { total: 0, rejected: 0, rate: 0 }, them: { total: 0, rejected: 0, rate: 0 } };
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!APOLOGY.test(m.body)) continue;
    const side = m.me ? 'me' : 'them';
    met[side].total++;
    for (let j = i + 1; j < msgs.length && msgs[j].ms - m.ms <= 2 * H; j++) {
      if (msgs[j].me !== m.me) { if (msgs[j].tension >= cal.hostileTension) met[side].rejected++; break; }
    }
  }
  met.me.rate = r3(met.me.total ? met.me.rejected / met.me.total : 0);
  met.them.rate = r3(met.them.total ? met.them.rejected / met.them.total : 0);
  return { firstRepairAfterPeak, metWithFire: met };
}

// ── D. The exit signature (how the OWNER leaves a fight), per era ──────────────
export type Exit = 'met' | 'softened' | 'withdraw_notice' | 'withdraw_silent' | 'block_threat';
const NOTICE = /\b(need (?:an? )?(?:hour|minute|moment|bit|break|some space|some time|time|space)|i'?m not leaving|not going anywhere|give me (?:a|some) (?:minute|hour|space|time)|talk (?:later|tomorrow)|come back to this|need to step away)\b/i;
const BLOCK = /\b(block(?:ing)? you|i'?ll block|blocked you|stop texting me|don'?t (?:text|contact) me)\b/i;

function classifyExit(body: string, tension: number, warmth: number, cal: ReturnType<typeof calibrationFor>): Exit {
  if (BLOCK.test(body)) return 'block_threat';
  if (NOTICE.test(body)) return 'withdraw_notice';
  if (warmth >= cal.warmWarmth || APOLOGY.test(body)) return 'softened';
  if (tension >= cal.hostileTension) return 'met';
  return 'withdraw_silent';
}

export interface ExitSignature {
  overall: Record<Exit, number>;
  byEra: { name: string | null; startMs: number; total: number; counts: Record<Exit, number> }[];
}
export function computeExitSignature(db: BetweenDB, threadId: number): ExitSignature {
  const cal = calibrationFor(db);
  const msgs = loadMsgs(db, threadId);
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const eps = getEpisodes(db, threadId);
  const eras = getEras(db, threadId);
  const zero = (): Record<Exit, number> => ({ met: 0, softened: 0, withdraw_notice: 0, withdraw_silent: 0, block_threat: 0 });
  const overall = zero();
  const eraBuckets = eras.map((e) => ({ name: e.name, startMs: e.startMs, endMs: e.endMs, total: 0, counts: zero() }));

  for (const e of eps) {
    // the owner's LAST message inside the episode span
    let last: FMsg | null = null;
    for (const m of msgs) { if (m.ms < e.startMs) continue; if (m.ms > e.endMs) break; if (m.me) last = m; }
    if (!last) continue;
    const exit = classifyExit(last.body, last.tension, last.warmth, cal);
    overall[exit]++;
    const bucket = eraBuckets.find((b) => e.startMs >= b.startMs && e.startMs <= b.endMs);
    if (bucket) { bucket.total++; bucket.counts[exit]++; }
  }
  void byId;
  return { overall, byEra: eraBuckets.map((b) => ({ name: b.name, startMs: b.startMs, total: b.total, counts: b.counts })) };
}

// ── E. The wearing-down curve (per quarter, both sides) ───────────────────────
const PLAYFUL = /(\blol\b|\blmao\b|\bhaha+\b|\bjk\b|🤣|😂|😆|😅)/i;
const ILY = /\bi\s+love\s+you\b/i;

export interface WearSide { n: number; words: number; warmthRate: number; ilyRate: number; playfulRate: number }
export interface WearingDown { quarters: { quarter: string; startMs: number; me: WearSide; them: WearSide }[] }

function quarterOf(ms: number): { q: string; startMs: number } {
  const d = new Date(ms); const y = d.getUTCFullYear(); const qn = Math.floor(d.getUTCMonth() / 3);
  return { q: `${y}-Q${qn + 1}`, startMs: Date.UTC(y, qn * 3, 1) };
}
export function computeWearingDown(db: BetweenDB, threadId: number): WearingDown {
  const cal = calibrationFor(db);
  interface Acc { startMs: number; me: { n: number; w: number; warm: number; ily: number; play: number }; them: { n: number; w: number; warm: number; ily: number; play: number } }
  const qs = new Map<string, Acc>();
  const side = () => ({ n: 0, w: 0, warm: 0, ily: 0, play: 0 });
  for (const m of loadMsgs(db, threadId)) {
    const { q, startMs } = quarterOf(m.ms);
    let a = qs.get(q); if (!a) { a = { startMs, me: side(), them: side() }; qs.set(q, a); }
    const s = m.me ? a.me : a.them;
    s.n++; s.w += (m.body.match(/\S+/g) ?? []).length;
    if (m.warmth >= cal.warmWarmth) s.warm++;
    if (ILY.test(m.body)) s.ily++;
    if (PLAYFUL.test(m.body)) s.play++;
  }
  const mk = (s: { n: number; w: number; warm: number; ily: number; play: number }): WearSide => ({
    n: s.n, words: r3(s.n ? s.w / s.n : 0), warmthRate: r3(s.n ? s.warm / s.n : 0), ilyRate: r3(s.n ? s.ily / s.n : 0), playfulRate: r3(s.n ? s.play / s.n : 0),
  });
  return { quarters: [...qs.entries()].sort((a, b) => a[1].startMs - b[1].startMs).map(([quarter, a]) => ({ quarter, startMs: a.startMs, me: mk(a.me), them: mk(a.them) })) };
}

// ── combined + cache ──────────────────────────────────────────────────────────
export interface Findings { threadId: number; ledger: Ledger; kidsFraming: KidsFraming; apology: ApologyEconomics; exitSignature: ExitSignature; wearingDown: WearingDown }

export function computeFindings(db: BetweenDB, threadId: number): Findings {
  return {
    threadId,
    ledger: computeLedger(db, threadId),
    kidsFraming: computeKidsFraming(db, threadId),
    apology: computeApologyEconomics(db, threadId),
    exitSignature: computeExitSignature(db, threadId),
    wearingDown: computeWearingDown(db, threadId),
  };
}

// ── Findings reading material (for the Fable render) ──────────────────────────
// Assembles the A–E numbers plus a small receipt bank of the heaviest, most-datable moments
// (physical + death-wish disclosures, both sides) so the reading can cite real messages by m<id>.
// The gate stance and self-report-bias verdict ride along so Fable frames direction honestly —
// two eras hard toward the owner, the middle genuinely mutual, and the owner slightly self-critical.
export interface FindingsMaterial { material: string; receiptIds: number[]; span: { startMs: number; endMs: number } }

const pctOf = (x: number) => `${Math.round(x * 100)}%`;

export function buildFindingsMaterial(db: BetweenDB, threadId: number): FindingsMaterial {
  const f = computeFindings(db, threadId);
  const msgs = loadMsgs(db, threadId);
  const span = { startMs: msgs.length ? msgs[0].ms : 0, endMs: msgs.length ? msgs[msgs.length - 1].ms : 0 };

  // receipt bank — up to 4 most-recent per (category, side); these are the only citeable receipts.
  const bank: LedgerEntry[] = [];
  for (const cat of ['physical', 'death_wish'] as const)
    for (const dir of ['me', 'them'] as const)
      bank.push(...f.ledger.entries.filter((e) => e.category === cat && e.dir === dir).sort((a, b) => b.ms - a.ms).slice(0, 4));
  const receiptIds = bank.map((e) => e.id);

  const gate = gateFor(db, threadId);   // calibration-aware: no support frame escapes an uncalibrated archive
  const status = calibrationStatus(db);
  let bias: { verdict?: string; note?: string; ownMeanSeverity?: number; otherMeanSeverity?: number } = {};
  try { bias = JSON.parse(db.getMeta('self_report_bias') ?? '{}'); } catch { /* none */ }

  const L: string[] = [];
  L.push('FINDINGS BRIEF — the final analytical pass over a message thread (owner = "you"; partner = "her").');
  L.push('Frame honestly and hold the paradox. Track direction over TIME, not a single verdict. Both people did harm.');
  if (!status.calibrated) {
    L.push('⚠ CALIBRATION: this owner has NOT completed the hold-out calibration, so the thresholds are shipped defaults tuned to a different person and the self-report honesty check never ran. Treat every directional claim (who was harder on whom, the power-balance stance) as PROVISIONAL — name that it is not yet tuned to them. Do NOT tell them the read is "not self-serving"; you cannot know that here.');
  }
  L.push('');
  L.push('A · THE LEDGER OF HANDS (disclosures counted from the raw words)');
  L.push(`  physical: you ${f.ledger.byDir.physical.me} · her ${f.ledger.byDir.physical.them}    death-wishes: you ${f.ledger.byDir.death_wish.me} · her ${f.ledger.byDir.death_wish.them}`);
  L.push('  These are KEYWORD DISCLOSURES — admissions, threats, and accusations mixed together, not adjudicated facts.');
  L.push('  Weigh them; do not tally them. Cite only the unambiguous, partner-directed ones (m<id>); quote sparingly, never sensationalize.');
  for (const e of bank) L.push(`    m${e.id} [${e.date} · ${e.dir === 'me' ? 'you' : 'her'} · ${e.category}] "${e.text}"`);
  L.push('');
  L.push('B · KIDS IN THE CROSSFIRE ("my kids" vs "our kids")');
  L.push(`  you — my ${f.kidsFraming.total.myMe} / our ${f.kidsFraming.total.ourMe};  her — my ${f.kidsFraming.total.myThem} / our ${f.kidsFraming.total.ourThem}. Higher my:our = kids claimed, not shared.`);
  L.push('');
  L.push('C · THE APOLOGY ECONOMICS');
  L.push(`  repairs first after a fight: you ${f.apology.firstRepairAfterPeak.me} · her ${f.apology.firstRepairAfterPeak.them} · no one ${f.apology.firstRepairAfterPeak.none}.`);
  L.push(`  apology met with fire: yours ${pctOf(f.apology.metWithFire.me.rate)} (${f.apology.metWithFire.me.rejected}/${f.apology.metWithFire.me.total}) · hers ${pctOf(f.apology.metWithFire.them.rate)} (${f.apology.metWithFire.them.rejected}/${f.apology.metWithFire.them.total}). You reached more and were burned more.`);
  L.push('');
  L.push('D · YOUR EXIT SIGNATURE (how you leave a fight), earliest → latest era');
  for (const e of f.exitSignature.byEra) {
    if (!e.total) continue;
    const c = e.counts;
    L.push(`  ${e.name ?? '—'}: met ${pctOf(c.met / e.total)} · softened ${pctOf(c.softened / e.total)} · named-pause ${pctOf(c.withdraw_notice / e.total)} · silent ${pctOf(c.withdraw_silent / e.total)} · block ${pctOf(c.block_threat / e.total)}`);
  }
  L.push('');
  L.push('E · THE WEARING-DOWN CURVE (you), by year — avg words · warmth · "i love you" · playful');
  const byYear = new Map<number, WearSide[]>();
  for (const q of f.wearingDown.quarters) { const y = Number(q.quarter.slice(0, 4)); (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(q.me); }
  for (const [y, arr] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const avg = (sel: (s: WearSide) => number) => arr.reduce((s, x) => s + sel(x), 0) / arr.length;
    L.push(`  ${y}: words ${avg((s) => s.words).toFixed(1)} · warmth ${pctOf(avg((s) => s.warmthRate))} · ily ${pctOf(avg((s) => s.ilyRate))} · playful ${pctOf(avg((s) => s.playfulRate))}`);
  }
  L.push('');
  // Derive the era breakdown from the ACTUAL gate — never hardcode a specific archive's result.
  const supportEras = gate.eras.filter((e) => e.frame === 'support').length;
  const twoReadingEras = gate.eras.filter((e) => e.frame === 'two_readings').length;
  const eraShape = supportEras === 0
    ? 'no era trips to a support frame — the whole span reads as two-sided.'
    : `${supportEras} era${supportEras > 1 ? 's' : ''} trip${supportEras > 1 ? '' : 's'} to support${twoReadingEras ? `, while ${twoReadingEras} stay two-readings` : ''}.`;
  L.push(`POWER-BALANCE STANCE (model-detected, gated): ${gate.stance.frame}${gate.stance.direction ? ` toward ${gate.stance.direction}` : ''} (confidence ${gate.stance.confidence.toFixed(2)}). ${eraShape}`);
  // The "not self-serving" reassurance is EARNED, not automatic: assert it only when the honesty check
  // actually ran AND the owner was at least as hard on themselves as on their partner. Otherwise silence.
  if (status.hasBias && bias.verdict) {
    const selfHarder = (bias.ownMeanSeverity ?? 0) >= (bias.otherMeanSeverity ?? 0);
    const earned = (bias.verdict === 'balanced' || bias.verdict === 'self_critical') && selfHarder;
    L.push(`CALIBRATION ASYMMETRY: ${bias.verdict} — ${bias.note ?? ''}${earned ? ' (This direction is not self-serving; if anything you graded yourself harder.)' : ' (Weigh the direction accordingly — your own labels leaned toward the other side.)'}`);
  } else {
    L.push('CALIBRATION ASYMMETRY: not run for this owner — the direction above is UNCHECKED against their own honesty. Say nothing about whether it is self-serving.');
  }
  return { material: L.join('\n'), receiptIds, span };
}

const METRIC_KEY = 'findings';
export function refreshFindings(db: BetweenDB, threadId: number): Findings {
  const f = computeFindings(db, threadId);
  db.raw.prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, ?, 'all', 0, ?)`)
    .run(threadId, METRIC_KEY, JSON.stringify(f));
  return f;
}
export function getFindings(db: BetweenDB, threadId: number): Findings | null {
  const row = db.raw.prepare(`SELECT value_json AS v FROM metrics WHERE thread_id = ? AND metric_key = ? AND period = 'all' AND period_start_ms = 0`).get(threadId, METRIC_KEY) as { v: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.v) as Findings; } catch { return null; }
}
