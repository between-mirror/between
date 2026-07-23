# Changelog

## v0.5.0 (2026-07-22) — A second backup used to crash, and that was the least of it

This release is mostly about the archive being *more than one file*: more than one import, more than
one format, more than one spelling of the same person. That turned out to be where nearly everything
was broken, and none of it was visible from a single clean import.

**Importing a second backup crashed on v0.4.1.** `UNIQUE constraint failed:
threads.participant_signature` — shipped, and the entire premise of "since you last looked". Threads
and contacts are now keyed on the participants' own identifiers rather than on the numbers a file
happened to hand out, and the dedup key is source-neutral, so the same conversation seen twice
converges while two messages that share a minute and a word stay two.

**New: three more ways in.** WhatsApp exported chats (`.txt`/`.zip`, one-to-one) and a generic
CSV/JSON/JSONL importer for anything reducible to when / who / which direction / what. A fourth —
the iMessage Mac `chat.db` — is built and tested but **deliberately not claimed**: every fixture
behind it was written here, because the only real `chat.db` files in existence are somebody's own
messages. It is reachable behind `--importers-beta` and joins the supported list when two volunteers
have read real archives with it cleanly, and not before.

**New: archive health, and it no longer waits to be opened.** A beautiful calm caused by missing data
is the most dangerous thing this product can show, so the report that quantifies what is missing —
spans, discontinuities, a suspected SMS→iMessage migration, attachment coverage, duplicates,
identity ambiguity — now escalates quietly on Home, and any reading whose span contains a gap says
so in its own header. "What percentage of the relationship is here" is not answered, because it is
not knowable; what the archive can and cannot see is.

**Calibration v2.** The hold-out now asks what is *observable* in the words rather than how bad a
message was, samples across the model's own low/mid/high tension bands instead of only the messages
it already called hostile, seeds the draw so any set of thresholds can be traced to the sample behind
it, and shows the owner every disagreement **before** anything is saved. v1 drew the messages the
model called hostile and then used those labels to validate the model's threshold; it also picked
thresholds by maximising F1 over disagreements nobody was ever shown.

**The interpretive layer has no switch, because it never had one.** This file previously said it was
turned on via Settings with sober consent, describing a control that had never been built, while the
actual path was an HTTP call the app could make on its own behalf. Both are gone; a test asserts the
route does not exist. It is not removed — an external reviewer cannot evaluate what they cannot run —
so research activation is documented, deliberately awkward, and takes two separate acts.

### The re-review, which found more than the release did

Every minor goes through an adversarial re-review before it ships: finders aimed at what the change
could break, three refuting skeptics per finding. This one ran 128 agents over the diff — 40
candidates, 24 reports survived refutation, and those reports describe nine distinct P0s — and then a
second pass over the fixes found three of those nine still open, recorded as fixed. The full record
is in
[POSTMORTEMS.md](docs/POSTMORTEMS.md). The ones a user would have felt:

- **An upgrade could take the archive away.** Recomputing dedup keys collided on a UNIQUE column, and
  the migration runs inside the only door into the store — so the archive became permanently
  unopenable by the app and every CLI, with no repair path. The trigger was ordinary: two photos sent
  in the same second. A comment in that file asserted this could not happen; it had been false since
  the day it was written. Both rewrites are now collision-safe by construction rather than by
  argument, and nothing may abort in there.
- **"Delete everything" left a complete unencrypted copy of the archive on disk**, because the
  migration writes its backup beside the database and the deletion sweep enumerates every folder
  except that one. The panel reported "0 backups" while every message sat readable next door.
- **Real messages were being destroyed and counted as unreadable.** The iMessage decoder skipped
  metadata with a prefix rule that also matched *NSFW*, *NSW next week?*, *NSA is at it again*.
- **Two strangers could become one relationship.** A generic export that names nobody used the same
  two synthetic identities as every other such file, so two people's exports merged into one thread
  split by direction. Scoped to the file now — with the limitation stated in STATUS rather than
  hidden.
- **The same person, written two ways, became two people** — while the thread merged anyway, so a
  1:1 conversation rendered as "Alice, Alice" and marking them a partner labelled half of them.
- **Who the archive belongs to** was recomputed per file, so importing one conversation and then the
  full backup forked the thread and invented a group chat that never existed.
- **A calibration with no hostile labels chose the strictest threshold available**, then reported
  "calibrated to you": the person who reported the least hostility got the reading with the most.
