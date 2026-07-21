// Between — ambient/baseline stats: the just-interesting, sentiment-free descriptive layer. Pure
// counting over messages — no model calls, no gates, no interpretation. Rhythm (when you text),
// cadence (how fast, who first), language (word maps, emoji, length, questions, "I love you"), and
// volume. Cached under metrics key='ambient'. Hour-of-day is UTC unless a tzOffsetHours is given.
import type { BetweenDB } from '../store/db';

const H = 3_600_000;
const DAY = 86_400_000;
const REPLY_CAP_MS = 6 * H; // gaps longer than this aren't "replies" (overnight / next conversation)

const STOP = new Set([
  'the', 'and', 'you', 'for', 'that', 'was', 'have', 'this', 'with', 'but', 'not', 'are', 'your',
  'its', 'just', 'like', 'get', 'got', 'can', 'will', 'what', 'when', 'out', 'now', 'she', 'him',
  'her', 'his', 'them', 'they', 'then', 'from', 'about', 'would', 'could', 'should', 'been', 'were',
  'has', 'had', 'did', 'does', 'dont', 'didnt', 'cant', 'wont', 'thats', 'youre', 'ive', 'yeah',
  'okay', ' good', 'know', 'want', 'need', 'going', 'gonna', 'really', 'much', 'some', 'any', 'all',
  'one', 'two', 'how', 'why', 'who', 'because', 'there', 'here', 'their', 'our', 'more', 'off', 'too',
]);

export interface WordN { w: string; n: number }
export interface EmojiN { e: string; n: number }

export interface AmbientStats {
  threadId: number;
  tzOffsetHours: number;
  volume: { total: number; me: number; them: number; activeDays: number; firstMs: number; lastMs: number; byYear: { year: number; me: number; them: number }[] };
  rhythm: {
    hourOfDay: { hour: number; me: number; them: number }[]; // 24
    dayOfWeek: { dow: number; me: number; them: number }[];   // 7, 0=Sun
    busiestDay: { date: string; count: number };
    longestStreakDays: number;
    longestSilenceDays: number;
  };
  cadence: { medianReplyMinMe: number; medianReplyMinThem: number; firstOfDay: { me: number; them: number } };
  language: {
    topWordsMe: WordN[]; topWordsThem: WordN[]; topEmoji: EmojiN[];
    avgWordsMe: number; avgWordsThem: number;
    questionRateMe: number; questionRateThem: number;
    iLoveYou: { me: number; them: number };
  };
  monthlyVolume: { ym: string; me: number; them: number }[];
  extras: {
    endearments: { me: number; them: number };   // baby / babe / honey / …
    goodnight: { me: number; them: number };
    goodmorning: { me: number; them: number };
    apologies: { me: number; them: number };
    doubleTextRate: { me: number; them: number }; // fraction of one's messages that follow one's own
    lastOfDay: { me: number; them: number };      // who sends the day's final message
    longestMessages: { dir: 'me' | 'them'; words: number; preview: string }[];
    busiestMonths: { ym: string; count: number }[];
  };
}

interface Flat2 { ms: number; me: boolean; body: string }
const ENDEAR = /\b(baby|babe|honey|hon|sweetheart|sweetie|darling|boo|bae|my love|beautiful|handsome)\b/i;
const GNIGHT = /\b(goodnight|good night|g'?night|nite|night night|sweet dreams)\b/i;
const GMORN = /\b(good ?morning|goodmorning|gm)\b/i;
const APOL = /\b(sorry|apologi[sz]e|my bad|i was wrong|forgive me)\b/i;

/** Second, cheap pass over the messages for the extra "fun facts". Uses the same local wall-clock. */
function computeExtras(M: Flat2[], dateStr: (ms: number) => string): Pick<AmbientStats, 'monthlyVolume' | 'extras'> {
  const month = new Map<string, { me: number; them: number }>();
  const endear = { me: 0, them: 0 }, goodnight = { me: 0, them: 0 }, goodmorning = { me: 0, them: 0 }, apologies = { me: 0, them: 0 };
  let dblMe = 0, dblThem = 0;
  const lastDir = new Map<string, boolean>();
  const longest: { dir: 'me' | 'them'; words: number; preview: string }[] = [];
  const dayTotal = new Map<string, number>();

  for (let i = 0; i < M.length; i++) {
    const m = M[i];
    const ds = dateStr(m.ms), ym = ds.slice(0, 7);
    const mc = month.get(ym) ?? { me: 0, them: 0 }; mc[m.me ? 'me' : 'them']++; month.set(ym, mc);
    dayTotal.set(ds, (dayTotal.get(ds) ?? 0) + 1);
    lastDir.set(ds, m.me); // overwrite → last message of the day wins
    const side = m.me ? 'me' : 'them';
    if (ENDEAR.test(m.body)) endear[side]++;
    if (GNIGHT.test(m.body)) goodnight[side]++;
    if (GMORN.test(m.body)) goodmorning[side]++;
    if (APOL.test(m.body)) apologies[side]++;
    if (i > 0 && M[i - 1].me === m.me) { if (m.me) dblMe++; else dblThem++; }
    const words = (m.body.match(/\S+/g) ?? []).length;
    if (words > (longest[longest.length - 1]?.words ?? 0) || longest.length < 5) {
      longest.push({ dir: side, words, preview: m.body.replace(/\s+/g, ' ').trim().slice(0, 120) });
      longest.sort((a, b) => b.words - a.words); if (longest.length > 5) longest.length = 5;
    }
  }
  const meTot = M.filter((m) => m.me).length, themTot = M.length - meTot;
  const lastOfDay = { me: 0, them: 0 };
  for (const isMe of lastDir.values()) lastOfDay[isMe ? 'me' : 'them']++;
  const round1 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    monthlyVolume: [...month.entries()].sort().map(([ym, v]) => ({ ym, ...v })),
    extras: {
      endearments: endear, goodnight, goodmorning, apologies,
      doubleTextRate: { me: round1(meTot ? dblMe / meTot : 0), them: round1(themTot ? dblThem / themTot : 0) },
      lastOfDay, longestMessages: longest,
      busiestMonths: [...month.entries()].map(([ym, v]) => ({ ym, count: v.me + v.them })).sort((a, b) => b.count - a.count).slice(0, 6),
    },
  };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x: number) => Math.round(x * 10) / 10;

