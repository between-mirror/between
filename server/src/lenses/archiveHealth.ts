// Between — archive health: what is actually IN this archive, quantified, before anything interprets it.
//
// Every other lens in this directory answers "what does the archive say". This one answers the
// question that has to come first: "how much of the relationship is in here at all".
//
// The reason it is a first-class surface rather than a footnote is that the most dangerous output
// this software can produce is a calm stretch caused by missing data. A month with four messages in
// it does not mean a quiet month; it usually means the conversation moved — to RCS, to iMessage, to
// WhatsApp, to the phone, to the kitchen. The river will happily draw that month as untroubled, the
// eras layer will fold it into a season, and a reader will conclude something false about their own
// life. Coverage caveats on individual charts were not enough, because they annotate a picture the
// reader has already believed.
//
// Everything here is deterministic counting. No model, no thresholds learned from anyone, no
// interpretation — it reports shape and names what that shape is CONSISTENT with, never what it
// means. "Twelve months below the floor, and the drop coincides with the end of MMS traffic" is a
// fact plus a hypothesis the owner can confirm in a second; "you drifted apart in 2021" is not
// something this file will ever say.
import type { BetweenDB } from '../store/db';
import type { SourceKind, SourceSpan } from '../types';

const DAY = 86_400_000;

/** Owner-side, by the same rule every other lens uses. A draft is something you wrote. */
const isMine = (dir: string): boolean => dir === 'outgoing' || dir === 'draft';

/** A month bucket, in the owner's lived timezone, with what was and was not in it. */
export interface MonthCoverage {
  /** 'YYYY-MM' */
  month: string;
  total: number;
  me: number;
  them: number;
  /** Messages carrying at least one attachment part — the MMS signal. */
  withAttachments: number;
  /** Days in the month that carry at least one message. */
  activeDays: number;
  daysInMonth: number;
  /** True when this month is far enough below the archive's own norm to be suspect. */
  belowFloor: boolean;
}

/** A stretch of consecutive months with no messages at all. */
export interface Gap {
  fromMonth: string;
  toMonth: string;
  months: number;
  /** The last message before the gap and the first after, so the owner can go look. */
  lastBeforeMs: number | null;
  firstAfterMs: number | null;
}

export interface IdentityAmbiguity {
  contactId: number;
  /** How many distinct identifiers (numbers/addresses) resolve to this person. */
  identifierCount: number;
  /** Messages attributed to them across all of those identifiers. */
  messages: number;
}

export interface ArchiveHealth {
  threadId: number;
  tzOffsetHours: number;

  source: {
    /** Distinct source files this thread's messages came from. */
    files: number;
    /**
     * One entry per format that contributed to this thread, each with its own span.
     *
     * Per-source rather than one label, because in a mixed archive the single most misleading thing
     * to report is a total. "SMS through March 2024, WhatsApp from January 2023" is a different
     * statement about what can be seen than "4,000 messages, 2019–2024", and only the first one
     * lets the owner notice that a year has only one source standing behind it.
     */
    spans: SourceSpan[];
    importedAt: string | null;
  };

  span: {
    firstMs: number;
    lastMs: number;
    /** Whole months from first to last message, inclusive. */
    months: number;
    /** Days between first and last that carry at least one message. */
    activeDays: number;
    /** activeDays as a share of the calendar days in the span. */
    activeDayShare: number;
  };

  volume: {
    total: number;
    me: number;
    them: number;
    /** Reactions are excluded from every metric; counted here so the number is not a mystery. */
    reactions: number;
    median: { perActiveDay: number; perMonth: number };
  };

  months: MonthCoverage[];

  /** Months with no messages at all, collapsed into runs. */
  gaps: Gap[];

  /** Months present but far below this archive's own norm. */
  thinMonths: string[];

  attachments: {
    /** Messages with at least one attachment. */
    messages: number;
    /** Of those, how many carry only a SMIL layout part and no real media. */
    smilOnly: number;
    /** The last month in which any attachment appears — the migration tell. */
    lastMonthWithAny: string | null;
  };

