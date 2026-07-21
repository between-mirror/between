// Between — E1 record-grade exports. Verbatim, neutral, evidence-chained: an episode, an era, a range,
// or the full timeline, written to data/exports/ (git-ignored). The core body is messages ONLY — never
// narrative_json or reflection prose (guardrail 7); a Between reading may be attached only as a separate,
// labelled appendix by the caller. Integrity = SHA-256 of the message-body block (deterministic: the
// generated-at stamp lives in the header, OUTSIDE the hash, so the same range always hashes the same).
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BetweenDB } from '../store/db';

export type ExportKind = 'range' | 'episode' | 'era' | 'timeline' | 'ledger';

export interface ExportResult {
  kind: ExportKind;
  threadId: number;
  fromMs: number | null;
  toMs: number | null;
  messageCount: number;
  ids: number[];
  bodyMd: string;    // the hashed block — verbatim messages only
  sha256: string;
  markdown: string;  // header + body + integrity footer
}

export interface ExportOpts {
  fromMs?: number | null;
  toMs?: number | null;
  kind?: ExportKind;
  label?: string;
  ids?: number[];              // explicit id set (e.g. the ledger); overrides the range clauses
  generatedAt?: string | null; // header only; never enters the hash
}

const speaker = (dir: string): 'ME' | 'THEM' => (dir === 'outgoing' || dir === 'draft' ? 'ME' : 'THEM');
const fmt = (ms: number | null): string => (ms == null ? '(open)' : new Date(ms).toISOString());

export function buildExport(db: BetweenDB, threadId: number, opts: ExportOpts = {}): ExportResult {
  const fromMs = opts.fromMs ?? null, toMs = opts.toMs ?? null, kind = opts.kind ?? 'range';
  const clauses = ['thread_id = @t', 'is_reaction = 0', "trim(coalesce(body_text,'')) != ''"];
  // An explicit id set (the ledger) selects exactly those messages, in time order; range is ignored.
  if (opts.ids && opts.ids.length) {
    clauses.push(`id IN (${opts.ids.map((n) => Number(n)).filter(Number.isInteger).join(',')})`);
  } else {
    if (fromMs != null) clauses.push('sent_at_ms >= @from');
    if (toMs != null) clauses.push('sent_at_ms <= @to');
  }
  const rows = db.raw
    .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages WHERE ${clauses.join(' AND ')} ORDER BY sent_at_ms ASC, id ASC`)
    .all({ t: threadId, from: fromMs, to: toMs }) as { id: number; ms: number; dir: string; body: string }[];

  const lines = rows.map((r) => `[m${r.id}] ${new Date(r.ms).toISOString()} ${speaker(r.dir)}: ${(r.body ?? '').replace(/\r?\n/g, ' ').trim()}`);
  const bodyMd = lines.join('\n');
  const sha256 = createHash('sha256').update(bodyMd, 'utf8').digest('hex');
  const ids = rows.map((r) => r.id);

  const header = [
    `# Between export — ${kind}${opts.label ? `: ${opts.label}` : ''}`, '',
    `- thread: ${threadId}`,
    `- range: ${fmt(fromMs)} → ${fmt(toMs)}`,
    `- messages: ${rows.length}`,
    `- first id: ${ids[0] ?? '—'}   last id: ${ids[ids.length - 1] ?? '—'}`,
    `- generated: ${opts.generatedAt ?? '(unset)'}`,
    `- body SHA-256: ${sha256}`, '',
    '> For understanding, not ammunition. A mirror, not evidence — see docs/ETHICS.md.',
    '', '---', '', '',
  ].join('\n');
  const footer = `\n\n---\n\n_Verbatim messages only — no interpretation. Integrity: SHA-256 of the message body block above = ${sha256}. To verify: extract the message block (between the two \`---\` rules, excluding this footer) and run \`sha256sum\`; a match proves the transcript is byte-for-byte what Between exported — it does NOT prove the messages are truthful or complete. Interpretation guide: docs/METHOD.md._\n`;

  return { kind, threadId, fromMs, toMs, messageCount: rows.length, ids, bodyMd, sha256, markdown: header + bodyMd + footer };
}

/** Write an export to `dir` (caller passes the git-ignored data/exports path). Returns the file path. */
export function writeExport(db: BetweenDB, threadId: number, opts: ExportOpts, dir: string): string {
  const res = buildExport(db, threadId, opts);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `export-t${threadId}-${res.kind}-${res.sha256.slice(0, 12)}.md`);
  writeFileSync(path, res.markdown, 'utf8');
  return path;
}
