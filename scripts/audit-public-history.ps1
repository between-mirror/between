<#
.SYNOPSIS
  Sweep the ENTIRE published history of the public repo for private patterns.

.DESCRIPTION
  The release script guards the tree it is about to publish. It cannot see what is already published.
  Nine releases went out before anything asked that second question, and the answer is not derivable
  from the working copy: a file removed from the tree today is still in the history that carries it.

  So this clones the PUBLIC repository fresh and sweeps every reachable commit, path, message, tag and
  blob for the patterns in the local, gitignored personal-patterns.txt.

  IT MUST NEVER RUN AGAINST THE LOCAL REPOSITORY. phase3's history is private by design — it contains
  the build journal, the internal planning documents, and whatever else the author kept out of the
  release. Every pattern would match, the audit would "fail", and the finding would be meaningless.
  The guard for that is explicit and refuses rather than warns.

  EXIT-CODE DISCIPLINE. git grep exits 0 on a match, 1 on no match, and >1 on an error. Treating
  "not 0" as clean is how a sweep reports success over a repository it could not read. Every call
  here distinguishes all three, and anything that is not a clean 1 fails the audit.

.PARAMETER PatternFile
  The local gitignored pattern list. Read from here and never written anywhere else — not into the
  clone, not into output, not into the notes this produces.

.PARAMETER WorkDir
  Scratch directory for the clone. Removed and recreated on each run.

.PARAMETER RepoUrl
  The public repository. The clone's origin must match this or the audit refuses.
#>
[CmdletBinding()]
param(
  [string]$PatternFile = 'personal-patterns.txt',
  [string]$WorkDir     = (Join-Path ([System.IO.Path]::GetTempPath()) 'between-history-audit'),
  [string]$RepoUrl     = 'https://github.com/between-mirror/between.git',

  # The known release floor. A clone carrying fewer tags than releases we know exist is incomplete,
  # and a sweep of an incomplete clone that reports CLEAN is the quietest possible lie. Overridable
  # only so the regression fixtures can build a smaller repository.
  [int]$MinTags        = 9
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

# git speaks UTF-8; decoding its output as the console codepage turns an accented path into mojibake
# and every check over it silently looks at the wrong string.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "AUDIT FAILED: $msg" -ForegroundColor Red
  exit 1
}
function Note([string]$msg) { Write-Host "  $msg" }

# ── the patterns ─────────────────────────────────────────────────────────────
if (-not (Test-Path $PatternFile)) {
  Fail "no $PatternFile. The sweep would run zero patterns and report clean, which is worse than not running."
}
$raw = [System.IO.File]::ReadAllText((Resolve-Path $PatternFile))
if ($raw -match "`u{FFFD}") {
  Fail "$PatternFile is not valid UTF-8 (replacement characters present). A mangled pattern matches nothing and reports clean."
}
$lineNo = 0
$patterns = @($raw -split "`r?`n" | ForEach-Object {
  $lineNo++
  $line = $_.Trim()
  if (-not $line) { return }
  if ($line.StartsWith('#')) { return }
  if ($line -match '\s#') {
    Fail "$PatternFile line ${lineNo}: whitespace followed by '#' is ambiguous ('#' is a legal regex character). Put comments on their own line."
  }
  $line
})
if ($patterns.Count -eq 0) { Fail "$PatternFile has no active patterns. A sweep of nothing is not a sweep." }

Write-Host ""
Write-Host "Public-history audit" -ForegroundColor Cyan
Note "patterns : $($patterns.Count) (from the local $PatternFile; never written anywhere)"
Note "target   : $RepoUrl"

# ── the clone ────────────────────────────────────────────────────────────────
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
$clone = Join-Path $WorkDir 'public'

# --mirror: every ref, including tags and anything else the remote advertises. A normal clone gets
# one branch, and the whole point is the commits nobody is looking at.
git clone --quiet --mirror $RepoUrl $clone 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "could not clone $RepoUrl (git exit $LASTEXITCODE)." }

