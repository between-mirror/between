// Findings CLI: `npx tsx server/src/cli/findings.ts --thread N [--db between.db]`.
// The final insight layer (A–E): ledger of hands, kids framing, apology economics, exit signature,
// wearing-down curve. Deterministic; caches to metrics key='findings'.
import { openDb } from '../store/db';
import { refreshFindings } from '../lenses/findings';

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; }
const pc = (x: number) => `${Math.round(x * 100)}%`;

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flag(argv, '--db') ?? 'between.db';
  const threadArg = flag(argv, '--thread');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) { console.error('usage: findings.ts --thread N'); process.exit(2); }
  const id = Number(threadArg);
  const db = openDb(dbPath);
  try {
    const f = refreshFindings(db, id);
    console.log(`\n=== thread ${id} — final findings (A–E) ===`);

    console.log(`\nA · THE LEDGER OF HANDS`);
    console.log(`  physical disclosures: you ${f.ledger.byDir.physical.me} · her ${f.ledger.byDir.physical.them}`);
    console.log(`  death-wishes:         you ${f.ledger.byDir.death_wish.me} · her ${f.ledger.byDir.death_wish.them}`);
    console.log(`  ${f.ledger.entries.length} entries total (verbatim + dated; exportable)`);

    console.log(`\nB · KIDS IN THE CROSSFIRE`);
    const k = f.kidsFraming.total;
    console.log(`  "my kids":  you ${k.myMe} · her ${k.myThem}     "our kids": you ${k.ourMe} · her ${k.ourThem}`);
    const ratio = (my: number, our: number) => (our ? (my / our).toFixed(2) : my ? '∞' : '0');
    console.log(`  my:our ratio — you ${ratio(k.myMe, k.ourMe)} · her ${ratio(k.myThem, k.ourThem)}  (higher = kids claimed, not shared)`);

    console.log(`\nC · THE APOLOGY ECONOMICS`);
    const r = f.apology.firstRepairAfterPeak;
    console.log(`  who repairs first after a fight: you ${r.me} · her ${r.them} · no repair ${r.none}`);
    console.log(`  apologies met with fire: yours ${pc(f.apology.metWithFire.me.rate)} (${f.apology.metWithFire.me.rejected}/${f.apology.metWithFire.me.total}) · hers ${pc(f.apology.metWithFire.them.rate)} (${f.apology.metWithFire.them.rejected}/${f.apology.metWithFire.them.total})`);

    console.log(`\nD · YOUR EXIT SIGNATURE (how you leave a fight), by era`);
    console.log(`  era                                   | met | softened | notice | silent | block`);
    for (const e of f.exitSignature.byEra) {
      const c = e.counts; const p = (n: number) => e.total ? pc(n / e.total).padStart(5) : '   — ';
      console.log(`  ${(e.name ?? '—').padEnd(37)} | ${p(c.met)}|${p(c.softened)}|${p(c.withdraw_notice)}|${p(c.withdraw_silent)}|${p(c.block_threat)}`);
    }

    console.log(`\nE · THE WEARING-DOWN CURVE (you), by year-ish — words · warmth · "i love you" · playful`);
    const yrs = new Map<string, typeof f.wearingDown.quarters>();
    for (const q of f.wearingDown.quarters) { const y = q.quarter.slice(0, 4); (yrs.get(y) ?? yrs.set(y, []).get(y)!).push(q); }
    for (const [y, qs] of yrs) {
      const avg = (sel: (q: typeof qs[0]) => number) => qs.reduce((s, q) => s + sel(q), 0) / qs.length;
      console.log(`  ${y}: words ${avg((q) => q.me.words).toFixed(1)} · warmth ${pc(avg((q) => q.me.warmthRate))} · ily ${pc(avg((q) => q.me.ilyRate))} · playful ${pc(avg((q) => q.me.playfulRate))}`);
    }
  } finally { db.close(); }
}
main();
