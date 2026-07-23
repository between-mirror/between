# Between — ship plan

*Deploy, distribute, and sustain. This is the operating plan for taking Between public and keeping it
alive without ever violating what it is: local-first, client-held, a mirror not a verdict. The
non-negotiables live in [PRIVACY-INVARIANTS.md](PRIVACY-INVARIANTS.md); the packaging gap in
[STATUS.md](STATUS.md). This document is the owner's playbook.*

> **Tasking rule (owner decision, 2026-07-13):** this playbook is the plan, not the ledger. The
> owner's action items live on the owner's task bus, and the board carries **only what is currently
> blocking** — blocking the project's path, or blocking the agent's execution. Contingent future
> actions stay written here and are filed to the bus the moment they become the actual next blocker.
> No markdown document in this repo maintains a human task list.

> **Shipped through v0.4.1.** Every public version reached `between-mirror/between` `main` plus an
> immutable tag through `scripts/publish-release.ps1`, the only sanctioned public-update path.
> **v0.5.0 is not published:** its release gate was demonstrated on 2026-07-22, and the remaining
> publish command is the owner's act (task #194). See `CHANGELOG.md` and `docs/STATUS.md`.
> **Announcements remain Michael's act** (task bus #181) — nothing has been announced anywhere.
>
> **Where the July-2026 adversarial review actually stands.** The earlier wording here said the review
> "is closed" with "zero P0s remain." That was the review's *own findings* being closed, stated as if
> the whole question were settled — an overclaim of exactly the kind this project exists to refuse.
> The honest statement has three buckets, and it is restated in
> [STATUS.md § Review status](STATUS.md) so it updates with every release:
>
> 1. **Original defects — fixed, test-first, released (v0.2.0).** P0-1…P0-6 and P1-7…P1-13, P2-14.
>    Each has a regression test that would fail if it came back; see `CHANGELOG.md` for what each was.
> 2. **Deferred by design — still open, on purpose.** *OS-level containment of the subscription drain*
>    is tool-level only (restricted tools, staged temp folder, MCP/hooks off). A real OS boundary
>    arrives with the packaged app in Era 3 and not before; until then the claim is "tool-contained,"
>    never "sandboxed." At-rest encryption is likewise deferred, with the reason published.
> 3. **Newly tracked — found after the review closed.** The defects found through the v0.5.0
>    productization and re-review rounds are fixed and recorded in `POSTMORTEMS.md`, with regressions.
>    The v0.5.0 confirmation found zero confirmed P0s. What remains open is stated in STATUS: the
>    method's evidence limits, honest importer/archive-health limits, the trademark search, the
>    contributor-rights decision, and Era 5's external clinician validation.
>
> A review is a snapshot, not a certificate. The standing doctrine holds: **a claim may only be as
> strong as its enforcement.**

The economics that shape everything here, measured on a real 170k-message archive: the entire
deterministic instrument (ingest, river, episodes, eras, findings, exports, conversation packet) costs **$0
forever** and never leaves the machine. The one-time L1 emotion pass is **~$30 on the owner's own API
key** (or $0 + patience on a local GPU), and the full literary tier — every reading including the
letter — is **under $3**. The maintainer's cost-to-serve is **zero**. So the software is free, the
analysis is free, and money is only ever charged for *convenience and human expertise* — never for
the data, never for the insight.

---

## 0 · What ships and what never ships

The public repo contains code, prompts, specs, and de-personalized docs — nothing else. The author's
archive, database, labels, exports, airlock artifacts, and private journals (`docs/DECISIONS.md`,
`docs/FABLE-EXPLORATION.md`) are git-ignored and additionally excluded by the fresh-history publish
recipe below. **The author's own thread is user zero and stays private permanently: it is never the
demo, the screenshot, the case study, or the marketing.**

## 1 · Seal the private history (do this first)

The existing repo history is the author's private build journal — historical versions of several docs
contain personal details that were scrubbed from the working tree on 2026-07-12. It must not be pushed
anywhere public, ever. Commit today's work to it privately, then leave it home:

