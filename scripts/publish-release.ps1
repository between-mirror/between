<#
.SYNOPSIS
  The ONLY sanctioned way to update the public Between repo (docs/SHIP.md §2, Phase G).

.DESCRIPTION
  Rebuilds the `public` branch from the current `phase3` working tree with .gitignore re-applied, so the
  private build journal never travels. It HARD-ASSERTS that no private journal (DECISIONS / FABLE) and no
  personal name-sweep pattern survives into the tracked set before it will commit anything.

  DEFAULT is a DRY RUN: it prepares the `public` branch locally, runs every assertion, prints what WOULD
  be published, then restores you to `phase3` WITHOUT committing or pushing. Nothing reaches the remote.

  Pass -Publish to actually commit `public`, push it to the `public` remote's `main`, and tag the release.
  -Publish is the irreversible, outward-facing step — run it only when the dry run is clean and you intend
  to publish.

  RELEASES ARE IMMUTABLE (v0.2.1). A version identifies ONE tree, forever. If the tag v<Version> already
  exists — locally or on the public remote — this script REFUSES unless the tree it would publish is
  byte-identical to the one already tagged (in which case there is nothing to do). Corrections bump the
  patch version; nothing ever force-moves a tag, because "v0.2.0" must never be able to mean two
  different pieces of software.

.PARAMETER Version
  The release version, e.g. 0.2.1. Used for the commit message and the tag (v<Version>).

.PARAMETER Title
  Optional release title for the commit message, e.g. "the truth patch".

.PARAMETER Publish
  Actually commit + push + tag. Omit for a dry run (prepare + assert + restore, no remote changes).

.EXAMPLE
  ./scripts/publish-release.ps1 -Version 0.2.1            # dry run: verify only
  ./scripts/publish-release.ps1 -Version 0.2.1 -Publish   # publish for real
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Title = '',
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'

# NOTE: $ErrorActionPreference does NOT apply to native commands. Verified on this machine —
# pwsh 7.6.3, $PSNativeCommandUseErrorActionPreference = False — a failing git prints its error, sets
# $LASTEXITCODE, and execution carries straight on to the next line. That is how a failed
# `git checkout public` could leave the whole release running on phase3: rebuilding, asserting,
# committing, and finally tagging and pushing the private history to a public remote.
#
# The blunt fix, turning $PSNativeCommandUseErrorActionPreference on globally, is wrong here: several
# git calls below use the exit code as DATA rather than as failure. `git diff --cached --quiet`
# returns 1 to mean "there are staged changes"; `git rev-parse --verify --quiet` returns non-zero to
# mean "that ref does not exist". Making those throw replaces a friendly abort with a raw
# NativeCommandExitException and breaks the guards.
#
# So: an explicit $LASTEXITCODE check after every git call whose failure would matter, plus a positive
# check that HEAD is where we think it is before anything is written.
Set-Location (Split-Path $PSScriptRoot -Parent)  # repo root

# git speaks UTF-8. Without this, PowerShell decodes its output using the console's ANSI codepage, so
# a tracked path containing any non-ASCII character arrives here as mojibake — and every check that
# reads the file list then matches its patterns against a string that is not the path. That is the
# core.quotePath defect one layer further out: whether the name sweep works would depend on a machine
# setting this repository never states.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Set the moment we leave phase3. Until then an abort must NOT touch the working tree: the restore
# below is `checkout -f`, which discards uncommitted work, and every preflight abort happens while the
# author is still standing on their own dirty phase3. The "working tree is not clean" path used to
# throw away the very changes it was complaining about.
$script:leftPhase3 = $false

