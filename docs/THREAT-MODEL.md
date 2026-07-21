# Between — Threat Model

*What local-first protects against, and what it does not. Between reads a couple's own message archive
back to them, on their own machine. That is a real privacy posture — but "on your machine" is not the
same as "safe from everything," and this document says exactly where the line is. Honesty about the
boundary is part of the product.*

The companion file [PRIVACY-INVARIANTS.md](PRIVACY-INVARIANTS.md) lists the testable promises the code
keeps. This file is the wider picture: the attackers and accidents those promises do and do not defend
against.

---

## 1. What local-first *does* protect against

Because the archive, the database, the analysis, and the exports never leave the machine except on the
three disclosed model paths (PRIVACY-INVARIANTS §3), Between structurally avoids the failure modes of a
hosted service:

- **No server breach can leak your archive** — there is no server holding it.
- **No operator, employee, or subpoena to a vendor** can reach data that only ever lived on your disk.
- **No telemetry, analytics, or crash-reporting** carries your content or metrics anywhere (§1.3, tested).
- **No account, no cloud sync of the archive, no "share" surface** — the tool is single-owner (§5).

## 2. What local-first does **not** protect against

Local-first moves the trust boundary to *your machine and your account*. Everything with access to those
has, in principle, access to your archive. Between does **not** defend against:

- **Malware or spyware on the machine** — anything running as your user can read `between.db` and `data/`.
- **Other accounts / other people with physical access** — a shared or unlocked computer.
- **OS or desktop search indexing** — indexers may read the archive text and the exports.
- **Backup and sync software** — Time Machine, File History, Dropbox/OneDrive/Google Drive/iCloud, etc.,
  can copy `between.db` and exports off the machine. (Between warns loudly at boot when its working
  directory sits under a known cloud-sync path, and keeps `between.db`/`data/`/`airlock/` git-ignored,
  but it cannot stop a backup tool you configured.)
- **Stolen or discarded hardware** — the database is not encrypted at rest by default (see §5).
- **Copies you make yourself** — an export you email, a screenshot, a `between.db` you paste into a chat.
- **Developer tooling** — an IDE, an AI coding assistant, or a shell agent with access to the folder.

The mitigations Between *does* apply at rest (restrictive file ACLs, a cloud-sync warning, plaintext
retention/cleanup of drained airlock files) are best-effort hardening, not a guarantee — see
PRIVACY-INVARIANTS and the retention notes in [DEPLOY.md](DEPLOY.md).

## 3. Prompt-injection (the archive is untrusted input)

The messages Between analyzes are **not trusted input**. A message could have been written by someone who
anticipated it being read back by a tool or a person later — an abuser crafting text to steer a reading,
or content deliberately shaped to manipulate the model.

- **Non-agentic paths (local Ollama, Batch API)** classify a transcript into JSON. They have no tools, no
  shell, no filesystem beyond the one result — so the worst an injected message can do is skew a score or
  a note, which the evidence contract (every claim must resolve to a real message) and validation bound.
- **The agentic path (Claude subscription drain)** runs a tool-capable model. This is the highest-risk
  path, so it is **contained** (P0-1, `server/src/airlock/drainSandbox.ts`): it runs in a staged temp dir
  holding only the pending job files — no database, no `data/`, no archive XML, no repo, no home dir —
  with MCP off, hooks off, and the toolset restricted to Read/Write/Glob. **This is tool-level containment,
  not OS-level.** Under it, the injection ceiling is *writing a malformed or dishonest result file*, and
  that is bounded by the Phase-A ingest validation: the envelope (job_id / input_hash / filename) must
  match or the file is quarantined; the payload is re-validated against its schema after evidence
  filtering; and no claim without a resolving receipt can reach a frozen reflection.
- **Not yet defended:** an OS-level escape from the tool sandbox (a real process/container boundary). That
  is future work and arrives with the packaged build. Until then, prefer the non-agentic paths for a first
  run, especially on an archive you did not author (see DEPLOY.md).

## 4. Relational misuse (the scenario the product exists inside)

Between reads intimate relationship data. The most important threats are not technical — they are people
using the tool, or its output, against the person in the archive. Between is designed around
*understanding, not ammunition*, and declines the uses that turn a reflection into a weapon:

- **An abusive partner profiling the other person.** Between never produces a "build a case" export: exports
  are verbatim message bodies + a fidelity hash, never Between's readings folded in as if they were facts.
  The other-side reading is explicitly guesswork about interior weather, gated and caveated, never a
  diagnosis. The power-balance gate refuses "your part in this" framing when the signals are one-directional.
- **A stalker or ex with an old device / a copy of the archive.** Local-first cannot stop someone who has
  the hardware or a copy — see §2. This is a reason the at-rest posture and the "don't sync this folder"
  warning matter, and a reason the tool never makes sharing frictionless.
- **A parent or employer running it on someone else's messages.** The tool is single-owner by construction
  (§5, no therapist/second-party mode). It is built to read *your own* archive; running it on someone
  else's is outside what it supports and outside its consent model — local ownership of a device is not
  the other person's consent to be analyzed (see [ETHICS.md](ETHICS.md)).
- **A litigant treating a reading as evidence.** Between is not evidence-grade and says so. The export hash
  proves byte-fidelity of a *copy*, never the truth or completeness of the conversation; the findings are
  keyword counts to *weigh, not tally*; the interpretive/support layer is experimental, text-only, and not
  externally validated (and off by default in public builds — Phase E).
- **"AI support frame as neutral proof."** The gate that can shift an era toward a "support" reading is an
  experimental, calibration-dependent instrument, not an adjudication. It is gated OFF by default, requires
  the owner's honest calibration, and is framed as one reading over time, never a verdict on a person.

## 5. Explicitly deferred

- **At-rest encryption of the database.** Deferred deliberately: a forgotten passphrase on a local-only,
  no-account tool means *unrecoverable* loss of irreplaceable intimate data. Best-effort ACLs + the
  sync/backup warnings are the current posture; opt-in full encryption with an unmistakable
  "no backdoor, no recovery" warning is a considered future option (SHIP.md), not a default.
- **Encrypted exports.** Same trade-off; deferred with the same reason.
- **An OS-level sandbox** for the agentic drain (a real process/container boundary). Future work, packaged
  build. Today the containment is tool-level (§3).

---

*One reading of the boundary, dated. If you can think of a threat this document doesn't name, that is a
security report worth filing — see [../SECURITY.md](../SECURITY.md).*
