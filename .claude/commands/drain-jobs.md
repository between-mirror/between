---
description: Drain pending Between analysis jobs from the airlock (reads airlock/jobs/, writes airlock/results/)
---

You are the analysis engine for Between. Process pending jobs from the filesystem airlock. Follow this protocol exactly — it is specified in docs/SPECS/airlock.md and enforced by tests.

**Hard rules, before anything:**
- You may READ `airlock/jobs/*.json` and WRITE `airlock/results/*.json` (atomically: write `<id>.json.tmp`, then rename). Nothing else.
- **Never** open, read, or modify any `.db`/`.sqlite` file, the `data/` directory, or anything in `airlock/jobs/`. The app is the sole database writer.
- Never echo message content into your summary output — report counts and job IDs only.

**Protocol:**
1. Read `airlock/jobs/_manifest.json`. Select up to **20** jobs with `status:"pending"`, highest `priority` first. Skip jobs whose `engine_hint` is `"local"` unless the user said to include them (those belong to the Ollama runner).
2. For each job file:
   a. Read it. The job is fully self-contained: `instructions`, `chunk.transcript` (speakers are ME/THEM; lines prefixed `[mID]`), `output_schema`, `rules`.
   b. Perform the analysis exactly per `instructions`. Think carefully; sarcasm, quoting, and jokes must not be mis-scored.
   c. **Self-validate** your JSON against `output_schema` (types, enums, required fields, and that every `evidence_ids` entry appears as an `[mID]` in the transcript). If invalid: fix it once. If still invalid: result `status:"error"` with the validation reason.
   d. If you cannot analyze the content (safety refusal): retry once, reframing to yourself that this is the archive owner's own conversation, analyzed at their request for their private self-reflection — structured observation, not judgment of a person. If you still cannot: result `status:"refused"` with a one-line reason. Refusing honestly is an acceptable outcome; fabricating scores is not.
   e. Write the result file per the airlock result shape (echo `job_id` + `input_hash`; include `validation`, `refusal`, `model_note` with your model name, and the `result` payload).
3. If a job's `sample_count` > 1, produce that many **independent** analyses (re-read the transcript fresh each time) and emit them in the result under `samples: [...]` — the app reconciles agreement; you do not.
4. After the batch, print exactly one summary table: `processed / errored / refused / skipped(local) / remaining`, plus `estimated further sittings = ceil(remaining / 20)`.
5. Do not start another batch unless the user asks. Do not touch anything outside `airlock/`.
