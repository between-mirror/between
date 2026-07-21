# Deploying Between on another machine

Between is built to move (Addendum B: *built for the next person*). The repo carries **no personal data** — you bring your own archive, and everything runs locally. A workstation with an NVIDIA GPU (e.g. an RTX 4080) turns the on-demand, capacity-metered analysis into something you can run **at full scale, locally, for free** via Ollama.

## Android only (for now)

Between reads exactly one input: an **Android** *SMS Backup & Restore* XML export of your own SMS/MMS. That's the only format the parser understands.

**iPhone / iMessage is not supported yet.** There is no path for an iOS backup or iMessage, and iMessage/RCS traffic isn't present in an Android SMS archive anyway (the tool flags the resulting gaps rather than guessing). If both people were on iPhone, the archive won't exist — you can't run Between on that conversation today.

## Get your messages out of your phone

You produce the input yourself, on the Android phone that holds the conversation. Nothing goes to a cloud service.

1. On the Android phone, install **SMS Backup & Restore** (SyncTech) from the Google Play Store.
2. Open it and choose **Set up a backup** (or **Backup**). Include **Messages**; media (MMS) can be included or skipped.
3. For the destination, pick **local storage on the phone** — export to a file, **not** to Google Drive / Dropbox / any cloud. The backup is written as XML, named like `sms-YYYYMMDDHHMMSS.xml`.
4. Copy that `sms-*.xml` off the phone to this workstation (USB, or a local transfer you trust). Keep it off cloud-synced folders.
5. Put the file in the repo's `data\` folder — that's the archive the steps below ingest.

## The engine tiers — who does what

The whole point of the design: **spend the expensive, worthwhile inference only where it matters, and do the grunt math locally.**

| Work | `engine_hint` | Tier | Runs on | Cost |
|---|---|---|---|---|
| Browse, search, T1 metrics, the VADER river | — | deterministic | Node (any machine) | free |
| **L1 per-message emotion** (bulk classification) | `local` | **grunt** | **Ollama (your GPU)** | free |
| Reduce — distilling findings | `claude` | worthwhile | Claude / Opus | subscription |
| Render — the First Reflection / letter | `render` | worthwhile | **Fable** | subscription |

**The guard is enforced in code:** `npm run drain` defaults to Ollama and, on Ollama, only reads `local`-hint jobs. It will **never** feed the reduce/render (the worthwhile prose) to the local model. Those stay pending until you run them on Claude/Fable. So the grunt is free and local; the inference worth paying for is never clobbered.

Nothing leaves the machine except the text you deliberately send to Claude/Fable for the reflection prose. Ollama is entirely local.

## Prerequisites (Windows)

- **Node.js 22 or newer** — `winget install OpenJS.NodeJS.LTS -e`. Node 20 is *not* enough on
  Windows: `better-sqlite3` publishes no prebuilt binary for Node 20 on win32, so installing there
  would need a full MSVC C++ toolchain. On Node 22+ the prebuilt binary exists and `npm install`
  needs no compiler. (Node 20 also went end-of-life in April 2026.)
- **Git** — `winget install Git.Git -e`
- **Ollama** — `winget install Ollama.Ollama -e` (installs a background service on `127.0.0.1:11434`)

## One-shot setup

You need the repo folder on this machine first. However it reached you — a zip, a shared drive, or a clone — `cd` into it, then:

```powershell
# from inside the repo folder (the one with between.config.json):
powershell -ExecutionPolicy Bypass -File scripts\setup-workstation.ps1 -XmlPath "C:\path\to\your\sms-XXXX.xml"
```

That script checks prerequisites, installs deps, pulls the model (`llama3.1` by default), and ingests your archive. (Omit `-XmlPath` to set the data up by hand.)

If you were given a git URL to clone from, run this first and substitute it for the placeholder:

```powershell
git clone <REPO_URL> between   # ← use the URL you were given
cd between
```

### Model choice for the 4080

- `llama3.1` (8B) — the default; fast, fits easily, reliable JSON. Good for the L1 grunt.
- `qwen2.5:14b` — a quality upgrade the 4080 handles comfortably: `ollama pull qwen2.5:14b`, then drain with `--model qwen2.5:14b`.

Set the default in `between.config.json` → `"ollama": { "model": "..." }`.

## The full run

