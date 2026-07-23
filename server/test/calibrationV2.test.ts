// Between — calibration rubric v2.
//
// The calibration is the one place the tool asks the owner to be a witness against themselves, and
// everything directional downstream leans on the answer. So these tests are about the two ways the
// exercise can be worthless while appearing to work: a sample that could never have disagreed with
// the model, and a threshold chosen behind the owner's back.
//
// All fixtures synthetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import {
  sampleHoldout, reviewCalibration, applyCalibration, biasLabelsFromMarks,
  bandOf, rng, defaultSeed, deriveThresholds, RUBRIC_VERSION,
} from '../src/lenses/calibrate';
import { calibrationStatus } from '../src/lenses/calibration';
import { computeSelfReportBias } from '../src/lenses/bias';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'between-cal2-')); });
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

const OWNER = 1;
const OTHER = 2;
const T0 = Date.UTC(2022, 0, 1);
let seq = 0;

/**
 * An archive with a KNOWN tension distribution: `spread` messages per side across the model's three
 * bands. The l1 emotion rows are written directly, which is what emotionByMessage reads.
 */
function makeDb(perBand = 12): BetweenDB {
  const db = openDb(join(dir, `c${seq++}.db`));
  db.setMeta('owner_contact_id', String(OWNER));
  db.setMeta('tz_offset_hours', '0');
  db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'You')").run(OWNER);
  db.raw.prepare("INSERT INTO contacts (id, display_name) VALUES (?, 'Them')").run(OTHER);
  db.raw.prepare(
    "INSERT INTO threads (id, participant_signature, is_group, first_ms, last_ms, message_count) VALUES (1, 'sig-cal', 0, 0, 0, 0)").run();
  for (const c of [OWNER, OTHER]) {
    db.raw.prepare('INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (1, ?, ?)')
      .run(c, c === OWNER ? 'owner' : 'member');
  }
  db.raw.prepare(
    "INSERT INTO source_files (id, path, content_sha256, imported_at, record_count, kind) VALUES (1, 's.xml', 'sha-cal', ?, 0, 'android_smsbackup')",
  ).run(new Date(T0).toISOString());

  let id = 0;
  const insM = db.raw.prepare(
    `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                           is_reaction, source_file_id, source_kind, dedup_key)
     VALUES (?, 1, ?, ?, 'sms', ?, ?, 0, 1, 'android_smsbackup', ?)`);
  const rows: { id: number; tension: number }[] = [];
  for (const dir_ of ['outgoing', 'incoming'] as const) {
    for (const tension of [0, 1, 2]) {
      for (let k = 0; k < perBand; k++) {
        id += 1;
        insM.run(id, dir_ === 'outgoing' ? OWNER : OTHER, dir_, T0 + id * 60_000,
          `message ${id} at tension ${tension}`, `dk-${id}`);
        rows.push({ id, tension });
      }
    }
  }
  // The model's own read, which the owner never sees. One L1 window covering the whole thread —
  // emotionByMessage reaches it through the job's chunk_ref, so the job row is not optional.
  const chunk = JSON.stringify({
    thread_id: 1, start_msg_id: 1, end_msg_id: id,
    member_ids: rows.map((r) => r.id), overlap_prefix_ids: [],
  });
  db.raw.prepare(
    `INSERT INTO analysis_jobs (id, input_hash, lens, kind, chunk_ref, prompt_id, prompt_version, created_at)
     VALUES ('job_cal', 'h-cal', 'l1_emotion', 'map', ?, 'l1', 1, ?)`,
  ).run(chunk, new Date(T0).toISOString());
  db.raw.prepare(
    `INSERT INTO analysis_results (input_hash, job_id, lens, result_json, created_at)
     VALUES ('h-cal', 'job_cal', 'l1_emotion', ?, ?)`,
  ).run(JSON.stringify({
    messages: rows.map((r) => ({ message_id: `m${r.id}`, valence: 0, warmth: 0, tension: r.tension })),
  }), new Date(T0).toISOString());
  return db;
}

describe('the sample can actually disagree with the model', () => {
  it('draws from all three model-tension bands, on both sides', () => {
    // v1 sorted each side by the model's tension and took the top spread, so the owner labelled
    // almost only messages the model already called hostile — and those labels were then used to
    // validate the model's threshold. Selecting on the variable you are about to validate against
    // leaves nothing to disagree about.
    const db = makeDb();
    const s = sampleHoldout(db, 1, 42);

    for (const side of ['ME', 'THEM'] as const) {
      for (const band of ['low', 'mid', 'high'] as const) {
        expect(s.strata[side][band], `${side}/${band} was never sampled`).toBeGreaterThan(0);
      }
    }
    db.close();
  });

  it('draws both sides in equal measure', () => {
    const db = makeDb();
    const s = sampleHoldout(db, 1, 42);
    const me = s.items.filter((i) => i.dir === 'ME').length;
    const them = s.items.filter((i) => i.dir === 'THEM').length;
    expect(Math.abs(me - them)).toBeLessThanOrEqual(1);
    db.close();
  });

  it('never leaks the model score the owner is supposed to label blind', () => {
    const db = makeDb();
    const s = sampleHoldout(db, 1, 42);
    for (const item of s.items) {
      expect(Object.keys(item).sort()).toEqual(['dir', 'id', 'ms', 'text']);
    }
    db.close();
  });
});