- **The iMessage importer could not have read any real file** — it scanned participants across the
  whole database, so every real archive looked like a group chat and was refused, saying so as the
  reason.

A later narrow verification of the final identity fix found two more P0s before the confirmation
review was launched. The owner-only participant key used a plain-text `self:` prefix that a generic
source identifier could reproduce, allowing an ordinary conversation to share a thread and dedup
space with a note-to-self thread. Participant roles are now structurally encoded and the migration,
repair and ingest paths use the same representation. A partial backup from a second handset could
also miss that handset's owner when its only evidence was one incoming one-to-one MMS; importing the
full backup later then changed the participant set, forked the conversation and duplicated the
overlap. A sole incoming recipient is now direct owner evidence. Both failures have regressions for
the adversarial values and both partial/full import orders.

The final confirmation re-read every earlier round before attacking the complete release tail
locally, with no external agent fan-out or paid API calls. It found zero confirmed P0s. It also added
the two regressions the tail still lacked: Android's real owner-placeholder shape in both partial/full
orders, and a v0.4.1-style owner-only thread surviving migration and re-import without a fork or a
doubled row. The release gate is demonstrated; publication remains the owner's separate act.

Nothing here was reported by a user. All of it was found by attacking this project's own claims.

## v0.4.1 — The guard was carrying the secret

The check written to stop the archive statistics being published **contained them**, hardcoded, each
annotated with which number it was. It exempted itself from its own scan — correctly, since a scanner
must contain its patterns — and so it passed, and the release shipped it. The same shape as
`HANDOFF.md` forbidding personal data four paragraphs before disclosing it, in the file written to
prevent exactly that. Twice in one release cycle.

The patterns now live in the gitignored private file with the names, read at run time and written
nowhere. When that file is absent — a stranger's clone, CI — the assertion says it was **skipped**
rather than reporting a pass it did not earn; the enforcement that matters is the release script,
which refuses to publish without it and now sweeps the statistics alongside the names.

v0.4.0 named a different tree for the few minutes before this was found. It is not reused: a version
identifies one tree forever, so the correction is a patch, and v0.4.1 is the first release of the
recreated repository.

## v0.4.0 — Somebody else can finally look

**A note about this repository's history.** Releases v0.1.0 through v0.3.2 published five internal
documents that should never have left this machine. They carried the author's own message archive in
numbers — its size, its exact per-type counts, its span, the number of people in it — the literal
local path it sits at, and one sentence comparing how harshly the author rated his own hard messages
against his partner's. `HANDOFF.md` stated, as a binding invariant, that no personal data may ever be
in the repository, and gave the counts four paragraphs later.

Every release gate this project had asked whether a private thing was *absent from the tree about to
be published*. Nothing looked at what the published tree *contained*, and nothing at all could see
the history already published. Both gaps are now closed by tests, and a new
`scripts/audit-public-history.ps1` sweeps the published history directly — it reports **CLEAN** for
every name and handle across 11 commits, 9 tags and 406 blobs.

Because that audit finds names and the exposure was numbers, the repository is being **recreated from
the cleaned tree** rather than rewritten in place: a rewrite leaves the old objects fetchable by SHA
until the host purges them, and privacy beats immutability here. That breaks this project's own
promise that a version identifies one tree forever, and it should be called what it is — a one-time
break, taken deliberately, documented rather than quietly absorbed. The earlier tags no longer exist.


Until now, seeing this tool meant trusting a description of it or cloning a repository. **There is now
a demo you can click: <https://between-mirror.github.io/between/demo/>.**

It is not a mockup or a video. It is the real application — the same React code, the same views —
reading a frozen copy of a fictional couple's archive. Every read is answered from JSON captured off
the actual API (31 surfaces), so what you see is what the software genuinely returns rather than what
someone wrote down about it. Every write is refused, with copy that says why: there is nothing of
yours there to change.

**It talks to nothing.** Loaded from a plain static server it makes six requests — the page, its
script, its stylesheet, and the data it needs — all to the page's own origin. The built bundle
contains exactly two absolute URLs, both of which are text rather than requests (W3C namespace
identifiers, which the DOM spec requires verbatim, and React's error-decoder link inside an error
message), and each was read and approved individually. A site arguing that this software does not talk
to third parties, hosting a demo that quietly loaded a font from one, would be a rebuttal of the
product published on the product's own website.