```powershell
git add -A
git commit -m "Stranger-ready first cut: honesty hard-stop, calibration UI, pricing, AGPL"
```

Pre-publish checks (all should already pass):

```powershell
npm run typecheck ; npm test          # both clean, 275+ green
# the name sweep — must print nothing:
# (sweep for your own family's names and personal handles — keep the actual list in the
#  private journal, never in a committed file, or the check itself becomes the leak)
git grep -inE "<name1>|<name2>|<handle>" -- . | Select-String -NotMatch "DECISIONS|FABLE-EXPLORATION"
```

**Max-product completions — DONE (2026-07-13), adversarially reviewed:**

1. **`examples/` demo archive — DONE.** A fictional couple (Alex & Jordan, 787 messages, 26 months,
   5 season-named eras) generated deterministically by `server/src/cli/gen-demo.ts`. Verified safe:
   zero violence, zero death-wishes, a mutual (two_readings) gate, and the crisis banner never fires.
   `npm run demo:serve` opens it via a non-destructive `BETWEEN_DB` override (your own `between.db` is
   untouched); the `.xml` showpiece + README ship, the `.db` builds on demand.
2. **Cost-consent block — DONE.** The estimate gate now shows honest dollars before any paid run
   (`readCost.ts` → the plan → `AnalyzePanel`): "$0, local" in local-only, "About $X–$Y on your API
   key" with the price sitting right above *Begin the reading* in api-key mode. The pre-ship review
   caught two real defects here (the L1 estimate undershot the real Batch bill ~5×; the reflection was
   mispriced off the L1 backlog) — both fixed and locked with regression tests.
3. **Engine-mode Settings — DONE.** A header gear opens a chooser for `local-only` (the fail-safe
   default) / `subscription` / `api-key`, each with an honest one-line cost/privacy description;
   persists via `PUT /api/engine-mode` and gates the paid Batch path.

## 2 · Publish (day one)

**Decide the home first:** a fresh GitHub **organization** is recommended over a personal handle — it
keeps a healthy distance between the project and the author's family, and reads better for a tool with
contributors. Publishing under a personal account is fine too; it is an identity decision, not a
technical one.

**Name (confirmed 2026-07-13) and a naming constraint for the org:** the product name is **Between** —
final. Note the collision diligence: VCNC's *"Between — Private Couples App"* (between.us) is a live,
actively-maintained couples messenger in the adjacent category. Consequences: do **not** name the org
`between-app` or anything reading as "the Between app"; pick a disambiguating org (the repo itself can
stay `between`), let the tagline carry discovery ("Between Mirror — with the words underneath"), accept
that the "between app" search term is theirs, and take a real trademark look before the paid installer
ships under the name. For an AGPL project off the app stores, the risk is otherwise low.

**Identity check before the first public commit:** commits carry `git config user.name` / `user.email`
verbatim. If the project should keep distance from your personal handle, set a per-repo identity now
(`git config user.name "Between" ; git config user.email "<project address or GitHub noreply>"`) —
it applies to the public commit below without touching your global config.

**Fresh-history publish** — the public repo starts at one commit; private history never travels:

```powershell
git checkout --orphan public
git rm -r --cached .                  # empty the index so .gitignore re-applies
git add .                             # DECISIONS.md and all ignored paths stay out
git ls-files | Select-String "DECISIONS|FABLE"   # MUST print nothing
git commit -m "Between v0.1.0 — first public release"
git remote add public https://github.com/<org>/between.git
git push public public:main
git checkout phase3                   # back to the private line for daily work
```