```powershell
# 1. Ingest (once per archive; ~1 min for a 200k-message backup)
npx tsx server/src/cli/ingest.ts "data\sms-XXXX.xml"

# 2. Browse it — deterministic, no model, no network
npm run dev            # http://localhost:5273

# 3. Deep-read a relationship (on-demand, capacity-honest). Pick a thread id from the UI.
npx tsx server/src/cli/analyze.ts --thread 25 --dry-run   # see the estimate first ("N stretches ≈ ... time")
npx tsx server/src/cli/analyze.ts --thread 25             # materialize the L1 jobs (whole thread)
#   scope it to a range if you like:  --from <epoch_ms> --to <epoch_ms>

# 4. Ollama reads the grunt — local, free, loops until done
npx tsx server/src/cli/drain.ts --loop
#   pick a model:  npx tsx server/src/cli/drain.ts --loop --model qwen2.5:14b
#   the river now shows real per-message emotion where it read.

# 5. The worthwhile letter — the small, high-value Claude/Fable pass
npx tsx server/src/cli/reflect.ts --thread 25 --engine claude
#   (needs Claude access. Local-only draft: --engine ollama, lower prose quality.)
```

> **Why `npx tsx …` and not `npm run …`?** On Windows, `npm run <script> -- --flags` silently drops `--`-prefixed flags (npm parses them as its own config). Positional args survive, flags don't — so the flag-taking CLIs are invoked directly via `npx tsx`. `npm run dev` (no flags) is fine.

### Draining the worthwhile tier

The reduce/render jobs are left for Claude/Fable. Two ways to run them:

- **Interactive Claude Code** in the repo: run the committed `/drain-jobs` command — it processes only the `claude`/`render` jobs (it skips `local`, which is Ollama's). Then the app ingests and freezes the reflection.
- **`npm run reflect -- --engine claude`** — orchestrates reduce → render → freeze end to end (when the automated Claude path is available on your account).

If neither is available, `--engine ollama` produces a fully-local draft — honest, but without the literary register the letter deserves. Reserve Fable for the letter; it's a tiny, infrequent spend.

## Notes

- **No Claude Code required** to browse or to run the Ollama grunt — the app is self-contained (Node + Ollama). Claude/Fable is only the optional worthwhile tier.
- **Re-import:** dropping in a newer backup dedups against what's there; only genuinely new windows ever spend anything.
- **Speed / tranches:** the L1 drain is sequential per request, so a whole 170k-message archive is a multi-day run. Drain it in predictable, **resumable tranches** with a time budget instead of one open-ended `--loop`:

  ```powershell
  # one ~12-hour overnight tranche (qwen for quality); rerun the same line to continue where it stopped
  npx tsx server/src/cli/drain.ts --loop --minutes 720 --model qwen2.5:14b
  ```

  A tranche stops when the budget is spent, leaving the rest pending; the Sentiment River refreshes after every round, so it fills as you go. Scope by relationship/era (`--from`/`--to` on `analyze`) if you'd rather chunk by time. Parallel Ollama throughput (`OLLAMA_NUM_PARALLEL`) is a further tuning follow-up.

- **Fast paid alternative (Batch API):** to skip the multi-day local run, submit the L1 grunt to Anthropic's Message Batches API on Haiku — **~1 hour** (guaranteed ≤24h), **~$30** for a whole 170k-message archive at batch pricing. This bills the **API** (`ANTHROPIC_API_KEY`), *not* your Claude subscription, and sends the window transcripts to the API (media is never sent). It's an opt-in re-tier of the grunt — the worthwhile reduce/render still go to Opus/Fable.

  ```powershell
  npx tsx server/src/cli/drain.ts --engine batch --dry-run       # cost/token estimate (no key needed)
  npx tsx server/src/cli/drain.ts --engine batch                 # submit + poll + collect
  npx tsx server/src/cli/drain.ts --engine batch --collect <id>  # resume collecting after an interruption
  ```

  It writes the same `results/*.json` the app ingests, so it's interchangeable with the local drain at the airlock contract. Trades the grunt tier's free-and-local properties for speed.

- **Which grunt path to prefer (safety):** the local **Ollama** path (default, free, nothing leaves the machine) and the **Batch API** path are both *non-agentic* — they classify a transcript and return JSON, with no tools, no shell, no filesystem beyond the one result. The Claude **subscription** drain runs an *agentic* model over archive text (untrusted input), and although it is tool-restricted and sandboxed (`docs/THREAT-MODEL.md`, P0-1), a non-agentic path has strictly less surface. **For a first run — especially on an archive you did not author — prefer Ollama, or api-key/Batch if you want speed; reserve the subscription drain for the small worthwhile reduce/render tier.**
- **Privacy / at-rest (P1-12):** keep the working copy off cloud-synced folders — the app applies
  best-effort owner-only file ACLs at boot, warns loudly if its directory looks cloud-synced, and deletes
  drained airlock plaintext older than 7 days. `between.db`, `data/`, and `airlock/` are git-ignored and
  must stay that way. Once your archive is ingested, the source XML is the most sensitive plaintext on
  disk; `ingest … --delete-source` removes it after a verified ingest. At-rest DB encryption is
  deliberately deferred (a forgotten passphrase on a no-account tool = unrecoverable loss) — see
  `docs/THREAT-MODEL.md`.
