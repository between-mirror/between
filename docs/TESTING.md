# TESTING — Rigorous validation plan

*What "green" means, phase by phase. Tests are the enforcement arm of the invariants: if an invariant matters, a test fails when it breaks.*

## 0. Principles

- **No real data, anywhere, ever.** No fixture, snapshot, test name, or assertion may contain real numbers, names, or message text. All fixtures come from the synthetic generator (§1). The privacy linter (T-CLEAN) enforces this mechanically.
- **Deterministic fixtures, known ground truth.** Every fixture archive is generated from a seed + manifest, so expected counts/metrics are *computed by construction*, not hand-maintained.
- **Tests must run for the next user** (Addendum B.3): `npm test` on a fresh clone, no local secrets, no network, no model. LLM-dependent paths are tested with **recorded/simulated result files**, never live drains.
- **Two kinds of validation:** automated (below) and **human** (§7 — the hold-out protocol). Neither substitutes for the other.

## 1. The synthetic fixture generator (`test/fixtures/gen.ts`)

Produces valid SMS Backup & Restore XML from a manifest: contacts (with deliberately inconsistent address formats: bare 10-digit, `+1` E.164, spaced/dashed), date ranges, per-thread cadence profiles, and planted features. Must be able to plant, on demand:

- exact duplicate messages across two overlapping archive files (dedup ground truth)
- MMS: 1:1 (no `<addrs>`) and group (full `<addrs>` with 137/151/130 roles), multi-part text, SMIL parts, and **oversized base64 parts (≥ 5 MB single attribute)**
- tapback reactions (`Liked "…"` etc.) in all six verbs
- non-English and code-switching message runs
- a "coverage hole": an active thread that goes SMS-silent while others continue (iMessage-shaped gap)
- emoji/entity torture: surrogate pairs, `&#128514;`, nested escaped XML in bodies, literal `"null"` attribute values
- planted sentiment/hostility windows and planted change-points (for T1/T3 ground truth)
- draft/outbox/failed types (3/4/5), `date_sent=0`, missing `contact_name`, same person under two numbers

## 2. Phase 0 matrix — ingest & store

| ID | Test |
|---|---|
| T0.1 | **Streaming safety:** 500 MB synthetic archive parses with peak RSS < 600 MB; a 5 MB base64 attribute does not buffer the element tree |
| T0.2 | **Field semantics:** `"null"`→NULL coercion on every field; type 1/2/3/4/5 → direction; `msg_box`/`m_type` cross-check for MMS; epoch-ms preserved as int64; `readable_date` never parsed |
| T0.3 | **MMS reconstruction:** text = ordered concat of `text/plain` parts (SMIL skipped); group sender = the single `137`; 1:1 fallback to envelope address; `~`-joined group addresses split |
| T0.4 | **Normalization:** a bare 10-digit number and its `+1` E.164 form resolve to one identifier; NFC unicode; entities decoded by the parser (property test: generator text == stored text for 10k random strings) |
| T0.5 | **Dedup idempotency (property):** import archive A, then A again, then overlapping A′ ⇒ byte-identical `messages` table each time; declared `count` mismatch warns, not fails |
| T0.6 | **Classifiers:** all six reaction verbs flagged `is_reaction` (and excluded from counts); language detector tags planted non-English runs; coverage hole yields low `coverage_confidence` on that thread only |
| T0.7 | **Identity:** two numbers merge on user confirm; **un-merge + re-propagation** restores prior state exactly; owner detection flags the empirically-correct number on synthetic data |
| T0.8 | **Media discipline:** after ingest of an attachment-heavy archive, zero decoded media on disk; `attachments` rows carry mime/size/sha256 with `blob_ref` NULL |
| T0.9 | **Re-import skip:** same file (same sha256) short-circuits before parsing |
| T0.10 | **FTS:** planted needle strings found; search < 200 ms on 200k synthetic messages |

**Real-archive smoke (owner present):** ingest your own export; the totals reconcile with the counts your backup app reports for the same file; the largest thread spans its full range; spot-open 5 random days and confirm the transcript renders correctly; the whole ingest finishes inside 5 minutes.

## 3. Phase 1 matrix — metrics & the river

| ID | Test |
|---|---|
| T1.1 | Each ⭐ metric equals the generator's computed ground truth (counts, sent/received ratio, sessionization at the gap threshold, streaks, silences) |
| T1.2 | **Reply latency:** cross-party turns only; consecutive same-sender messages never produce a latency sample; reactions excluded |
| T1.3 | Heatmap cell sums == total message count; timezone handling stable across DST boundaries |
| T1.4 | **Lexicon gating:** VADER/NRC suppressed (with caveat) on threads whose non-English share exceeds threshold |
| T1.5 | **Coverage gating:** ghosting/silence/effort-asymmetry claims suppressed on the low-coverage fixture thread; caveat marker present on affected charts |
| T1.6 | Rolling sentiment + planted negativity spikes detected at the planted indices (tolerance ±1 day) |
| T1.7 | Moments shelf: "first message / biggest day / longest streak" match construction; longest-quiet suppressed under low coverage |
| T1.8 | **A11y:** keyboard path through river → evidence panel; visible focus; `prefers-reduced-motion` kills animation; contrast ≥ 4.5:1 both themes (automated axe pass) |
| T1.9 | **Perf:** river first paint < 2 s for 8.5-year range; pan/zoom ≥ 45 fps on 200k synthetic messages (viewport-driven loading verified by request log) |

