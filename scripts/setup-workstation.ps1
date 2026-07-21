#requires -Version 5
<#
  Between — workstation setup (Windows + NVIDIA GPU, e.g. RTX 4080).
  Idempotent. Clones/updates the repo, installs deps, pulls the local model, and (optionally)
  ingests your archive. Nothing personal ever leaves the machine; Ollama does the grunt work locally.

  Normally you already HAVE the repo folder (zip, shared drive, or a clone). Run this from inside it:
    powershell -ExecutionPolicy Bypass -File scripts\setup-workstation.ps1 -XmlPath "C:\path\to\sms-XXXX.xml"
  If instead you were given a git URL, pass it and run from the PARENT folder — the script clones into .\between:
    powershell -ExecutionPolicy Bypass -File scripts\setup-workstation.ps1 -Repo <REPO_URL> -XmlPath "C:\path\to\sms-XXXX.xml"
#>
param(
  # Optional git URL to clone from, if you don't already have the folder. Leave empty when running
  # from inside the repo (the normal case). Substitute the URL you were given for this placeholder.
  [string]$Repo = '',
  [string]$Model = 'llama3.1',
  [string]$XmlPath = ''
)
$ErrorActionPreference = 'Stop'
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

Section 'Prerequisites'
$missing = @()
if (Have node) { Write-Host "node $(node -v)" } else { $missing += 'OpenJS.NodeJS.LTS' }
if (Have ollama) { Write-Host 'ollama present' } else { $missing += 'Ollama.Ollama' }
# git is only needed to clone; if you already have the folder it's optional.
if (Have git) { Write-Host 'git present' } elseif ($Repo) { $missing += 'Git.Git' }
if ($missing.Count) {
  Write-Host 'Missing prerequisites — install these, then re-run this script:' -ForegroundColor Yellow
  foreach ($m in $missing) { Write-Host "  winget install --id $m -e" }
  exit 1
}

Section 'Repository'
$inRepo = Test-Path 'between.config.json'
if (-not $inRepo) {
  if (-not (Test-Path 'between')) {
    if (-not $Repo) {
      Write-Host 'Not inside the repo and no -Repo URL given.' -ForegroundColor Yellow
      Write-Host 'Either cd into the Between folder and re-run, or pass -Repo <REPO_URL> to clone.'
      exit 1
    }
    git clone $Repo between
  }
  Set-Location between
}
if (Have git) {
  try { git pull --ff-only } catch { Write-Host 'skip git pull (local changes or offline)' -ForegroundColor DarkGray }
}

Section 'Install dependencies'
npm install

Section "Ollama model: $Model"
# Ollama installs a background service; nudge it and pull the model.
Start-Process -WindowStyle Hidden ollama -ArgumentList 'serve' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
ollama pull $Model

Section 'Data'
New-Item -ItemType Directory -Force -Path 'data' | Out-Null
if ($XmlPath -and (Test-Path $XmlPath)) {
  Copy-Item $XmlPath 'data\' -Force
  $xml = Get-ChildItem 'data\*.xml' | Sort-Object Length -Descending | Select-Object -First 1
  Section "Ingest $($xml.Name)"
  $env:NODE_OPTIONS = '--max-old-space-size=4096'
  npx tsx server/src/cli/ingest.ts "$($xml.FullName)"
} else {
  Write-Host 'No -XmlPath given. Export your Android SMS Backup & Restore XML (see docs/DEPLOY.md),' -ForegroundColor Yellow
  Write-Host 'drop the sms-*.xml into .\data\, then run:'
  Write-Host '  npx tsx server/src/cli/ingest.ts "data\sms-XXXX.xml"'
}

Section 'Ready'
Write-Host @'
  npm run dev                                                  # browse + metrics + river -> http://localhost:5273
  npx tsx server/src/cli/analyze.ts --thread <id> --dry-run    # capacity estimate first
  npx tsx server/src/cli/analyze.ts --thread <id>              # materialize the L1 jobs
  npx tsx server/src/cli/drain.ts --loop                       # Ollama reads the grunt (local, free)
  npx tsx server/src/cli/reflect.ts --thread <id> --engine claude   # the worthwhile letter (Claude/Fable)

Full runbook + the engine tiers: docs/DEPLOY.md
(On Windows, use npx tsx for the flag-taking CLIs — npm run drops --flags.)
'@ -ForegroundColor Green
