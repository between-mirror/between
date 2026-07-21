# PRIVACY INVARIANTS — the non-negotiables of a distributed build

Between reads a couple's own archive back to them, on their own machine. That promise is
only as good as the boundaries the code keeps. This file names those boundaries as a flat
list of testable assertions, so that a future contributor — packaging an installer, adding a
feature, wiring a new engine — cannot quietly regress one of them.

The rule for reading this file: **every line below is a promise the tool already makes to the
person using it.** If a change would make any assertion false, that change breaks the tool's
reason to exist, no matter how convenient it is. When in doubt, keep the boundary and open a
discussion, not a workaround.

Each invariant is marked **[enforced]** (a mechanism in the code makes it true) or
**[convention]** (nothing stops a contributor from breaking it — only care and this file).
The convention-only ones are the ones most likely to rot. Where an invariant is mechanical, a
recommended build-blocking test is named so it can be made **[enforced]**.

---

## What a distributed build MUST NOT do

A packaged or distributed Between build must not, ever:

- listen on any interface other than loopback;
- turn on request logging that records message content;
- send any telemetry, analytics, crash report, or usage ping — about content or about anything;
- send the couple's words anywhere except the three disclosed model paths below;
- write an export that contains anything beyond the verbatim message bodies and their integrity hash;
- commit, bundle, or ship the archive, the database, the airlock, or exports;
- ship a mode where anyone other than the archive's owner operates the tool on that archive;
- send a single window to a paid API on nothing more than the presence of a key.

Everything under here is the same list, said precisely enough to test.

---

## 1. The network boundary

**1.1 — The server binds loopback only, and refuses to boot otherwise.**
The read API binds `127.0.0.1`. This is the default in two places: `server/src/config.ts`
(`api.host: '127.0.0.1'`) and the entry-point fallback in `server/src/server.ts`
(`host = '127.0.0.1'`). CORS is pinned to the local web origin (`http://localhost:5273`).
*Status: [enforced] (v0.2.0, P0-6).* The boot path now calls `assertLoopbackBoot(host)`: a non-loopback
`api.host` **refuses to boot** unless `BETWEEN_DANGEROUS_HOST=1` is set, and then only after printing a
screaming multi-line warning. On top of the bind, a Fastify `onRequest` hook enforces two things on every
request: the `Host` header must be loopback (`isLoopbackHostHeader` — a DNS-rebinding defense), and a
present `Origin` must equal the local web origin, else `403`. CORS sits on top of that.
*Assertion:* the server binds `127.0.0.1` (or `::1`); a non-loopback bind refuses to boot; a rebinding
Host or foreign Origin is rejected `403`.
*Build test:* `server/test/boundary.test.ts` (build-blocking) — asserts the resolved host is loopback,
`assertLoopbackBoot` throws on `0.0.0.0`, and Host/Origin mismatches return `403`.

**1.1a — Per-install auth token (packaged-build plumbing).**
On first boot the server generates an `app_meta` `auth_token` and accepts it via
`Authorization: Bearer <token>`. It is **enforced only when the build serves its own static assets**
(`servesStatic()` / `BETWEEN_SERVE_STATIC=1` — the future packaged app). The dev flow (Vite proxy → API)
does not send the token and is not blocked by it, so day-to-day development stays usable. The token is
never written to a log and never part of an export.
*Status: [enforced] where it applies (static-serving build); generated + accepted always.*

**1.2 — The Fastify logger is off.**
`buildServer` constructs Fastify with `{ logger: false }` (`server/src/server.ts`). Nothing
about a request — least of all a body — is written to a log. The error handler is sanitized:
it returns generic text and never leaks a stack trace to a client.
*Status: [enforced].*
*Assertion:* the Fastify instance is built with logging disabled.
*Recommended build test:* assert the Fastify options passed in `buildServer` carry
`logger: false` (guard against a future contributor flipping it on for debugging and leaving it).

**1.3 — No telemetry, analytics, crash reporting, or usage ping.**
There is no analytics or telemetry dependency and no phone-home code. The server's runtime
dependencies (`server/package.json`) are the data-plane libraries only: fastify + cors,
better-sqlite3, execa, the Anthropic SDK, phone/language/sentiment libraries, and zod. None
of them, and no code, reports anything about the person or their content to anyone.
*Status: [convention]* — nothing currently prevents a new dependency or a `fetch` from being
added.
*Assertion:* no analytics/telemetry/crash-reporting dependency is present, and no outbound
network call is made except to the three model paths in §3.
*Recommended build test:* an allow-list check over `dependencies` (no analytics SDKs) plus a
source scan that fails the build on `fetch(`/`http` calls outside the three known egress
modules (`airlock/engine.ts`, `airlock/batch.ts`).