# Match a name-sweep pattern against arbitrary TEXT using git's own regex engine, so that a pattern
# means exactly what it means in the content sweep. Returns the matching lines, or nothing.
# Fails the release rather than returning a wrong answer: a sweep that did not run is not a sweep.
function Search-WithGitGrep([string]$Pattern, [string]$Text, [string]$Label) {
  # In its own directory, and run from there: `git grep --no-index` still resolves pathspecs against
  # the surrounding repository and refuses anything outside it.
  $dir = Join-Path ([System.IO.Path]::GetTempPath()) ("between-sweep-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  try {
    [System.IO.File]::WriteAllText((Join-Path $dir 'sweep.txt'), $Text, [System.Text.UTF8Encoding]::new($false))
    Push-Location $dir
    try {
      $hits = git grep --no-index -a -i -h -E -e $Pattern -- 'sweep.txt' 2>&1
      $code = $LASTEXITCODE
    } finally { Pop-Location }
    if ($code -eq 0) { return @($hits) }
    if ($code -eq 1) { return @() }
    Abort "name-sweep pattern '$Pattern' could NOT be evaluated against $Label (git grep exit ${code}): $hits`nA sweep that did not run is not a sweep."
  } finally { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
}

function Abort([string]$msg) {
  Write-Host ""
  Write-Host "ABORTING: $msg" -ForegroundColor Red
  # Best-effort return to a clean phase3 so the working tree is never left on `public` — but only if
  # we actually went there. Nothing has been modified before that point, so there is nothing to undo.
  if ($script:leftPhase3) { git checkout -f phase3 --quiet 2>$null }
  exit 1
}

# ── preflight ────────────────────────────────────────────────────────────────
# A version identifies one tree forever, so the string had better be a version. Validated FIRST,
# because everything downstream is irreversible: `-Version v1.0.0` published a permanent tag named
# "vv1.0.0", and `-Version "0.3.2 beta"` pushed `main` and only then failed at `git tag`, leaving the
# public branch published with no tag naming it.
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Abort "'$Version' is not a version. Expected three dot-separated numbers, e.g. 0.3.2 (no leading 'v', no suffix)."
}

$startBranch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($startBranch -ne 'phase3') { Abort "must run from the phase3 branch (currently on '$startBranch')." }

# `-c core.excludesFile=` and `-uall` are load-bearing, and their absence was a way to publish a file
# the operator could not see.
#
# The rebuild deliberately blanks the personal global gitignore so that what ships depends on the
# repository alone. This check did not, so the two disagreed: a path hidden from the operator by their
# own global ignore was invisible HERE ("working tree is clean") and visible to `git add .` THERE — and
# went out under a permanent tag. On this machine the global ignore hides `.claude/settings.local.json`
# and the repo's .gitignore says nothing about `.claude`, so the next project-scoped permission
# approval would have written a file that published itself.
#
# `-uall` because `status.showUntrackedFiles = no` is a common performance setting, and with it this
# check reported clean while whole untracked directories shipped.
#
# So: the repository is the only authority, in both directions. Anything the repo does not classify
# shows up here and stops the release until a human decides.
$dirty = git -c core.excludesFile= status --porcelain -uall
if ($LASTEXITCODE -ne 0) { Abort "git status failed (exit $LASTEXITCODE) — a failure here would read as a clean tree." }
if ($dirty) {
  Abort @"
working tree is not clean. Commit, stash, delete, or add to .gitignore:
$($dirty -join "`n")

If your own `git status` says the tree IS clean, that is expected and is the point: this check reads
the tree with THIS REPOSITORY's ignore rules only — deliberately ignoring your personal global
gitignore and status.showUntrackedFiles — because the release rebuild does the same. When the two
disagreed, a file you could not see published itself under a permanent tag.
"@
}

if (-not (git rev-parse --verify --quiet public)) { Abort "no local 'public' branch. Create it first (see docs/SHIP.md §2)." }

# ── immutability preflight (v0.2.1) ──────────────────────────────────────────
# Does v<Version> already exist? Locally we can compare trees exactly. On the remote we cannot without
# fetching, so a remote-only tag is refused outright — the conservative direction.
$tagName   = "v$Version"
$localTag  = (git rev-parse --verify --quiet "refs/tags/$tagName")
$remoteTag = $null
$remoteKnown = $false