  /**
   * Signals that the archive is missing conversation rather than reflecting a quiet period.
   *
   * Each is a fact and a hypothesis, never a conclusion. The owner is the only one who knows whether
   * they changed phones in March.
   */
  suspicions: {
    /** Attachments stop well before the archive does — consistent with a move to RCS or iMessage. */
    attachmentsStopEarly: boolean;
    /** Volume falls off a cliff and never recovers — consistent with the conversation moving. */
    trailingCollapse: boolean;
    /** The archive ends long before it was exported — consistent with a partial backup. */
    endsLongBeforeImport: boolean;
    /** One side is drastically under-represented — consistent with a one-sided restore. */
    lopsided: boolean;
  };

  group: {
    isGroup: boolean;
    /** Other threads sharing a participant with this one, which can bleed context. */
    relatedThreads: number;
  };

  duplicates: {
    /** Rows the ingest collapsed via dedup_key — reported so "we deduped" is a number, not a claim. */
    collapsed: number;
  };

  identity: {
    ambiguous: IdentityAmbiguity[];
  };

  timezone: {
    offsetHours: number;
    /** True when the offset is an assumption rather than something the owner confirmed. */
    assumed: boolean;
  };

  /**
   * The one-line version, for surfaces that are not this report.
   *
   * Home shows this and nothing else. The full report is a page someone has to choose to open, and
   * the reader who most needs it is exactly the reader who will not go looking — they came to see
   * the river, the river looks calm, and the calm is the missing data. So the escalation travels to
   * where they already are.
   *
   * It escalates QUIETLY and it stays silent when there is nothing to say. A card that always looks
   * concerned is a card people learn to scroll past, and then it is worth less than nothing, because
   * it has spent the attention it would need on the day something is actually wrong.
   */
  caution: {
    level: 'clear' | 'notable' | 'serious';
    /** Null when level is 'clear' — the card renders nothing at all rather than reassurance. */
    headline: string | null;
    /** The facts underneath, so the card can be specific instead of ominous. */
    reasons: string[];
  };
}

