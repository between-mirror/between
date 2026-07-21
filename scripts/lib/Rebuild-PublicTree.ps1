<#
.SYNOPSIS
  Rebuild the currently checked-out branch's tree from another branch, with .gitignore re-applied.

.DESCRIPTION
  This is the load-bearing four lines of the release. It is a separate file for one reason: so
  server/test/publishRebuild.test.ts can run THE ACTUAL SEQUENCE against a throwaway repository
  instead of a copy of it that can drift.

  It must satisfy two properties at once, and the obvious repairs each satisfy only one:

    (1) A file deleted on the source branch must DIE. It is not enough to untrack it — if it is still
        sitting in the working tree when `git add .` runs, it comes straight back. Something removed
        FOR PRIVACY would then persist in every future release.

    (2) A file that is tracked on the source branch but git-ignored here must NOT ship. On the source
        branch docs/DECISIONS.md — the author's private journal — is both tracked and listed in
        .gitignore. Tracking wins there, which is what makes it available to the author; here it must
        lose. That only works if the index is EMPTY when `git add .` runs, because .gitignore applies
        to untracked paths only.

  Hence the order:

    git rm -r -f -q .          delete tracked files from index AND working tree -> stale deletions die
    git checkout <src> -- .    overlay the source content (this STAGES it, private files included)
    git rm -r -q --cached .    empty the index again, leaving the working tree alone
    git add .                  .gitignore now re-applies -> private/ignored paths stay out

  The naive repair, `git checkout <src> -- .` on its own, satisfies (2) and silently breaks (1).
  Dropping the second `git rm --cached` satisfies (1) and publishes the private journal.

  NEVER add `git clean -fdx` to this. The ignored private data — between.db, data/, airlock/,
  personal-patterns.txt — lives in this same working directory and is not recoverable from git.
  Step 1 uses `git rm`, which touches tracked files only, and that is exactly why it is the right tool.

  Step 2 carries no such guarantee, and the distinction matters. `git checkout <src> -- .` will
  overwrite an ignored local path if the source branch tracks something at the same name — including
  replacing a local ignored DIRECTORY with a tracked FILE of that name, which destroys everything
  inside it with no warning and no way back. No such collision exists in this repo today (nothing
  tracked collides with between.db, data/, airlock/ or personal-patterns.txt), but a new tracked path
  that shadows an ignored one would be silently destructive. Check before adding one.

.PARAMETER SourceBranch
  The branch whose content becomes the new tree, e.g. phase3.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceBranch
)

$ErrorActionPreference = 'Stop'

# 1. Delete every tracked file from the index and the working tree. Untracked and ignored files —
#    the private data — are not tracked, so `git rm` cannot touch them.
# 0. COLLISION PRE-CHECK, before anything is deleted or overwritten.
#
# Step 2 runs `git checkout <source> -- .`, which writes the source branch's tracked paths into this
# working tree and overwrites whatever is sitting at those paths WITHOUT WARNING. Steps 1 and 3 only
# ever touch TRACKED files, so anything ignored or untracked here — which on this machine means the
# database, the imported archive, the airlock, and the private pattern list — is invisible to them and
# is exactly what step 2 would silently clobber.
#
# Two shapes of collision, and the second is the nasty one:
#   - exact path: source tracks `notes.md`, an ignored `notes.md` exists here  -> overwritten
#   - file/dir prefix: source tracks `data/x.txt`, an ignored FILE `data` exists here (or the reverse)
#     -> git removes the file to make the directory, or refuses mid-way leaving the tree half-built
#
# Detected and refused, not warned about: the whole point is that the loss is silent.
$sourcePaths = @((git -c core.quotePath=false ls-tree -r --name-only $SourceBranch) | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw "collision pre-check failed: could not list $SourceBranch (exit $LASTEXITCODE)" }
if ($sourcePaths.Count -eq 0) { throw "collision pre-check failed: $SourceBranch appears to track nothing." }