**Ask answers there, and declines there.** Three questions, offered as chips rather than a text box:
`sorry` returns 29 receipts, `miss you` returns 17, and `money` honestly declines. Each answer comes
from the real planner, not from a hand-written fixture. The decline is deliberate and is enforced by a
test — a demo where every question succeeds misrepresents an instrument whose central claim is that it
stops when the words run out.

The Ask questions are phrased as the search terms they are, which was the second attempt. The first
used natural sentences, sent them whole to a full-text search, matched nothing, and made all three
questions decline — a demo that would have taught visitors the tool is considerably worse than it is.

**A defect that was not one.** STATUS had carried an open performance defect since v0.3.0: that
`GET /threads/:id/episodes` took roughly 20 seconds on the demo, blamed on recomputation per request.
Measured, none of it held — that endpoint is a single indexed `SELECT` over a bounded table, it runs
in 4–29 ms on the demo and 0 ms on a 50,000-message archive, and the whole Overview completes in about
30 ms. The wrong diagnosis had aimed the fix at moving work that was already in the right place, while
the reads that genuinely cost something at scale (findings 507 ms, ambient 374 ms at 50k) had nothing
watching them. Budgets now sit where the time actually goes, asserted against both the demo and a
generated 50,000-message archive.

**One thing published that should not have been.** The first export of the "Your data" panel carried
the maintainer's own drive letter and directory layout — an absolute local path to the example
database — headed for a public page about privacy. The export truthfully reports where files live, which is correct in the
application and wrong on a website. Paths are now redacted to a generic home, keeping everything below
the repo root so the panel still reads like a real install.

Also in this release: the release script polls public CI after pushing and reports green, red, or
unverified, and [OPERATIONS.md](docs/OPERATIONS.md) now states plainly that branch protection does not
enforce against the release path — GitHub prints "Bypassed rule violations" during every publish — so
the script's local gates are the real enforcement.

## v0.3.2 — Things that could not be seen

Two release blockers, a copy pass, and four pictures of nothing. The theme is defects that were
invisible in review — not subtle, *unrenderable*: bytes no editor shows, a diff git refused to
display, and screenshots that were exactly what they claimed to be except for what was in them.

**The site's honesty check was not checking anything.** The assertion that the pages never claim to
produce evidence had four literal U+0008 BACKSPACE bytes where `\b` word boundaries belonged — a
heredoc ate the backslashes — so two of its three negation alternatives could never match and it had
quietly degraded to a substring search for "never". Fixing the regex was not enough, and the attempt
to prove the fix is what showed why: adding a plain overclaim to a page still passed. The "per
sentence" splitter ran over raw HTML, where `answers.</p>` is not a sentence break because the `.` is
followed by `<`. One measured "sentence" was 1123 characters spanning the doctype, the whole nav, a
`<meta>` description containing "not", and the next section containing "never". Every overclaim was
absolved by any negation near it, including words in attributes no reader ever sees. Copy is now cut
into the units a reader reads one at a time, and the assertion was watched failing on a deliberate
overclaim before the fix was committed.

A new source-hygiene test fails the build on any C0 control byte in any committed text file, and
found a second instance on its first run: `docs/SPECS/airlock.md` has carried two literal NUL bytes
since its first commit, at the separator positions of the idempotency key. They render as nothing and
made git classify the file as binary and refuse to diff it at all. Whoever implemented `hash.ts` read
the rendered spec, saw empty quotes, and used a space — so the spec and the code have disagreed
silently for the project's entire history. The spec is corrected to the shipped behaviour rather than
the reverse, because `input_hash` is a persisted primary key: changing the separator would strand
every cached analysis in every existing database and force a re-drain that costs real money. The
separator is now named (`SEP = one U+0020 SPACE`), never shown.

**The release script could resurrect a file deleted for privacy.** It emptied the index with
`git rm --cached`, which untracks without deleting, so a file present on `public` but since deleted
on `phase3` was still in the working tree when the final `git add .` ran — and came back, in that
release and every one after it. The obvious repair is worse than the bug: `git checkout phase3 -- .`
stages what it restores, and would have published `docs/DECISIONS.md`. Both properties are needed at
once, so the sequence now lives in `scripts/lib/Rebuild-PublicTree.ps1` and a test runs the real
script plus both broken variants, asserting each exhibits its own defect. The bug was latent — the
two branches differ by zero files — and would have fired on the first deletion.

