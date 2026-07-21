# Roadmap

*What is coming, what is being looked at, and — the section that matters most — what will never be
built. For what exists **today**, [STATUS.md](STATUS.md) is the authority; when the README and STATUS
disagree, STATUS wins. The full staging and its gates live in [SHIP.md](SHIP.md) §5.*

---

## Committed

Things that will be built, in roughly this order. Each era is gated: the next does not start until
the previous one's gate is met.

### Official Desktop (v0.4)

A signed, one-click Windows installer — no Node, no Git, no terminal. Guided import and identity
review, automatic migrations, signed auto-updates, and data-lifecycle management that asks about your
data separately from the app.

The part that matters beyond convenience: **OS-level containment of the model drain**. Today's
containment is tool-level (restricted tools, a staged temp folder, MCP and hooks off) and is described
that way everywhere. The packaged app is where a restricted subprocess with no inherited secrets, a
job-only mount, and constrained egress becomes real. That is a boundary, not a convention.

Published provenance for every release: immutable signed tag, commit SHA, SHA-256 checksums, SBOM,
build attestation.

### More archives — the v2 upgrade

- **iMessage** (macOS `chat.db` and the iPhone-backup route), including Apple epoch handling and
  `attributedBody` decoding.
- **WhatsApp** `.txt` exports.
- **Google Messages / RCS** where technically feasible.
- A documented **generic importer format**, so a format nobody here owns can still be contributed.
- **"Since you last looked"** — a deterministic diff reading over a re-import: new stretches,
  direction shifts, era boundaries that moved.

macOS build lands when iMessage does. This is the moment "for people with an Android archive" widens
honestly, and not before.

### The earned claims (v1.0)

External clinician validation of the experimental interpretive layer against an expert-labelled
adversarial benchmark, with false-positive, false-negative and speaker-asymmetry numbers **published
in STATUS.md whatever they say**. Only after that review signs off do the interpretive defaults
change, the conversation packet get promoted, or shared calibration ship.

**This gate is external by design.** It cannot be met by the project deciding it has been met.

## Investigating

Not commitments. Listed so the thinking is visible.

- **Encryption at rest.** Deliberately deferred: a forgotten passphrase on a no-account tool means
  unrecoverable loss of something irreplaceable. Leaning toward opt-in with a blunt "no backdoor, no
  recovery" warning, once the packaged app can hold a key properly.
- **Group threads** as first-class, rather than the 1:1 focus the readings assume today.
- **Non-English archives.** The lexicon layer is English-first and says so; what an honest
  multilingual version looks like is an open question, not a translation task.
- **A grief/keepsake reading** — ships in whichever era its pull actually arrives.
- **Accessibility beyond the current keyboard and ARIA work** — a real screen-reader pass, done
  properly, with someone who uses one.

## Not planned

Permanent. These are not "unlikely" or "not yet" — they are things this project exists partly *not*
to do. If any of them ever appears, it is a different project wearing this name, and
[TRADEMARK.md](../TRADEMARK.md) exists partly so you can tell.

- **DRM, licence servers, activation, or phone-home entitlement checks.** The paid edition is a
  trusted *distribution*, never a locked one. The installer will be shared; the AGPL allows it.
- **Accounts.** No sign-up, no login, no identity, no password reset — because there is nothing on a
  server to attach an account to.
- **Telemetry, in any form.** No analytics, no crash reporting, no "anonymous usage statistics",
  nothing reported about a person, their archive, or their use of the program. Not opt-in, not
  opt-out — absent, and CI-checked. The signed update check the installer will carry is not an
  exception to this and is not telemetry: it will fetch one static release manifest, identical for
  every installation, carrying no install ID, no machine ID and no counter, with a one-click off
  switch. One is the program asking a question; the other is the program reporting on you. Today no
  such check exists, because the installer does not.
- **A hosted service.** Nobody's archive on anybody's server, including ours. Not for the demo, not
  for support, not for "just the aggregates".
- **Per-reading or per-message fees, or a paywall on the analysis itself.** The deterministic
  instrument is free forever. Money is only ever for convenience and human expertise.
- **"Premium insight."** No reading that a paying user gets and a source user doesn't.
- **Evidence-grade or legal-grade claims.** No "build a case" export, no court-ready report, no
  scoring anyone for use against them. The export is verbatim messages and a hash — deliberately
  neutral, deliberately not a verdict.
- **Abuse detection as a product claim.** The interpretive layer is experimental, off by default, and
  will never be marketed as detecting abuse — not before external validation, and not after.
- **Selling, sharing, or training on anyone's messages.** Including ours.
- **Social features.** No sharing, no comparison with other couples, no leaderboards. Every one of
  those turns a mirror into an audience.
- **An always-on background agent** watching new messages as they arrive. Reflection is a thing you
  choose to sit down and do; a tool that watches continuously is surveillance with a nicer font.

## How to argue with this list

The "not planned" items are settled and a pull request will not move them. Everything else is open:
open a [Discussion](https://github.com/between-mirror/between/discussions), and if the reasoning is
good the list changes. See [CONTRIBUTING.md](../CONTRIBUTING.md) — including the current caveat that
substantial external code cannot be merged until the contributor-rights question is decided.
