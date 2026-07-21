// Ambient stats CLI: `npx tsx server/src/cli/ambient.ts --thread N [--tz -6] [--db between.db]`.
// The just-interesting, sentiment-free baseline: rhythm, cadence, word maps, emoji. Deterministic.
import { openDb } from '../store/db';
import { refreshAmbient } from '../lenses/ambient';

function flag(argv: string[], name: string): string | undefined { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; }

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = flag(argv, '--db') ?? 'between.db';
  const threadArg = flag(argv, '--thread');
  const tz = flag(argv, '--tz');
  if (threadArg === undefined || !Number.isInteger(Number(threadArg))) { console.error('usage: ambient.ts --thread N [--tz -6] [--db between.db]'); process.exit(2); }
  const id = Number(threadArg);
  const db = openDb(dbPath);
  try {
    const a = refreshAmbient(db, id, { tzOffsetHours: tz != null ? Number(tz) : 0 });
    const v = a.volume, r = a.rhythm, c = a.cadence, l = a.language;
    console.log(`\n=== thread ${id} — the shape of it (hours are UTC${a.tzOffsetHours ? ` ${a.tzOffsetHours >= 0 ? '+' : ''}${a.tzOffsetHours}` : ''}) ===`);
    console.log(`\nVOLUME: ${v.total.toLocaleString()} messages (you ${v.me.toLocaleString()} / her ${v.them.toLocaleString()}) across ${v.activeDays.toLocaleString()} active days`);
    console.log(`  busiest single day: ${r.busiestDay.date} (${r.busiestDay.count} messages)`);
    console.log(`  longest daily streak: ${r.longestStreakDays} days · longest silence: ${r.longestSilenceDays} days`);

    const maxH = Math.max(...r.hourOfDay.map((h) => h.me + h.them), 1);
    console.log(`\nWHEN YOU TEXT (by hour):`);
    for (const h of r.hourOfDay) {
      const tot = h.me + h.them;
      const bar = '█'.repeat(Math.round((tot / maxH) * 40));
      console.log(`  ${String(h.hour).padStart(2, '0')}:00 ${bar} ${tot}`);
    }

    console.log(`\nCADENCE: your median reply ${c.medianReplyMinMe} min · hers ${c.medianReplyMinThem} min`);
    console.log(`  who speaks first each day: you ${c.firstOfDay.me} · her ${c.firstOfDay.them}`);

    console.log(`\nLANGUAGE:`);
    console.log(`  avg words/message: you ${l.avgWordsMe} · her ${l.avgWordsThem}   |   question rate: you ${l.questionRateMe}% · her ${l.questionRateThem}%`);
    console.log(`  "I love you": you said it ${l.iLoveYou.me} times · her ${l.iLoveYou.them}`);
    console.log(`  top emoji: ${l.topEmoji.slice(0, 12).map((e) => `${e.e}${e.n}`).join('  ')}`);
    console.log(`  your top words:  ${l.topWordsMe.slice(0, 15).map((w) => w.w).join(', ')}`);
    console.log(`  her top words:   ${l.topWordsThem.slice(0, 15).map((w) => w.w).join(', ')}`);

    const x = a.extras;
    console.log(`\nMORE:`);
    console.log(`  terms of endearment: you ${x.endearments.me} · her ${x.endearments.them}`);
    console.log(`  "goodnight": you ${x.goodnight.me} · her ${x.goodnight.them}   |   "good morning": you ${x.goodmorning.me} · her ${x.goodmorning.them}`);
    console.log(`  apologies: you ${x.apologies.me} · her ${x.apologies.them}`);
    console.log(`  who ends the day (last message): you ${x.lastOfDay.me} · her ${x.lastOfDay.them}`);
    console.log(`  double-texting: you ${(x.doubleTextRate.me * 100).toFixed(0)}% · her ${(x.doubleTextRate.them * 100).toFixed(0)}%`);
    console.log(`  busiest months: ${x.busiestMonths.map((m) => `${m.ym} (${m.count})`).join(' · ')}`);
    if (x.longestMessages[0]) console.log(`  longest message: ${x.longestMessages[0].words} words (${x.longestMessages[0].dir}) — "${x.longestMessages[0].preview}…"`);
  } finally { db.close(); }
}
main();