Running that script for the first time found two more: it reached for a helper that the branch switch
had just deleted from the working tree, and its abort path ran `git checkout -f` unconditionally,
including from the preflight that refuses a dirty tree — silently discarding the uncommitted work it
was complaining about.

**The public copy said more than the software can prove.** "Nothing is uploaded" is not true of a
tool whose written readings you can point at Anthropic. "Nothing is collected" is not true of any
page served over HTTP — GitHub Pages receives the request metadata every web server receives, and
that is a different sentence from "the project collects nothing", which remains true. The
update-policy contradiction is settled rather than hidden: update checks will be default-on and
identifier-free, one static manifest identical for every installation, with a one-click off switch —
written in the future tense throughout, because the installer that would carry one does not exist and
the shipped code dials nothing but a local model. "No telemetry" stays permanent; an update check is
the program asking a question, not reporting on you. The paid edition is no longer "byte-for-byte the
free one", which code signing makes impossible, and the security page now states that its
prompt-injection ceiling holds under documented tool-policy assumptions and that this is not OS-level
isolation. Six assertions lock the pass in, one of which fails if any removed absolute reappears.

**Four of the six published screenshots were pictures of the application doing nothing.** The hero —
the README's opening image, and now the social card for every page — was the words "Reading the shape
of these years…" over an empty panel, captioned as a warmth-and-tension river with statistics beneath
it. `receipt.png` was the "No reading yet" empty state under a caption describing a claim opened onto
the message it rests on. They were genuine screenshots of the real application, which is what made
them feel safe. The capture script waited fixed delays and photographed whatever was there;
`episode.png` was right only because it was the one capture with a content assertion. Every capture
now waits for the content its caption will claim and refuses rather than shipping an empty panel —
and with that in place all six re-captured correctly, so nothing had to be withdrawn.

**Then four rounds of adversarial review went at this release's own diff, and every round found a
critical fail-open that the previous round's fix had introduced.** That is the honest headline of the
version — not that the release script was fixed, but that fixing it went wrong four times in a row,
each time in the same shape: a check printing "clean" over something it never looked at.

The release script could run an entire release *from the wrong branch*. `$ErrorActionPreference` does
not apply to native commands, so a failed `git checkout public` printed its error and execution
continued — rebuild, assertions, commit, tag, push, all with HEAD still on `phase3`. Since `public`
shares no ancestor with `phase3`, that tag push uploads the whole private history. A reviewer read the
leaked journal blob out of the receiving repository. Separately, the **name sweep was failing open
twice over**: `git grep` errors read as "clean", and because git grep defaults to POSIX *basic* regex,
the obvious `Name1|Name2|handle` pattern matched nothing at all while reporting a passed sweep.

And the overclaim check was defeated 25 ways — by ordinary English, not trickery. "Nothing is more
court-ready" passed; "We don't produce court-ready exports" failed. Three versions of that check have
now tried to decide mechanically whether a sentence asserts or denies, and each refinement traded a
bypass for a false positive. That is the wrong problem for a regular expression, so the check no
longer attempts it: the vocabulary is banned outright, with a three-line list of approved sentences
that a person has read. The remaining false positives are the feature — the list is the review.

**Then a third round found that the second round's own fix had opened a new way to publish a private
file.** The repair for the machine-local gitignore defect told `git add` to ignore `core.excludesFile`,
so that a personal rule could not silently drop files from a release. The preflight's clean-tree check
still honoured it. The two therefore disagreed about what was in the working tree, and a path hidden
from the operator by their own global ignore was invisible to "working tree is not clean" and fully
visible to `git add .` — bound for a permanent tag. On the maintainer's machine that path is
`.claude/settings.local.json`, which records approved tool permissions and local paths; the global
ignore hides it, this repo's `.gitignore` said nothing about `.claude`, and `.claude/` already exists.
It had not fired only because no such file had been written yet. `status.showUntrackedFiles=no` beat
the same check a second way.

Three consecutive rounds, three fail-opens in one script, every one the same shape: a check printing
"clean" over something it never looked at. The preflight now reads the tree with the repository's own
rules only; the repo classifies that file itself instead of leaving it to a personal one; and a
never-ship deny-list covers the general case that naming two journal files by hand never could.

