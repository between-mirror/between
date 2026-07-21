# Operations

*How this project is maintained once strangers are using it: how incoming reports are triaged, and how
a patch release actually goes out. The product plan is [SHIP.md](SHIP.md); this is the running of it.*

---

## Triage lanes

Triage runs **at least weekly**. Everything incoming lands in one of four lanes, and the lane decides
the clock — not how loudly it was reported.

### 1. Security and privacy — acknowledge within 48 hours

Anything that could expose message content, weaken the network boundary, break the engine-mode gate,
or let something off the machine that the owner did not choose to send.

Arrives via a **GitHub security advisory**, never a public issue ([SECURITY.md](../SECURITY.md)).

1. Acknowledge within 48 hours, even if the answer is "looking at it".
2. Reproduce, and write the failing test **first** — the test is the artifact that keeps it fixed.
3. Fix, ship as a patch release, publish the advisory with the honest version range.
4. Add what it revealed to the **newly tracked** bucket in [STATUS.md](STATUS.md). A review is a
   snapshot, not a certificate, and STATUS is where that stays true.

A vulnerability that is real but not yet fixed still gets stated in STATUS. Silence while a fix is
prepared is fine; silence *after* is not.

### 2. Correctness — next patch release

Anything that makes the tool say something untrue: a wrong count, a claim whose receipts don't hold, a
coverage number that misrepresents what was read, an ingest that drops or duplicates messages.

These outrank features permanently. The entire proposition is that what you read is what the evidence
supports; a correctness bug is not a rough edge, it is the product failing.

### 3. Installability — next patch release

A stranger unable to get from `git clone` to a working app is a total failure for that person, however
small the cause. This lane exists because it has already happened twice: a documented Node floor that
was false on Windows, and boot-time hardening that locked the owner out of their own database. Both
looked like edge cases and were not.

### 4. Everything else — batched

UX friction, docs, refactors, new formats. Batched into a minor release. Real, just not urgent.

## Handling a report that contains personal data

It will happen: someone will paste their own messages into an issue to explain a bug.

1. **Edit the issue immediately** to remove the content, and say why in a comment — kindly. They were
   trying to help.
2. Ask for the *shape* instead ("an MMS with no text part", "an emoji-only body") and build a
   synthetic fixture.
3. If it reached a place edits cannot reach, delete rather than redact.
4. Never copy the content into a commit message, a test, or a note to yourself. See
   [CONTRIBUTING.md](../CONTRIBUTING.md) — no real personal data, anywhere, ever.

## Patch-release checklist

Every patch. No steps skipped because it is "only a one-liner" — v0.2.2 was a one-liner that shipped
red, and v0.2.3's red build was caused by a cache key nobody thought was part of the change.

**Before**

- [ ] A failing test existed first, and now passes.
- [ ] `npm run typecheck && npm test` green on the whole suite, locally.
- [ ] `CHANGELOG.md` entry written in the candor register: what was wrong, what it meant for someone
      using it, what changed. Not a list of commits.
- [ ] [STATUS.md](STATUS.md) updated — especially the three review buckets (fixed / deferred by design
      / newly tracked). If the fix is not done, it says "open", not "fixed".
- [ ] Version bumped in all three `package.json` files.
- [ ] No claim written in the past tense for work that has not shipped yet. This is easy to get wrong
      while writing release notes ahead of the release, and it is the exact overclaim v0.2.1 existed
      to remove.

**Publishing**

- [ ] Dry run: `./scripts/publish-release.ps1 -Version X.Y.Z` — assertions pass, no DECISIONS/FABLE,
      no name-sweep hit.
- [ ] Publish: `./scripts/publish-release.ps1 -Version X.Y.Z -Title "…" -Publish`.

  This is the **only** sanctioned path to the public repo. It rebuilds `public` from the working tree
  with `.gitignore` re-applied, so the private build journal cannot travel. **Tags are immutable**: if
  the version already exists over a different tree the script refuses and names the next patch. A
  correction is a patch release — never a moved tag, because a version that can mean two trees makes
  every provenance claim built on it worthless.

## Auditing the history you already published

The release gates all ask one question: is a private thing absent from the tree about to be
published. None of them can see what is **already** out there, and removing a file from the tree does
nothing about the commit that carried it.

Run [`scripts/audit-public-history.ps1`](../scripts/audit-public-history.ps1) before any release that
matters, and after any privacy incident. It clones the public repository fresh and sweeps contents at
every commit, every path at every commit, all commit messages, annotated tag messages, and every
reachable blob. It refuses to run against a clone carrying `phase3`, because there every pattern
matches by design and the habit of dismissing its output would start immediately.

**If it reports a match, privacy beats immutability.** Stop, record the object and commit, remediate,
and publish a candid note explaining the break rather than absorbing it quietly. That is settled
doctrine, not a judgement call to be made under pressure at the time.

### The one-time repository recreation (owner action)

Decided after v0.3.2: five internal documents carrying real archive statistics, a local path, and one
personal sentence were published in every release from v0.1.0. They are out of the tree now, and
`publishedTree.test.ts` keeps them out — but they remain in all 11 published commits and all 9 tags.

