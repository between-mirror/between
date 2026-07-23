// Between — archive health: the report that has to be right before any other number is worth reading.
//
// The failure this lens exists to prevent is specific and quiet: a stretch of months that looks calm
// because the conversation moved somewhere the parser cannot see. The river will draw that as a
// peaceful season, the eras layer will name it, and the reader will believe something false about
// their own life. So these tests build archives with holes in them deliberately, and assert that the
// holes are reported as holes.
//
// Every fixture here is synthetic. Nothing in this file resembles anyone's real archive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { computeArchiveHealth, spanDiscontinuity } from '../src/lenses/archiveHealth';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'between-health-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const DAY = 86_400_000;
const OWNER = 1;
const OTHER = 2;

let dbSeq = 0;

/** A database with an owner, one other person, and one 1:1 thread. */
function makeDb(): BetweenDB {
  const db = openDb(join(dir, `h${dbSeq++}.db`));
  db.setMeta('owner_contact_id', String(OWNER));
  db.setMeta('tz_offset_hours', '0');
  db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'You')").run(OWNER);
  db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'Them')").run(OTHER);
  db.raw.prepare(
    "INSERT INTO threads (id, participant_signature, is_group, first_ms, last_ms, message_count) VALUES (1, 'sig-1', 0, 0, 0, 0)",
  ).run();
  for (const c of [OWNER, OTHER]) {
    db.raw.prepare('INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (1, ?, ?)')
      .run(c, c === OWNER ? 'owner' : 'member');
  }
  db.raw.prepare(
    "INSERT INTO source_files (id, path, content_sha256, imported_at, record_count, kind) VALUES (1, 'synthetic.xml', 'sha-1', ?, 0, 'android_smsbackup')",
  ).run(new Date(Date.UTC(2024, 0, 1)).toISOString());
  return db;
}

let msgSeq = 0;
function addMsg(db: BetweenDB, ms: number, from: number, opts: { attachment?: boolean; smilOnly?: boolean; reaction?: boolean } = {}): number {
  const id = ++msgSeq;
  db.raw.prepare(
    `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                           is_reaction, source_file_id, source_kind, dedup_key)
     VALUES (?, 1, ?, ?, ?, ?, 'x', ?, 1, 'android_smsbackup', ?)`,
  ).run(
    id, from, from === OWNER ? 'outgoing' : 'incoming',
    opts.attachment ? 'mms' : 'sms', ms, opts.reaction ? 1 : 0, `dk-${id}`,
  );
  if (opts.attachment) {
    db.raw.prepare(
      "INSERT INTO attachments (message_id, mime_type, is_smil) VALUES (?, ?, ?)",
    ).run(id, opts.smilOnly ? 'application/smil' : 'image/jpeg', opts.smilOnly ? 1 : 0);
  }
  return id;
}

/** n messages per day across a date range, alternating sides. */
function fill(db: BetweenDB, startMs: number, days: number, perDay: number, opts: { attachment?: boolean } = {}): void {
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      addMsg(db, startMs + d * DAY + i * 3_600_000, i % 2 === 0 ? OWNER : OTHER, opts);
    }
  }
}

const JAN2022 = Date.UTC(2022, 0, 1);