The same round found the name sweep silently matching nothing in **five further ways** — a pattern
with trailing whitespace, a pattern with a trailing inline comment (a shape
`personal-patterns.txt` itself instructs you to write, so following its advice disabled the sweep), a
pattern file saved as cp1252, a name inside a file git treats as binary (`.gitattributes` marks
`*.png` binary, and a screenshot of this application is the likeliest place for a real name to sit in
plain sight), and a name appearing only in a *filename*, which `git grep` never searches. The
`-Title` text, spliced verbatim into a permanent public commit message, was the one operator-supplied
string reaching the remote unswept. Twelve regression tests, each watched failing against the
pre-fix script.

**And a fourth round found that round three's checks could be defeated by one accented character.**
`git ls-files` honours `core.quotePath`, on by default, so a path containing any byte above ASCII
comes back octal-escaped and quoted. Both of the list-based checks round three had just added — the
filename sweep and the never-ship deny-list — matched their patterns against that mangled string
rather than the real path. A real name in a non-ASCII filename published itself while the sweep
reported clean, and every `$`-anchored deny rule was defeated by putting one accented character in the
name. PowerShell decoding git's UTF-8 output as the console's ANSI codepage was the same defect one
layer out. Round three's own comment had claimed that "the repository is the only authority, in both
directions"; it wasn't, and it took a fourth reviewer to notice that the cure had the disease.

The same round found round three's inline-comment stripper silently rewriting valid patterns —
`Surname|@handle #hashtag` became `Surname|@handle`, still valid, matching less, shipping the handle —
and the filename sweep reading patterns in a different regex language from the content sweep, so
`\<Zoe\>` meant a word boundary to one and an escaped `<` to the other. The parser no longer guesses
what a `#` means; it stops. Both sweeps now run through the same engine.

Full detail is in [STATUS.md](docs/STATUS.md). Also fixed there: a remote tag's SHA that was read,
validated and never compared to anything, so a version already taken by someone else's tree was
reported as our own release, already live; a failed `git ls-remote` moved the
published `main` while leaving the tag behind; an exit-zero `ls-remote` *warning* was parsed as a
commit SHA and reported a tag that did not exist as already published; an interrupted tag push wedged
a version permanently; `-Version v1.0.0` published a tag named `vv1.0.0` and `-Version "0.3.2 beta"`
pushed `main` before failing at `git tag`; a personal machine-local gitignore silently truncated a
release; and the tests written for the first round of fixes did not fail when those fixes were
reverted, so they were replaced with behavioural ones.

Also: canonical/OpenGraph/Twitter metadata and a favicon on every page, a no-referrer policy, a quiet
sponsor link that says plainly there is nowhere to send money yet, the waitlist telling people to
press Subscribe because nothing here can contact them, `npm ci` in the public instructions, a test
that no published PNG carries text metadata chunks, a test that the four version numbers agree
(`package-lock.json` had sat at 0.2.4 through two releases), and a Pages deploy that runs typecheck
and the full suite before it uploads — so the site cannot ship from a tree that fails its own claims.

## v0.3.1 — The launch kit

A landing site, and the drafts for a launch that has not happened.