# Exact name match, not a substring: a remote called 'mypublic-mirror' used to satisfy this test and
# then fail the ls-remote below in silence.
if ((git remote) -contains 'public') {
  # stderr is kept OUT of the value. Merging it with 2>&1 meant an ordinary, exit-0 warning became
  # field 0 and was read as a commit SHA: GitHub prints "warning: redirecting to <url>" for a renamed
  # repository, ssh prints "Warning: Permanently added ... to the list of known hosts". With a
  # local-only tag present, $remoteTag = "warning:" made the script announce "already published with
  # this exact tree - nothing to do" and exit 0 while the remote carried no tag at all.
  $errFile = [System.IO.Path]::GetTempFileName()
  try {
    $line = (git ls-remote --tags public "refs/tags/$tagName" 2>$errFile)
    $lsExit = $LASTEXITCODE
    $lsErr  = (Get-Content -Raw $errFile -ErrorAction SilentlyContinue)
  } finally { Remove-Item $errFile -Force -ErrorAction SilentlyContinue }
  if ($lsExit -ne 0) {
    # Discarding this failure removed the remote-tag guard entirely, and the run then went on to move
    # the published `main` before the tag push was rejected — leaving the public branch showing a tree
    # that no tag names. If we cannot read the remote, we cannot honour immutability, so we stop.
    Abort "could not read the public remote (git ls-remote exit $lsExit): $lsErr`nRefusing to publish without being able to check whether $tagName already exists there."
  }
  $remoteKnown = $true
  if ($line) {
    $field0 = (($line | Select-Object -First 1) -split '\s+')[0]
    # Only a real object name counts. Anything else means we did not understand the output, and
    # guessing is how a tag that does not exist gets reported as already published.
    if ($field0 -notmatch '^[0-9a-f]{40}$') {
      Abort "could not parse git ls-remote output for ${tagName}: '$field0' is not an object name.`nRaw: $line"
    }
    $remoteTag = $field0
  }
}
if ($remoteTag -and -not $localTag) {
  Abort "$tagName already exists on the public remote but not locally, so its tree cannot be compared. Tags are immutable — bump the version (corrections are a patch release) or fetch the tag first."
}
# Both exist: they must be the SAME OBJECT. The remote SHA was read and validated and then never
# compared to anything, so a remote tag placed by someone else — over an entirely different tree —
# left the local "same tree, nothing to do" branch free to report the release as already live. The
# operator was told their tree was published under this version. Someone else's was, and the version
# was already spent.
if ($remoteTag -and $localTag) {
  $localTagSha = (git rev-parse --verify --quiet "refs/tags/$tagName")
  if (-not $localTagSha -or $localTagSha.Trim() -ne $remoteTag.Trim()) {
    Abort "$tagName exists locally as $($localTagSha) and on the public remote as $remoteTag. They are different objects, so the remote is already carrying a DIFFERENT release under this version. Tags are immutable — bump the patch version."
  }
}