## 4. Phase 2 matrix — the airlock & first lens

| ID | Test |
|---|---|
| T2.1 | **Hash determinism:** `input_hash` identical across runs/platforms for identical (prompt_id, version, params, chunk, schema); any single byte change → new hash |
| T2.2 | **Cache no-op:** planning the same analysis twice creates zero new jobs; editing one synthetic message invalidates exactly the windows containing it + one overlapping neighbor |
| T2.3 | **Windowing:** windows align to message boundaries; overlap = last 2–3 turns; ~6–8k token budget respected; reduce dedups overlap |
| T2.4 | **Validation loop:** malformed result JSON → one self-correct retry → `error` state with reason; valid-but-schema-violating (wrong enum, missing evidence_ids) rejected by Zod |
| T2.5 | **Refusal path:** planted refusal-shaped results (apology preamble, empty deflection) → `refused` state → UI renders "couldn't score this window" — never an empty gap |
| T2.6 | **Crash resume:** kill the app mid-drain (after k of n results written); relaunch reconciles from `results/` with zero lost or duplicated work |
| T2.7 | **⛔ BUILD-BLOCKING — evidence contract end-to-end:** synthetic windows → map (simulated results) → hierarchical reduce → render: every rendered claim's `evidence_ids` resolve to real message rows; a claim stripped of IDs mid-reduce is **dropped, not rendered**; post-validation catches a planted ID-less sentence |
| T2.8 | **⛔ BUILD-BLOCKING — sole writer:** instrumented drain run shows zero DB writes from the drain process; results ingested only by the app on awaited completion |
| T2.9 | **Capacity honesty:** planner's "N windows ≈ X drains ≈ ~Y" estimate shown before any run > 10 jobs; drain summary prints processed/cached/errored/skipped/refused |
| T2.10 | **First Reflection gates:** below the evidence floor → the VOICE decline copy, no reflection; grief-marked contact → reflection suppressed; output is frozen (re-request creates a new dated row, never mutates) |
| T2.11 | **Ollama adapter:** same job/result contract; local-engine results interchangeable with claude-engine results at the schema level; graceful degradation path when Ollama absent |

**Real smoke:** drain one real week of the primary thread end-to-end (plan → estimate → drain → river updates → open receipts → First Reflection renders in the VOICE register).

## 5. Phase 3 matrix — temporal, episodes, hard moments

| ID | Test |
|---|---|
| T3.1 | Change-point detection finds planted regime shifts (±3 days) and does **not** fire on planted stationary noise (false-positive budget: 0 on the null fixture) |
| T3.2 | Episode segmentation matches planted conflict arcs; arc stages ordered; unresolved-thread fixture flagged |
| T3.3 | **Adversarial abuse fixtures:** quoting someone's insult, joke profanity between friends, venting *about* a third party, song lyrics — none may reach a confirmed flag; planted genuine patterns (repetition across windows) must |
| T3.4 | **Directionality:** planted one-sided hostility yields correct direction; **power-balance gate trips** ⇒ downstream synthesis prompt assembly verifiably drops the both-sides mandate (assert on the assembled prompt, not just UI) |
| T3.5 | **Crisis tripwire:** deterministic keyword set fires with the model stubbed out entirely; resources card renders from the region config; never fires on the benign fixture set |
| T3.6 | Ask-anything: answers cite retrieved message IDs; the three hard-declines (predict/diagnose/stay-leave) return the VOICE redirect copy on planted probe questions |
| T3.7 | Zoom continuity: river → episode → session → transcript descent preserves selection state; breadcrumb ascent restores exact prior viewport |

## 6. Phase 4 matrix — letter & keepsake

| ID | Test |
|---|---|
| T4.1 | Letter assembly: strengths-first ordering; sample-and-agree keeps only claims recurring across draws (planted unstable claim is dropped); power-balance-tripped fixture produces the support frame |
| T4.2 | Frozen versioning: regeneration is a new dated artifact; prior letters immutable and listed |
| T4.3 | Render post-validation: planted sentence without resolvable evidence is removed before display |
| T4.4 | Keepsake export: redaction list honored (names/numbers replaced); interpretive-frame header present; export encrypted by default |

## 7. Human validation — the hold-out protocol (schedule during Phase 2)

1. App samples ~100–200 windows across eras/tones (stratified by prefilter score) from the user's real archive.
2. The user labels each in a purpose-built 20-minute-session UI: hostile? direction? severity? sarcasm/joke? (labels stay local, never in the repo).
3. L4/L1 outputs are scored against labels → set the corroboration threshold at the user's chosen precision/recall balance → **calibrate the confidence language** ("felt fairly sure" must empirically mean something).
4. Re-run after any prompt-version bump that touches L4. No hard-moment timeline ships to the UI until this protocol has run once.

## 8. Continuous checks (from the first commit)

- **T-CLEAN (privacy linter, pre-commit + CI):** scans staged text for 10-digit/E.164 patterns, the archive filename pattern, and a local (git-ignored) `personal-patterns.txt`; any hit blocks the commit. The `.gitignore` denials (xml/db/media/jobs/results) are asserted by a repo test.
- **T-VOICE:** rendered-copy snapshot tests — human-facing strings match VOICE.md exactly; a diff means someone paraphrased the voice (invariant 7).
- **T-SCHEMA:** Zod schemas ↔ schema.sql drift check.
- Typecheck + lint + `npm test` green before any phase-gate demo.