---

## 2. What leaves as an export

**2.1 — Exports are message bodies only.**
`buildExport` (`server/src/lenses/exports.ts`) selects verbatim messages — id, timestamp,
speaker (`ME`/`THEM`), body text — and nothing else. No narrative, no reflection prose, no
model reading. The header carries only the range and counts; a Between reading may be attached
only as a separate, labelled appendix, by the caller, never folded into the body.
*Status: [enforced] in `buildExport`; [convention] for the "no reading in the body" rule at
the call sites.*
*Assertion:* an export's hashed body block contains message rows only — no interpretation.

**2.2 — Every export carries a SHA-256 of exactly that block.**
The integrity hash is `SHA-256` of the message-body block and only that block. The generated-at
stamp lives in the header, outside the hash, so the same range always hashes the same. The
footer tells the reader how to verify it, and is honest about what a match proves (byte-for-byte
fidelity, not truth or completeness).
*Status: [enforced].*
*Assertion:* the export contains a SHA-256 that recomputes from the body block alone; the hash
is deterministic across regenerations of the same range.
*Recommended build test:* build two exports of the same range at different timestamps and assert
identical `sha256`; independently `sha256` the extracted body block and assert it matches the
footer.

**2.3 — Exports, the archive, the database, and the airlock never enter version control.**
`.gitignore` excludes the source archive (`*.xml`, `sms-*.xml`, `calls-*.xml`), every database
form (`*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite*`, `*.sqlcipher`, `between.db*`), and the whole
transport/output tree (`/airlock/`, `/data/`, `/exports/`, `/media/`, `/attachments/`,
`/cache/`, `/results/`, `/jobs/`, `/.between/`). Secrets are excluded too (`.env*`, `*.key`,
`*.pem`), as is the local privacy-pattern list (`personal-patterns.txt`). Exports are written
under `data/exports/`, which sits inside the ignored `/data/` tree.
*Status: [enforced] by `.gitignore`.*
*Assertion:* `data/`, the airlock, exports, and any `*.db` are git-ignored; a packaged build
bundles none of them.
*Recommended build test:* a repo check that `git check-ignore` matches `data/`, `between.db`,
and a sample export path; a packaging check that the shipped artifact contains no `.db`, no
`data/`, no `.xml`.

---

## 3. Egress — the three disclosed model paths, and no fourth

The couple's words leave the machine on exactly three paths, all disclosed to the person, and
never any other. The classifier tier ("grunt", the per-message L1 work) can run three ways; the
worthwhile reduce/render work runs on one.

1. **Local Ollama — nothing leaves the machine.** The default grunt engine POSTs each window to
   `http://127.0.0.1:11434/api/generate` (`server/src/airlock/engine.ts`; default URL also in
   `config.ts`). This is loopback: the words stay on the machine.
2. **Claude subscription drain — spawns a CONTAINED, tool-restricted `claude` CLI (P0-1).** The
   worthwhile (`claude`/`render`) jobs run by spawning `claude -p /drain-jobs` via execa
   (`server/src/airlock/drainSandbox.ts`). Because this is an agentic model reading archive-derived
   (untrusted) text, it is contained: it runs in a fresh temp dir holding ONLY the pending job files
   (no DB, no `data/`, no archive XML, no repo, no home dir), with MCP off (`--strict-mcp-config` +
   empty config), hooks off (`--settings`), and the toolset restricted to Read/Write/Glob. This is
   TOOL-level containment, not OS-level — a true OS boundary is future work (the packaged build).
   Egress goes through the person's own Claude subscription, the disclosed "deep readings use your
   Claude subscription" posture. Prompt-injection is in the threat model: the injection ceiling under
   this containment is writing a malformed result file, which the Phase-A ingest validation bounds
   (envelope check, schema re-validation, evidence resolution). See `docs/THREAT-MODEL.md`.