# The name-sweep patterns live ONLY in the gitignored personal-patterns.txt (one regex/pattern per line;
# '#' comments allowed). Searching for literal placeholder tokens is meaningless (they appear in this
# script and the docs), so: with the file present we sweep for real; PUBLISH refuses without it; a dry
# run warns and skips the sweep. The DECISIONS/FABLE hard assert below always runs either way.
$patternFile = 'personal-patterns.txt'
$namePatterns = @()
if (Test-Path $patternFile) {
  # Read as UTF-8 explicitly. Get-Content's default encoding turned an accented name saved as
  # cp1252/ANSI into U+FFFD, producing a pattern that could never match — and the sweep reported
  # "swept clean" over a file containing the name.
  $patternRaw = [System.IO.File]::ReadAllText((Resolve-Path $patternFile), [System.Text.UTF8Encoding]::new($false, $false))
  if ($patternRaw -match "�") {
    Abort "personal-patterns.txt is not valid UTF-8 (it contains a replacement character). Save it as UTF-8 and re-run — a mis-decoded pattern silently matches nothing."
  }
  # '#' is a legal regex character, so a parser cannot tell a comment from a pattern. Guessing is what
  # made this fail open twice in opposite directions:
  #
  #   - passing the raw line to git grep meant "Michael   # first name alone" became a VALID ERE that
  #     could never match, so the sweep reported clean while publishing the name. The file's own
  #     instructions documented that exact shape, so following its advice disabled it.
  #   - stripping the comment silently rewrote "Surname|@handle #hashtag" to "Surname|@handle",
  #     dropping a real handle from a still-valid pattern. Nothing errored, nothing matched, and the
  #     handle shipped.
  #
  # So it no longer guesses. A comment is a line whose first non-space character is '#'. Anything else
  # containing whitespace-then-'#' is ambiguous and STOPS the release rather than being interpreted.
  $lineNo = 0
  $namePatterns = @($patternRaw -split "`r?`n" | ForEach-Object {
    $lineNo++
    $raw = $_
    $line = $raw.Trim()
    if (-not $line) { return }
    if ($line.StartsWith('#')) { return }        # a whole-line comment
    if ($line -match '\s#') {
      Abort "personal-patterns.txt line ${lineNo}: contains whitespace followed by '#'. That is ambiguous — '#' is a legal regex character, so this is either a pattern or a trailing comment and guessing wrong silently disables the sweep. Put comments on their own line."
    }
    $line                                        # already trimmed: trailing whitespace used to be
  })                                             # passed through to git grep and matched nothing
  if ($namePatterns.Count -eq 0) {
    if ($Publish) { Abort "personal-patterns.txt exists but has NO active patterns (all commented). Add your real names/handles first — publishing now would run no name check at all." }
    Write-Host "Name-sweep: personal-patterns.txt has 0 active patterns — SWEEP SKIPPED (fill it in before publishing)." -ForegroundColor Yellow
  } else {
    Write-Host "Name-sweep: using $($namePatterns.Count) pattern(s) from $patternFile"
  }
} elseif ($Publish) {
  Abort "personal-patterns.txt is absent — refusing to PUBLISH without a real name sweep. Provide the gitignored personal-patterns.txt (one pattern per line) and re-run."
} else {
  Write-Host "Name-sweep: personal-patterns.txt absent — SWEEP SKIPPED for this dry run (the DECISIONS/FABLE assert still runs). Provide personal-patterns.txt before publishing." -ForegroundColor Yellow
}

# The rebuild sequence lives in scripts/lib/Rebuild-PublicTree.ps1 so that a regression test can run
# the real thing. Read its header before changing a single line of it: it has to make stale deletions
# die AND keep the private journal out, and the obvious repair for either one breaks the other.
#
# It is loaded into memory HERE, before the checkout, and that is not a style choice. `git checkout
# public` rewrites the working tree, deleting any file tracked on phase3 but absent from public — and
# a newly added helper is exactly that. Resolving it from disk afterwards fails on precisely the
# release that introduces it, which is how this was found. PowerShell has already read the file you
# are looking at; anything it reaches for later must be captured before the branch moves. Loading it
# now also means a syntax error in the helper surfaces before anything has been touched.
$rebuildScript = Join-Path $PSScriptRoot 'lib/Rebuild-PublicTree.ps1'
if (-not (Test-Path $rebuildScript)) { Abort "scripts/lib/Rebuild-PublicTree.ps1 is missing — the rebuild sequence it holds IS the release." }
$rebuildPublicTree = [scriptblock]::Create((Get-Content -Raw $rebuildScript))

Write-Host ""
Write-Host "Rebuilding 'public' from 'phase3' (version $Version, $(if ($Publish) { 'PUBLISH' } else { 'DRY RUN' }))..." -ForegroundColor Cyan

# ── rebuild the public working tree from phase3 with .gitignore re-applied ────
git checkout public --quiet
if ($LASTEXITCODE -ne 0) { Abort "could not check out 'public' (git exit $LASTEXITCODE). Nothing has been changed. A common cause: 'public' is already checked out in another worktree." }

