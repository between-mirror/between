# Draft — r/selfhosted, **New Project Megathread only**

**Status: NOT POSTED.**

## Read this before posting

- **Megathread only.** Standalone project posts require the project to be several months old; posting
  one early is the fastest way to be removed and remembered for it. Find the current month's "New
  Project" / "Release" megathread and reply there.
- **Verify the rule still says that** before posting. It has changed before.
- Keep it short. A megathread comment is a paragraph, not a landing page.

---

**Comment:**

> **Between Mirror** — read your own SMS archive locally, with receipts under every claim.
>
> You export your own Android SMS/MMS backup, it ingests to a local SQLite file, and you get a
> browsable history: warmth/tension over time, bounded episodes of tension, eras, full-text search,
> verbatim exports. Optional written readings run through a model you choose — a local one via Ollama
> (nothing leaves), your Claude subscription, or your own API key with a cost estimate shown first.
> The counting half never leaves the machine at all.
>
> Relevant to this sub specifically: **no accounts, no server, no telemetry, no licence check, no
> phone-home.** The API binds loopback and refuses to boot otherwise — there is a build-blocking test
> for it, not just a claim. Your data is one SQLite file you can copy, check, and delete from inside
> the app. If the project disappears tomorrow, nothing stops working.
>
> Stack: TypeScript, Fastify, SQLite (better-sqlite3), React. Node 22+. AGPL.
>
> **Honest limitations:** Android SMS/MMS only right now — no iMessage, no WhatsApp, no RCS (those are
> the next major version). No Docker image yet. No encryption at rest, deliberately, because a
> forgotten passphrase on a tool with no accounts means losing something irreplaceable — the threat
> model explains the trade rather than hiding it. The model-containment story is tool-level, not
> OS-level, until the packaged build lands, and it is described that way.
>
> There is a fictional demo couple, so you can see the whole thing without pointing it at anything
> real — in the browser at <https://between-mirror.github.io/between/demo/>, or from the source with
> `npm run demo:serve`. The browser one is the actual app reading a frozen copy; it makes no request
> to anything but that page.
>
> <https://github.com/between-mirror/between>

---

## Note on tone for this venue

No screenshots unless the megathread format invites them. This audience wants the stack, the
dependencies, the deployment story and the catch — in that order. The emotional framing that works
elsewhere reads as marketing here and will be downvoted for it.
