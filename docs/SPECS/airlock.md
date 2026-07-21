# SPEC — The Airlock (job/result protocol)

*The app never calls a model. It plans jobs to `airlock/jobs/`; an engine (Claude Code via `/drain-jobs`, or the Ollama adapter) writes `airlock/results/`; the app ingests results on awaited subprocess completion and is the sole DB writer. JSON files are transport, never truth — the DB is truth.*

## Directories

```
airlock/
  jobs/            <job_id>.json     written by the app (atomic: .tmp → rename)
  jobs/_manifest.json                run inventory + counts, rewritten by the app
  results/         <job_id>.json     written by the engine (atomic: .tmp → rename)
  archive/                           processed files moved here by the app after ingest
```
Local, non-cloud-synced path. Recommend a Windows Defender exclusion on first run (GAMEPLAN §4.6).

## The idempotency key (exact definition — T2.1)

```
canonical(x) = JSON with lexicographically sorted keys, no insignificant whitespace, UTF-8
SEP          = one U+0020 SPACE
preimage     = canonical({prompt_id, prompt_version, params})
               + SEP + chunk_text
               + SEP + canonical(output_schema)
digest       = sha256(utf8 bytes of preimage)        // the raw 32 bytes
input_hash   = "sha256:" + lowercase hex of digest   // WITH the "sha256:" prefix
job id       = "job_" + base32lower(digest)[0:16]    // the RAW 32 bytes, not the hex string
```
The separator is **named rather than shown**, and that is not pedantry. From this file's first commit until v0.3.2 the two `SEP` positions held a literal U+0000 NUL byte — invisible in every editor, and enough to make git classify this file as binary and refuse to diff it at all. Whoever implemented [hash.ts](../../server/src/airlock/hash.ts) read the rendered spec, saw nothing between the quotes, and wrote a space. Spec and implementation therefore disagreed silently for the project's entire history. The space is what actually ships and what every stored `input_hash` was computed with, so the spec is corrected to match the code; the code is not changed to match the spec, because `analysis_results.input_hash` is a **persisted primary key** and altering it would strand every cached analysis in every existing database and force a full re-drain — real money on the subscription and API paths. Any future change to `SEP` is a migration, not an edit.

Two neighbouring ambiguities were fixed in the same pass, because they are the same hazard: this
document exists in its current form *because* a reimplementer read it literally and got a different
answer from the code. It previously defined `input_hash = sha256hex(…)` — bare hex — while the code
returns `sha256:<hex>` and the job-file example below uses the prefixed form, so the spec contradicted
itself. And `base32lower(input_hash bytes)` read literally means the bytes *of the string
`input_hash`*, which yields a different job id than the code's base32 of the raw digest. Both are now
written so that only one reading is possible.

`analysis_results.input_hash` is the primary key: same analysis over unchanged data = no new work. Bumping `prompt_version` deliberately invalidates only affected windows. The planner shows a capacity estimate before any run > 10 jobs (invariant 6).

## Job file — fully self-contained

```json
{
  "job_id": "job_k3t9x2m8q4w7r1z5",
  "input_hash": "sha256:…",
  "lens": "l1_emotion",
  "kind": "map",
  "engine_hint": "local",
  "prompt_id": "l1-emotion",
  "prompt_version": 1,
  "instructions": "<the complete prompt from prompts/, params interpolated>",
  "chunk": {
    "thread_id": 3,
    "start_msg_id": 4400, "end_msg_id": 4462,
    "overlap_prefix_ids": [4398, 4399],
    "transcript": "[m4400] 2021-03-14 09:12 ME: …\n[m4401] 2021-03-14 09:15 THEM: …"
  },
  "output_schema": { "…JSON Schema; every claim object REQUIRES evidence_ids…" },
  "rules": [
    "Return ONLY JSON matching output_schema — no prose, no fences.",
    "Every claim MUST carry evidence_ids drawn from [mNNNN] ids present in the transcript.",
    "If you cannot analyze this content, return {\"refused\": true, \"reason\": \"…\"}."
  ]
}
```
Transcript lines are prefixed `[m<message_id>]` — this is how evidence_ids stay resolvable (invariant 1). Speakers render as `ME`/`THEM`/`THEM-2`; **real names and numbers never enter a job file** (Addendum B.1).

## Result file

```json
{
  "job_id": "job_k3t9x2m8q4w7r1z5",
  "input_hash": "sha256:…",
  "status": "done",                      // done | error | refused
  "validation": { "schema_ok": true, "retries": 0 },
  "refusal":    { "detected": false, "reason": null },
  "model_note": "claude-opus-4-8 via claude-code drain",
  "result": { "…validated payload…" }
}
```

## Engine contract (both engines identical)

1. Read pending jobs from the manifest (batch ≤ 20 per invocation).
2. Follow `instructions` exactly; produce JSON per `output_schema`.
3. **Self-validate** against the embedded schema; on mismatch retry ONCE with the validation error appended; then emit `status:"error"`.
4. **Refusal detection** (§4.2a): apology/deflection preamble, non-JSON, or `refused:true` → one re-frame retry (restate the self-reflection consent context) → else `status:"refused"`. Refusals surface in the UI as "couldn't score this window" — never a silent gap.
5. Write result atomically. **Never open, read, or write the SQLite DB** (T2.8). Never modify `jobs/`.
6. Print a drain summary: `processed / cached-skipped / errored / refused / remaining` + estimated drains left.

## Routing (§4.4)

- `engine_hint:"local"` → Ollama adapter (bulk L1 volume; the app spawns/streams it; same contract). Absent Ollama, the planner degrades: heuristic pre-filter tightens and residue routes to `claude` with an honest larger estimate.
- `engine_hint:"claude"` → `/drain-jobs` in Claude Code (nuanced residue, reduce steps, L4 adjudication).
- `kind:"render"` → prose jobs. Instructions embed the VOICE.md register + exemplar; **any strong model may drain them**; a Fable-model session is optional polish for the highest-stakes letters, never required.
- High-stakes windows (L4, letters): planner emits `sample_count: 3`; the app keeps only claims recurring across draws (sample-and-agree, §4.2).

## App-side ingest (on subprocess completion — never a watcher)

For each result file: verify `input_hash` matches a known job → Zod-validate `result` (belt over the engine's braces) → **evidence check: every `evidence_ids[]` entry resolves to a real message row in the chunk range, else the claim is dropped and logged** → upsert `analysis_results`, flip job status → apply `overrides` suppressions → move the pair to `archive/`. Crash recovery: on launch, reconcile any `results/*.json` not yet in the DB (T2.6).