Push-Location $clone
try {
  # ── THE SAFETY INTERLOCK ───────────────────────────────────────────────────
  # Everything below reports a match as a privacy incident. Pointed at the local repository it would
  # match on the first commit and mean nothing — phase3's history is private ON PURPOSE. Refuse.
  $origin = (git config --get remote.origin.url)
  if ($LASTEXITCODE -ne 0 -or -not $origin) { Fail "could not read the clone's origin." }
  $normalize = { param($u) ($u -replace '\.git$','' -replace '^git@github\.com:','https://github.com/').TrimEnd('/') }
  if ((& $normalize $origin) -ne (& $normalize $RepoUrl)) {
    Fail "the clone's origin is '$origin', not '$RepoUrl'. This audit only ever runs against the public repository."
  }
  if (git rev-parse --verify --quiet 'refs/heads/phase3') {
    Fail "this clone contains a branch named 'phase3'. That is the PRIVATE branch — refusing, because every pattern would match by design and the result would be meaningless."
  }
  Note "interlock: origin verified public, no phase3 branch present"

  # ── what we are about to sweep ─────────────────────────────────────────────
  $commits = @(git rev-list --all)
  if ($LASTEXITCODE -ne 0) { Fail "git rev-list failed (exit $LASTEXITCODE)." }
  if ($commits.Count -eq 0) { Fail "the clone has no commits. A sweep of nothing reports clean." }

  $tags = @(git for-each-ref --format='%(refname:short)' refs/tags)
  $objects = @(git cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)')
  if ($LASTEXITCODE -ne 0) { Fail "git cat-file --batch-all-objects failed (exit $LASTEXITCODE)." }
  $blobs = @($objects | Where-Object { $_ -like 'blob *' })

  # Known-coverage check. If the walk is somehow shallow or partial, the counts will not support the
  # releases we know exist, and a shallow sweep that reports clean is the failure mode that matters.
  # The real coverage property is not a count comparison — a repository may legitimately carry more
  # tags than commits — it is that EVERY TAG'S COMMIT IS IN THE SET WE ARE ABOUT TO SWEEP. If a tag
  # points somewhere the walk does not reach, a published release is not being audited, and that is
  # precisely the release most likely to hold something old.
  $commitSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$commits)
  foreach ($t in $tags) {
    $target = (git rev-list -n 1 $t 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $target) { Fail "could not resolve tag $t to a commit." }
    if (-not $commitSet.Contains($target.Trim())) {
      Fail "tag $t points at $($target.Trim()), which the history walk does not reach — the sweep would miss a published release."
    }
  }
  if ($tags.Count -lt $MinTags) {
    Fail "found only $($tags.Count) tags; at least $MinTags releases are known to exist. The clone is incomplete."
  }

  $first = (git rev-list --all --reverse | Select-Object -First 1)
  $last  = (git rev-list --all | Select-Object -First 1)

  Note "commits  : $($commits.Count)"
  Note "tags     : $($tags.Count)"
  Note "blobs    : $($blobs.Count)"
  Note "range    : $($first.Substring(0,8))..$($last.Substring(0,8))"
  Write-Host ""

  $hits = @()

  # Run one git grep and classify its exit code honestly.
  function Grep-Or-Fail([string[]]$grepArgs, [string]$what) {
    $out = & git @grepArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) { return ,@($out) }          # match
    if ($code -eq 1) { return ,@() }              # clean
    Fail "git grep failed while sweeping $what (exit $code): $out"
  }

  foreach ($pat in $patterns) {
    # (1) file CONTENTS at every reachable commit. -a so a file git treats as binary is still read;
    # a name inside a PNG is still a name.
    foreach ($c in $commits) {
      $r = Grep-Or-Fail @('grep','-a','-i','-I','-l','-E','-e',$pat,$c,'--','.') "contents of $c"
      if ($r.Count) { $hits += "CONTENT  commit $c :: $($r -join ', ')" }
    }

    # (3) commit MESSAGES.
    $msgs = & git log --all --format='%H%x00%B%x00---' 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "git log failed (exit $LASTEXITCODE)." }
    foreach ($block in ($msgs -join "`n") -split '---') {
      if ($block -match '(?i)' + $pat) {
        $sha = ($block -split "`0")[0].Trim()
        $hits += "MESSAGE  commit $sha"
      }
    }

    # (4) annotated TAG messages.
    foreach ($t in $tags) {
      $body = & git for-each-ref "refs/tags/$t" --format='%(contents)' 2>&1
      if ($LASTEXITCODE -ne 0) { Fail "git for-each-ref failed for tag $t (exit $LASTEXITCODE)." }
      if (($body -join "`n") -match '(?i)' + $pat) { $hits += "TAGMSG   $t" }
    }
  }

  # (2) PATHS at every commit — a name in a filename is published in every clone's file listing and
  # no content sweep sees it.
  foreach ($c in $commits) {
    $paths = & git ls-tree -r --name-only $c 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "git ls-tree failed for $c (exit $LASTEXITCODE)." }
    foreach ($pat in $patterns) {
      $m = @($paths | Where-Object { $_ -match '(?i)' + $pat })
      if ($m.Count) { $hits += "PATH     commit $c :: $($m -join ', ')" }
    }
  }

  # (5) every reachable BLOB, belt over braces: catches content in an object no current tree names.
  foreach ($line in $blobs) {
    $sha = ($line -split ' ')[1]
    $content = & git cat-file blob $sha 2>&1
    if ($LASTEXITCODE -ne 0) { continue }
    $text = ($content -join "`n")
    foreach ($pat in $patterns) {
      if ($text -match '(?i)' + $pat) { $hits += "BLOB     $sha" }
    }
  }

  # ── verdict ────────────────────────────────────────────────────────────────
  Write-Host ""
  if ($hits.Count) {
    Write-Host "VERDICT: MATCHES FOUND ($($hits.Count))" -ForegroundColor Red
    # The locations, never the patterns — this output is meant to be pasteable into a note.
    $hits | Select-Object -Unique | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "Owner doctrine: privacy beats immutability. Rewrite the public history without the" -ForegroundColor Yellow
    Write-Host "named objects, re-cut the tags, and publish a candid note explaining the one-time break." -ForegroundColor Yellow
    exit 1
  }

  Write-Host "VERDICT: CLEAN" -ForegroundColor Green
  Write-Host ""
  Write-Host "  $($patterns.Count) patterns swept across $($commits.Count) commits, $($tags.Count) tags," -ForegroundColor Green
  Write-Host "  $($blobs.Count) blobs; range $($first.Substring(0,8))..$($last.Substring(0,8))." -ForegroundColor Green
  exit 0
}
finally {
  Pop-Location
}
