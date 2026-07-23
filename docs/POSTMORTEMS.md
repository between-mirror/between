# Postmortems — the full engineering record

*Every defect found in this project since it went public: what was wrong, what it meant for someone
using it, and what changed. [STATUS.md](STATUS.md) is the short answer to "can I trust this today";
this file is the long answer to "how did they find out", and it is deliberately unabridged.*

This exists as a separate document because it was making STATUS unreadable. A visitor asking a
reasonable question — is this stable, what is broken — was being handed two hundred lines of
release-script forensics first. That is the wrong order. The record is worth keeping in full, and
worth keeping out of the way.

A note on what it demonstrates. Read quickly, a list this long looks like instability. Read
properly, almost every entry has the same structure: something claimed to be enforced was not
actually enforced, that was found by attacking it rather than by waiting for a user to hit it, and a
regression test now fails if it comes back. The uncomfortable ones — four consecutive review rounds
where each fix introduced the next defect, and a set of internal documents published for nine
releases — are kept in the same voice as the rest rather than softened.

---

## Found after the July-2026 review closed

- *Fixed in v0.2.1:* the release script force-moved tags on re-publish, so one version could name two
  different trees. Tags are now immutable; a correction bumps the patch. Guarded by a test.
- *Fixed in v0.2.3–v0.2.4:* Windows CI had been removed rather than repaired, leaving the primary
  development platform unverified behind an explanation. Restoring it surfaced a real user-facing
  defect: Node 20 was never a working floor on Windows (better-sqlite3 publishes no Node 20 win32
  prebuild, and the source-build fallback needs a C++ toolchain), so the documented install requirement
  was false. The floor is now Node 22, and CI is a required matrix of ubuntu-latest + windows-latest ×
  Node 22 and 24. v0.2.3's own matrix then came back red because the cache key still named Node 20 and
  served a binary built for the wrong ABI; v0.2.4 fixed the key.
- *Fixed in v0.3.0:* connective prose (bridges and the closing question) was still model-authored and
  therefore the one unreceipted thing a reading could contain — the model can no longer emit either.
  Thread-level coverage was computed but did not gate the surface displaying it; it now does, in both
  directions.
- *Fixed in v0.3.0, found while capturing the release's own screenshots:* the boot-time at-rest ACL
  hardening was locking the owner out of their own database on Windows — it applied inheritance flags
  to files, where they are inert, after stripping every inherited entry, and reported success. Any
  `npm run demo:serve` on Windows permanently bricked the demo database. The hardening now grants
  before it strips, never recurses, verifies by opening the file, and rolls back if the owner has lost
  access.
- *Fixed in v0.3.0:* the Eras, Trajectory, Findings and rhythm views assumed the archive's owner was a
  man and the other person a woman ("His hostile share", "She initiates"). The app knows which number
  is yours and what you named the other person; it does not know anyone's gender.
- *Fixed in v0.3.2:* the site's central honesty check — "never claims to produce evidence, only ever
  refuses to" — was not checking anything. Two independent defects stacked. First, four literal
  U+0008 BACKSPACE bytes sat where `\b` word boundaries belonged (a heredoc ate the backslashes), so
  two of the three negation alternatives could never match and the test had degraded to a substring
  search for "never". Second, and worse, the "per sentence" splitter ran over raw HTML, where
  `answers.</p>` is not a sentence break; one measured "sentence" was 1123 characters spanning the
  doctype, the whole nav, a `<meta>` description and the next section. Any overclaim was absolved by
  any negation near it, including words in attributes no reader sees. Copy is now cut into the units
  a reader reads one at a time, and the assertion was observed failing on a deliberate overclaim
  before the fix was committed. A new source-hygiene test fails the build on any C0 control byte in
  any committed text file.