describe('the one-line version, for the surfaces that are not this report', () => {
  it('says nothing at all about a continuous archive', () => {
    // The hardest requirement to keep. A card that always looks concerned is one people learn to
    // scroll past, and it has then spent the attention it needs for the day something is wrong.
    const db = makeDb();
    fill(db, JAN2022, 200, 4);
    // Exported two days after the last message, as an ordinary backup is — otherwise the archive
    // genuinely does stop long before its own export, and saying so would be correct.
    db.raw.prepare('UPDATE source_files SET imported_at = ? WHERE id = 1')
      .run(new Date(JAN2022 + 202 * DAY).toISOString());
    const h = computeArchiveHealth(db, 1);

    expect(h.caution.level).toBe('clear');
    expect(h.caution.headline).toBeNull();
    expect(h.caution.reasons).toEqual([]);
    db.close();
  });

  it('does not escalate on an unconfirmed timezone alone', () => {
    // True of nearly every archive on first import. Counting it would put a permanent caution on
    // Home and teach the owner the card means nothing.
    const db = openDb(join(dir, `h-tz${dbSeq++}.db`));
    db.setMeta('owner_contact_id', String(OWNER));
    db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'You')").run(OWNER);
    db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'Them')").run(OTHER);
    db.raw.prepare(
      "INSERT INTO threads (id, participant_signature, is_group, first_ms, last_ms, message_count) VALUES (1, 'sig-tz', 0, 0, 0, 0)").run();
    for (const c of [OWNER, OTHER]) {
      db.raw.prepare('INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (1, ?, ?)')
        .run(c, c === OWNER ? 'owner' : 'member');
    }
    db.raw.prepare(
      "INSERT INTO source_files (id, path, content_sha256, imported_at, record_count, kind) VALUES (1, 'synthetic.xml', 'sha-tz', ?, 0, 'android_smsbackup')",
    ).run(new Date(JAN2022 + 202 * DAY).toISOString());
    fill(db, JAN2022, 200, 4);

    const h = computeArchiveHealth(db, 1);
    expect(h.timezone.assumed).toBe(true);
    expect(h.caution.level).toBe('clear');
    db.close();
  });

  it('escalates to serious for a season-long hole', () => {
    const db = makeDb();
    fill(db, JAN2022, 20, 4);
    fill(db, Date.UTC(2022, 6, 1), 20, 4);           // Feb–Jun absent
    const h = computeArchiveHealth(db, 1);

    expect(h.caution.level).toBe('serious');
    expect(h.caution.headline).toBeTruthy();
    expect(h.caution.reasons.join(' ')).toContain('months in this span hold no messages');
    db.close();
  });

  it('escalates to serious when only one side is present', () => {
    const db = makeDb();
    for (let d = 0; d < 60; d++) addMsg(db, JAN2022 + d * DAY, OWNER);
    const h = computeArchiveHealth(db, 1);

    expect(h.suspicions.lopsided).toBe(true);
    expect(h.caution.level).toBe('serious');
    db.close();
  });

  it('never speaks in verdicts, exclamations, or pass/fail', () => {
    const db = makeDb();
    fill(db, JAN2022, 20, 4);
    fill(db, Date.UTC(2022, 6, 1), 20, 4);
    const h = computeArchiveHealth(db, 1);

    const all = [h.caution.headline ?? '', ...h.caution.reasons].join(' ');
    expect(all).not.toMatch(/!/);
    expect(all.toLowerCase()).not.toMatch(/\b(fail|failed|bad|broken|corrupt|invalid|error)\b/);
    db.close();
  });
});

describe('the line a reading carries when its own span has holes', () => {
  it('stays quiet over a stretch that is fully covered', () => {
    const db = makeDb();
    fill(db, JAN2022, 200, 4);
    const h = computeArchiveHealth(db, 1);

    expect(spanDiscontinuity(h, JAN2022, JAN2022 + 60 * DAY)).toBeNull();
    db.close();
  });

  it('names the holes inside the span the reading actually covers', () => {
    const db = makeDb();
    fill(db, JAN2022, 20, 4);
    fill(db, Date.UTC(2022, 6, 1), 20, 4);           // Feb–Jun absent
    const h = computeArchiveHealth(db, 1);

    const line = spanDiscontinuity(h, JAN2022, Date.UTC(2022, 6, 20));
    expect(line).toContain('5 months with no messages at all');
    db.close();
  });

  it('ignores holes that fall outside the reading', () => {
    // A reading over a clean stretch must not inherit a caveat earned by a different year, or the
    // line becomes noise and gets ignored where it matters.
    const db = makeDb();
    fill(db, JAN2022, 20, 4);
    fill(db, Date.UTC(2022, 6, 1), 120, 4);          // Feb–Jun absent, then a solid run
    const h = computeArchiveHealth(db, 1);

    expect(spanDiscontinuity(h, Date.UTC(2022, 7, 1), Date.UTC(2022, 9, 1))).toBeNull();
    db.close();
  });
});

