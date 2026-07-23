// Between — the diagnostic bundle: everything a maintainer needs to debug a problem, and nothing a
// maintainer must never see.
//
// This exists because of a specific, predictable accident. Someone hits a bug, wants help, and pastes
// their messages into a GitHub issue to explain it — docs/OPERATIONS.md has a whole procedure for
// cleaning up after that, which is an admission that it will happen. The procedure is damage control.
// This is the thing that makes the damage unnecessary: a button that produces exactly the report a
// maintainer would ask for, so the owner never has to improvise one out of their own conversation.
//
// THE INVARIANT: no message text, no contact names, no phone numbers, no file paths outside Between's
// own folder, no archive content of any kind. Shapes and counts only. It is asserted by a test that
// builds a database full of distinctive strings and greps the bundle for every one of them.
//
// Where a value is borderline, it is left out. A bundle that omits something a maintainer wanted
// costs one round trip; a bundle that includes something the owner did not know they were sending
// costs the thing this entire program is about.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BetweenDB } from '../store/db';

export interface DiagnosticBundle {
  /** Schema version of this report, so a maintainer can tell what they are reading. */
  bundleVersion: 1;
  generatedAt: string;

  app: {
    version: string;
    node: string;
    platform: string;
    arch: string;
  };

  database: {
    /** SQLite's own answer, not ours. */
    integrity: string;
    schemaVersion: number | null;
    pageCount: number | null;
    pageSize: number | null;
    /** Rows per table — the shape of the archive with none of its content. */
    counts: Record<string, number>;
  };

  archive: {
    threads: number;
    groupThreads: number;
    /** Coarse span only: years, never dates that could pin down a person's life. */
    firstYear: number | null;
    lastYear: number | null;
    /** Messages by kind and direction — the numbers that explain most parser bugs. */
    byKind: Record<string, number>;
    byDirection: Record<string, number>;
    /** How many messages have an empty body, which is the shape of most MMS complaints. */
    emptyBodies: number;
    attachments: number;
  };

  engine: {
    mode: string;
    experimentalLenses: boolean;
    mockAllowed: boolean;
  };

  airlock: {
    jobs: number;
    byState: Record<string, number>;
    /** Distinct error CODES seen, never their messages — a message can quote a message. */
    errorCodes: string[];
  };

  /** Anything that looked wrong while building this report. */
  notes: string[];
}

/** Count rows in a table, tolerating a table that does not exist in an older database. */
function safeCount(db: BetweenDB, table: string, notes: string[]): number {
  try {
    const r = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return r.n;
  } catch {
    notes.push(`table '${table}' is absent`);
    return 0;
  }
}

function groupCount(db: BetweenDB, table: string, column: string, notes: string[]): Record<string, number> {
  try {
    const rows = db.raw.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`)
      .all() as { k: string | null; n: number }[];
    const out: Record<string, number> = {};
    // The KEY is a schema enum (sms/mms, incoming/outgoing) — never free text from the archive.
    for (const r of rows) out[String(r.k ?? 'null')] = r.n;
    return out;
  } catch {
    notes.push(`could not group ${table}.${column}`);
    return {};
  }
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildDiagnosticBundle(
  db: BetweenDB,
  opts: { engineMode?: string; experimentalLenses?: boolean; mockAllowed?: boolean } = {},
): DiagnosticBundle {
  const notes: string[] = [];

  let integrity = 'unknown';
  try {
    const r = db.raw.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    integrity = String(Object.values(r)[0] ?? 'unknown');
  } catch { notes.push('integrity_check failed to run'); }

  const pragma = (name: string): number | null => {
    try {
      const r = db.raw.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
      const v = Object.values(r)[0];
      return typeof v === 'number' ? v : null;
    } catch { return null; }
  };

  const counts: Record<string, number> = {};
  for (const t of [
    'contacts', 'identifiers', 'threads', 'thread_participants', 'messages',
    'attachments', 'source_files', 'reflections', 'analysis_jobs', 'overrides', 'events',
  ]) {
    counts[t] = safeCount(db, t, notes);
  }

  // Years only. A first and last DATE, combined with anything else in a public issue, starts to
  // describe a specific person's life; a year is enough to debug a date-parsing bug.
  let firstYear: number | null = null;
  let lastYear: number | null = null;
  try {
    const r = db.raw.prepare('SELECT MIN(sent_at_ms) AS a, MAX(sent_at_ms) AS b FROM messages').get() as { a: number | null; b: number | null };
    if (r.a != null) firstYear = new Date(r.a).getUTCFullYear();
    if (r.b != null) lastYear = new Date(r.b).getUTCFullYear();
  } catch { notes.push('could not read the message span'); }

  let groupThreads = 0;
  try {
    groupThreads = (db.raw.prepare('SELECT COUNT(*) AS n FROM threads WHERE is_group = 1').get() as { n: number }).n;
  } catch { /* counted as zero, already noted if the table is missing */ }

  let emptyBodies = 0;
  try {
    emptyBodies = (db.raw.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE body_text IS NULL OR TRIM(body_text) = ''",
    ).get() as { n: number }).n;
  } catch { /* non-fatal */ }

  // Error CODES only. An airlock error message can quote the payload that failed, and the payload is
  // message text — so the messages are deliberately not read, even to summarise them.
  let errorCodes: string[] = [];
  try {
    const rows = db.raw.prepare(
      "SELECT DISTINCT error_code AS c FROM analysis_jobs WHERE error_code IS NOT NULL AND error_code != ''",
    ).all() as { c: string }[];
    errorCodes = rows.map((r) => r.c).slice(0, 40);
  } catch { /* older schema, or no such column */ }

  return {
    bundleVersion: 1,
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersion(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    database: {
      integrity,
      schemaVersion: pragma('user_version'),
      pageCount: pragma('page_count'),
      pageSize: pragma('page_size'),
      counts,
    },
    archive: {
      threads: counts.threads ?? 0,
      groupThreads,
      firstYear,
      lastYear,
      byKind: groupCount(db, 'messages', 'kind', notes),
      byDirection: groupCount(db, 'messages', 'direction', notes),
      emptyBodies,
      attachments: counts.attachments ?? 0,
    },
    engine: {
      mode: opts.engineMode ?? 'unknown',
      experimentalLenses: opts.experimentalLenses ?? false,
      mockAllowed: opts.mockAllowed ?? false,
    },
    airlock: {
      jobs: counts.analysis_jobs ?? 0,
      byState: groupCount(db, 'analysis_jobs', 'state', notes),
      errorCodes,
    },
    notes,
  };
}