- *Fixed in v0.3.2, found by that new guard on its first run:* `docs/SPECS/airlock.md` had carried two
  literal NUL bytes since its first commit, at the two separator positions of the idempotency key.
  They render as nothing and made git classify the file as binary and refuse to diff it. Whoever
  wrote `hash.ts` read the rendered spec, saw empty quotes, and used a space — so spec and
  implementation disagreed silently for the project's entire history. The spec is corrected to the
  shipped behaviour rather than the reverse: `input_hash` is a persisted primary key, and changing
  the separator would strand every cached analysis in every existing database and force a paid
  re-drain. The separator is now named (`SEP = one U+0020 SPACE`), not shown.
- *Fixed in v0.3.2:* the release script could resurrect a file deleted for privacy. It emptied the
  index with `git rm --cached`, which untracks without deleting, so a file present on `public` but
  since deleted on `phase3` was still in the working tree when the final `git add .` ran — and came
  back, in that release and every one after it. The obvious repair is worse: `git checkout phase3 --
  .` stages what it restores, and would have published `docs/DECISIONS.md`, the private journal. The
  sequence that satisfies both properties is now in `scripts/lib/Rebuild-PublicTree.ps1`, and the
  test runs the real script plus both broken variants, asserting each exhibits its own defect. The
  bug was latent — `public` and `phase3` differed by zero files — and would have fired on the first
  deletion.
- *Fixed in v0.3.2, and the most dangerous defect this project has had:* the release script could run
  an entire release **from the wrong branch**. `$ErrorActionPreference = 'Stop'` does not apply to
  native commands — verified on pwsh 7.6.3, where `$PSNativeCommandUseErrorActionPreference` defaults
  to false — so a failing `git checkout public` printed its error and execution carried straight on to
  the next line. The script would then rebuild, pass its assertions, commit, tag and push while HEAD
  was still on `phase3`. Because `public` is an orphan line sharing no ancestor with `phase3`, pushing
  that tag uploads the **entire private history**, including every `docs/DECISIONS.md` blob. The
  DECISIONS/FABLE assertion would not have caught it: it inspects the tracked set, not the branch. The
  script now checks `$LASTEXITCODE` after every git call that writes and positively verifies HEAD is
  on `public` before anything is written, with a regression test that locks `public` in a worktree and
  asserts nothing reaches the remote. A related fault: a failed push reported "Published… The tag is
  now permanent" and exited 0, while the local tag it had already created made that version
  permanently unpublishable — the immutability guard saw a tag over an identical tree and reported
  "nothing to do" forever. Failed pushes now delete the local tag and say so.
- *Fixed in v0.3.2:* **the name sweep — the last thing standing between a real name and a permanent
  public tag — was failing open in two ways at once.** `git grep` exits 0 for a match, 1 for no
  match, and anything else for "it did not run"; the script treated everything but 0 as clean and
  discarded stderr, so an invalid pattern exited 128 and reported a passed sweep. And `git grep`
  defaults to POSIX **basic** regex, where `|` is a literal character — so the obvious way to write a
  pattern list, `Name1|Name2|handle`, could never match anything, silently, while reporting success. A
  reviewer published a real name under a permanent tag through that hole. The sweep now uses `-E` and
  treats only exit 1 as a pass. The nine live patterns were checked and all evaluate, so the tree was
  never actually leaking; the defect was a trap for whoever next edited that file.
- *Fixed in v0.3.2:* a failed `git ls-remote` silently removed the remote-tag guard, and the run then
  **moved the published `main`** before the tag push was rejected — leaving the public branch showing
  a tree that no tag names, which is the immutability promise broken exactly where a visitor sees it.
- *Fixed in v0.3.2:* an interrupt between `git tag` and `git push <tag>` — Ctrl-C, a closed terminal,
  a killed push — wedged that version permanently: every retry found a local tag over an identical
  tree and reported "already published, nothing to do" while the remote had never received it. The
  script already held the information to tell those cases apart and discarded it.
