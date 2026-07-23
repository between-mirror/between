# Between Mirror — Status

*The single authoritative statement of what works, what's experimental, what's designed but not built,
and what's turned off. When the README and this file disagree, this file wins. Dated by the git history;
every capability called "implemented" below is one CI runs a test for.*

## Implemented & tested

The deterministic instrument runs end-to-end on a real archive and is covered by the test suite:

- **Ingest** — three claimed importers into one normalized SQLite store (parse, dedup, identity,
  threads): Android SMS Backup & Restore XML; WhatsApp exported chats (.txt/.zip, one-to-one); and a
  generic CSV/JSON/JSONL importer for anything reducible to when / who / direction / what. Each emits
  the same record shape, so a new format is a new parser and touches nothing else. WhatsApp date order
  is inferred across the whole file and says when it was not proven; the archive owner must be named
  because no export marks one. A fourth — iMessage `chat.db` — is built and tested but **not claimed**;
  see *Supported inputs* for why and how to try it.
- **Importing more than once** — a second backup merges into the archive instead of forking it.
  Threads and contacts are keyed on the participants' own identifiers rather than on per-file
  numbering, and the dedup key is source-neutral (counterpart, direction, a 60-second bucket, a body
  hash), so the same conversation seen twice converges while two messages that share a minute and a
  word stay two. Participant roles are encoded structurally rather than as text a source identifier
  can imitate, so an ordinary participant cannot become the archive owner's note-to-self thread. A
  person is matched on the **number underneath the spelling** as well as the
  spelling itself, because one export writes `+15555550100` where another writes `(555) 555-0100`
  and they are one person. **Who the archive belongs to is remembered archive-wide**: that is found
  by co-occurrence or by a message's unambiguous sender/recipient roles. A file holding a single
  conversation cannot show co-occurrence, but an incoming one-to-one MMS that names exactly one
  recipient identifies that handset's owner directly; an import with neither kind of evidence reads
  the owner from the store instead of guessing. Threads built before anyone could see the owner are
  re-keyed the moment it becomes known. Every row records the format it came from; existing
  archives are upgraded by forward-only migrations that copy the database first and cannot drop a
  row — and the copy is reused across a retry only when it really is this archive's own
  pre-migration state, not merely a file with the right name. Every rewrite onto a UNIQUE column is
  collision-safe by construction: a value that would collide is not written, the row keeps the one
  it has, and the count is recorded. **An archive has exactly one owner**, and the first import able
  to identify them settles it: a second file whose guess differs cannot add a second, because two
  flagged people would both drop out of the thread key and leave their conversations sharing one.
- **Rows an importer cannot read are reported, not dropped quietly.** The generic importer refuses a
  row whose date is ambiguous rather than guessing at it, and the count and the reasons come back
  with the import result.
- **Baseline & ambient stats** — volume, rhythm (hour-of-day / day-of-week, bucketed by the owner's
  lived timezone), cadence, word maps, emoji, monthly volume.
- **Sentiment river** — per-day warmth/tension, VADER by default, model L1 when drained. Thread-level
  coverage **gates** the chart, not just annotates it: below 95% model-scored coverage the river draws
  the deterministic layer and says so ("Model-scored: 94% — showing the deterministic layer"), because
  an unscored message reads as neutral and a thinly-read thread would otherwise look calm rather than
  thin. Refused and errored windows are named as the reason coverage is short.
- **Episodes, eras, trajectory, findings (A–E counts)** — deterministic reads over the words.
- **The airlock** — job/result protocol with hashing, cache, resumable drain, and a validated ingest:
  envelope verification (mismatch → quarantine), schema re-validation after evidence filtering, exact
  L1 coverage-or-error, and the evidence contract (no claim reaches a frozen reading without a receipt).