describe('archive health — the span and what is in it', () => {
  it('reports the months, including the ones with nothing in them', () => {
    const db = makeDb();
    fill(db, JAN2022, 31, 2);                       // January
    fill(db, Date.UTC(2022, 3, 1), 30, 2);          // April — February and March are empty
    const h = computeArchiveHealth(db, 1);

    expect(h.span.months, 'Jan..Apr inclusive').toBe(4);
    expect(h.months.map((m) => m.month)).toEqual(['2022-01', '2022-02', '2022-03', '2022-04']);
    // The empty months are PRESENT with a zero, not missing from the list. A reader scanning the
    // report has to be able to see the hole; an absent row is invisible.
    expect(h.months[1].total).toBe(0);
    expect(h.months[2].total).toBe(0);
    db.close();
  });

  it('collapses consecutive empty months into one gap, with the messages either side', () => {
    const db = makeDb();
    fill(db, JAN2022, 5, 3);
    fill(db, Date.UTC(2022, 5, 1), 5, 3);           // Feb-May empty
    const h = computeArchiveHealth(db, 1);

    expect(h.gaps).toHaveLength(1);
    expect(h.gaps[0].fromMonth).toBe('2022-02');
    expect(h.gaps[0].toMonth).toBe('2022-05');
    expect(h.gaps[0].months).toBe(4);
    // The point of these two is that the owner can go and look at what was happening either side.
    expect(h.gaps[0].lastBeforeMs).toBeGreaterThan(0);
    expect(h.gaps[0].firstAfterMs).toBeGreaterThan(h.gaps[0].lastBeforeMs!);
    db.close();
  });

  it('excludes reactions from the counts and says how many it excluded', () => {
    const db = makeDb();
    fill(db, JAN2022, 10, 2);
    for (let i = 0; i < 7; i++) addMsg(db, JAN2022 + i * DAY, OTHER, { reaction: true });
    const h = computeArchiveHealth(db, 1);

    expect(h.volume.total).toBe(20);
    expect(h.volume.reactions).toBe(7);
    db.close();
  });

  it('measures thin months against this archive, not against a universal idea of chatty', () => {
    // A quiet relationship is not a broken archive. What matters is a month that is quiet relative
    // to its own neighbours.
    const db = makeDb();
    for (let m = 0; m < 6; m++) fill(db, Date.UTC(2022, m, 1), 20, 5);   // ~100/month
    fill(db, Date.UTC(2022, 6, 1), 1, 2);                                 // July: 2 messages
    const h = computeArchiveHealth(db, 1);

    expect(h.thinMonths).toContain('2022-07');
    expect(h.thinMonths).not.toContain('2022-03');
    db.close();
  });

  it('a uniformly quiet archive has no thin months at all', () => {
    const db = makeDb();
    for (let m = 0; m < 6; m++) fill(db, Date.UTC(2022, m, 1), 3, 1);     // 3/month throughout
    const h = computeArchiveHealth(db, 1);
    expect(h.thinMonths, 'quiet is not the same as missing').toEqual([]);
    db.close();
  });
});