- *Fixed in v0.3.2:* the operator's own **machine-local gitignore** silently truncated the published
  tree. Emptying the index to let `.gitignore` decide also gave a vote to `core.excludesFile` and
  `.git/info/exclude`, both per-machine and invisible to the repository; a personal global ignore
  containing `site/` dropped the whole site from a release, with no warning, under an immutable tag.
  `git add` now runs with `-c core.excludesFile=`, `.git/info/exclude` is inspected, and a collapse in
  the tracked-file count against the previous release aborts.
- *Fixed in v0.3.2:* the release script's `Abort()` ran `git checkout -f phase3` unconditionally,
  including from the preflight that refuses a dirty working tree. That path fires before the script
  has changed anything, and the forced checkout silently discarded the author's uncommitted work —
  the complaint destroyed what it was complaining about. It now restores only if the branch actually
  moved.
- *Audited in v0.4.0 — the published history, not just the tree.* Every release gate this project has
  asks whether a private thing is absent from the tree about to be published. None of them can see
  what is **already** published, and a file removed today is still in the commit that carried it.
  [`scripts/audit-public-history.ps1`](../scripts/audit-public-history.ps1) closes that: it clones the
  public repository fresh and sweeps file contents at every reachable commit, every path at every
  commit, all commit messages, annotated tag messages, and every reachable blob.

  **Result: CLEAN.** 9 patterns swept across **11 commits, 9 tags, 406 blobs**, range
  `f84f2269..cb4b8c65`. No name or handle from the private pattern list appears anywhere in the
  published history.

  It refuses rather than guesses: it will not run against a clone carrying the private `phase3`
  branch (where every pattern matches by design), it distinguishes git's three exit codes so an
  unreadable repository can never report clean, and it fails if any tag points outside the commits it
  walked. Nine regression tests cover each of those, plus a name planted in an old commit, a path, a
  commit message and a tag message.
- *Fixed in v0.3.2, and the fix above is what caused it:* **the repair for the machine-local gitignore
  defect opened a third way to publish a private file.** Blanking `core.excludesFile` for `git add`
  stopped a personal ignore from silently dropping files — but the preflight's clean-tree check still
  honoured it, so the two disagreed about what was in the working tree. A path hidden from the operator
  by their own global ignore was invisible to "working tree is not clean" and fully visible to
  `git add .`, and would have gone out under a permanent tag. On the maintainer's machine that path is
  `.claude/settings.local.json` — the global ignore hides it, this repo's `.gitignore` said nothing
  about `.claude`, and `.claude/` already exists; it had not fired only because no such file had been
  written yet. `status.showUntrackedFiles=no`, a common performance setting, defeated the same check a
  second way. The preflight now reads the tree with the repository's own rules only and with `-uall`,
  the repo classifies that file itself rather than leaving it to a personal one, and a never-ship
  deny-list covers the general case that naming two journal files by hand never could. Three
  consecutive rounds of review each found a fail-open in this one script, every time in the same shape:
  a check printing "clean" over something it never looked at.
- *Fixed in v0.3.2:* **the name sweep was silently matching nothing in five further ways**, each
  printing "N name pattern(s) swept clean" while publishing the name: a pattern with trailing
  whitespace (the filter trimmed the line it tested and passed the untrimmed one to `git grep`); a
  pattern with a trailing inline comment — and `personal-patterns.txt`'s own instructions document
  exactly that shape, so following the file's advice disabled the sweep; a pattern file saved as
  cp1252, where an accented name decoded to a replacement character and became unmatchable; a name
  inside a file git treats as binary, because `-I` skipped it and `.gitattributes` marks `*.png`
  binary — a screenshot of this application being the single most likely place for a real name to be
  sitting in plain sight; and a name appearing only in a **filename**, which `git grep` never searches.
  The `-Title` text, spliced verbatim into a permanent public commit message, was the one
  operator-supplied string that reached the remote unswept.