**site/** — eight hand-written static pages (home, demo, get it, privacy, security, method, pricing,
FAQ) deployed to GitHub Pages. No build step, no bundler, no scripts at all, no fonts or images from
anywhere but its own origin. A page arguing that this software does not phone third parties should
not need a CDN to render its typography.

That is enforced rather than intended: `server/test/siteNoEgress.test.ts` runs on every push and
fails on an off-origin asset, a `<script>` tag, a known analytics or font host, an `@font-face`, or an
outbound link to a host that isn't on a short allowlist. The Pages workflow repeats the check against
the exact bytes it is about to publish.

The same test also holds the site to what the software actually does: it may not claim to produce
evidence, it must state the Android-only scope and that iPhone is unsupported, it must say the
installer is not for sale yet, and it may not claim a browser demo that does not exist. Writing
marketing copy is exactly when a project drifts from its status page, so the drift is a test failure.

**A waitlist that collects nothing** — a pinned Discussion where you react 👍 and optionally say which
platform you need. No email, no form, no third-party service, nothing to unsubscribe from.

**docs/launch/** — five venue drafts and a shot-by-shot video storyboard, **none of them posted**, each
carrying its venue's rules at the top and the gate that must be met first. They exist so the writing
is not being done under launch-day pressure.

Still missing, and named rather than implied: the browser-only interactive demo. The demo page says so
in its own words instead of pretending. Ask cannot be demonstrated in it yet either — `examples/demo.db`
holds no pre-computed answer, so Ask honestly declines, which is real behaviour but not a
demonstration.

## v0.3.0 — The presentation release

The instrument was hardened in v0.2.0. This release is about whether a stranger can pick it up,
understand what it is, and tell what it is claiming — plus the last place where a claim outran its
enforcement.

### The name

The product is **Between Mirror** everywhere a person can read it: the browser tab, the app header,
the README, the package description. Internal identifiers are deliberately unchanged. VCNC's
"Between" is a live couples app in an adjacent category, which is exactly why the mark is two words —
and [TRADEMARK.md](TRADEMARK.md) now states the fork terms plainly: use the code, say you are "based
on Between Mirror", don't imply your build is the official one. It also discloses that no registered
mark exists yet.

Two phrases retired. The README no longer bills the product as "powered by Claude Code" — a mirror is
not powered by the thing that reads for it — and "working name" is gone, because the name is final.

### Every model-authored sentence now carries receipts

Observations and interpretations have required evidence since v0.2.0. The *connective tissue* did not:
bridges between paragraphs and the question that closes a reading carried no evidence **by design**,
which meant the one sentence per reading nobody was watching was the one the model wrote freely.

The fix is not to demand receipts for a sentence that asserts nothing. It is to take the pen away. The
model may now emit only the two evidence-bearing kinds, each requiring at least one receipt that
resolves to a real message; a payload containing a bridge or a question is rejected whole. The app
composes the connective prose itself, from authored template sets in
[docs/VOICE.md](docs/VOICE.md) §6b, chosen by a hash of the reading's own text so a regenerated
reading composes identically. The templates are built so they *cannot* carry a fact — no numbers, no
dates, no names, no placeholders.

**The claim this earns:** every model-authored proposition carries receipts; connective prose is
app-authored from fixed templates.

### Coverage now gates the river instead of captioning it

The model-scored coverage number was honest and did nothing. The river drew the model layer whenever
any model data existed, so a thread the model had read 60% of rendered as a complete close reading.
An unscored message reads as neutral — so a thin drain didn't look thin, it looked calm, which is the
worst thing this particular chart can do.

Below 95% coverage the river now draws the deterministic layer and says so; above it, it says that
too. Refused and errored windows are named as the reason coverage is short, so a declined stretch
isn't mistaken for an unread one.

### Eleven tabs became five surfaces

Overview, Trajectory, Episodes, Eras, Findings, Readings, Ask, The shape of it, Calibrate, Session,
Transcript — as equals, that is a menu written by whoever built each one. Now: **Home · Explore · Ask
· Messages · Readings**, with Explore holding the analysis views under names written for a reader
(Timeline, Eras, Episodes, Patterns, Rhythm). Calibrate stops being a destination: the flow moved to
Settings, and the invitation appears inline wherever a reading is provisional without it. Keyboard
navigation, ARIA semantics and receipt drill-through are preserved and tested.

### "Your data"

A new Settings panel: where the database, your imported files, exports and model transport actually
live — with an integrity check that reports SQLite's own answer verbatim, a timestamped backup taken
through the online-backup API (never overwriting a previous one), deletion of imported source files
(restricted to Between Mirror's own folder), an immediate purge of transport plaintext, and a
double-confirmed delete-everything whose typed word is verified on the server as well as the client.
Every action writes a plain-language line to a log.

Because "your data stays with you" is half a promise if you cannot find it, and worth very little if
leaving is not one of the things you can do.

### Two defects found while preparing this release

**The at-rest hardening was locking owners out of their own database.** On Windows, the boot-time ACL
tightening applied inheritance flags to *files*, where they do nothing, after stripping every
inherited entry — then reported success. The result was a database with an empty access list:
unreadable by the person who owns it. Every `npm run demo:serve` on Windows permanently bricked the
demo database. It now grants before it strips, never recurses, verifies by actually opening the file,
and rolls back if access was lost. Found by accident, because the demo would not start.

**The app assumed a gender.** The Eras cards read "His hostile share" and "She initiates", with the
tooltip explaining "His" as *your* messages — so the primary analysis surface hard-coded that the
owner is a man and the other person a woman. Trajectory, Findings and the rhythm view carried the same
assumption. A tool that reads a marriage's worst hours and then misgenders one of the two people has
failed at something more basic than analysis. Swept per-file by test now.

### Also

- **Governance**: CONTRIBUTING (failing-test-first, privacy invariants as PR-blocking, DCO, no real
  personal data in fixtures ever), CODE_OF_CONDUCT (Contributor Covenant 2.1), SUPPORT (crisis
  language first — this is not a crisis service), [docs/ROADMAP.md](docs/ROADMAP.md) with a permanent
  "not planned" list, and [docs/OPERATIONS.md](docs/OPERATIONS.md).
- **An experience-first README** with six visuals captured from the fictional demo couple — the real
  application, never a mockup, and never anyone's real archive.
- A web test suite, and `npm test` now runs both workspaces.

## v0.2.4 — The cache key that made CI lie

v0.2.3 shipped the two-platform matrix and it came back **red on Ubuntu** — while Windows, the
platform the whole exercise was about, passed on both Node versions.

The cache key for the installed tree was `${{ runner.os }}-node20-modules-<lockfile hash>`, with the
Node version hardcoded from the old single-version workflow. So the Ubuntu jobs at Node 22 and 24
restored a `node_modules` whose native `better-sqlite3` binary had been compiled against **Node 20's
ABI**, skipped the install that would have fixed it, and failed to load it. The key now carries
`matrix.node`.

Worth saying plainly, because it is the argument for the step: the failure was caught by the
"verify the native addon loads" step added in v0.2.3, which reported `NODE_MODULE_VERSION 115` vs
`127` in one line. Without it this would have surfaced as an unreadable wall of failing tests, and the
tempting fix would have been to blame the tests.

A cache that can serve the wrong artifact is not a performance optimisation, it is a correctness bug
that only shows up on someone else's machine.

## v0.2.3 — Windows is tested again, and the Node floor is honest

**If you run Windows, you now need Node 22 or newer.** The project said Node 20 was enough. On
Windows that was never true, and CI had stopped being able to notice.

CI ran on Ubuntu only, with a reason recorded in the workflow: better-sqlite3 "has no prebuild for the
pinned Node on win32," so building it would need an MSVC toolchain the hosted runner does not cleanly
expose. Rather than take that at face value, we restored the Windows job and read the failure.

It was half right, and the half it got wrong is the interesting half. better-sqlite3 12.11.1 publishes
Windows prebuilt binaries for Node **22, 24, 25 and 26** — but not for Node 20. On Node 20 the install
falls through to compiling from source, and there the second half holds: the runner's bundled node-gyp
cannot detect the Visual Studio version now installed on it. So the failure was real, and its actual
cause was that **Node 20 had never been a working floor on Windows** — a stranger on Windows and Node
20 LTS could not install this project without a full C++ toolchain, and nothing told them so. (Node 20
also reached end-of-life in April 2026.)

- `engines.node` is now `>=22`, and the README and DEPLOY say so with the reason attached.
- CI is a matrix of **ubuntu-latest and windows-latest × Node 22 and 24** — the supported floor and the
  version development actually happens on — with `fail-fast: false` so no cell's failure can hide
  another's result.
- A step between install and test loads the native addon and runs a real query, so a toolchain problem
  reports itself as a toolchain problem instead of a wall of confusing test failures.
- The installed tree is cached per platform, Node version, and lockfile.

A capability that is "supported" but untested is a claim without an enforcement — the same defect class
as the two the previous release fixed, wearing different clothes. This one had been shipping a false
install requirement to every Windows user who read the README.

## v0.2.1 — The truth patch

A small release with one job: make two statements true that weren't.

### Releases are immutable

`scripts/publish-release.ps1` force-moved the tag when a version was re-published (`git tag -f`,
`git push -f`). That meant `v0.2.0` could quietly name two different trees — and a version that can
mean two things makes every provenance claim built on it (signed tag, commit SHA, checksums) worth
nothing. The force-move is gone. A version now identifies one tree forever: if the tag already exists
over a different tree the script refuses and tells you to bump the patch; if the tree is identical it
reports "nothing to do" rather than mutating anything. A test holds the line, including one that runs
the real script against a throwaway repo.

**Corrections are a patch release.** That is the whole policy.

### The review status is stated in three buckets, not one

The ship plan said the July-2026 adversarial review "is closed" with "zero P0s remain." What was
actually true is narrower: the review's *own findings* were fixed. Saying it the broad way is the
same species of overclaim this project exists to refuse, so it is now restated — in
[docs/STATUS.md](docs/STATUS.md), which updates with every release — as **fixed** (the original
defects, each with a regression test), **deferred by design** (OS-level containment of the drain
stays tool-level until the packaged app; at-rest encryption, with the reason published), and **newly
tracked** (what has been found since, including the tag defect above and the three items Era 1 is
carrying into v0.3.0).

Nothing about the software's behaviour changed in this release. What changed is what it claims.

## v0.2.0 — The hardening release

This release is a trust artifact. A July 2026 adversarial security and grounding review found that
several of Between's core promises were made by convention, not by mechanism — and a few were quietly
false. This release makes them true, and says plainly what was wrong.

The whole point of Between is that every observation traces back to the words underneath, and that
nothing about your archive leaves your machine without your say. The review found the seams where that
could break. They are closed now, each with a test that would fail if it regressed.

### The evidence chain (what you read is what the evidence supports)

- **The First Reflection could read raw model output.** It read the engine's raw result file for its
  reduce/render, so a result that failed validation or lost its receipts could still reach a frozen
  reading. Now the app reads only the *cleaned, re-validated* payload from its own database; raw files
  are transport, nothing more. A result that fails is an honest decline, never a reading.
- **Result files weren't verified against the job they claimed to answer.** A stray or tampered file
  could be cached as a job's own output. Now the filename, job id, and content hash must all match, or
  the file is quarantined and nothing is stored.
- **Cleaned payloads weren't re-checked.** Dropping fabricated receipts could leave a result below its
  own schema, and it was cached anyway. Now it's re-validated after filtering and rejected whole if it
  no longer holds.
- **Prose was trusted, receipts were an afterthought.** The model returned free prose plus a side-list
  of claims. Now it returns typed, evidence-bearing *blocks*, and the app composes the prose only from
  the ones whose receipts resolve — a sentence without its evidence in the same object cannot exist.
- **An unscored message could read as neutral, and a thin drain could look complete.** The per-message
  emotion pass is now exact-coverage-or-error, and the river shows model-scored coverage and falls back
  to the deterministic layer below the floor.

### The boundary (nothing leaves without your say)

- **The client could pick the engine, and an unknown one silently ran the test mock.** The server now
  decides which engine may run, enforces your engine mode, and refuses anything outside it. The mock
  exists only under a test flag — never in a build.
- **A non-loopback bind, a rebinding Host, or a foreign Origin could slip through.** The server now
  refuses to boot off loopback, rejects a mismatched Host or Origin, and ships a build-blocking test
  proving it binds loopback, logs nothing, and carries no telemetry dependency.
- **The Claude drain ran with full tools and full disk access over untrusted archive text.** It now runs
  tool-restricted in a staged temp folder that holds only the pending jobs — no database, no archive, no
  repo, no home — with MCP and hooks off. This is tool-level containment (an OS boundary is future work),
  and it's stated honestly.

### Honesty about interpretation

- **The self-report check was framed as a trust verdict and read confidence from tiny samples.** It's now
  named "calibration asymmetry," refuses to speak below a minimum sample, and no longer tells you the
  gate can "trust" your labels.
- **The interpretive/support layer was always on.** The directional support frame, the abuse-pattern
  stage, and the other-side/findings readings are experimental, text-only, and not externally validated —
  the layer most easily misread as neutral proof. It is now **off by default** and opt-in with sober
  consent. The deterministic findings counts stay available regardless.

### Honesty about data and at-rest

- Day-level surfaces (the river, the heatmap) now bucket by your **lived timezone**, DST included.
- The ask view reports an honest **"500+"** when a query matches more than it shows.
- At boot: best-effort owner-only file permissions, a loud warning if the working folder looks
  cloud-synced, and deletion of drained plaintext after a week. `ingest --delete-source` removes the
  source XML after a verified ingest. Full at-rest encryption is deliberately deferred (a forgotten
  passphrase on a no-account tool would mean unrecoverable loss) — and the threat model says so.

### Docs

- New: [THREAT-MODEL.md](docs/THREAT-MODEL.md), [ETHICS.md](docs/ETHICS.md),
  [STATUS.md](docs/STATUS.md), and a root [SECURITY.md](SECURITY.md).
- The airlock "property of the wiring" overclaim is reworded to the honest protocol-plus-containment
  claim; the README's stale "planning & design" and test-count copy are gone; "therapy pack" is now
  "conversation packet."
- CI runs typecheck + the full suite on every push.

*One release, dated. See [docs/STATUS.md](docs/STATUS.md) for the authoritative state of every surface.*
