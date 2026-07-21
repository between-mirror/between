# Trademark policy — "Between Mirror"

*This is a policy about a **name**, not about the code. The code is
[AGPL-3.0](LICENSE) and nothing here narrows the freedoms that licence grants you.*

## The short version

**You may fork this, change it, run it, and distribute it.** That is the licence, and it is not
negotiable by this document. What this document asks is narrower: that when you distribute a modified
version, a stranger can still tell **whose build they are running**.

- ✅ You may say your project is **"based on Between Mirror"** or **"a fork of Between Mirror"**.
- ✅ You may keep the internal identifiers (`between`, `@between/*`, `between.db`) — they are code, not
  branding, and renaming them would be pointless churn.
- ✅ You may state, accurately, what you changed.
- ❌ Please do not name your fork **"Between Mirror"**, or a name a reasonable person would confuse
  with it.
- ❌ Please do not use the project's logo or wordmark as your project's own mark.
- ❌ Please do not imply your build is official, endorsed, approved, or supported by this project.
- ❌ Please do not use the name to describe a **hosted service** that holds other people's archives.
  See [docs/PRIVACY-INVARIANTS.md](docs/PRIVACY-INVARIANTS.md) — that is the one thing this project
  asks nobody ever do under this name.

## Why a tool like this needs a mark at all

Between Mirror reads the most sensitive data a consumer application can hold: years of someone's
private messages. The entire proposition is that it stays on their machine and that every claim it
makes traces back to the words underneath.

That promise is only checkable if the person can tell **which build** they installed. A modified
build that phones home, or that pipes an archive to a scoring service, would be free software doing
something the licence permits — and if it wore this name, every honest statement this project has
made would become a lie told on its behalf, to someone who had no way to know.

So the mark does exactly one job: it identifies the origin of a build. It is not a restriction on
what you may make. It is the thing that lets a user hold *someone* accountable for what they ran.

## "Official Between Mirror"

Only builds **signed and published by the project's own organisation** may be described as
**Official Between Mirror** builds. Today that means releases published to
`github.com/between-mirror/between` — each an immutable tag, a commit SHA, and (once the packaged
desktop app ships) a signed installer with published checksums and build provenance.

Everything else — your fork, your patched build, a distro package, a build a friend compiled for you
— is a **community build**. Community builds are welcome and legitimate. They are simply not
*official*, and should not describe themselves as such.

The paid Official Desktop edition is a trusted *distribution* of this same AGPL software, never a
different or better program. See [docs/SHIP.md](docs/SHIP.md) §4.

## The honest disclosure

There is **no registered trademark** for "Between Mirror" at the time of writing. This is a statement
of intent and a request for good faith, not an assertion of a registered right.

There is also a known name collision worth stating plainly: **VCNC's "Between"** is a live, actively
maintained private-couples messaging app in an adjacent category. That collision is precisely why
this project uses the two-word mark **Between Mirror** rather than the bare word, and why the org and
this document exist at all. A professional trademark search is a prerequisite before any money is
collected under this name.

## If you think this policy is in your way

It probably isn't meant to be — ask. Open an issue. This policy exists to protect the people whose
messages are being read, not to make forking unpleasant. If a legitimate use is blocked by the
wording above, the wording is the thing that should change.