- *Fixed in v0.3.2:* `git ls-remote`'s stderr was merged into its value, so an ordinary **exit-zero
  warning** — GitHub's "redirecting to" for a renamed repo, ssh's "Permanently added … to the list of
  known hosts" — became field 0 and was read as a commit SHA. With a local-only tag present that made
  the script announce "already published with this exact tree — nothing to do" over a remote carrying
  no tag at all. Also: a version string is now validated before anything moves (`-Version v1.0.0`
  published a permanent tag named `vv1.0.0`; `-Version "0.3.2 beta"` pushed `main` irreversibly and
  only then failed at `git tag`, leaving the public branch published with no tag naming it), a reused
  local tag is checked to name the commit actually published, and a failed restore says so instead of
  leaving the operator standing on `public` with the whole rebuilt tree staged.
- *Fixed in v0.3.2, and the fix above is what caused it — the fourth round running:* **the checks
  round three added could be defeated by one accented character.** `git ls-files` honours
  `core.quotePath`, which defaults to true, so a path containing any byte ≥ 0x80 comes back
  octal-escaped and wrapped in quotes. Both new list-based checks — the filename name-sweep and the
  never-ship deny-list — matched their patterns against that mangled string instead of the real path.
  A real name in a non-ASCII filename published itself under a permanent tag while the sweep reported
  clean, and every `$`-anchored deny rule (`.key`, `.pem`, `.pfx`, `.local.json`) was defeated the same
  way. PowerShell decoding git's UTF-8 output as the console's ANSI codepage was the same defect one
  layer further out. Whether the sweep worked was therefore decided by two per-machine settings this
  repository never states — the exact disease round three's own comment claimed to have cured.
- *Fixed in v0.3.2:* round three's inline-comment stripper **silently rewrote valid patterns**. `#` is
  a legal regex character, so `Surname|@handle #hashtag` became `Surname|@handle` — still a valid
  expression, so nothing errored, nothing matched, and a real handle shipped. The parser no longer
  guesses: a comment is a whole line, and anything else containing whitespace-then-`#` stops the
  release rather than being interpreted. Round two had the mirror-image bug in the same place.
- *Fixed in v0.3.2:* the filename sweep used **a different regex language** from the content sweep.
  `\<Zoe\>` is a word boundary to git's ERE and an escaped literal `<` to .NET, so a pattern the
  content sweep honoured the filename sweep silently ignored. Both now run through git's engine.
- *Fixed in v0.3.2:* the remote tag's SHA was read, validated, and then **never compared to anything**.
  A tag placed on the remote by someone else, over an entirely different tree, left the "same tree,
  nothing to do" branch free to report the release as already live — telling the operator their tree
  was published under that version when it was not, and the version was already spent.
- *Known cost, stated rather than fixed:* the preflight reads the tree with this repository's ignore
  rules only, so it names files the operator's own `git status` insists do not exist. Ordinary editor
  and OS residue is now classified by `.gitignore` here rather than left to a personal global file,
  and the abort message explains why it disagrees with `git status`. Separately, searching binary files
  for names means a short pattern can match a random byte sequence inside a screenshot — measured at
  roughly one in five for three-character patterns and never for four or more. The nine live patterns
  are all five characters or longer; the abort message says when a hit is likely coincidental.
- *Fixed in v0.3.2:* **four of the six published visuals were pictures of the application doing
  nothing.** `hero-river.png` showed "Reading the shape of these years…" over an empty panel while
  its caption described a warmth-and-tension river with statistics beneath it; `eras.png` showed
  "Tracing the arc of these years…"; `ask.png` showed a spinner; `receipt.png` showed the "No reading
  yet" empty state under a caption describing a claim opened to reveal the message underneath it.
  They were genuine screenshots of the real application, which is exactly what made them feel safe to
  ship. `capture-media.mjs` waited fixed millisecond delays instead of waiting for content, and
  `episode.png` was correct only because it was the one capture with a content assertion. Every
  capture now waits for the content its caption will claim and refuses rather than photographing an
  empty panel — and with those guards in place all six re-captured correctly, so nothing was
  withdrawn. `receipt.png` was a timing failure like the others, not missing data: `gen-demo.ts`
  freezes a First Reflection into `examples/demo.db` citing two real receipts, and the old
  `if (await claim.count())` silently skipped the click and photographed whatever was on screen
  instead of failing.
