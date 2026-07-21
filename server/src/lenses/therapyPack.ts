// Between — E2 conversation packet: a printable brief that makes an hour count. It ASSEMBLES existing,
// frozen/validated artifacts only (no new model pass): a deterministic trajectory summary, the era
// map, the most severe already-narrated episodes, the current frozen reflection(s), and the questions
// the data itself raised (reduce question_seed + era summaries). Nothing here is invented; every
// reading it carries was already sampled-and-agreed and receipt-validated when it was frozen.
import type { BetweenDB } from '../store/db';
import { computeTrajectory } from './trajectory';
import { getEras } from './eras';
import { getEpisodes } from './episodes';
import { getFindings, computeFindings, type Findings } from './findings';
import { gateFor } from './abuse';
import { experimentalLensesEnabled } from './experimental';

export interface TherapyPack {
  threadId: number;
  markdown: string;
  episodeNotes: number;
  reflections: number;
  questions: string[];
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pc = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const pctR = (x: number) => `${Math.round(x * 100)}%`;
const DAY = 86_400_000;

/** A care banner whenever a death-wish disclosure exists on EITHER side. The crisis resource is never
 *  suppressed by age — recency only sharpens the wording. An archive that ends before a quiet stretch
 *  (common once someone has left) must still ship the 988 line to the person reading it. */
function safetyBanner(f: Findings): string | null {
  const dw = f.ledger.entries.filter((e) => e.category === 'death_wish');
  if (!dw.length) return null;
  const latest = Math.max(...f.ledger.entries.map((e) => e.ms), 0);
  const recent = dw.filter((e) => latest - e.ms <= 45 * DAY);
  const mine = dw.filter((e) => e.dir === 'me').length;
  const hers = dw.filter((e) => e.dir === 'them').length;
  const lead = recent.length
    ? `**Read this first.** Within the last six weeks of this record, the unsurvivable thing was said — these are not old wounds; they are recent.`
    : `**Read this first.** Somewhere in this record, the unsurvivable thing was said — ${mine} time(s) by you, ${hers} time(s) by her.`;
  return [
    `> ${lead}`,
    '> This brief is a mirror, not a ruling. If "I want to die" is still true for either of you, the next move is a person, not a text —',
    '> in the US, call or text **988** (Suicide & Crisis Lifeline); outside the US, contact your local crisis line or tell someone who can sit with you today.',
  ].join('\n');
}

function questionSeeds(db: BetweenDB, threadId: number): string[] {
  const out: string[] = [];
  const rows = db.raw
    .prepare(`SELECT r.result_json AS j FROM analysis_results r JOIN analysis_jobs jo ON jo.id = r.job_id
              WHERE r.lens = 'first_reflection_reduce' AND jo.chunk_ref LIKE '%"thread_id":' || ? || '%'`)
    .all(threadId) as { j: string }[];
  for (const row of rows) {
    try { const seed = (JSON.parse(row.j) as { question_seed?: string }).question_seed; if (seed) out.push(seed); } catch { /* skip */ }
  }
  return out;
}

export function buildTherapyPack(db: BetweenDB, threadId: number, opts: { generatedAt?: string | null } = {}): TherapyPack {
  const traj = computeTrajectory(db, threadId);
  const eras = getEras(db, threadId);
  const episodes = getEpisodes(db, threadId);
  const narrated = episodes
    .filter((e) => e.narrative && typeof e.narrative === 'object' && (e.narrative as { note?: unknown }).note)
    .sort((a, b) => (b.severeMe + b.severeThem) - (a.severeMe + a.severeThem))
    .slice(0, 3);
  // Append-only reflections: id is the true creation order, so id DESC = newest first (more reliable
  // than the date-only generated_at stamps, which tie). Carries the two most recent — findings + letter.
  const reflections = db.raw
    .prepare('SELECT lens, content_md AS md, generated_at AS at FROM reflections WHERE thread_id = ? ORDER BY id DESC')
    .all(threadId) as { lens: string; md: string; at: string }[];

  // deterministic trajectory headline over the whole span
  const tot = traj.months.reduce((s, m) => ({
    hostileMe: s.hostileMe + m.hostileMe, hostileThem: s.hostileThem + m.hostileThem,
    severeMe: s.severeMe + m.severeMe, severeThem: s.severeThem + m.severeThem,
    recip: s.recip + m.recip, soft: s.soft + m.soft, withdrew: s.withdrew + m.withdrew, denom: s.denom + m.recipDenom,
  }), { hostileMe: 0, hostileThem: 0, severeMe: 0, severeThem: 0, recip: 0, soft: 0, withdrew: 0, denom: 0 });

  const questions = [...questionSeeds(db, threadId), ...eras.filter((e) => e.summary).map((e) => e.summary!)].slice(0, 3);
  const findings = getFindings(db, threadId) ?? computeFindings(db, threadId);
  const gate = gateFor(db, threadId);   // calibration-aware: an uncalibrated archive never ships a support verdict

  const parts: string[] = [];
  parts.push(`# Between — session brief (thread ${threadId})\n`);
  parts.push(`_Generated ${opts.generatedAt ?? '(unset)'}. Assembled from frozen, receipt-validated readings — no new interpretation. Texts carry less than half of any conversation._\n`);
  parts.push(`> **For the clinician reading this:** please read **docs/METHOD.md** before trusting any number here — it explains what each finding measures, what the power-balance gate does and doesn't mean, and the tool's limits. The counts are deterministic keyword/pattern reads over a noisy channel: weigh them, don't tally them. This is a mirror, not a ruling.\n`);

  const banner = safetyBanner(findings);
  if (banner) { parts.push(banner); parts.push(''); }

  parts.push('## What the record shows\n');
  parts.push(`- Hostile messages: her ${tot.hostileThem.toLocaleString()} vs you ${tot.hostileMe.toLocaleString()}; the cruelest (severe): her ${tot.severeThem.toLocaleString()} vs you ${tot.severeMe.toLocaleString()}.`);
  parts.push(`- When she came in hostile, you answered: hostile ${pc(tot.recip, tot.denom)} · soft ${pc(tot.soft, tot.denom)} · withdrew ${pc(tot.withdrew, tot.denom)}.`);
  if (traj.delugeDays.length) parts.push(`- ${traj.delugeDays.length} "deluge" days (≥${traj.delugeMin} of her hostile messages in one day).`);
  parts.push('');

  parts.push('## The eras\n');
  parts.push('| era | span | her hostile share | who initiates |');
  parts.push('|---|---|---|---|');
  for (const e of eras) {
    const s = e.stats;
    parts.push(`| ${e.name ?? '—'} | ${iso(e.startMs)} → ${iso(e.endMs)} | ${pc(Math.round((s.hostShareThem ?? 0) * 100), 100)} | ${pc(Math.round((s.themInitShare ?? 0) * 100), 100)} her |`);
  }
  parts.push('');

  // ── the five findings (A–E), deterministic ──
  const F = findings;
  parts.push('## The five findings\n');
  parts.push(`- **The hands.** Keyword disclosures of physical harm — weigh, don't tally: you ${F.ledger.byDir.physical.me} · her ${F.ledger.byDir.physical.them}. Death-wishes said to each other: you ${F.ledger.byDir.death_wish.me} · her ${F.ledger.byDir.death_wish.them}.`);
  parts.push(`- **The kids.** "My kids" vs "our kids": you ${F.kidsFraming.total.myMe}/${F.kidsFraming.total.ourMe}, her ${F.kidsFraming.total.myThem}/${F.kidsFraming.total.ourThem} — she claims them more than she shares them.`);
  parts.push(`- **The apologies.** You repaired first ${F.apology.firstRepairAfterPeak.me}× vs her ${F.apology.firstRepairAfterPeak.them}× (${F.apology.firstRepairAfterPeak.none} fights healed by no one). Your apologies met with fire ${pctR(F.apology.metWithFire.me.rate)} vs hers ${pctR(F.apology.metWithFire.them.rate)} — you reached more and were burned more.`);
  const firstEra = F.exitSignature.byEra.find((e) => e.total);
  const lastEra = [...F.exitSignature.byEra].reverse().find((e) => e.total);
  if (firstEra && lastEra) parts.push(`- **How you leave.** Silent exits rose from ${pctR(firstEra.counts.withdraw_silent / firstEra.total)} (${firstEra.name}) to ${pctR(lastEra.counts.withdraw_silent / lastEra.total)} (${lastEra.name}) — you stopped meeting fire with fire and started leaving the room.`);
  const w = F.wearingDown.quarters;
  if (w.length) parts.push(`- **The wearing down.** "I love you" fell to ~1% of your messages and stayed there, even as you kept writing more words — still talking, no longer saying it.`);
  parts.push('');

  // ── the honest framing that must travel with this brief (handoff-critical) ──
  parts.push('## How to read this honestly\n');
  // EXPERIMENTAL GATE (P1-11): the directional/support reading is shown ONLY when the owner has opted
  // into the experimental layer. Otherwise the packet carries the deterministic counts and no verdict.
  if (experimentalLensesEnabled(db)) {
    parts.push(`- **Direction, gated:** ${gate.stance.frame}${gate.stance.direction ? ` toward ${gate.stance.direction}` : ''} (confidence ${gate.stance.confidence.toFixed(2)}). This is a timeline, not a static verdict — read direction over time, never as a ruling on the whole relationship. This directional layer is experimental and not externally validated.`);
  } else {
    parts.push('- **Direction:** not shown. Between’s directional/support reading is an experimental, text-only layer — off by default, not externally validated. Only the deterministic counts above are shown; weigh them, do not tally them.');
  }
  const bias = ((): { verdict?: string; note?: string } => { try { return JSON.parse(db.getMeta('self_report_bias') ?? '{}'); } catch { return {}; } })();
  parts.push(`- **Calibration asymmetry:** ${bias.verdict ?? 'unknown'}. ${bias.note ?? ''} The whole method only calibrates if the owner was honest and vulnerable about their OWN part — that is the hard requirement, and it cannot be verified from the outside.`);
  parts.push('');

  if (narrated.length) {
    parts.push('## A few episodes, with the words underneath\n');
    for (const e of narrated) {
      const n = e.narrative as { title?: string; note?: string };
      parts.push(`### ${n.title ?? iso(e.startMs)} (${iso(e.startMs)})`);
      parts.push(n.note ?? '');
      parts.push('');
    }
  }

  // Carry the two most recent frozen readings (typically the findings reading + the letter).
  const carry = reflections.slice(0, 2);
  if (carry.length) {
    parts.push('## The readings\n');
    for (const r of carry) { parts.push(r.md); parts.push(''); }
  }

  if (questions.length) {
    parts.push('## Questions the data raises\n');
    for (const q of questions) parts.push(`- ${q}`);
    parts.push('');
  }

  return { threadId, markdown: parts.join('\n'), episodeNotes: narrated.length, reflections: reflections.length, questions };
}