describe('the draw is seeded, and therefore reproducible', () => {
  it('gives the same sample twice for the same seed', () => {
    const db = makeDb();
    const a = sampleHoldout(db, 1, 42, 12345);
    const b = sampleHoldout(db, 1, 42, 12345);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    db.close();
  });

  it('gives a different sample for a different seed', () => {
    // Otherwise "seeded" would be decoration over a fixed order, and a re-calibration would show
    // the owner the same forty messages forever.
    const db = makeDb();
    const a = sampleHoldout(db, 1, 42, 1);
    const b = sampleHoldout(db, 1, 42, 999);
    expect(a.items.map((i) => i.id)).not.toEqual(b.items.map((i) => i.id));
    db.close();
  });

  it('defaults to a seed derived from the archive, not the clock', () => {
    const db = makeDb();
    expect(defaultSeed(db, 1)).toBe(defaultSeed(db, 1));
    expect(sampleHoldout(db, 1, 42).seed).toBe(defaultSeed(db, 1));
    db.close();
  });

  it('the generator itself is deterministic and in range', () => {
    const a = rng(7); const b = rng(7);
    for (let i = 0; i < 50; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('bands follow the model’s own categories', () => {
    expect(bandOf(0)).toBe('low');
    expect(bandOf(0.9)).toBe('low');
    expect(bandOf(1)).toBe('mid');
    expect(bandOf(2)).toBe('high');
    expect(bandOf(3)).toBe('high');
  });
});

describe('disagreement is shown, never silently resolved', () => {
  const marksFor = (db: BetweenDB, label: (tension: number) => string) => {
    const rows = db.raw.prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[];
    const scores = db.raw.prepare('SELECT result_json FROM analysis_results').all() as { result_json: string }[];
    const tension = new Map<number, number>();
    for (const s of scores) {
      const p = JSON.parse(s.result_json) as { messages: { message_id: string; tension: number }[] };
      for (const m of p.messages) tension.set(Number(m.message_id.slice(1)), m.tension);
    }
    return rows.map((r) => ({ id: r.id, label: label(tension.get(r.id) ?? 0) }));
  };

  it('writes nothing to the database', () => {
    // The whole point of the review step. v1 went from labels straight to persisted thresholds.
    const db = makeDb();
    const marks = marksFor(db, (t) => (t >= 2 ? 'name_calling' : 'none'));
    reviewCalibration(db, 1, marks);

    expect(db.getMeta('calibration')).toBeNull();
    expect(db.getMeta('self_report_bias')).toBeNull();
    expect(calibrationStatus(db).calibrated).toBe(false);
    db.close();
  });

  it('lists the messages the owner and the model read differently, and which way', () => {
    const db = makeDb();
    // The owner calls every LOW-tension message hard and nothing else — maximal disagreement, in a
    // direction the model can see.
    const marks = marksFor(db, (t) => (t === 0 ? 'threat' : 'none'));
    const review = reviewCalibration(db, 1, marks);

    expect(review.disagreements.length).toBeGreaterThan(0);
    expect(review.disagreements.some((d) => d.kind === 'owner_harder')).toBe(true);
    expect(review.disagreements.some((d) => d.kind === 'model_harder')).toBe(true);
    for (const d of review.disagreements) {
      expect(d.text.length).toBeGreaterThan(0);   // the owner has to be able to re-read it
      expect(['ME', 'THEM']).toContain(d.dir);
    }
    db.close();
  });

  it('reports no disagreement when the owner and the model agree', () => {
    const db = makeDb();
    const marks = marksFor(db, (t) => (t >= 2 ? 'name_calling' : 'none'));
    const review = reviewCalibration(db, 1, marks);
    expect(review.disagreements).toEqual([]);
    db.close();
  });
});

describe('honest labels never produce a harsher reading than the default', () => {
  it('keeps the neutral prior when the owner reports no hard messages', () => {
    // The failure this exists for. With zero hostile labels the F1 sweep has no positives to fit:
    // every candidate threshold scores 0, `f > bestH` is true only for the FIRST, and t = 1 wins on
    // tie-break. So an owner who honestly answered "nothing of the kind" to all forty-two came out
    // with hostile >= 1 — STRICTER than the shipped 2 — and was told they were calibrated, which
    // also drops the provisional warning from every directional surface. The person who reported the
    // least hostility got the reading with the most. It is the common case, not an edge one: v2 has
    // no catch-all "mild", and two thirds of the stratified draw is the model's low and mid bands.
    const labels = Array.from({ length: 42 }, (_, i) => ({
      dir: (i % 2 === 0 ? 'ME' : 'THEM') as 'ME' | 'THEM',
      tension: i % 3,
      label: 'none',
    }));
    expect(deriveThresholds(labels)).toEqual({ hostile_tension: 2, severe_tension: 3 });
  });

  it('keeps the neutral prior when the model scored nothing at all', () => {
    // Same shape from the other direction: with no L1 pass run, every tension is 0 and every band is
    // 'low'. Nothing gates the calibration on emotion coverage.
    const labels = Array.from({ length: 42 }, (_, i) => ({
      dir: (i % 2 === 0 ? 'ME' : 'THEM') as 'ME' | 'THEM',
      tension: 0,
      label: i % 5 === 0 ? 'dismissal' : 'none',
    }));
    const t = deriveThresholds(labels);
    expect(t.hostile_tension).toBeGreaterThanOrEqual(2);
  });

  it('keeps the neutral prior when every message sits in one tension band', () => {
    // The same degeneracy as the two above, one step further along. With a few genuine hostile
    // labels the sweep runs — but if the model put every message in one band, exactly ONE candidate
    // threshold predicts anything, and because it predicts everything it scores above zero and wins
    // uncontested while the others sit at a zero they could never have beaten. The labels did not
    // choose hostile >= 1; it was the only option allowed to score, and the owner marked three
    // messages out of forty-two.
    const labels = Array.from({ length: 42 }, (_, i) => ({
      dir: (i % 2 === 0 ? 'ME' : 'THEM') as 'ME' | 'THEM',
      tension: 1,
      label: i < 3 ? 'name_calling' : 'none',
    }));
    expect(deriveThresholds(labels)).toEqual({ hostile_tension: 2, severe_tension: 3 });
  });

  it('still tunes when there is real hostility to tune against', () => {
    const labels = [
      ...Array.from({ length: 12 }, () => ({ dir: 'THEM' as const, tension: 3, label: 'name_calling' })),
      ...Array.from({ length: 12 }, () => ({ dir: 'ME' as const, tension: 0, label: 'none' })),
    ];
    const t = deriveThresholds(labels);
    expect(t.hostile_tension).toBeGreaterThanOrEqual(1);
    expect(t.severe_tension).toBeGreaterThan(t.hostile_tension - 1);
  });
});

describe('the record says which rubric it was taken under', () => {
  it('stamps rubric_version and the seed on commit', () => {
    const db = makeDb();
    const marks = (db.raw.prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[])
      .map((r) => ({ id: r.id, label: 'none' }));
    const res = applyCalibration(db, biasLabelsFromMarks(db, 1, marks), { seed: 4242 });

    expect(res.rubricVersion).toBe(RUBRIC_VERSION);
    const stored = JSON.parse(db.getMeta('calibration')!) as Record<string, unknown>;
    expect(stored.rubric_version).toBe(2);
    expect(stored.seed).toBe(4242);
    expect(calibrationStatus(db).rubricVersion).toBe(2);
    db.close();
  });

  it('leaves a v1 record valid, and does not relabel it as v2', () => {
    // Someone who calibrated under the old rubric answered a different question honestly. Their
    // thresholds are still theirs; the dishonest move would be to reinterpret their answers.
    const db = makeDb();
    db.setMeta('calibration', JSON.stringify({ hostile_tension: 1, severe_tension: 3 }));
    db.setMeta('self_report_bias', JSON.stringify({ verdict: 'balanced' }));

    const status = calibrationStatus(db);
    expect(status.calibrated).toBe(true);
    expect(status.rubricVersion).toBe(1);
    expect(status.note).toContain('earlier rubric');
    db.close();
  });
});

describe('the honesty check reads both rubrics', () => {
  it('treats v2 observable labels as hard messages', () => {
    const labels = [
      ...Array.from({ length: 10 }, () => ({ dir: 'ME' as const, tension: 3, label: 'none' })),
      ...Array.from({ length: 10 }, () => ({ dir: 'THEM' as const, tension: 3, label: 'name_calling' })),
    ];
    const bias = computeSelfReportBias(labels);
    // Owner called none of their own hard messages hard, and all of the partner's. Self-lenient.
    expect(bias.verdict).toBe('self_lenient');
  });

  it('still treats v1 severity labels as hard messages', () => {
    const labels = [
      ...Array.from({ length: 10 }, () => ({ dir: 'ME' as const, tension: 3, label: 'benign' })),
      ...Array.from({ length: 10 }, () => ({ dir: 'THEM' as const, tension: 3, label: 'cruel' })),
    ];
    expect(computeSelfReportBias(labels).verdict).toBe('self_lenient');
  });

  it('does not count a repair attempt as hostility', () => {
    const labels = [
      ...Array.from({ length: 10 }, () => ({ dir: 'ME' as const, tension: 3, label: 'repair' })),
      ...Array.from({ length: 10 }, () => ({ dir: 'THEM' as const, tension: 3, label: 'repair' })),
    ];
    const bias = computeSelfReportBias(labels);
    expect(bias.selfHostileRate).toBe(0);
    expect(bias.otherHostileRate).toBe(0);
  });
});
