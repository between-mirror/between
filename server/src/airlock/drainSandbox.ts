// Between — the sandboxed subscription drain (P0-1). The `claude` drain runs an AGENTIC model over
// archive-derived transcripts — untrusted input (an abuser could have written the words with a later
// reader in mind). Previously it ran in the repo root with every tool, every MCP server, every hook,
// and full read access to the DB, the archive XML, the repo, and the home dir. This contains it.
//
// The drain now runs in a FRESH temp dir that holds ONLY: airlock/jobs/ (the pending job files),
// an empty airlock/results/, the /drain-jobs command, and a hooks-off tool-policy settings file. The
// database, data/, the archive XML, the repo, and the home dir are simply NOT PRESENT. On top of that
// the process is spawned with MCP off (--strict-mcp-config + empty config), hooks off (--settings),
// and the built-in toolset restricted to Read/Write/Glob (Bash/WebFetch/WebSearch/Task/etc. denied).
//
// IMPORTANT — this is TOOL-LEVEL containment, not OS-level. The DB, archive, repo, and home dir are
// not staged into the temp dir; the tools are restricted to Read/Write/Glob PATH-SCOPED to airlock/
// (below); Bash/WebFetch/WebSearch/Task and MCP/hooks are off. Defense in depth, not a wall: file
// writes are additionally bounded by Claude Code's default working-directory confinement, and there is
// no attacker feedback channel (stdio is the owner's console; results land in the owner's own DB behind
// Phase-A validation). So the injection ceiling remains "write a bad result file", which the ingest
// validation (envelope check, schema re-validation, evidence resolution) bounds. A true OS boundary (a
// sandboxed process, a container) remains future work and arrives with the packaged build — see the
// threat model.
import {
  mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { airlockPaths, listJobFiles } from './paths';

/** The bare built-in toolset the sandboxed drain may use (restricts which tools EXIST via --tools). */
export const SANDBOX_ALLOWED_TOOLS = ['Read', 'Write', 'Glob'] as const;
/** PATH-SCOPED permission grants: read/list only under airlock/, write only under airlock/results/.
 *  A determined out-of-scope read/write is denied by these rules (belt over --tools + cwd confinement). */
export const SANDBOX_ALLOWED_SCOPED = ['Read(./airlock/**)', 'Glob(./airlock/**)', 'Write(./airlock/results/**)'] as const;
/** Explicitly denied even so — belt over the restricted toolset (defense in depth). */
export const SANDBOX_DENIED_TOOLS = [
  'Bash', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NotebookEdit',
] as const;

/** Settings that disable hooks and pin the PATH-SCOPED tool permission policy for the sandboxed drain. */
export function sandboxSettings(): { hooks: Record<string, never>; permissions: { allow: string[]; deny: string[] } } {
  return {
    hooks: {},
    permissions: { allow: [...SANDBOX_ALLOWED_SCOPED], deny: [...SANDBOX_DENIED_TOOLS] },
  };
}

/** Read the /drain-jobs command from the repo (.claude/commands/), or fall back to an embedded copy so
 *  a packaged build without .claude/ still works. The command is staged INTO the sandbox by the app; the
 *  sandboxed model only ever sees the copy in its own temp dir. */
function drainCommandText(): string {
  try {
    const p = fileURLToPath(new URL('../../../.claude/commands/drain-jobs.md', import.meta.url));
    if (existsSync(p)) return readFileSync(p, 'utf8');
  } catch { /* fall through to embedded */ }
  return EMBEDDED_DRAIN_COMMAND;
}

const EMBEDDED_DRAIN_COMMAND = `---
description: Drain pending Between analysis jobs from the airlock (reads airlock/jobs/, writes airlock/results/)
---

You are the analysis engine for Between. Process pending jobs from the filesystem airlock.

- READ \`airlock/jobs/*.json\`, WRITE \`airlock/results/*.json\` (atomically: write \`<id>.json.tmp\`, then rename). Nothing else.
- Each job is self-contained: instructions, chunk.transcript, output_schema, rules. Perform the analysis per instructions.
- Self-validate against output_schema; if invalid, fix once then \`status:"error"\`. On a safety refusal, retry once then \`status:"refused"\`.
- Echo \`job_id\` + \`input_hash\` in each result; include validation, refusal, model_note, and the result payload.
- Never echo message content into your summary — counts and job IDs only.
`;

export interface Staged {
  sandboxDir: string;
  airlockDir: string;
  jobsDir: string;
  resultsDir: string;
  settingsPath: string;
  stagedJobs: number;
}

/**
 * Stage pending jobs into a fresh temp dir that contains ONLY the airlock jobs + an empty results dir
 * + the /drain-jobs command + a hooks-off settings file. The DB, data/, archive XML, repo, and home
 * dir are never copied in. Pure filesystem — no DB access, no spawn — so it is directly testable.
 */
export function stageDrainSandbox(realAirlockDir: string): Staged {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'between-drain-'));
  const airlockDir = join(sandboxDir, 'airlock');
  const jobsDir = join(airlockDir, 'jobs');
  const resultsDir = join(airlockDir, 'results');
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });

  const real = airlockPaths(realAirlockDir);
  let stagedJobs = 0;
  for (const name of listJobFiles(real.jobsDir)) {
    // Only pending jobs — one already carrying a result was drained; don't re-stage it.
    if (existsSync(join(real.resultsDir, name))) continue;
    copyFileSync(join(real.jobsDir, name), join(jobsDir, name));
    stagedJobs++;
  }
  if (existsSync(real.manifestPath)) copyFileSync(real.manifestPath, join(jobsDir, '_manifest.json'));

  const cmdDir = join(sandboxDir, '.claude', 'commands');
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, 'drain-jobs.md'), drainCommandText(), 'utf8');

  const settingsPath = join(sandboxDir, 'sandbox-settings.json');
  writeFileSync(settingsPath, JSON.stringify(sandboxSettings(), null, 2), 'utf8');

  return { sandboxDir, airlockDir, jobsDir, resultsDir, settingsPath, stagedJobs };
}

