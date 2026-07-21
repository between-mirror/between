# Draft — Privacy Guides, Project Showcase

**Status: NOT POSTED.** Check the forum's current showcase rules before posting; they change, and
arriving having ignored the sidebar is a first impression that cannot be undone.

**Why this venue first:** it is the audience most likely to find the weak spot, and most worth having
found it. Lead with the threat model and the limitations. Do not lead with what it feels like to read
your own years — that is the wrong register entirely here, and it reads as marketing.

---

**Title:** Between Mirror — a local-first tool for reading your own SMS archive, with the threat model up front

---

I built a local-first tool for reading your own message history and I would like this forum to try to
break the privacy story, because a review already found parts of it were convention rather than
mechanism and I would rather hear the rest now than after other people are relying on it.

**What it is:** you export your own Android SMS/MMS archive, it ingests into a local SQLite file, and
you can explore it — volume and rhythm over time, bounded episodes of tension, eras, full-text search
— plus optional written readings from a language model. AGPL, no accounts, no server.

**Egress, precisely.** The deterministic half (all the counting, the charts, search, exports) never
leaves the machine. The written readings need a model, and there are exactly three paths, chosen by
the owner, defaulting to the first:

1. **Local model (Ollama)** — nothing leaves.
2. **Claude subscription** — the message text of the stretches being read goes to Anthropic when you
   run a reading.
3. **Your own Anthropic API key** — same, billed to you, with a dollar estimate shown first.

The mode is enforced server-side, not in the UI, so a local-only owner cannot be talked into spending
or sending by a client bug. The server binds loopback only and refuses to boot otherwise, rejects a
rebinding `Host` or a foreign `Origin`, ships `logger:false`, and carries no analytics dependency —
each of those has a build-blocking test rather than a promise in a README.

**What it does NOT protect against, since that is the interesting part:**

- Anyone with your unlocked machine has the archive. There is no app password and adding one would be
  theatre.
- **No encryption at rest.** Deliberate, and I will defend the reasoning but happily hear the
  counter-argument: on a tool with no accounts and no recovery path, a forgotten passphrase means
  losing something irreplaceable. Best-effort owner-only ACLs plus a loud boot warning if the folder
  looks cloud-synced is the current posture, and the threat model says exactly this.
- **Model containment is tool-level, not OS-level.** On the subscription path the reading runs
  tool-restricted in a staged temp folder holding only the pending jobs — no database, no archive, no
  repo, no home. That is containment by configuration, not by the operating system. A real boundary
  arrives with the packaged desktop build. I am describing it as it is rather than calling it a
  sandbox.
- **Archive text is untrusted input.** Someone who texted you in 2019 could have written something
  aimed at a model reading it in 2026. Prompt injection is in the threat model; under containment its
  ceiling is a bad result file, which validation bounds.

**The grounding problem, which is the part I actually want reviewed.** A tool that writes prose about
your relationship is worthless if it can make things up. So the model cannot return prose at all: it
returns typed blocks, each claim carrying message ids, and every id is resolved against the real
database at render time — a claim whose evidence does not resolve is dropped rather than shown. Even
the connective sentences between paragraphs are drawn from a fixed authored set, because those assert
nothing and therefore cannot carry receipts, which made them the one place unreceipted text could
live.

**Known-weak areas I would genuinely like broken:** the loopback + Origin gate; whether the
tool-level drain containment is worth the name; the export path (verbatim messages plus a hash, no
readings attached, deliberately not "evidence"); and whether the honest-decline behaviour actually
holds when the archive cannot support an answer.

Threat model, privacy invariants and a status page listing what is fixed / deferred / still open:
<https://github.com/between-mirror/between>

There is nothing to buy and no signup. A signed installer is planned later; the source does
everything the installer will.
