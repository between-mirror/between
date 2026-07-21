# prompt: first-reflection (v1) — reduce + render

*Addendum A.1 — the MVP's voice. Two jobs: a `reduce` (analysis JSON, engine "claude") then a `render` (prose, kind "render"). Gates checked by the planner BEFORE job creation: ≥150 substantive messages in range, grief mode off, overrides applied. Below the floor → VOICE §6 decline copy, no jobs.*

## Job 1 — reduce (`lens:"first_reflection_reduce"`)

Input: the validated L1 window outputs (JSON, never raw transcript) + T1 stats for the range.

```
From these per-window emotion readings and summary statistics of one relationship over one
date range, assemble material for a short reflection addressed to ME (the archive owner).
You are selecting and grounding, not writing prose.

Requirements:
- strengths: exactly 1-2, specific and evidenced (recurring warmth, repair, initiative —
  something the stats/windows actually show). Each carries the evidence_ids of its
  strongest supporting window notes.
- observation: exactly ONE pattern in ME's own behavior worth gentle attention, with
  evidence_ids, plus TWO readings of it (one self-critical is allowed, one benign is required).
- question_seed: one forward-looking experiment growing out of the observation.
- Discard any candidate claim whose evidence_ids you cannot carry forward. Do not invent.

Return ONLY JSON per the schema.
```

```json
{ "type": "object",
  "required": ["strengths", "observation", "question_seed"],
  "properties": {
    "strengths": { "type": "array", "minItems": 1, "maxItems": 2, "items": {
      "type": "object", "required": ["claim", "evidence_ids"],
      "properties": { "claim": {"type":"string"}, "evidence_ids": {"type":"array","minItems":1,"items":{"type":"string"}} } } },
    "observation": { "type": "object",
      "required": ["pattern", "reading_a", "reading_b", "evidence_ids"],
      "properties": { "pattern": {"type":"string"}, "reading_a": {"type":"string"},
        "reading_b": {"type":"string"}, "evidence_ids": {"type":"array","minItems":2,"items":{"type":"string"}} } },
    "question_seed": { "type": "string" }
  } }
```

## Job 2 — render (`lens:"first_reflection_render"`, kind `render`, **v2 — the blocks contract, P0-3**)

Input: Job 1's validated JSON + `render_spec` (VOICE §7) with the **VOICE §4 exemplar embedded verbatim**.

The render no longer returns free prose. It returns typed **evidence-bearing blocks**, and the app
composes `body_md` from the ones whose evidence resolves — so no rendered sentence can exist without
its receipts in the same object.

```
Write "A first reading" addressed to the owner, from the material JSON only.
Match the embedded exemplar's register exactly: strengths first; the one observation
offered with both readings (observation vs tentative_interpretation blocks); the
one-reading footer. ≤250 words. Plain warm English — no clinical terms, no
"always/never", no opening disclaimer, no exclamation marks. State facts plainly
(observation), hedge only meanings (tentative_interpretation — the A.6 rule).
Write NO connective sentences and NO closing question; the app adds those itself.
Return ONLY JSON as blocks — these two kinds only, each with at least one receipt:
{"title": "...", "blocks": [
  {"kind": "observation"|"tentative_interpretation", "text": "<claim>", "evidence_ids": ["m..."]}
]}
```

## App-side composition (invariant 1 / P0-3 — the model never hands us prose to trust)

Each observation/tentative_interpretation block keeps only the `evidence_ids` that resolve to a real
message row; a block left with none is **dropped**. Those are the only kinds the model may emit — a
payload containing a bridge or a question is rejected whole. The app then composes `body_md` from the
survivors and adds the connective tissue itself: up to two bridges between surviving observations and
exactly one closing question, drawn from the authored template sets in
[docs/VOICE.md](../docs/VOICE.md) §6b and selected deterministically from a hash of the surviving text
(no RNG). Connective prose asserts nothing, so it cannot carry a receipt — which is precisely why the
model is not allowed to write it. Result is inserted into `reflections` at **prompt_version 2** — frozen, dated,
immutable. Legacy prose reflections stay at version 1, untouched.