/**
 * The claude argv for a print-mode drain with MCP off, hooks off, and the toolset restricted to
 * Read/Write/Glob. Pure (no spawn) so the restriction policy is directly testable.
 */
export function sandboxClaudeArgs(settingsPath: string): string[] {
  return [
    '-p', '/drain-jobs',
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--settings', settingsPath,
    '--tools', ...SANDBOX_ALLOWED_TOOLS,           // which tools EXIST (bare names)
    '--allowedTools', ...SANDBOX_ALLOWED_SCOPED,    // auto-approve ONLY the airlock-scoped forms
    '--disallowedTools', ...SANDBOX_DENIED_TOOLS,
  ];
}

/** Copy the sandbox's result files back into the real airlock results dir (for the app to ingest). */
export function copyBackResults(staged: Staged, realAirlockDir: string): number {
  const real = airlockPaths(realAirlockDir);
  mkdirSync(real.resultsDir, { recursive: true });
  let copied = 0;
  for (const name of listJobFiles(staged.resultsDir)) {
    copyFileSync(join(staged.resultsDir, name), join(real.resultsDir, name));
    copied++;
  }
  return copied;
}

export interface SandboxDrainResult { staged: number; copiedBack: number }

/**
 * The full sandboxed subscription drain (P0-1): stage → spawn tool-restricted `claude -p /drain-jobs`
 * in the staged temp dir → copy the result files back into the real airlock → delete the sandbox. The
 * app ingests the copied-back results separately (with the Phase-A envelope + schema validation).
 */
export async function drainSandbox(realAirlockDir: string, opts: { cliPath?: string } = {}): Promise<SandboxDrainResult> {
  const staged = stageDrainSandbox(realAirlockDir);
  try {
    const { execa } = await import('execa');
    try {
      await execa(opts.cliPath ?? 'claude', sandboxClaudeArgs(staged.settingsPath), {
        cwd: staged.sandboxDir,
        windowsHide: true,
        stdio: 'inherit',
      });
    } catch {
      // Surface nothing sensitive; some results may still have been written before a non-zero exit.
    }
    const copiedBack = copyBackResults(staged, realAirlockDir);
    return { staged: staged.stagedJobs, copiedBack };
  } finally {
    try { rmSync(staged.sandboxDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