- *Closed as misdiagnosed, with numbers.* This entry previously said `GET /threads/:id/episodes` took
  **roughly 20 seconds** on the 787-message demo, "queued behind the other Overview requests on Node's
  single thread", and blamed `refreshEpisodes`/`refreshEras` recomputing per request. **None of that
  is true, and the wrong diagnosis pointed the fix in the wrong direction.** `getEpisodes` is a single
  indexed `SELECT` over a bounded table; it recomputes nothing, and never did. Measured against the
  real demo database:

  | read | 787 messages | 50,000 messages |
  |---|---|---|
  | episodes | 4–29 ms | **0 ms** (bounded row count) |
  | trajectory | 12–22 ms | 117 ms |
  | ambient | 19–29 ms | 374 ms |
  | findings | 8–28 ms | 507 ms |
  | *whole Overview, concurrent* | **~30 ms wall clock** | — |

  The endpoints that cost anything at scale are the ones that compute over every message — findings,
  ambient, trajectory — not episodes. Budgets are now asserted where the time actually goes
  ([readBudget.test.ts](../server/test/readBudget.test.ts)): every Overview read under **500 ms** on
  the demo, and under **2 s** on a generated 50,000-message archive, with a separate assertion that a
  repeat call costs the same as the first — the "recomputing on read" failure the original entry
  feared, now enforced rather than assumed. Ingest of that archive takes ~11 s and is deliberately
  outside the budget: it happens once, at import, behind a progress bar.

  What the 20 seconds probably was: a first navigation under the Vite **dev server**, which compiles
  the view's module on demand. That is a development artifact, not something a user of a built app
  ever meets — and it is exactly the kind of thing that gets recorded as a product defect when the
  measurement is taken through `npm run demo:serve` and never checked against the API directly.