# Do not take the checkout's word for it. Ask where HEAD actually is, because everything after this
# line — the rebuild, the assertions, the commit, the tag, the push — is only safe on 'public'. If a
# release ever ran on phase3, `git push public <tag>` would upload the whole private history, and the
# DECISIONS/FABLE assertion would not save us: it inspects the tracked set, not the branch.
# Set BEFORE the verification, not after: the checkout above has already moved HEAD, so an abort from
# here on must restore phase3. Setting it one line later stranded the operator on a detached HEAD —
# reachable in practice, because a TAG named 'public' satisfies the preflight's rev-parse and then
# checks out detached.
$script:leftPhase3 = $true
$landedOn = (git rev-parse --abbrev-ref HEAD)
if ($LASTEXITCODE -ne 0) { Abort "could not determine the current branch after checkout (git exit $LASTEXITCODE)." }
if ($landedOn.Trim() -ne 'public') { Abort "expected to be on 'public' but HEAD is '$($landedOn.Trim())'. Refusing to rebuild, commit, tag or push from the wrong branch." }
try {
  & $rebuildPublicTree -SourceBranch phase3

  # ── HARD ASSERTIONS ────────────────────────────────────────────────────────
  # -z and core.quotePath=false, both load-bearing. `git ls-files` honours core.quotePath, which
  # defaults to TRUE: a path containing any byte >= 0x80 comes back octal-escaped and wrapped in
  # literal quotes — "docs/Zo\303\253 Ashworth interview.md". Every list-based check below then matched
  # its regexes against that mangled string instead of the real path, so a real name in a non-ASCII
  # FILENAME published itself while the sweep reported clean, and every $-anchored never-ship rule
  # (.key, .pem, .pfx, .local.json) was defeated by putting one accented character in the name.
  #
  # Whether those checks worked was therefore decided by a per-machine git setting this repository
  # never states — which is precisely the disease the preflight above was rewritten to cure. The
  # repository is the only authority, in both directions, and that has to include how it reads itself.
  $tracked = @((git -c core.quotePath=false ls-files -z) -join '' -split "`0" | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0) { Abort "git ls-files failed (exit $LASTEXITCODE) — every assertion below would pass over an empty list." }

  $count = ($tracked | Measure-Object).Count
  # An empty tracked set means the rebuild did not work, and every assertion below would then pass
  # vacuously while reporting success over nothing.
  if ($count -eq 0) { Abort "the rebuild produced 0 tracked files. Every assertion below would pass over an empty list." }

  # And a sudden collapse means something silently removed paths — the failure mode a machine-local
  # gitignore used to cause, where an immutable tag went out over a truncated tree with no warning.
  # Relative, not a fixed floor: the number that matters is "much less than last time", and a fixed
  # floor is wrong for every repository except this one.
  $previous = (git ls-tree -r --name-only HEAD | Measure-Object).Count
  if ($previous -ge 20 -and $count -lt [int]($previous / 2)) {
    Abort "the rebuild produced $count tracked file(s), down from $previous in the previous release. That is a collapse, not an edit — check for a machine-local gitignore or a bad .gitignore rule before publishing."
  }

  $leaks = $tracked | Select-String -Pattern 'DECISIONS|FABLE-EXPLORATION|FABLE'
  if ($leaks) { Abort "private journal file(s) would be published:`n$($leaks -join "`n")" }

  # Belt to the .gitignore braces. Naming two journal files by hand was never going to cover the
  # general case, and the class of accident that matters is a machine-local file that no rule in this
  # repository happens to mention. These never ship, whatever any ignore file does or does not say.
  $NEVER_SHIP = @(
    '(^|/)\.env($|\.)', '\.key$', '\.pem$', '\.pfx$', '\.p12$',
    '(^|/)personal-patterns\.txt$', '\.local\.json$', '(^|/)\.npmrc$',
    '(^|/)id_(rsa|ed25519)', '\.sqlite\d?$', '\.db$', '(^|/)secrets?\.'
  )
  foreach ($deny in $NEVER_SHIP) {
    $hit = $tracked | Where-Object { $_ -match $deny }
    if ($hit) { Abort "a path matching the never-ship rule '$deny' is in the tree to be published:`n$($hit -join "`n")" }
  }

  # The name sweep is the last thing standing between a real name and a permanent public tag, and it
  # used to fail open in two ways at once.
  #
  # `git grep` exit codes: 0 = matched, 1 = no match, anything else = it did not run. Only "1" is a
  # pass. An invalid pattern exits 128 with its complaint sent to the null device, and the old code
  # read the empty output as "clean".
  #
  # And -E, not the default: `git grep` uses POSIX BASIC regex by default, where '|' is a LITERAL
  # character. Writing the obvious `Name1|Name2|handle` produced a pattern that could never match
  # anything, silently, and reported a passed sweep.
  # No -I. That flag told git grep to skip binary files, and .gitattributes marks *.png, *.jpg, *.gif,
  # *.db and *.sqlite as binary — so a name baked into a shipped screenshot, or in any file with a NUL
  # early in it, was never looked at while the sweep reported clean. Screenshots of this application
  # are exactly where a real name is most likely to be sitting in plain sight.
  foreach ($pat in $namePatterns) {
    $hits = git grep -a -i -l -E -e $pat -- . 2>&1
    $grepCode = $LASTEXITCODE
    if ($grepCode -eq 0) {
      # A short pattern can match a random byte sequence inside a PNG. Measured against this project's
      # own screenshots: 3-character patterns hit a real image about 20% of the time, 4-character ones
      # never did. The hit is still a stop — but the operator is told how to tell a real name from a
      # coincidence instead of staring at a screenshot wondering.
      $binaryOnly = @($hits | Where-Object { $_ -match '\.(png|jpe?g|gif|db|sqlite\d?|pdf|zip|woff2?|ttf)$' })
      $note = if ($binaryOnly.Count -eq @($hits).Count -and $pat.Length -lt 5) {
        "`n`nEvery hit is a binary file and the pattern is only $($pat.Length) characters, so this may be a coincidental byte sequence rather than a real name. Verify with:  git grep -a -i -E -e '$pat' -- <file>"
      } else { '' }
      Abort "name-sweep pattern '$pat' found in tracked file(s):`n$($hits -join "`n")$note"
    } elseif ($grepCode -ne 1) {
      Abort "name-sweep pattern '$pat' could NOT be evaluated (git grep exit $grepCode): $hits`nA sweep that did not run is not a sweep. Fix the pattern before publishing."
    }
    # git grep searches CONTENTS. A name in a PATH — docs/Michael-King-interview.md — is published in
    # the file listing of every clone, and nothing above would have seen it.
    #
    # Through git grep, not PowerShell's -match. Those are different regex languages, and a pattern
    # written for the sweep is written for git's: `\<Zoe\>` is a word boundary to GNU ERE and an
    # escaped literal '<' to .NET, so the content sweep honoured it and the filename sweep silently
    # did not. Same for POSIX classes like [[:alpha:]]. One pattern must mean one thing.
    $pathHits = Search-WithGitGrep -Pattern $pat -Text ($tracked -join "`n") -Label 'the tracked file list'
    if ($pathHits) {
      Abort "name-sweep pattern '$pat' appears in the FILENAME of tracked file(s):`n$($pathHits -join "`n")"
    }
  }

  # The release title is free text spliced into a permanent public commit message, and it was the one
  # operator-supplied string that reached the remote without ever being swept.
  if ($Title) {
    foreach ($pat in $namePatterns) {
      if (Search-WithGitGrep -Pattern $pat -Text $Title -Label 'the -Title text') {
        Abort "the -Title text matches name-sweep pattern '$pat'. It would be committed to the public history permanently."
      }
    }
  }

  # personal-patterns.txt itself must never be tracked.
  if ($tracked | Select-String -SimpleMatch 'personal-patterns.txt') { Abort "personal-patterns.txt is tracked — it must be git-ignored." }

  Write-Host "Assertions passed: $count tracked file(s), no DECISIONS/FABLE, $($namePatterns.Count) name pattern(s) swept clean." -ForegroundColor Green

  # ── IMMUTABILITY: this version may only ever mean this tree ────────────────
  # The index now holds exactly what would be published, so compare its tree to the tagged one.
  $newTree = (git write-tree).Trim()
  if ($localTag) {
    $oldTree = (git rev-parse --verify --quiet "$tagName^{tree}")
    if ($oldTree -and $oldTree.Trim() -eq $newTree) {
      # A local tag over an identical tree used to mean "already published — nothing to do". It does
      # not. It only means the tag exists HERE. If a previous run was interrupted between `git tag`
      # and `git push <tag>` — Ctrl-C, a closed terminal, a killed push — the tag is local-only, and
      # short-circuiting here made that version permanently unpublishable: every retry reported
      # success while the remote never received anything. The version could only be escaped by
      # burning the next number.
      if ($remoteKnown -and -not $remoteTag) {
        Write-Host ""
        Write-Host "$tagName exists locally over this exact tree but was never pushed — finishing the publish." -ForegroundColor Yellow
        if (-not $Publish) {
          Write-Host "DRY RUN complete — re-run with -Publish to push the existing tag." -ForegroundColor Yellow
          git checkout -f phase3 --quiet
          exit 0
        }
      } else {
        Write-Host ""
        Write-Host "$tagName is already published with this exact tree — nothing to do." -ForegroundColor Green
        git checkout -f phase3 --quiet
        exit 0
      }
    } else {
      $parts = $Version -split '\.'
      $next  = if ($parts.Count -ge 3) { "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)" } else { 'the next patch' }
      Abort "$tagName already exists and points at a DIFFERENT tree. Tags are immutable: a version identifies one tree forever. Corrections are a patch release — bump to $next and re-run."
    }
  }

  if (-not $Publish) {
    Write-Host ""
    Write-Host "DRY RUN complete — nothing committed or pushed. Re-run with -Publish to release." -ForegroundColor Yellow
    git checkout -f phase3 --quiet               # fully reset index + working tree to phase3
    exit 0
  }

  # ── PUBLISH (irreversible) ─────────────────────────────────────────────────
  # Every step below is checked. Previously a push could fail with "Could not read from remote
  # repository", and the script would print "Published … The tag is now permanent." and exit 0 — while
  # having published nothing. Worse, the local tag it had already created then made the version
  # unusable forever: a re-run found a local tag over an identical tree and reported "already
  # published with this exact tree — nothing to do", so the release could never be completed.
  $msg = if ($Title) { "Between v$Version — $Title" } else { "Between v$Version" }

  # A resumed run (branch pushed, tag push failed last time) has nothing left to commit. That is a
  # normal state, not an error — commit only if the index actually differs from HEAD.
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) {
    git commit -q -m $msg
    if ($LASTEXITCODE -ne 0) { Abort "the commit failed (git exit $LASTEXITCODE). Nothing has been pushed or tagged." }
  } else {
    Write-Host "'public' already carries this exact tree — nothing new to commit; tagging the existing commit." -ForegroundColor Yellow
  }

  git push public public:main
  if ($LASTEXITCODE -ne 0) { Abort "pushing 'public' to the remote FAILED (git exit $LASTEXITCODE). No tag was created, so re-running this same version after fixing the remote is safe." }

  # No -f, here or anywhere: the tag is created once and never moves. If the remote already carries it,
  # this push FAILS — which is the guard doing its job, not a problem to work around.
  # A local-only tag from an interrupted earlier run is reused rather than recreated.
  if (-not $localTag) {
    # Tag HEAD explicitly. `git tag <name>` with no commit-ish also means HEAD, so this is the same
    # object — being explicit is the point of the check below, not of this line.
    git tag "$tagName" HEAD
    if ($LASTEXITCODE -ne 0) { Abort "could not create the tag $tagName (git exit $LASTEXITCODE). The branch is pushed; re-run this same version once the cause is fixed." }
  }

  # A REUSED local tag is the dangerous case. The immutability guard only proves the tag names the same
  # TREE, and an identical tree can sit on a different commit — so a resumed run could publish `main`
  # at one commit and permanently tag another. Content was never at risk; provenance was: the tag did
  # not name the commit the release actually published.
  $tagCommit  = (git rev-parse --verify --quiet "$tagName^{commit}")
  $headCommit = (git rev-parse --verify --quiet 'HEAD')
  if (-not $tagCommit -or -not $headCommit) { Abort "could not resolve $tagName or HEAD to a commit after tagging." }
  if ($tagCommit.Trim() -ne $headCommit.Trim()) {
    Abort "$tagName names commit $($tagCommit.Trim()) but the commit just published to 'main' is $($headCommit.Trim()). A tag must name the commit it released. Delete the stale local tag and re-run."
  }

  git push public "$tagName"
  $pushTagCode = $LASTEXITCODE     # captured FIRST: the cleanup below resets $LASTEXITCODE, and the
                                   # abort message used to report the cleanup's exit code (always 0).
  if ($pushTagCode -ne 0) {
    # Remove the local tag, or the immutability guard treats this half-finished release as a finished
    # one. Only ever removes the tag this run just created: `git tag` fails on an existing name, so
    # reaching this line proves the name was free — unless we deliberately reused a local-only tag
    # from an interrupted run, which must survive so the retry can push it.
    if (-not $localTag) { git tag -d "$tagName" | Out-Null }
    $note = if ($localTag) { "The local tag was left in place; re-run the same version." }
            else { "The local tag has been deleted so this version is NOT wedged — fix the remote and re-run the same version." }
    Abort "pushing the tag $tagName FAILED (git exit $pushTagCode). $note"
  }

  Write-Host ""
  Write-Host "Published $tagName to the public remote (main + tag). The tag is now permanent." -ForegroundColor Green

  # ── post-push CI poll ──────────────────────────────────────────────────────
  # Branch protection on the public repo requires all four CI cells, and does NOT enforce them against
  # administrators. This script pushes as an administrator, so those required checks are bypassed —
  # GitHub says so in its own output during the push ("Bypassed rule violations for refs/heads/main").
  # Branch protection is therefore advisory against this path, and the local gates above are the real
  # enforcement. See docs/OPERATIONS.md.
  #
  # What is left is to refuse to CALL it a good release until the public tree has proved itself on the
  # public runners. This cannot un-push anything — the tag is already permanent, by design — so it does
  # not abort. It reports the truth, so that "published" and "green" are never conflated again.
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Host "NOTE: gh CLI not found — cannot poll public CI. Check it by hand before announcing." -ForegroundColor Yellow
  } else {
    $sha = (git rev-parse HEAD).Trim()
    Write-Host ""
    Write-Host "Waiting for public CI on $($sha.Substring(0,8)) (the required checks were bypassed by this push)..." -ForegroundColor Cyan
    $deadline = (Get-Date).AddMinutes(20)
    $verdict = $null
    while ((Get-Date) -lt $deadline) {
      $raw = gh run list --repo between-mirror/between --commit $sha --workflow CI --json status,conclusion 2>$null
      if ($LASTEXITCODE -eq 0 -and $raw) {
        $runs = $raw | ConvertFrom-Json
        if ($runs.Count -gt 0 -and -not ($runs | Where-Object { $_.status -ne 'completed' })) {
          $verdict = if ($runs | Where-Object { $_.conclusion -ne 'success' }) { 'RED' } else { 'GREEN' }
          break
        }
      }
      Start-Sleep -Seconds 20
    }
    if ($verdict -eq 'GREEN') {
      Write-Host "Public CI is GREEN for $tagName." -ForegroundColor Green
    } elseif ($verdict -eq 'RED') {
      Write-Host "PUBLIC CI IS RED for $tagName. The tag is permanent and does NOT move: fix forward with the next patch release. Do not announce this version." -ForegroundColor Red
    } else {
      Write-Host "Public CI did not finish within 20 minutes. $tagName is published but UNVERIFIED — check before announcing." -ForegroundColor Yellow
    }
  }
}
finally {
  # Always land back on a clean phase3 (force: the rebuild leaves the index/tree modified).
  #
  # The result is checked and said out loud. Swallowing it left the operator standing on `public` with
  # the entire rebuilt tree staged and nothing on screen to say so — and the next ordinary `git commit`
  # in that terminal would have committed the rebuild onto the public branch by hand. The release is
  # already over by this point, so this cannot abort; it can only refuse to be quiet.
  git checkout -f phase3 --quiet 2>$null
  $restoreCode = $LASTEXITCODE
  $landedOn = (git rev-parse --abbrev-ref HEAD 2>$null)
  if ($restoreCode -ne 0 -or ($landedOn -and $landedOn.Trim() -ne 'phase3')) {
    Write-Host ""
    Write-Host "WARNING: could not return to phase3 (git exit $restoreCode). You are on '$($landedOn)'." -ForegroundColor Red
    Write-Host "         The rebuilt tree may still be staged here. Do NOT commit in this state." -ForegroundColor Red
    Write-Host "         Recover with:  git checkout -f phase3" -ForegroundColor Red
  }
}