# IGNORED files specifically — not merely untracked ones.
#
# The hazard is data that cannot be recovered: the database, the imported archive, the airlock, the
# pattern list. Those are ignored, which is exactly why `git rm` cannot see them and why step 2 would
# destroy them without a word.
#
# A merely-untracked file is a different case and is already handled upstream: publish-release.ps1
# refuses to run at all unless the tree is clean under this repository's own ignore rules, so by the
# time we get here an untracked-and-not-ignored file cannot exist. Including them anyway made this
# check fire on the whole repository the moment the target branch was empty — with nothing tracked,
# every source path read as "under an untracked directory" and ~300 legitimate paths were refused.
# A guard that blocks every release gets deleted, which makes it worse than no guard.
$present = @((git -c core.quotePath=false ls-files --others --ignored --exclude-standard --directory --no-empty-directory) | Where-Object { $_ })
$presentSet = [System.Collections.Generic.HashSet[string]]::new([string[]]$present, [StringComparer]::OrdinalIgnoreCase)

$collisions = @()
foreach ($p in $sourcePaths) {
  if ($presentSet.Contains($p)) { $collisions += "exact: $p"; continue }
  # A directory entry from ls-files --others ends in '/'; a source path underneath it collides.
  foreach ($q in $present) {
    if ($q.EndsWith('/') -and $p.StartsWith($q, [System.StringComparison]::OrdinalIgnoreCase)) {
      $collisions += "under ignored dir: $p (inside $q)"
      break
    }
  }
  # The reverse: source wants a DIRECTORY where an untracked FILE sits.
  $parts = $p -split '/'
  for ($i = 1; $i -lt $parts.Count; $i++) {
    $prefix = ($parts[0..($i - 1)] -join '/')
    if ($presentSet.Contains($prefix)) { $collisions += "file/dir: $p needs directory '$prefix', which exists here as a file"; break }
  }
}
if ($collisions.Count -gt 0) {
  throw ("the rebuild would overwrite files this branch does not track:`n  " + (($collisions | Select-Object -Unique) -join "`n  ") +
         "`nThese are ignored or untracked here, so no step of the rebuild would report their loss. Move them before releasing.")
}

# `--ignore-unmatch` so that a target branch tracking NOTHING is a valid starting point rather than a
# fatal error. `git rm -r .` exits 128 with "pathspec did not match any files" against an empty tree,
# which is precisely the state of a freshly-orphaned public branch — the shape you are in when the
# published history has to be replaced rather than extended. It changes nothing in the normal case:
# the flag only tolerates "there was nothing to remove", not a real failure to remove something.
git rm -r -f -q --ignore-unmatch .
if ($LASTEXITCODE -ne 0) { throw "rebuild step 1 failed (git rm -r -f -q .): exit $LASTEXITCODE" }

# 2. Overlay the source branch's content into the working tree. This also stages it.
git checkout $SourceBranch -- .
if ($LASTEXITCODE -ne 0) { throw "rebuild step 2 failed (git checkout $SourceBranch -- .): exit $LASTEXITCODE" }

# 3. Empty the index again without touching the working tree, so every path is "untracked" and
#    .gitignore gets a vote.
git rm -r -q --cached .
if ($LASTEXITCODE -ne 0) { throw "rebuild step 3 failed (git rm -r -q --cached .): exit $LASTEXITCODE" }

# 4. Re-add. Ignored paths are now excluded.
#
# `-c core.excludesFile=` deliberately blanks the operator's PERSONAL global gitignore for this one
# command. Emptying the index gives .gitignore a vote, but it gives all THREE exclude sources a vote,
# and two of them are per-machine and invisible to the repository. An ordinary personal global ignore
# containing `site/` or `*.json` silently dropped those paths from the release — no warning, no error,
# an immutable tag over a truncated tree. What ships must depend on the repository alone.
git -c core.excludesFile= add .
if ($LASTEXITCODE -ne 0) { throw "rebuild step 4 failed (git add .): exit $LASTEXITCODE" }

# .git/info/exclude is the third source and cannot be overridden by a -c flag, so it is inspected.
$infoExclude = Join-Path (git rev-parse --git-dir).Trim() 'info/exclude'
if (Test-Path $infoExclude) {
  $active = @(Get-Content $infoExclude | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') })
  if ($active.Count -gt 0) {
    throw "$infoExclude has $($active.Count) active rule(s). That file is per-machine and invisible to the repo, and it silently removes paths from the published tree. Clear it before releasing."
  }
}