- *Shipped in v0.4.0:* the browser-only **interactive demo** now exists, at
  [/demo](https://between-mirror.github.io/between/demo/). It is the real React application — the same
  code, the same views — booted through a separate entry that answers every `/api` read from JSON
  captured off the real server (`npm run demo:export`, 31 surfaces) and refuses every write.

  Two entry points and two Vite configs rather than one bundle with a runtime flag, so the installed
  application cannot contain the code that serves frozen answers. Verified from a plain static server:
  the page issues **six requests, all same-origin**, and nothing else — asserted in CI, and the built
  bundle contains exactly two absolute URLs, both non-fetching (W3C namespace identifiers and React's
  error-decoder link), each approved individually.

  Ask offers **three questions** rather than a text box, because the demo holds answers to exactly
  those: `sorry` (29 receipts), `miss you` (17), and `money`, which **honestly declines**. Each plan is
  captured off the real `/ask/plan` route, not hand-written. Every receipt cited in a demo reading is
  asserted to resolve to a message in the captured transcript.
- *Closed, and it turned out to be the point:* the previous entry here said `examples/demo.db` holds no
  pre-computed Ask answer, so Ask in the demo could only decline. Measured, the archive answers plenty
  — the earlier attempt had sent whole sentences to a full-text search. The decline is kept anyway, as
  one of the three offered questions, because a demo where every question succeeds misrepresents an
  instrument whose central claim is that it stops when the words run out.

## The second import, and three keys that could not survive one

*Found while building the multi-source schema foundation, by writing the test for what the next
importer would need and running it against what already shipped.*

Importing a second backup of the same phone — the most ordinary thing anyone does with this program
after the first month, and the entire premise of "since you last looked" — raised `UNIQUE constraint
failed: threads.participant_signature` and aborted. Not a silent wrong number: a crash, on the second
use, shipped since the beginning. Twenty-one importer tests passed the whole time, because every one
of them imported exactly once.

Three keys were built on values that do not survive a second file, and they failed together.

**Identity.** Contact temp-ids are handed out in first-encounter order *within a file*, so two
backups of the same phone number the same two people differently depending on who happened to text
first. `participant_signature` hashed those temp-ids, making it a hash of the order the file was
written in. Depending on the ordering, a second import either collided on that UNIQUE column and took
the import down, or filed the same conversation as a second thread with a second copy of the same
person. Signatures are now built from the participants' natural keys, and contacts merge on the
identifiers they arrived with — never on display name, which two people can share.

**Dedup.** The key hashed `raw_type`, an Android SMS type code, and an exact millisecond. A WhatsApp
export carries neither; its timestamps are whole minutes, because that is what the export prints. So
the same conversation imported from both sources shared no component of the key and doubled silently
— every per-thread number computed over twice the relationship, with nothing visibly wrong. The
canonical key is counterpart, direction, a 60-second bucket and a body hash, disambiguated by an
occurrence index that ranks *distinct exact timestamps* within the bucket. That ranking is what lets
one message seen twice collapse while two "ok"s seconds apart both survive; the first attempt ranked
by arrival order instead, which split a file containing overlapping backups into two archives, and
the existing doubled-fixture test caught it.

**Provenance.** Nothing recorded which format a row came from. Archive health — the one surface whose
entire job is to say what you are looking at — read a meta key that no code has ever written, so it
reported "Android SMS Backup & Restore XML" for every import, including archives with no Android
backup in them at all. `source_files.kind` and `messages.source_kind` are now NOT NULL with no
default, so an import that cannot name its own format fails loudly instead of picking a category.

The migration that repairs existing archives is the first code here that edits an archive in place.
It copies the database before touching it, runs in one transaction, and cannot lose a row: occurrence
indices are assigned over the rows already present, in id order, so two rows the database holds
separately stay separate. No deletes, no merges, and therefore no evidence id in a frozen reading
left pointing at nothing. Its backup file is named to end in `.db` — it was `.bak` for an hour, which
would have placed a complete unencrypted copy of someone's archive outside `.gitignore`'s `*.db` and
every other rule that keeps a database out of a commit. A test now fails if that name changes.

## The published history, and the one-time break of immutability

Releases v0.1.0 through v0.3.2 published five internal documents carrying the author's real archive
statistics — its size, exact per-type counts, span and contact number — the literal local path it sat
at, and one line comparing how harshly the author rated his own hard messages against his partner's.
`HANDOFF.md` states, as binding invariant 3, that no personal data may ever be in the repository, and
gives the counts four paragraphs later.

Every gate in place at the time asked whether a named private thing was ABSENT from the tree about to
be published. Nothing asked what the published tree CONTAINED, and nothing could see the history
already published. Both are now closed: `publishedTree.test.ts` asserts on content, and
`scripts/audit-public-history.ps1` sweeps the published history directly.

**Remediated by recreating the public repository** from the cleaned tree rather than rewriting it in
place. A rewrite changes every SHA, breaks immutability anyway, and leaves the old objects fetchable
by SHA until the host purges them — so it is not a purge. Recreation leaves nothing behind. That
deliberately broke this project's own promise that a version identifies one tree forever; privacy
beat immutability, and it is recorded here rather than quietly absorbed. Verified afterwards: every
statistic pattern returns 0 of 2 published commits, and the audit reports CLEAN.

The correction had its own correction. `publishedTree.test.ts` — written to stop the statistics being
published — hardcoded them, annotated, and exempted itself from its own scan. It passed, and v0.4.0
shipped it. The self-exemption was correct; what was never asked is where the patterns should live.
They now live in the gitignored private file with the names, read at run time and written nowhere.
v0.4.0 was not reused.

## The re-review before v0.5.0, and the six that were not all of them

The hardening leg before this release went through the standing adversarial re-review: finders aimed
at what the change could break, three refuting skeptics per finding, then a completeness sweep. Forty
candidates, twenty-four survived refutation, and the first pass fixed six P0s.

**The count was read off a summary rather than out of the code.** Checking each finding against the
source afterwards, three P0s were still open. Two were in files that the fixing commit never opened —
so nothing about that commit's diff would have revealed them — and the third had been filed by the
completeness sweep rather than in the main findings list, in a different part of the same report. A
review is only closed when each item has been confirmed closed individually; "six were fixed" and
"there were six" are different statements, and the second one was never checked.

**The filter that ate the words.** The iMessage `attributedBody` decoder skipped Apple metadata with
a prefix regex — `NS` followed by a capital, `kIM`, `__kIM` — tested against the message body itself.
Any real message beginning with those letters was discarded as metadata and stored as
`[unreadable message]`: *NSFW*, *NSW next week?*, *NSA is at it again*, *NSAIDs make me sick*. The
words were destroyed and then counted in `unreadable`, the number whose only job is to mean "these
bytes could not be decoded" — so a decode that succeeded was reported as a decode that failed.
Metadata is now matched on shape: a class name known by name, or a single namespaced identifier with
no whitespace in it. A filter for metadata must not be able to match a sentence.

**The importer that could not read an older Mac.** Every message read selected `date_edited` and
`date_retracted`, which arrived with macOS 13 in 2022, so any older `chat.db` died on `no such
column` before a single row was read. The sharp edge is what it did to the test suite: the seconds
epoch is pre-2017, so a database old enough to use it cannot carry those columns — the test named
"reads seconds, which is what older machines wrote" was passing against a file that could never have
existed, because the fixture builder only knew how to write today's schema.

**The copy that survived "delete everything".** A migration takes a complete, unencrypted copy of the
archive before it runs, and writes it beside the database. The deletion sweep enumerates directories
— exports, backups, airlock, data — and the database's own folder is not one of them. So the panel
could report *"Deleted everything: every message, contact, reading and export, 0 backups"* while
every message sat readable in plaintext next door. This is the product's stated worst case: someone
who wants every trace gone, told it is gone. The migration carried a comment claiming the sweep
caught these "because the name ends in `.db`"; the sweep had never matched on extension. Both sides
now call one exported function. The first fix for it was itself wrong in the same way — it matched
only the *current* schema version's copies, so shipping the next migration would have silently
started leaving the older ones behind; a test that plants two vintages caught it.

### The residuals — four ways an identity can be wrong

The P1s held back with the release were almost all identity, which is where this product's quiet
failures live: nothing crashes, and the archive is about the wrong people.

**Two strangers, one relationship.** The generic importer accepts a file carrying only timestamp,
direction and body. Every sender-less row fell back to the literal strings `owner` and `other` — the
same two strings in every such file — so importing two different people's exports produced ONE
thread holding both, split by *direction* rather than by person: each conversation cut in half and
interleaved with a stranger's, with every metric, era and episode computed across two people who
have never met. The previous release refused these files, but by accident rather than by design: a
UNIQUE constraint, not a check. Removing the accidental guard without adding a real one turned a
loud refusal into silent contamination. The identity is now derived from the file's own bytes, and
it is one identity per file rather than one per direction.

**The person who was two people.** Contacts merged on an exact string match against
`identifiers.raw_value` while threads merged on the normalized number underneath it, so the same
person written `+15555550100` in one export and `(555) 555-0100` in another merged the thread and
forked the person. A one-to-one conversation rendered as its own duplicate, the contact list split
one history in two, and marking someone a partner — or as someone who had died — labelled one row
while every lens keyed on those fields read the other as unknown. The existing test could not catch
it: both its fixtures wrote the identical string, and the numbers used elsewhere in that file are too
short to have an E.164 form at all, so raw-only matching looked correct.

**The owner nobody could see yet.** Owner detection needs a person who appears with more than one
other person — a fact about a whole archive that was being recomputed per file. A file holding one
conversation cannot show it, so the owner fell in among the counterparties and the thread was keyed
on two participants instead of one. Import one conversation to try the tool, then import the full
backup, and the same conversation forks: three threads for two, the spare flagged as a group chat
that never existed, its messages counted twice. The archive now remembers, and the rows that predate
that knowledge are re-keyed the moment it arrives — collision-safe by construction, nothing deleted,
nothing merged on ambiguity. Both import orders are tested, because a fix that only works in one
order is a fix that depends on the user having been lucky.

### The final identity fix, and two assumptions it left as strings

The narrow verification before the confirmation gate found two P0s in the participant-signature
fix itself. The confirmation review was not launched in that session: a demonstrated counterexample
is already the answer, and another sweep cannot turn it into a pass. After both were fixed, the owner
authorized a local confirmation without external agent fan-out or paid API calls. It re-read every
earlier round, attacked the complete release tail, and found zero confirmed P0s.

**The role marker a source could impersonate.** An owner-only thread used the natural owner key with
the text `self:` prepended. Generic source identifiers are arbitrary strings, so an ordinary sender
could legitimately be named by exactly that value. The owner-only thread and the ordinary
participant then had the same participant signature. If their minute, direction and body also
matched, message dedup silently discarded one real row; otherwise two unrelated conversations still
shared a thread. The role is now part of a serialized tuple, not a naming convention. Ingest,
migration and owner repair all use that representation, and the dedup counterpart is the same
unambiguous serialized participant set. The regression imports the adversarial identifier and proves
both messages and both threads remain distinct.

**The second handset visible only as a recipient.** The earlier fix treated an outgoing sender as
direct owner evidence, but not its exact mirror: an incoming one-to-one MMS with exactly one
recipient. A partial file from a second handset could therefore key a conversation on the handset
owner plus the counterparty; its full backup could identify the owner by co-occurrence and key the
same conversation on the counterparty alone. Partial-then-full forked the thread, invented a group
and duplicated the overlap. A sole incoming recipient is now direct owner evidence; several
recipients remain deliberately ambiguous because that is a group. The end-to-end regression covers
partial-first and full-first imports and asserts one overlap, no doubled row and no phantom group.

**One thread, charged with the whole archive.** `duplicates.collapsed` subtracted an archive-wide
stored count from a thread-scoped declared count — two different populations — so every thread
reported the entire archive's collapse total as its own, at the moment the dedup layer had begun
resting its honesty case on that number. It cannot be made per-thread honestly, because a row
dropped as a duplicate is dropped before it belongs to a thread. It is now computed archive-wide on
both sides and labelled as archive-wide.

**And one that was only slow.** Moving archive health onto Home and onto every reading made a lens
that had been reachable only from its own tab run on the default view of every conversation — while
its per-message attachment lookups had no index behind them. Measured by the reviewers at roughly
forty seconds on a sixty-thousand-message archive, on a synchronous server that serves nothing else
meanwhile. The index it always needed ships as a second forward-only migration rather than as an
edit to the first: a migration that has already run on someone's archive is history, and history
does not get amended.

**The confirmation gate.** The local confirmation generated more than one hundred thousand
adversarial participant identifiers, traced the four representations of a thread key (ingest,
migration, owner repair and message dedup), rehearsed a published v0.4.1 upgrade, and ran the complete
suite. It added two missing regressions without changing product behavior: the real Android
`insert-address-token` owner placeholder in both partial/full import orders, and an owner-only legacy
thread migrating and re-importing without a fork or a doubled row. The result was zero confirmed
P0s, 781 server tests, 24 web tests and clean typechecks. That demonstrates this release's gate; it
does not turn a review snapshot into a certificate.