Rewriting in place was rejected: every SHA changes, the immutability promise breaks anyway, **and the
old objects stay fetchable by SHA on GitHub until Support purges them**, so it is not actually a
purge. Recreating the repository is the only option that leaves nothing behind.

This needs the owner, because deleting a repository requires a scope the working token does not have
(`gh auth refresh -h github.com -s delete_repo`) and because it is irreversible.

1. **Confirm the local tree is the one to keep.** `./scripts/publish-release.ps1 -Version X.Y.Z`
   (dry run) — assertions pass, and `npm test` green including `publishedTree.test.ts`.
2. **Delete** `github.com/between-mirror/between` (Settings → General → Danger Zone), or grant the
   scope above and let a session do it.
3. **Recreate** it public, same name, in the same org. Do not initialise it with anything.
4. **Restore the settings** captured below.
5. **Publish** the current version through `publish-release.ps1 -Publish`. It becomes the first
   commit and the first tag; earlier versions no longer exist and the changelog says so.
6. **Re-enable Pages** with source = GitHub Actions, and re-add branch protection on `main` requiring
   the four CI contexts.
7. **Recreate the waitlist Discussion.** It is linked from the README and two site pages as
   `/discussions/1`; created first in the new repo it takes that number again. Verify the links.

Settings to restore, captured 2026-07-21:

| Field | Value |
|---|---|
| Description | A local-first instrument for reading your own message archive honestly. A mirror, not a verdict. |
| Website | `https://between-mirror.github.io/between/` |
| Topics | `data-visualization local-first ollama personal-data privacy-first self-hosted sms sqlite typescript` |
| Discussions | enabled · Issues enabled · default branch `main` |
| Pages | build type: GitHub Actions |
| Branch protection (`main`) | require: `typecheck + tests (ubuntu-latest, node 22 / 24)`, `(windows-latest, node 22 / 24)` |

At the time of the decision the repository had **0 stars, 0 watchers, 0 forks, 0 issues** and one
waitlist thread with no comments. That is the entire cost, and it only grows from here.

### What actually enforces the gates

Say this plainly, because the obvious assumption is wrong and it matters.

The public `main` branch has protection requiring all four CI cells. It is configured with
`enforce_admins: false`, and the release script pushes as an administrator. **Those required checks
are therefore bypassed on every release.** This is not a theory — GitHub prints it during the push:

```
remote: Bypassed rule violations for refs/heads/main:
remote: - 4 of 4 required status checks are expected.
```

So branch protection is **advisory** against the release path. The real enforcement is:

1. **The script's local gates** — the clean-tree preflight, the rebuild's two properties, the
   DECISIONS/FABLE assert, the never-ship deny-list, the name sweep, and the immutability guard. These
   run before anything reaches the remote and they are the only thing standing between a private file
   and a permanent tag.
2. **The post-push CI poll** — after pushing, the script waits for the public CI run on that exact SHA
   and reports GREEN, RED, or unverified. It cannot un-push anything (the tag is permanent by design),
   so it does not abort; it exists so that "published" is never mistaken for "green".

That is a deliberate posture, not an oversight, and it has a known cost: those local gates are exactly
the thing that has repeatedly turned out to be wrong. Four consecutive rounds of adversarial review
during v0.3.2 each found a critical fail-open in that script, and **every one had been introduced by
the previous round's fix**. A PR-based flow, where the checks genuinely cannot be bypassed, is the
alternative; it is filed as an open decision on the task bus rather than assumed.

**After**

- [ ] GitHub Release created with the changelog entry as its notes.
- [ ] **Watch CI on the public repo.** All four matrix cells (ubuntu / windows × Node 22 / 24) green.
      The script polls for this and prints the verdict; confirm it rather than trusting the push
      output, which says "Published" the moment the tag lands. Red CI on a published tag is fixed by
      the next patch, not by rewriting history.
- [ ] Fresh-clone rehearsal on the release itself: clone the public repo somewhere new, `npm ci`,
      `npm run typecheck`, `npm test`, `npm run demo:serve`, open it. The rehearsal is what catches
      the things a working tree hides — it is how the demo-serve path bug was found.
- [ ] Task bus reflects reality: close what shipped, file what was deferred.

## Minor releases

Everything above, plus:

- [ ] An **adversarial re-review over the whole diff** before publishing, with finders aimed at what
      this particular change could plausibly have broken — not a generic sweep. Zero confirmed P0s.
- [ ] [STATUS.md](STATUS.md) rewritten rather than patched.
- [ ] The stranger rehearsal done as a stranger would: public repo, install, test, demo, first screen.

## The standing doctrine

Adopted permanently from the July-2026 adversarial review, and the reason most of the above exists:

> **A claim may only be as strong as its enforcement.**

Which in practice means: STATUS.md is the single truth and updates with every release; every public
update goes through the release script; a capability that is "supported" but untested is a claim
without an enforcement; and when something turns out to be false, the correction is published in the
same voice as the original claim.