- **Prose lenses via evidence-bearing blocks** — **every model-authored proposition carries receipts;
  connective prose is app-authored from fixed templates.** The model may emit only the two
  evidence-bearing kinds, each requiring at least one receipt that must resolve to a real message or
  the block is dropped. The sentences that assert nothing — the bridges between observations and the
  question that closes a reading — are composed by the app from the authored template sets in
  [VOICE.md](VOICE.md) §6b, selected deterministically from a hash of the reading's own text. A
  payload containing a model-written bridge or question is rejected whole.
- **Calibration (rubric v2)** — the hold-out labeling flow writes per-owner thresholds and a
  *calibration-asymmetry* check (with a minimum-sample guard); the power-balance gate reads it. The
  hold-out asks what is **observable** in the words (named them / a threat / brushed past / reaching
  back) rather than how bad a message was, because severity is a judgement of intent and intent
  cannot be read off a text. The sample is **stratified** across the model's own low/mid/high tension
  bands per side — v1 drew only the messages the model already called hostile and then used those
  labels to validate the model's threshold — and the draw is **seeded**, with the seed recorded so
  any set of thresholds can be traced to the exact sample behind it. Where the owner and the model
  disagree is **shown before anything is saved**, and the owner can change any label; v1 picked the
  thresholds by maximizing F1 over disagreements nobody was shown. Records carry `rubric_version`;
  a v1 calibration stays in force until its owner chooses to re-run. Documented in
  [METHOD.md](METHOD.md) §0a.
- **Exports** — verbatim messages + a deterministic SHA-256 integrity hash, purpose-limitation header.
- **The network boundary** — loopback-only bind (refuses to boot otherwise), Host/Origin gate,
  `logger:false`, zero telemetry dependencies — enforced by a build-blocking boundary test.