3. **Anthropic Batch API — the paid alternative grunt.** `drain --engine batch`
   (`server/src/cli/drain.ts`, `server/src/airlock/batch.ts`) submits the pending L1 windows to
   Anthropic's Message Batches API using `ANTHROPIC_API_KEY`. It sends window transcript text —
   the message bodies — at archive scale. **Media is never sent** on any path.

*Status: [convention]* — nothing structurally prevents a fourth network destination from being
added.
*Assertion:* the only outbound destinations are loopback Ollama, the spawned `claude` CLI, and
`api.anthropic.com` via the SDK. Media bytes are never transmitted.
*Recommended build test:* the same source scan named in §1.3 — fail the build on any network
call originating outside `airlock/engine.ts` and `airlock/batch.ts`.

---

## 4. Consent before paid/API egress

**4.1 — The API/Batch drain currently has no runtime consent gate. It needs one.**
This is the open gap, stated plainly so it is not mistaken for a settled invariant.

Today, `drain --engine batch` sends raw window transcripts to Anthropic **as soon as
`ANTHROPIC_API_KEY` is set.** The only things standing between an invocation and money +
content leaving the machine are:

- a required API key (its absence throws in `makeClient`, `batch.ts`) — a capability check, not
  consent;
- a "batch already in flight" state file that blocks a *second* submission (`drain.ts`
  `runBatch`) — a double-spend guard, not consent;
- an optional `--dry-run` the operator may or may not run first.

None of these is the person saying "yes, send my words to a paid API." A key present in the
environment is not a decision. This means a script, a scheduled task, or a packaged build that
sets the key can move the couple's words to a paid API with no recorded, explicit yes.

**The required invariant (not yet enforced):** the API and Batch paths must require an explicit,
persisted consent — a recorded decision, tied to this archive, distinct from the presence of a
key — before any window is submitted. The subscription drain (§3.2) carries the person's own
disclosed subscription posture; the paid-API path spends money and sends at archive scale, so it
is the one that must not proceed on a key alone.
*Status: [convention] / MISSING.*
*Assertion:* API/Batch drain refuses to submit unless an explicit persisted consent record for
this archive exists; presence of `ANTHROPIC_API_KEY` alone never authorizes a submission.
*Recommended build test:* with a key set but no consent record, assert `runBatch` refuses to
call `submitBatch` and exits without a network call; with consent recorded, assert it proceeds.

**4.2 — No auto-drain without consent.**
By construction the app is the sole DB writer and ingests only on awaited completion of a drain
the operator started — never a file watcher, never a background daemon
(`server/src/cli/drain.ts` header; `airlock/batch.ts` "app ingests separately"). No path drains
automatically. A distributed build must not add a background or scheduled drain that runs
without a fresh, explicit go — and, for the paid path, without the consent of §4.1.
*Status: [convention].*
*Assertion:* no code path initiates a drain (local, subscription, or API) without an explicit
operator action; nothing watches the filesystem to drain on its own.

---

## 5. No therapist-operated mode

A therapist **receives** the exports and the conversation packet; a therapist never operates Between on
a client's data. The tool is single-owner: it runs on the archive owner's machine, on the owner's
own archive. There is no multi-tenant mode, no "clinician view" that ingests someone else's
messages, no server that serves a second party's data.
*Status: [convention]* — enforced today only by the absence of such a feature.
*Assertion:* the build ships no mode in which a non-owner operates the tool on the owner's
archive, and no remote-serving path that would expose one archive to another party (this is the
same boundary as §1.1's loopback bind, seen from the other side).

---

## How to use this file when you change the code

- Adding a dependency, a `fetch`, or a `spawn`? You are touching §1.3 and §3. Prove you are not
  opening a fourth egress path.
- Adding a config knob for host, port, or logging? You are touching §1.1 and §1.2. A knob that
  can widen the bind or turn logging on is a regression unless it is gated and defaulted safe.
- Adding anything to an export? You are touching §2.1 and §2.2. If it is not a verbatim message
  body, it does not belong in the hashed block.
- Adding automation, a scheduler, or a new engine? You are touching §4 and §5. The paid path
  needs consent; nothing runs a drain on its own; nobody but the owner operates the tool.

The mechanical invariants (§1.1, §1.2, §2.2, §2.3, §3, §4.1) are the ones a test can hold. Turning
each recommended test into a build-blocking check is how a promise stops depending on memory.