Then, on GitHub: tag **v0.1.0** as a Release; protect `main`; enable Issues and Discussions; enable
**Sponsors** (money channel #1 — zero marginal effort). After pushing, do the one true smoke test:
clone fresh on another machine or directory, `npm install`, `npm test`, and run the quickstart in
[DEPLOY.md](DEPLOY.md) end to end.

## 3 · Showcase — staged, feedback-first (revised 2026-07-21 per the productization review)

**The mark is "Between Mirror"** (adopted: the org already carries it; VCNC's "Between" couples app
makes the standalone word commercially unsafe; a professional trademark search precedes any payment
collection). Positioning: *"Between Mirror turns years of messages into a private, explorable
relationship history — with the words underneath every observation."* For people with an Android
SMS/MMS archive, a WhatsApp export, or anything they can shape into the generic importer's format —
named precisely, one at a time, and widened only as each one ships with its tests. iMessage is the
line that has not moved. Never: AI therapist, relationship judge, abuse detector, evidence generator,
or couples app.

**The launch kit gates all promotion:** a real landing page (GitHub Pages: /, /demo, /download,
/privacy, /security, /method, /pricing, /faq), a **browser-accessible read-only interactive demo**
(Alex & Jordan, static-JSON demo build — no import, no model, no writes), a 60–90s demonstration
video, six strong visuals, and the founder story (the honest one: built it to avoid handing years of
messages to a scoring cloud; an adversarial review found the promise was partly convention; blocked
promotion and rebuilt the boundaries first).

**Sequence — soft showcase (feedback, not sales) → installer beta → full launch:**
1. Privacy Guides Project Showcase (lead with threat model, egress, limitations — never emotion).
2. Quantified Self forum ("what should a personal-data tool be allowed to infer?").
3. r/dataisbeautiful — an `[OC]` *standalone visualization* of the synthetic couple, not a product
   screenshot; disclose synthetic data + tools in the first comment; check live rules before posting.
4. r/selfhosted **New Project Megathread** only (standalone posts require 3+ months of age).
5. The architecture essay (DEV/own blog): *"An adversarial review found my 'privacy architecture'
   was partly convention. Here is how I rebuilt it."* — later submittable to HN/Lobsters on its own.
6. **Show HN waits** until a stranger can try the interactive demo instantly; Lobsters waits until
   the owner has genuinely participated there; Product Hunt / Microsoft Store / AlternativeTo wait
   for the installer. GitHub topics (local-first, privacy-first, personal-data, sms, sqlite, ollama)
   set immediately.
- Positioning rules stand (VOICE): mirror not verdict; both-things-true; never "AI detects abuse";
  never marketing on anyone's crisis; the 988 surface is a floor, not a feature. Clinician channel
  arrives by pull only.

## 4 · Money — supporterware, no DRM (revised 2026-07-21)

**Two editions, materially identical software.** *Between Mirror Community* — full AGPL source,
manual install, everything, forever free. *Between Mirror Official Desktop* — the paid product is the
**trusted distribution**, not features: signed one-click installer, no Node/Git/terminal, guided
import + identity review, automatic migrations, signed auto-updates, safe data-lifecycle management
(backup/restore/uninstall that asks about data separately), 30 days of setup support, and published
release provenance (immutable signed tag, commit SHA, SHA-256 checksums, SBOM, build attestation).

| Tier | Trigger | What | Price |
|---|---|---|---|
| 0 | **not live** — needs the Sponsors profile enabled on the org (owner action) | GitHub Sponsors (light benefits: monthly dev note, early beta access, optional acknowledgment — no feature votes, no data access, no influence on any reading) | $5 / $15 / $50 monthly + custom one-time |
| 1 | installer beta (~20–30 credible waitlist signups) | Official Desktop, Windows-first — **founding release, first 100 buyers** | **$29 one-time** |
| 2 | after the first 100 + friction fixes | Official Desktop, standard | **$49 one-time**; all v1 updates + security fixes for supported life |
| 3 | only when a real v2 exists (iMessage + WhatsApp + the diff experience) | major-version upgrade | $19–29 |
| 4 | a handful of clinicians arrive by pull | packet-reading workshop + certificate | per-cohort |
| 5 | inbound only; AFTER contributor-rights + trademark are settled | AGPL commercial exception | negotiated |

Checkout via a merchant-of-record (Lemon Squeezy: ~5% + 50¢, handles VAT/sales tax); its licensing
SDK never touches the app — the checkout gates the official download, the app stays offline and
unactivated. Microsoft Store after 25–50 direct customers. **No DRM, ever:** no activation servers,
no accounts, no hardware fingerprints, no phone-home license checks, no updater that abandons
security fixes. The installer will be shared; the AGPL allows it; the moat is the mark + the signed
official build (see TRADEMARK.md).

**Hard lines, forever:** no hosting anyone's archive, no telemetry, no paywall on the analysis itself,
no per-reading/per-message fees, no "premium insight," no locked privacy controls, no "evidence-grade"
claims. The deterministic surface stays free — that promise is the trust the whole thing runs on.

## 5 · The long path — five eras, each gated (re-sequenced 2026-07-21: productize before widening)

*The productization review's structural correction, adopted: the next step is NOT another feature
cycle. Sell the trusted distribution of what exists; the import expansion becomes the v2 upgrade.*

**Era 1 — Foundations & truth (v0.2.1, then v0.3.0 "the presentation release").**
Immutable releases (kill the force-moved tag — a version identifies one tree forever; corrections
bump the patch), honest re-review wording (fixed-original vs deferred-OS-containment vs newly
tracked), Windows CI restored (fix the toolchain, don't explain it away), the **Between Mirror**
rename across public surfaces (+ TRADEMARK.md; professional trademark search filed before money),
receipts absolutism (bridges/questions become app-side templates — every model-authored proposition
has receipts), thread-level coverage gating wired to the UI, the stranger nav (Home / Explore / Ask /
Messages / Readings; Calibrate to Settings + contextual), the "Your data" lifecycle panel,
experience-first README with real visuals, governance files (CONTRIBUTING, CODE_OF_CONDUCT, SUPPORT,
ROADMAP), and the CLA-vs-AGPL-only decision filed before outside code arrives.
*Gate:* v0.3.0 published immutably, Windows + Ubuntu CI green, re-review zero P0s.

**Era 2 — The launch kit + soft showcase.** Landing page on GitHub Pages, the read-only interactive
demo, video + six visuals, founder story; then the §3 soft sequence (Privacy Guides, Quantified Self,
r/dataisbeautiful, r/selfhosted megathread, the architecture essay) — feedback, not sales; an
installer waitlist with visible planned pricing ($29 founding / $49 standard).
*Gate:* demo instantly usable by a stranger — **met in v0.4.0**: the real application runs at
[/demo](https://between-mirror.github.io/between/demo/) with no install, no account and no request to
any other origin, and Ask answers there. The remaining half of this gate (~20–30 credible waitlist
signups) is downstream of the soft showcase, which is a posting decision, not a build one.

**Era 3 — Official Desktop (v0.4).** Tauri 2 Windows-first: signed NSIS/MSIX, bundled WebView2,
signed updater with stable/beta channels, OS-level drain containment (restricted subprocess, no
inherited secrets, job-only mount, egress constrained — the boundary the tool-level containment
honestly lacks), data in the OS user-data dir, full lifecycle + diagnostic bundle (redacted,
manifested), the Windows test matrix (clean VM, non-admin, upgrade, uninstall/reinstall, migrations,
odd paths, offline, interrupted import, SmartScreen/AV), provenance attestations + SBOM + checksums.
Founding 100 at $29 via Lemon Squeezy → interviews → friction fixes → $49. Then the full launch:
Show HN (instant demo ready), Product Hunt, Microsoft Store, AlternativeTo.
*Gate:* clean-machine installs verified; trademark search cleared BEFORE the first sale.

**Era 4 — Reach = the v2 upgrade.** iMessage (Mac chat.db / iPhone backup), WhatsApp `.txt`,
Google Messages/RCS where feasible, a documented generic importer format for contributors, and the
"since you last looked" diff experience. macOS build when iMessage lands. This is the $19–29 major
upgrade — and the moment "for people with an Android archive" widens honestly.
*Gate:* per-format fixture suites; cross-source dedup + coverage semantics verified.

**Era 5 — The earned claims (v1.0 of the instrument).** External clinician validation of the
experimental layer against an expert-labeled adversarial benchmark; FP/FN/asymmetry numbers published
in STATUS.md whatever they say; only then do the interpretive defaults, the promoted conversation
packet, the certification channel, and shared calibration ship. *This gate is external by design.*

### The prior four-era plan (superseded 2026-07-21)

*(Rewritten 2026-07-21, after v0.2.0 "the hardening release" shipped and the adversarial re-review
found no P0 among its own findings. The standing doctrine, adopted permanently from that review: a claim may only be
as strong as its enforcement; STATUS.md is the single truth and updates with every release; every
public update goes through `scripts/publish-release.ps1`; an adversarial re-review workflow runs
before every minor release; the first public claim stays narrow — "privately explore your own
archive, see patterns over time, trace every observation to the words underneath" — and the bigger
claims are earned, era by era.)*

**Era 1 — Introduction (now, v0.2.x).** The hardened instrument meets its first strangers.
- Owner: enable Sponsors; write and post the four announcements (Show HN first; the hardening arc —
  "an adversarial review found real defects at my load-bearing boundaries, here is how each was
  closed" — is the story, told plainly).
- Standing operations: issue triage at least weekly; severity lanes (security via GitHub advisories →
  respond within 48h and patch via the release script; correctness → next patch; UX/docs → batched).
  Patch releases are v0.2.x; every one re-runs the boundary test + stranger rehearsal.
- **Gate to Era 2:** the announcement wave answered; every wild-caught defect triaged; no confirmed
  P0 standing; `CONTRIBUTING.md` added at the first stranger PR.

**Era 2 — Reach (v0.3).** The audience-doubling release; recurrence becomes real.
- **iMessage import** (macOS `chat.db` + iPhone-backup route): Apple epoch, `attributedBody` decoding,
  source-aware coverage flags, dedup against Android imports. The single highest-impact feature.
- **WhatsApp `.txt` import**: small parser, locale/date-format variants, media-omitted placeholders.
- **"Since you last looked"**: deterministic diff reading over incremental re-imports — new spans,
  direction shifts, era boundary moves. The thesis feature: direction over time, watched.
- Fold measured token priors into the cost estimates (carry-over).
- **Owner decision at era start:** encryption-at-rest posture (leaning opt-in + "no backdoor, no
  recovery" warning). File to the task bus when the era begins.
- **Gate to Era 3:** import-correctness fixture suites green for all three formats; real strangers on
  all three platforms; coverage semantics honest across mixed-source archives.

**Era 3 — The instrument in hand (v0.4).** The packaged app; the OS boundary the review wanted.
- **Tauri wrapper**: bundled runtime, Fastify serving static with the per-install auth token now
  ENFORCED, file ACLs by default, no dev proxy — the packaged build is where OS-level containment
  of the drain becomes real rather than tool-level.
- **The $29 one-time signed installer** when the demand trigger fires (~20 genuine "easier install?"
  asks). Source stays free and identical. Code-signing cert is an owner identity/cost decision.
- Encryption-at-rest lands here if the Era-2 decision chose it. Auto-update channel.
- **Gate to Era 4:** installer smoke on clean machines; packaged boundary test suite; the paid
  artifact changes nothing about what the free source can do.

**Era 4 — The earned claims (v1.0).** The "relationship instrument" claim, finally made in public.
- **External validation of the experimental layer** — the only path to un-gating it: a clinician
  review panel recruited through the pull channel (never cold-pitched); an expert-labeled adversarial
  benchmark corpus (extend the demo generator into known-ground-truth scenarios: mutual conflict,
  one-sided coercion, false-balance traps, trauma-related self-blame); measured false-positive /
  false-negative / speaker-asymmetry numbers **published in STATUS.md**, whatever they say.
- Only after that review signs off: the interpretive layer's default and marketing change, the
  conversation packet is promoted, the clinician workshop/certification (revenue tier 2) opens, and
  **shared calibration** — both partners calibrate separately and compare readings — ships as the
  couples product the clinician channel actually wants.
- The grief/keepsake reading ships in whichever era its pull arrives.
- **This era's gate is external, by design: independent domain review, not self-assessment.**

## 6 · What success looks like

Not stars. Three things: a stranger completes an honest calibration and the tool tells them something
true they could act on; a therapist receives a pack cold and finds METHOD.md sufficient to read it
responsibly; and zero privacy incidents, permanently. The revenue target is sustainability — enough to
justify the maintenance hours — not growth.