export function computeAmbient(db: BetweenDB, threadId: number, opts: { tzOffsetHours?: number } = {}): AmbientStats {
  const tz = opts.tzOffsetHours ?? 0;
  const rows = db.raw
    .prepare(`SELECT sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages
              WHERE thread_id = ? AND is_reaction = 0 AND trim(coalesce(body_text,'')) != ''
              ORDER BY sent_at_ms ASC, id ASC`)
    .all(threadId) as { ms: number; dir: string; body: string }[];
  const M = rows.map((r) => ({ ms: r.ms, me: r.dir === 'outgoing' || r.dir === 'draft', body: r.body ?? '' }));

  const empty = (): AmbientStats => ({
    threadId, tzOffsetHours: tz,
    volume: { total: 0, me: 0, them: 0, activeDays: 0, firstMs: 0, lastMs: 0, byYear: [] },
    rhythm: { hourOfDay: Array.from({ length: 24 }, (_, hour) => ({ hour, me: 0, them: 0 })), dayOfWeek: Array.from({ length: 7 }, (_, dow) => ({ dow, me: 0, them: 0 })), busiestDay: { date: '', count: 0 }, longestStreakDays: 0, longestSilenceDays: 0 },
    cadence: { medianReplyMinMe: 0, medianReplyMinThem: 0, firstOfDay: { me: 0, them: 0 } },
    language: { topWordsMe: [], topWordsThem: [], topEmoji: [], avgWordsMe: 0, avgWordsThem: 0, questionRateMe: 0, questionRateThem: 0, iLoveYou: { me: 0, them: 0 } },
    monthlyVolume: [],
    extras: { endearments: { me: 0, them: 0 }, goodnight: { me: 0, them: 0 }, goodmorning: { me: 0, them: 0 }, apologies: { me: 0, them: 0 }, doubleTextRate: { me: 0, them: 0 }, lastOfDay: { me: 0, them: 0 }, longestMessages: [], busiestMonths: [] },
  });
  if (!M.length) return empty();

  const local = (ms: number) => new Date(ms + tz * H); // shift then read UTC fields = local wall clock
  const dateStr = (ms: number) => local(ms).toISOString().slice(0, 10);

  // volume
  const byYear = new Map<number, { me: number; them: number }>();
  const dayCount = new Map<string, number>();
  const hour = Array.from({ length: 24 }, (_, h) => ({ hour: h, me: 0, them: 0 }));
  const dow = Array.from({ length: 7 }, (_, d) => ({ dow: d, me: 0, them: 0 }));
  const firstOfDayDir = new Map<string, boolean>(); // date -> first sender is me?
  let me = 0, them = 0;
  const wordsMe = new Map<string, number>(), wordsThem = new Map<string, number>(), emoji = new Map<string, number>();
  let sumWordsMe = 0, sumWordsThem = 0, qMe = 0, qThem = 0, ilyMe = 0, ilyThem = 0;
  const replyMe: number[] = [], replyThem: number[] = [];
  const emojiRe = new RegExp('\\p{Extended_Pictographic}(?:\\uFE0F|\\u200D\\p{Extended_Pictographic})*', 'gu'); // full emoji seqs

  for (let i = 0; i < M.length; i++) {
    const m = M[i];
    const d = local(m.ms);
    const y = d.getUTCFullYear();
    if (m.me) me++; else them++;
    const yr = byYear.get(y) ?? { me: 0, them: 0 }; if (m.me) yr.me++; else yr.them++; byYear.set(y, yr);
    const ds = dateStr(m.ms);
    dayCount.set(ds, (dayCount.get(ds) ?? 0) + 1);
    if (!firstOfDayDir.has(ds)) firstOfDayDir.set(ds, m.me);
    hour[d.getUTCHours()][m.me ? 'me' : 'them']++;
    dow[d.getUTCDay()][m.me ? 'me' : 'them']++;

    // cadence: a reply is a message from the other side within the cap
    if (i > 0 && M[i - 1].me !== m.me) { const gap = m.ms - M[i - 1].ms; if (gap > 0 && gap <= REPLY_CAP_MS) (m.me ? replyMe : replyThem).push(gap / 60000); }

    // language
    const wc = (m.body.match(/[a-z']{3,}/gi) ?? []);
    if (m.me) sumWordsMe += wc.length; else sumWordsThem += wc.length;
    const wmap = m.me ? wordsMe : wordsThem;
    for (const raw of wc) { const w = raw.toLowerCase(); if (STOP.has(w) || w.length < 3) continue; wmap.set(w, (wmap.get(w) ?? 0) + 1); }
    for (const e of m.body.match(emojiRe) ?? []) emoji.set(e, (emoji.get(e) ?? 0) + 1);
    if (m.body.includes('?')) { if (m.me) qMe++; else qThem++; }
    if (/\bi\s+love\s+you\b/i.test(m.body)) { if (m.me) ilyMe++; else ilyThem++; }
  }

  // streak + silence over active days
  const days = [...dayCount.keys()].sort();
  let streak = 1, longestStreak = 1, longestSilence = 0;
  for (let i = 1; i < days.length; i++) {
    const gap = Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY);
    if (gap === 1) { streak++; longestStreak = Math.max(longestStreak, streak); } else { streak = 1; longestSilence = Math.max(longestSilence, gap - 1); }
  }
  const busiest = [...dayCount.entries()].reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0] as [string, number]);
  const firstOfDay = { me: 0, them: 0 };
  for (const isMe of firstOfDayDir.values()) firstOfDay[isMe ? 'me' : 'them']++;

  const top = (m: Map<string, number>, key: 'w' | 'e', n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ [key]: k, n: v })) as any;

  return {
    threadId, tzOffsetHours: tz,
    volume: {
      total: M.length, me, them, activeDays: dayCount.size, firstMs: M[0].ms, lastMs: M[M.length - 1].ms,
      byYear: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, v]) => ({ year, ...v })),
    },
    rhythm: { hourOfDay: hour, dayOfWeek: dow, busiestDay: { date: busiest[0], count: busiest[1] }, longestStreakDays: longestStreak, longestSilenceDays: longestSilence },
    cadence: { medianReplyMinMe: round1(median(replyMe)), medianReplyMinThem: round1(median(replyThem)), firstOfDay },
    language: {
      topWordsMe: top(wordsMe, 'w', 30), topWordsThem: top(wordsThem, 'w', 30), topEmoji: top(emoji, 'e', 20),
      avgWordsMe: round1(me ? sumWordsMe / me : 0), avgWordsThem: round1(them ? sumWordsThem / them : 0),
      questionRateMe: round1(me ? (100 * qMe) / me : 0), questionRateThem: round1(them ? (100 * qThem) / them : 0),
      iLoveYou: { me: ilyMe, them: ilyThem },
    },
    ...computeExtras(M, dateStr),
  };
}

const METRIC_KEY = 'ambient';

export function refreshAmbient(db: BetweenDB, threadId: number, opts: { tzOffsetHours?: number } = {}): AmbientStats {
  const stats = computeAmbient(db, threadId, opts);
  db.raw
    .prepare(`INSERT OR REPLACE INTO metrics (thread_id, metric_key, period, period_start_ms, value_json) VALUES (?, ?, 'all', 0, ?)`)
    .run(threadId, METRIC_KEY, JSON.stringify(stats));
  return stats;
}

export function getAmbient(db: BetweenDB, threadId: number): AmbientStats | null {
  const row = db.raw
    .prepare(`SELECT value_json AS v FROM metrics WHERE thread_id = ? AND metric_key = ? AND period = 'all' AND period_start_ms = 0`)
    .get(threadId, METRIC_KEY) as { v: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.v) as AmbientStats; } catch { return null; }
}