/** Local-time month key for an epoch ms, at a fixed offset. */
function monthKey(ms: number, tzOffsetHours: number): string {
  const d = new Date(ms + tzOffsetHours * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(ms: number, tzOffsetHours: number): string {
  const d = new Date(ms + tzOffsetHours * 3_600_000);
  return d.toISOString().slice(0, 10);
}

function daysInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Every month key from a to b inclusive, so absent months are visible rather than merely missing. */
function monthRange(a: string, b: string): string[] {
  const out: string[] = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function computeArchiveHealth(
  db: BetweenDB,
  threadId: number,
  opts: { tzOffsetHours?: number } = {},
): ArchiveHealth {
  const metaTz = db.getMeta('tz_offset_hours');
  const tzAssumed = opts.tzOffsetHours == null && metaTz == null;
  const tz = opts.tzOffsetHours ?? (metaTz != null ? Number(metaTz) : 0);

  const ownerId = Number(db.getMeta('owner_contact_id') ?? 0);

  // Reactions are excluded from every other metric, so they are excluded here too — and counted
  // separately, because an unexplained gap between "messages" and "rows" invites the wrong theory.
  // `direction`, not sender_contact_id — the same rule every other lens uses (ambient, ask, episodes,
  // calibrate all read `dir === 'outgoing' || dir === 'draft'`). The owner is not a contacts row, so
  // sender_contact_id is never the owner id, and using it reported the demo archive as 0 messages from
  // the owner and 787 from the other person: a perfectly balanced conversation flagged as a broken
  // one-sided restore. A wrong warning on this surface is worse than none, because this is the surface
  // that tells you whether to believe the others.
  const rows = db.raw.prepare(
    `SELECT m.id, m.sent_at_ms, m.direction, m.is_reaction, m.kind,
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS att,
            (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id AND a.is_smil = 1) AS smil
       FROM messages m
      WHERE m.thread_id = ?
      ORDER BY m.sent_at_ms ASC`,
  ).all(threadId) as {
    id: number; sent_at_ms: number; direction: string;
    is_reaction: number; kind: string; att: number; smil: number;
  }[];

  const msgs = rows.filter((r) => !r.is_reaction);
  const reactions = rows.length - msgs.length;

  if (msgs.length === 0) {
    return emptyHealth(threadId, tz, tzAssumed);
  }

  const firstMs = msgs[0].sent_at_ms;
  const lastMs = msgs[msgs.length - 1].sent_at_ms;

  // ── month buckets, including the empty ones ────────────────────────────────
  const byMonth = new Map<string, { total: number; me: number; them: number; att: number; days: Set<string> }>();
  for (const r of msgs) {
    const k = monthKey(r.sent_at_ms, tz);
    let b = byMonth.get(k);
    if (!b) { b = { total: 0, me: 0, them: 0, att: 0, days: new Set() }; byMonth.set(k, b); }
    b.total += 1;
    if (isMine(r.direction)) b.me += 1; else b.them += 1;
    if (r.att > 0) b.att += 1;
    b.days.add(dayKey(r.sent_at_ms, tz));
  }

  const allMonths = monthRange(monthKey(firstMs, tz), monthKey(lastMs, tz));

  // The floor is relative to this archive, not to some universal idea of a chatty month. A quiet
  // relationship is not a broken archive; a month that is quiet RELATIVE TO ITSELF is the signal.
  const populated = allMonths.map((k) => byMonth.get(k)?.total ?? 0).filter((n) => n > 0);
  const monthMedian = median(populated);
  const floor = Math.max(1, Math.round(monthMedian * 0.15));

  const months: MonthCoverage[] = allMonths.map((k) => {
    const b = byMonth.get(k);
    const total = b?.total ?? 0;
    return {
      month: k,
      total,
      me: b?.me ?? 0,
      them: b?.them ?? 0,
      withAttachments: b?.att ?? 0,
      activeDays: b?.days.size ?? 0,
      daysInMonth: daysInMonth(k),
      belowFloor: total > 0 && total < floor,
    };
  });

  // ── gaps: runs of entirely empty months ───────────────────────────────────
  const gaps: Gap[] = [];
  let runStart: string | null = null;
  for (let i = 0; i < months.length; i++) {
    const empty = months[i].total === 0;
    if (empty && runStart == null) runStart = months[i].month;
    if ((!empty || i === months.length - 1) && runStart != null) {
      const end = empty ? months[i].month : months[i - 1].month;
      const before = msgs.filter((r) => monthKey(r.sent_at_ms, tz) < runStart!).at(-1) ?? null;
      const after = msgs.find((r) => monthKey(r.sent_at_ms, tz) > end) ?? null;
      gaps.push({
        fromMonth: runStart,
        toMonth: end,
        months: monthRange(runStart, end).length,
        lastBeforeMs: before?.sent_at_ms ?? null,
        firstAfterMs: after?.sent_at_ms ?? null,
      });
      runStart = null;
    }
  }

  // ── attachments and the migration tell ────────────────────────────────────
  const withAtt = msgs.filter((r) => r.att > 0);
  const smilOnly = msgs.filter((r) => r.att > 0 && r.att === r.smil).length;
  const lastAttMs = withAtt.at(-1)?.sent_at_ms ?? null;
  const lastMonthWithAny = lastAttMs != null ? monthKey(lastAttMs, tz) : null;

  // Attachments stopping months before the archive does is the clearest available signal that
  // picture messages moved to a channel this parser cannot see.
  const attachmentsStopEarly =
    withAtt.length > 0 && lastAttMs != null && (lastMs - lastAttMs) > 120 * DAY;

  // A trailing collapse: the last quarter of the span carries a small fraction of the norm.
  const tailStart = lastMs - 90 * DAY;
  const tailCount = msgs.filter((r) => r.sent_at_ms >= tailStart).length;
  const spanDays = Math.max(1, (lastMs - firstMs) / DAY);
  const perDay = msgs.length / spanDays;
  const trailingCollapse = spanDays > 365 && tailCount < perDay * 90 * 0.2;

  const importedAtRaw = db.raw.prepare(
    `SELECT MAX(sf.imported_at) AS at, COUNT(DISTINCT sf.id) AS files
       FROM source_files sf
       JOIN messages m ON m.source_file_id = sf.id
      WHERE m.thread_id = ?`,
  ).get(threadId) as { at: string | null; files: number } | undefined;

  // Per-format spans, read from what each row actually recorded rather than from one label for the
  // whole archive. Before this column existed, every import — WhatsApp, generic, anything — was
  // reported here as "Android SMS Backup & Restore XML", on the one surface whose entire job is to
  // tell the owner what they are looking at.
  const spans = db.raw.prepare(
    `SELECT COALESCE(source_kind, 'unknown') AS kind,
            MIN(sent_at_ms) AS firstMs, MAX(sent_at_ms) AS lastMs, COUNT(*) AS messages
       FROM messages
      WHERE thread_id = ? AND is_reaction = 0
      GROUP BY COALESCE(source_kind, 'unknown')
      ORDER BY firstMs`,
  ).all(threadId) as { kind: SourceKind; firstMs: number; lastMs: number; messages: number }[];

  const importedMs = importedAtRaw?.at ? Date.parse(importedAtRaw.at) : NaN;
  const endsLongBeforeImport = Number.isFinite(importedMs) && (importedMs - lastMs) > 180 * DAY;

  const me = msgs.filter((r) => isMine(r.direction)).length;
  const them = msgs.length - me;
  const lopsided = msgs.length >= 50 && (me === 0 || them === 0 || Math.min(me, them) / Math.max(me, them) < 0.1);

  // ── group contamination ───────────────────────────────────────────────────
  const thread = db.raw.prepare('SELECT is_group FROM threads WHERE id = ?').get(threadId) as { is_group: number } | undefined;
  const related = db.raw.prepare(
    `SELECT COUNT(DISTINCT tp2.thread_id) AS n
       FROM thread_participants tp1
       JOIN thread_participants tp2 ON tp2.contact_id = tp1.contact_id
      WHERE tp1.thread_id = ? AND tp2.thread_id != ? AND tp1.contact_id != ?`,
  ).get(threadId, threadId, ownerId) as { n: number } | undefined;

  // ── duplicates collapsed at ingest ────────────────────────────────────────
  // This is an ARCHIVE-WIDE number and is now computed as one on both sides. It used to subtract an
  // archive-wide stored count from a thread-scoped declared count — two different populations — so
  // every thread displayed the whole archive's collapse total as if it were its own: on an archive
  // of thirty conversations, each panel claimed tens of thousands of collapsed rows. dedup.ts rests
  // its honesty case on this figure, which made a wrong number worse than no number.
  //
  // It cannot honestly be made per-thread FROM THIS SUBTRACTION. The declared side is
  // `source_files.record_count` — a count of a whole file, and one file feeds many conversations —
  // so there is no per-thread declared figure to subtract a per-thread stored figure from. (The
  // insert does know which thread a collapsed row would have joined; nothing records it, and
  // inventing an apportionment here would be worse than naming the number's real scope.)
  const declared = db.raw.prepare(
    `SELECT COALESCE(SUM(record_count), 0) AS declared FROM source_files`,
  ).get() as { declared: number } | undefined;
  const totalStored = db.raw.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  const collapsed = Math.max(0, (declared?.declared ?? 0) - totalStored.n);

  // ── identity ambiguity ────────────────────────────────────────────────────
  const ambiguous = db.raw.prepare(
    `SELECT c.id AS contactId, COUNT(DISTINCT i.id) AS identifierCount,
            (SELECT COUNT(*) FROM messages m WHERE m.sender_contact_id = c.id AND m.thread_id = ?) AS messages
       FROM contacts c
       JOIN identifiers i ON i.contact_id = c.id
       JOIN thread_participants tp ON tp.contact_id = c.id AND tp.thread_id = ?
      GROUP BY c.id
     HAVING identifierCount > 1`,
  ).all(threadId, threadId) as IdentityAmbiguity[];

  const activeDays = new Set(msgs.map((r) => dayKey(r.sent_at_ms, tz))).size;
  const spanCalendarDays = Math.max(1, Math.round((lastMs - firstMs) / DAY) + 1);

  return {
    threadId,
    tzOffsetHours: tz,
    source: {
      files: importedAtRaw?.files ?? 0,
      spans,
      importedAt: importedAtRaw?.at ?? null,
    },
    span: {
      firstMs,
      lastMs,
      months: allMonths.length,
      activeDays,
      activeDayShare: activeDays / spanCalendarDays,
    },
    volume: {
      total: msgs.length,
      me,
      them,
      reactions,
      median: {
        perActiveDay: median(Object.values(
          msgs.reduce<Record<string, number>>((acc, r) => {
            const k = dayKey(r.sent_at_ms, tz); acc[k] = (acc[k] ?? 0) + 1; return acc;
          }, {}),
        )),
        perMonth: monthMedian,
      },
    },
    months,
    gaps,
    thinMonths: months.filter((m) => m.belowFloor).map((m) => m.month),
    attachments: {
      messages: withAtt.length,
      smilOnly,
      lastMonthWithAny,
    },
    suspicions: {
      attachmentsStopEarly,
      trailingCollapse,
      endsLongBeforeImport,
      lopsided,
    },
    group: {
      isGroup: !!thread?.is_group,
      relatedThreads: related?.n ?? 0,
    },
    duplicates: { collapsed },
    identity: { ambiguous },
    timezone: { offsetHours: tz, assumed: tzAssumed },
    caution: summarize(
      gaps,
      months.filter((m) => m.belowFloor).map((m) => m.month),
      allMonths.length,
      { attachmentsStopEarly, trailingCollapse, endsLongBeforeImport, lopsided },
    ),
  };
}

/** Whole months with nothing in them, across every gap. */
function missingMonths(gaps: Gap[]): number {
  return gaps.reduce((n, g) => n + g.months, 0);
}

/**
 * Reduce the report to one line, and decide how loudly to say it.
 *
 * Deterministic thresholds, written down rather than tuned: a gap of a season or more, a side that
 * barely appears, or a conversation that falls off and never returns are the shapes where a reading
 * would be describing an absence. Everything else that fires is worth a quieter word.
 *
 * The timezone assumption is deliberately NOT an escalation. It is true of nearly every archive on
 * first import, so counting it would put a caution on Home permanently and teach the owner that the
 * card means nothing. It is stated plainly in the full report instead.
 */
function summarize(
  gaps: Gap[], thinMonths: string[], totalMonths: number,
  suspicions: ArchiveHealth['suspicions'],
): ArchiveHealth['caution'] {
  const reasons: string[] = [];
  const absent = missingMonths(gaps);
  const longestGap = gaps.reduce((n, g) => Math.max(n, g.months), 0);

  if (absent > 0) {
    reasons.push(absent === 1
      ? 'One month in this span holds no messages at all.'
      : `${absent} months in this span hold no messages at all.`);
  }
  if (thinMonths.length > 0) {
    reasons.push(thinMonths.length === 1
      ? 'One month is far quieter than this archive’s own normal.'
      : `${thinMonths.length} months are far quieter than this archive’s own normal.`);
  }
  if (suspicions.attachmentsStopEarly) {
    reasons.push('Picture messages stop months before the conversation does, which is what it looks like when photos moved to a channel this archive cannot see.');
  }
  if (suspicions.trailingCollapse) {
    reasons.push('The conversation falls off near the end and does not come back.');
  }
  if (suspicions.endsLongBeforeImport) {
    reasons.push('The archive stops well before the day it was exported.');
  }
  if (suspicions.lopsided) {
    reasons.push('Almost everything here is from one side, which is the shape of a backup that only saved half the conversation.');
  }

  const serious = longestGap >= 3 || suspicions.lopsided || suspicions.trailingCollapse;
  const thinShare = totalMonths > 0 ? thinMonths.length / totalMonths : 0;
  const notable = reasons.length > 0 || thinShare >= 0.25;

  if (serious) {
    return {
      level: 'serious',
      headline: 'Some of this conversation is not in the archive. Read the shapes below knowing that.',
      reasons,
    };
  }
  if (notable) {
    return {
      level: 'notable',
      headline: 'There are stretches this archive cannot see.',
      reasons,
    };
  }
  return { level: 'clear', headline: null, reasons: [] };
}

/**
 * The line that rides in a reading's header when the span it covers has holes in it.
 *
 * A reading is the surface where an absence does the most damage, because prose fills gaps that a
 * chart at least leaves visibly empty — three missing months become "a quieter season" in a sentence
 * that reads perfectly well. This says so at the top, every time, before the prose gets its chance.
 *
 * Returns null when the covered span is continuous, so a reading over a well-covered stretch is not
 * decorated with a caveat it has not earned.
 */
export function spanDiscontinuity(
  health: ArchiveHealth, fromMs: number | null, toMs: number | null,
): string | null {
  // 0 means "the whole thread", not "the epoch". A reading over the entire conversation is stored
  // with range_start_ms = range_end_ms = 0 (firstReflection.ts writes `params.fromMs ?? 0` into a
  // NOT NULL column), and that is the ONLY range the UI can produce — the Analyze panel sends no
  // range at all. Treating 0 as a real timestamp made `to <= from` true and returned null for every
  // reading the product can actually generate, so this caveat existed and never once fired.
  const from = fromMs || health.span.firstMs;
  const to = toMs || health.span.lastMs;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;

  const tz = health.tzOffsetHours;
  const startKey = monthKey(from, tz);
  const endKey = monthKey(to, tz);
  const within = (key: string): boolean => key >= startKey && key <= endKey;

  const gapMonths = health.gaps
    .filter((g) => g.toMonth >= startKey && g.fromMonth <= endKey)
    .reduce((n, g) => n + monthRange(
      g.fromMonth > startKey ? g.fromMonth : startKey,
      g.toMonth < endKey ? g.toMonth : endKey,
    ).length, 0);
  const thin = health.thinMonths.filter(within).length;

  if (gapMonths === 0 && thin === 0) return null;

  const parts: string[] = [];
  if (gapMonths > 0) {
    parts.push(gapMonths === 1 ? 'one month with no messages at all' : `${gapMonths} months with no messages at all`);
  }
  if (thin > 0) {
    parts.push(thin === 1 ? 'one month far quieter than the rest' : `${thin} months far quieter than the rest`);
  }
  return `The span this reading covers has ${parts.join(' and ')}. `
    + 'What is missing from the archive is missing from the reading.';
}

function emptyHealth(threadId: number, tz: number, assumed: boolean): ArchiveHealth {
  return {
    threadId,
    tzOffsetHours: tz,
    source: { files: 0, spans: [], importedAt: null },
    span: { firstMs: 0, lastMs: 0, months: 0, activeDays: 0, activeDayShare: 0 },
    volume: { total: 0, me: 0, them: 0, reactions: 0, median: { perActiveDay: 0, perMonth: 0 } },
    months: [],
    gaps: [],
    thinMonths: [],
    attachments: { messages: 0, smilOnly: 0, lastMonthWithAny: null },
    suspicions: {
      attachmentsStopEarly: false, trailingCollapse: false,
      endsLongBeforeImport: false, lopsided: false,
    },
    group: { isGroup: false, relatedThreads: 0 },
    duplicates: { collapsed: 0 },
    identity: { ambiguous: [] },
    timezone: { offsetHours: tz, assumed },
    caution: { level: 'clear', headline: null, reasons: [] },
  };
}