- **Engine mode** — enforced server-side (local-only / subscription / api-key); no silent fallback.
- **Your data** — a Settings panel showing where the database, sources, exports and model transport
  actually live, with: an integrity check reporting SQLite's own answer verbatim, a timestamped backup
  taken through the online-backup API (never overwriting a previous one), deletion of the imported
  source XML (restricted to Between's own data folder), immediate purge of model transport plaintext,
  and a double-confirmed delete-everything whose typed word is checked on the server. Every action
  writes a plain-language line to a log kept in the database.
- **Five surfaces, not eleven tabs** — Home / Explore / Ask / Messages / Readings, with keyboard
  navigation, ARIA tab semantics, and receipt drill-through from any reading to the words underneath.
  Calibration moved to Settings and appears inline wherever a reading is provisional without it.
- **No assumed gender** — user-visible copy never guesses anyone's gender; swept per-file by test.

## The interpretive layer — disabled in ordinary builds

A **research preview, not validated.** Text-only, calibration-dependent, and evaluated by nobody
(see [ETHICS.md](ETHICS.md), [THREAT-MODEL.md](THREAT-MODEL.md)):

- The **L4 abuse-pattern stage-2** drain.
- The **power-balance support frame** (a directional reading over time).
- The **other-side reading** and the **findings reading** (the interpretive prose).

**It cannot be switched on from inside the application, and there is no setting for it.** An earlier
version of this file said it was "turned on via Settings, with sober consent" — describing a control
that had never been built, while the actual path was an HTTP call the app could make on its own
behalf. Both are gone. Nothing in the running program can open this gate; a test asserts the route
does not exist.

**Research activation, documented for evaluators.** It is deliberately not removed — an external
review cannot evaluate what it cannot run. Two separate acts turn it on, because they answer
different questions:

1. **The flag**, a decision about a process: `"researchInterpretiveLayer": true` written by hand into
   `between.config.json`, or `BETWEEN_RESEARCH_LAYER=1` in the environment.
2. **The acknowledgement**, a decision about an *archive* — whether an unvalidated reading may be
   written about the specific person in it: `npx tsx server/src/cli/research-mode.ts --acknowledge`,
   which prints the terms in full and records nothing until you re-run it with `--yes`. Withdraw with
   `--withdraw`; check either with `--status`.

The flag alone runs nothing. The deterministic findings **A–E counts** never depended on any of this
and remain available.

## Designed, not yet implemented

- **iMessage / iPhone import** (today: Android SMS, WhatsApp, and a generic CSV/JSON importer).
- **Group-chat import for WhatsApp and the generic importer** — refused rather than approximated: a
  group threads by a participant SET, which a single correspondent field cannot express, and importing
  it approximately would put the wrong people in the wrong conversation.
- **"Since you last looked"** diff readings over re-imported backups.
- The **signed one-click installer** (Tauri desktop wrapper).
- An **OS-level sandbox** for the subscription drain (today: tool-level containment only).
- **At-rest DB encryption** and **encrypted exports** — deliberately deferred (a forgotten passphrase on
  a no-account tool means unrecoverable loss); best-effort ACLs + a cloud-sync warning are the current
  at-rest posture.

## Disabled in public builds

- The **mock engine** — available only when `BETWEEN_ALLOW_MOCK=1` (the test harness); never in a build.
- **Non-loopback bind** — refuses to boot unless `BETWEEN_DANGEROUS_HOST=1` (with a screaming warning).

## Review status

A security review is a snapshot, not a certificate — so this section says what stands open, not just
what closed. The July-2026 adversarial security/grounding review, in three honest buckets:

**v0.5.0 release gate — demonstrated 2026-07-22.** The final confirmation re-read every prior round,
attacked the complete release tail locally without external agent fan-out or paid API calls, and
found zero confirmed P0s. Two missing boundary regressions were added: Android's real owner
placeholder across both partial/full import orders, and a v0.4.1-style owner-only thread across
migration and re-import. The complete gate is 781 server tests, 24 web tests and clean typechecks.
Publication is a separate owner act; this remains a snapshot, not a certificate.

**Fixed — original defects, test-first, shipped in v0.2.0.** P0-1…P0-6 and P1-7…P1-13, P2-14: raw
model output reaching a frozen reading; unverified result envelopes; un-rechecked cleaned payloads;
trusted free prose; unscored messages reading as neutral; client-chosen engines and the silent mock;
non-loopback bind / Host / Origin; an uncontained drain; the self-report "trust verdict"; an
always-on interpretive layer. Each carries a regression test that fails if it returns —
see [CHANGELOG.md](../CHANGELOG.md).

**Deferred by design — open on purpose, with the reason published.**

- **OS-level containment of the subscription drain.** Today's containment is *tool-level*: restricted
  tools, a staged temp folder holding only pending jobs, MCP and hooks off. That is not an OS
  sandbox and is never described as one. The real boundary arrives with the packaged desktop app
  (Era 3) — a restricted subprocess with no inherited secrets, a job-only mount, and constrained
  egress. Until then: tool-contained, stated plainly.
- **At-rest database encryption and encrypted exports.** A forgotten passphrase on a no-account tool
  means unrecoverable loss; best-effort owner-only ACLs plus a cloud-sync warning are the current
  posture. Revisited when the packaged app can hold a key properly.

**Newly tracked — found after that review closed.** Defects have kept being found and fixed since,
most of them by attacking this project's own claims rather than by waiting for someone to trip over
them. The full record — every cause, remediation and regression test — is in
[POSTMORTEMS.md](POSTMORTEMS.md). It is long, and it is meant to be: a claim that was never tested is
not a claim, and the list is the evidence that they are tested now. (This paragraph used to carry a
running total. Nothing checked it, and it was wrong within one release — which is the exact shape of
the problem this file exists to prevent, so it now points at the record instead of counting it.)

What is **open right now**, which is what this section is actually for:

- *Open — the limit of the evidence contract, which is a property of the method rather than a defect
  in it.* A receipt shows where an observation came from. It does not prove the observation is the
  only reasonable interpretation. The contract stops the model quoting messages that were never sent
  and asserting things it read nowhere; it cannot stop a true message being cherry-picked, sarcasm
  being read flat, or a handful of examples standing in for years — and it cannot see the calls, the
  RCS and iMessage threads, or anything said in person. Treat a reading as inspectable, not settled.
  The *Archive health* report quantifies what is missing before any pattern is shown, and it no
  longer waits to be opened: Home carries a quiet one-line escalation when the archive has holes in
  it, and any reading whose span contains a gap says so in its own header — because prose closes a
  gap that a chart at least leaves visibly empty. Each source in a mixed archive reports its own
  span, so a stretch only one format covers is legible as exactly that.
- *Open — a generic export that names nobody is scoped to its own file.* The generic importer
  accepts a file carrying only when / which direction / what, with no sender column at all. Nothing
  in such a file says who the conversation is with, so its identity is derived from the file's own
  contents: re-importing the same export converges as usual, but a *second, different* export of the
  same conversation lands as a second conversation. The alternative is worse and was the real
  behaviour until this release — every such file resolved to the same two synthetic identities, so
  two unrelated people's exports merged into one thread. Add a sender column and they converge.
- *Open — "repeated rows collapsed at import" is an archive-wide number.* A row dropped as a
  duplicate is dropped before it belongs to a thread, so it cannot honestly be attributed to one.
  The archive-health panel reports the archive's total and says that is what it is.
- *Open:* a professional trademark search for the mark (blocks any payment collection); the
  contributor-rights decision, CLA vs AGPL-only, which is disclosed in
  [CONTRIBUTING.md](../CONTRIBUTING.md) and currently means substantial external code cannot be merged;
  and external clinician validation of the experimental layer (Era 5 — external by design, see
  [SHIP.md](SHIP.md) §5).

## Security model

Loopback-only, single-owner, no telemetry, three disclosed egress paths, a tool-contained agentic drain,
and a validated evidence chain. The full model and its limits — including what local-first does **not**
protect against and the prompt-injection ceiling — are in [THREAT-MODEL.md](THREAT-MODEL.md) and
[PRIVACY-INVARIANTS.md](PRIVACY-INVARIANTS.md). Report issues via [SECURITY.md](../SECURITY.md).

## Supported inputs

*The list below is the claim, and a test reads it. Prose is easy to write and hard to check — this
project has a postmortem about an honesty check that was parsing English and had quietly degraded to
matching the word "never" — so what can be read is stated as a list a machine can compare against
what the importer dispatch actually routes, in both directions.*

<!-- claimed-inputs:begin -->
- **Android SMS Backup & Restore XML**
- **WhatsApp exported chats** (.txt or .zip, one-to-one)
- **Generic CSV/JSON/JSONL** — anything shaped into when / who / direction / what
<!-- claimed-inputs:end -->

Import more than one and they merge rather than stack: the same conversation seen twice converges,
and each source reports its own span in the archive-health report.

**Not claimed, and built:** the **iMessage Mac `chat.db`** importer exists, is covered by a synthetic
fixture suite, and is reachable only behind `--importers-beta`. A `chat.db` holds *every* conversation
on the Mac, so it also needs `--conversation <id>` to say which one to read; it refuses to guess, and
lists the conversations it found. It is **unverified on real archives** —
every fixture behind it was written here, because the only real `chat.db` files in existence are
somebody's own messages. It joins the list above when two volunteers have read real archives with it
cleanly, and not before. If you have one: it opens the file read-only, writes nothing to it, and
refuses to touch the live database under `~/Library/Messages`.

**Not supported:** iPhone/iOS backups. For the Android path: SMS/MMS only — iMessage, RCS, voice, and
in-person are not in the archive, so some conversations will look quieter than they were.

## Tests

The server suite is the source of truth for behavior, and the web workspace now has one too. CI runs
`typecheck` + both suites on every push to `main` and every pull request, across **ubuntu-latest and
windows-latest × Node 22 and 24** — all four required. Pushes to other branches do not trigger it, so
a green badge describes `main`, not whatever is in flight. The site deploy runs the same gate before
it publishes. The current result is shown by the CI badge in the README.