describe('archive health — the signals that the conversation moved', () => {
  it('notices when attachments stop long before the messages do', () => {
    // The clearest available tell that picture messages went to RCS or iMessage: MMS traffic
    // stops, plain texts carry on.
    const db = makeDb();
    fill(db, JAN2022, 60, 2, { attachment: true });
    fill(db, JAN2022 + 61 * DAY, 300, 2);
    const h = computeArchiveHealth(db, 1);

    expect(h.suspicions.attachmentsStopEarly).toBe(true);
    expect(h.attachments.lastMonthWithAny).toBe('2022-03');
    db.close();
  });

  it('does not cry migration when attachments run to the end', () => {
    const db = makeDb();
    fill(db, JAN2022, 200, 2, { attachment: true });
    const h = computeArchiveHealth(db, 1);
    expect(h.suspicions.attachmentsStopEarly).toBe(false);
    db.close();
  });

  it('notices a trailing collapse — the archive thinning out and never recovering', () => {
    const db = makeDb();
    fill(db, JAN2022, 500, 4);                       // ~4/day for most of two years
    // Then a trickle: fifteen messages scattered across the final three months. This is the shape of
    // a conversation that moved channel, not one that ended — the thread never actually stops.
    for (let i = 0; i < 15; i++) addMsg(db, JAN2022 + (505 + i * 6) * DAY, i % 2 ? OWNER : OTHER);
    const h = computeArchiveHealth(db, 1);
    expect(h.suspicions.trailingCollapse).toBe(true);
    db.close();
  });

  it('notices when the archive ends long before it was exported', () => {
    // A partial restore looks exactly like a relationship that stopped.
    const db = makeDb();
    fill(db, Date.UTC(2021, 0, 1), 60, 3);          // ends early 2021; import stamped 2024
    const h = computeArchiveHealth(db, 1);
    expect(h.suspicions.endsLongBeforeImport).toBe(true);
    db.close();
  });

  it('notices a one-sided archive', () => {
    const db = makeDb();
    for (let d = 0; d < 60; d++) addMsg(db, JAN2022 + d * DAY, OWNER);
    for (let d = 0; d < 3; d++) addMsg(db, JAN2022 + d * DAY, OTHER);
    const h = computeArchiveHealth(db, 1);
    expect(h.suspicions.lopsided, 'a restore that dropped one side reads as silence').toBe(true);
    db.close();
  });

  it('attributes messages the way the real ingest writes them, not the way a fixture might', () => {
    // The bug this exists for: the lens counted owner-side messages by comparing sender_contact_id to
    // the owner contact id. The owner is not a contacts row, so real outgoing messages carry a NULL or
    // foreign sender_contact_id — and the demo archive, 394 sent against 393 received, was reported as
    // 0 from the owner and 787 from the other person, and flagged as a broken one-sided restore.
    //
    // The fixtures above did not catch it because they set direction and sender_contact_id
    // consistently, which the real importer does not. So this one writes the awkward shape on purpose:
    // balanced by DIRECTION, with sender_contact_id never once equal to the owner.
    const db = makeDb();
    for (let d = 0; d < 60; d++) {
      const out = d * DAY + JAN2022;
      db.raw.prepare(
        `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                               is_reaction, source_file_id, source_kind, dedup_key)
         VALUES (?, 1, NULL, 'outgoing', 'sms', ?, 'x', 0, 1, 'android_smsbackup', ?)`,
      ).run(++msgSeq, out, `dk-out-${msgSeq}`);
      db.raw.prepare(
        `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                               is_reaction, source_file_id, source_kind, dedup_key)
         VALUES (?, 1, ?, 'incoming', 'sms', ?, 'x', 0, 1, 'android_smsbackup', ?)`,
      ).run(++msgSeq, OTHER, out + 3_600_000, `dk-in-${msgSeq}`);
    }

    const h = computeArchiveHealth(db, 1);

    expect(h.volume.me, 'owner-side messages must be counted by direction').toBe(60);
    expect(h.volume.them).toBe(60);
    expect(h.suspicions.lopsided, 'a balanced archive must not be called one-sided').toBe(false);
    db.close();
  });

  it('a healthy archive raises none of the four suspicions', () => {
    // The guard against a report that always looks alarming: an ordinary archive must come back clean,
    // or the whole surface becomes noise the reader learns to skip.
    const db = makeDb();
    fill(db, JAN2022, 400, 3, { attachment: true });
    db.raw.prepare("UPDATE source_files SET imported_at = ? WHERE id = 1")
      .run(new Date(JAN2022 + 402 * DAY).toISOString());
    const h = computeArchiveHealth(db, 1);

    expect(h.suspicions).toEqual({
      attachmentsStopEarly: false,
      trailingCollapse: false,
      endsLongBeforeImport: false,
      lopsided: false,
    });
    expect(h.gaps).toEqual([]);
    db.close();
  });
});

