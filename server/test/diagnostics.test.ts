// Between — the diagnostic bundle must be useful, and must never carry the archive.
//
// The whole point of this feature is that someone with a bug does not have to paste their own
// messages into a public issue to get help. That only works if the bundle is provably clean, so the
// central test here is crude on purpose: build a database in which every field that could leak is a
// distinctive nonsense string, generate the bundle, serialise it, and assert that not one of those
// strings survives anywhere in the output.
//
// A subtler test would be easier to fool. This one fails if anybody ever adds a field that reaches
// into the archive, including one nobody thought about while writing the assertion.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import type { BetweenDB } from '../src/store/db';
import { buildDiagnosticBundle } from '../src/lib/diagnostics';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'between-diag-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

// Every one of these is planted somewhere the bundle might reach. None may appear in the output.
const SECRETS = {
  bodyA: 'ZZQQ-MESSAGE-BODY-ALPHA',
  bodyB: 'ZZQQ-MESSAGE-BODY-BETA',
  contact: 'ZZQQ-CONTACT-NAME',
  rawNumber: 'ZZQQ5550001234',
  e164: '+15550001234',
  threadTitle: 'ZZQQ-THREAD-TITLE',
  sourcePath: 'ZZQQ-SOURCE-PATH.xml',
  filename: 'ZZQQ-ATTACHMENT-NAME.jpg',
  reflection: 'ZZQQ-FROZEN-READING-PROSE',
  jobError: 'ZZQQ-ERROR-QUOTED-THE-PAYLOAD',
  coverageNote: 'ZZQQ-COVERAGE-NOTE',
};

let seq = 0;
function seed(): BetweenDB {
  const db = openDb(join(dir, `diag${seq++}.db`));
  db.setMeta('owner_contact_id', '1');
  db.raw.prepare('INSERT INTO contacts (id, display_name) VALUES (1, ?)').run(SECRETS.contact);
  db.raw.prepare("INSERT INTO identifiers (contact_id, raw_value, normalized_e164, kind) VALUES (1, ?, ?, 'mobile')")
    .run(SECRETS.rawNumber, SECRETS.e164);
  db.raw.prepare(
    `INSERT INTO threads (id, participant_signature, is_group, title, coverage_note, first_ms, last_ms, message_count)
     VALUES (1, 'sig', 0, ?, ?, 0, 0, 0)`,
  ).run(SECRETS.threadTitle, SECRETS.coverageNote);
  db.raw.prepare('INSERT INTO thread_participants (thread_id, contact_id, role) VALUES (1, 1, ?)').run('owner');
  db.raw.prepare(
    "INSERT INTO source_files (id, path, content_sha256, imported_at, record_count, kind) VALUES (1, ?, 'sha', ?, 2, 'android_smsbackup')",
  ).run(SECRETS.sourcePath, new Date().toISOString());

  for (const [i, body] of [SECRETS.bodyA, SECRETS.bodyB].entries()) {
    db.raw.prepare(
      `INSERT INTO messages (id, thread_id, sender_contact_id, direction, kind, sent_at_ms, body_text,
                             is_reaction, source_file_id, source_kind, dedup_key)
       VALUES (?, 1, 1, ?, 'sms', ?, ?, 0, 1, 'android_smsbackup', ?)`,
    ).run(i + 1, i === 0 ? 'outgoing' : 'incoming', Date.UTC(2022, 5, 1) + i * 1000, body, `dk-${i}`);
  }
  db.raw.prepare("INSERT INTO attachments (message_id, mime_type, filename, is_smil) VALUES (1, 'image/jpeg', ?, 0)")
    .run(SECRETS.filename);

  return db;
}

describe('the diagnostic bundle', () => {
  it('carries no message text, name, number, path or prose from the archive', () => {
    const db = seed();
    try {
      const bundle = buildDiagnosticBundle(db, { engineMode: 'local_only' });
      const serialised = JSON.stringify(bundle);

      const leaked = Object.entries(SECRETS).filter(([, v]) => serialised.includes(v));
      expect(
        leaked.map(([k]) => k),
        `the bundle leaked archive content: ${leaked.map(([k, v]) => `${k}="${v}"`).join(', ')}`,
      ).toEqual([]);
    } finally { db.close(); }
  });

  it('still says enough to debug with', () => {
    // The other half of the bargain. A bundle that leaks nothing because it contains nothing is not
    // a feature, it is a placebo, and the maintainer ends up asking for the messages anyway.
    const db = seed();
    try {
      const b = buildDiagnosticBundle(db, { engineMode: 'local_only', experimentalLenses: false, mockAllowed: false });

      expect(b.database.counts.messages).toBe(2);
      expect(b.database.counts.contacts).toBe(1);
      expect(b.archive.threads).toBe(1);
      expect(b.archive.attachments).toBe(1);
      expect(b.archive.byDirection).toEqual({ outgoing: 1, incoming: 1 });
      expect(b.archive.byKind).toEqual({ sms: 2 });
      expect(b.database.integrity, 'SQLite\'s own answer').toBe('ok');
      expect(b.app.node).toBe(process.version);
      expect(b.engine.mode).toBe('local_only');
    } finally { db.close(); }
  });

  it('reports the span as years, not dates', () => {
    // A first and last date, next to anything else in a public issue, starts to describe a specific
    // person's life. A year debugs a date-parsing bug just as well.
    const db = seed();
    try {
      const b = buildDiagnosticBundle(db);
      expect(b.archive.firstYear).toBe(2022);
      expect(b.archive.lastYear).toBe(2022);
      // No full ISO date anywhere except the bundle's own generation stamp.
      const dates = JSON.stringify(b).match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      expect(dates.every((d) => b.generatedAt.startsWith(d))).toBe(true);
    } finally { db.close(); }
  });

  it('survives a database missing tables a newer version expects', () => {
    // An owner on an older schema is exactly the person most likely to need to send a bundle.
    const db = openDb(join(dir, 'bare.db'));
    try {
      db.raw.exec('DROP TABLE IF EXISTS analysis_jobs');
      const b = buildDiagnosticBundle(db);
      expect(b.notes.join(' ')).toMatch(/analysis_jobs/);
      expect(b.database.counts.messages).toBe(0);
    } finally { db.close(); }
  });
});