describe('archive health — what it says about itself', () => {
  it('reports the timezone as assumed when nobody has confirmed one', () => {
    const db = makeDb();
    db.raw.prepare("DELETE FROM app_meta WHERE key = 'tz_offset_hours'").run();
    fill(db, JAN2022, 5, 2);
    const h = computeArchiveHealth(db, 1);
    // Hour-of-day and day-boundaries all rest on this. If it is a guess, it says so.
    expect(h.timezone.assumed).toBe(true);
    db.close();
  });

  it('does not claim an assumption when the owner set one', () => {
    const db = makeDb();
    fill(db, JAN2022, 5, 2);
    const h = computeArchiveHealth(db, 1);
    expect(h.timezone.assumed).toBe(false);
    db.close();
  });

  it('flags a person reachable at several identifiers', () => {
    // Two numbers merged into one contact is usually right and occasionally wrong; either way the
    // owner should know it happened before reading anything about who said what.
    const db = makeDb();
    db.raw.prepare("INSERT INTO identifiers (contact_id, raw_value, normalized_e164, kind) VALUES (?, '5550000001', '+15550000001', 'mobile')").run(OTHER);
    db.raw.prepare("INSERT INTO identifiers (contact_id, raw_value, normalized_e164, kind) VALUES (?, '5550000002', '+15550000002', 'mobile')").run(OTHER);
    fill(db, JAN2022, 5, 2);
    const h = computeArchiveHealth(db, 1);

    const amb = h.identity.ambiguous.find((a) => a.contactId === OTHER);
    expect(amb?.identifierCount).toBe(2);
    db.close();
  });

  it('does not charge one thread with the whole archive\'s collapsed rows', () => {
    // `collapsed` subtracted an ARCHIVE-WIDE stored count from a THREAD-SCOPED declared count, so a
    // thread holding five of the archive's messages could report a collapse total belonging to
    // thirty conversations — and dedup.ts rests its honesty case on this number. Two threads, two
    // files: 8 records declared, 6 rows stored, 2 genuinely collapsed. Whatever the number means,
    // it must not exceed what the archive actually dropped.
    const db = makeDb();
    db.raw.prepare(
      "INSERT INTO threads (id, participant_signature, is_group, first_ms, last_ms, message_count) VALUES (2, 'sig-2', 0, 0, 0, 0)",
    ).run();
    db.raw.prepare(
      "INSERT INTO source_files (id, path, content_sha256, imported_at, record_count, kind) VALUES (2, 'second.xml', 'sha-2', ?, 4, 'android_smsbackup')",
    ).run(new Date(Date.UTC(2024, 0, 2)).toISOString());
    db.raw.prepare('UPDATE source_files SET record_count = 4 WHERE id = 1').run();
    // Three rows in thread 1, three in thread 2 — six stored against eight declared.
    fill(db, JAN2022, 3, 1);
    for (let i = 0; i < 3; i++) {
      const id = ++msgSeq;
      db.raw.prepare(
        `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms,
                               body_text, is_reaction, source_file_id, source_kind, dedup_key)
         VALUES (?, 2, ?, 'incoming', 'sms', ?, 'x', 0, 2, 'android_smsbackup', ?)`,
      ).run(id, OTHER, JAN2022 + i * DAY, `dk2-${id}`);
    }

    const one = computeArchiveHealth(db, 1);
    const two = computeArchiveHealth(db, 2);
    expect(one.duplicates.collapsed).toBe(2);
    expect(two.duplicates.collapsed).toBe(2);
    db.close();
  });

  it('survives an empty thread without inventing a span', () => {
    const db = makeDb();
    const h = computeArchiveHealth(db, 1);
    expect(h.volume.total).toBe(0);
    expect(h.span.months).toBe(0);
    expect(h.months).toEqual([]);
    expect(h.gaps).toEqual([]);
    db.close();
  });
});
