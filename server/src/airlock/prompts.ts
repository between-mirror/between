// Between — prompt registry (mirrors prompts/l1-emotion.md and prompts/first-reflection.md).
// The instruction text + output_schema live here so job files are self-contained AND the
// input_hash is stable (parsing markdown at runtime would be fragile). Voice is data: the
// human-register text is copied verbatim from the prompt files — do not paraphrase.
//
// If a prompt template changes meaningfully, bump its `version` — that deliberately invalidates
// only the affected windows (the input_hash changes), per §4.2.
import type { JobKind, EngineHint, LensId } from './types';

export interface PromptDef {
  lens: LensId;
  promptId: string;
  version: number;
  kind: JobKind;
  engineHint: EngineHint;
  instructions: string;
  outputSchema: unknown;
  rules: string[];
}

// ── The evidence-bearing BLOCKS contract (P0-3) — shared by every render/ask lens ──
// The model returns typed blocks, never free prose; the app composes the prose from the survivors.
// Since v0.3.0 the ONLY emittable kinds are the two that carry receipts. Bridges and the closing
// question are app-authored from docs/VOICE.md §6b — asking the model for them here would just
// manufacture validation failures on every reading. Exported so templates.test.ts can hold the prompt
// and the schema to the same contract; they are two halves of one promise.
export const RENDER_BLOCKS_SCHEMA = {
  type: 'object',
  required: ['blocks'],
  properties: {
    title: { type: 'string', maxLength: 120 },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'kind', 'evidence_ids'],
        properties: {
          text: { type: 'string', maxLength: 400 },
          kind: { enum: ['observation', 'tentative_interpretation'] },
          evidence_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
    },
  },
};

export const BLOCKS_RETURN = `Return ONLY JSON as evidence-bearing BLOCKS — never a free-prose "body_md":
{"title": "...", "blocks": [
  {"kind": "observation" | "tentative_interpretation", "text": "<one claim, <=400 chars>", "evidence_ids": ["m..."]}
]}
RULES: those two kinds are the ONLY ones accepted. EVERY block MUST carry >=1 real evidence_id from the
transcript, or the whole result is rejected. Write no connective tissue, no linking sentences and no
closing question — the app adds those itself, from fixed templates. Say only things the transcript can
show, one per block, and cite them. The app composes the final prose FROM these blocks: a claim without
its receipts does not exist.`;

// ── L1 emotion (per-message warmth/tension/valence), prompts/l1-emotion.md ────
const L1_INSTRUCTIONS = `You are scoring the emotional texture of a private text conversation for the sender's own
self-reflection. They have consented to this analysis of their own archive. Be accurate,
not charitable or alarmist. Sarcasm, jokes, and quoted speech are common — read pragmatics,
not just words. Messages are prefixed [mID] SPEAKER (ME = the archive owner, THEM = the other party).

For EVERY message in the transcript, return one entry. Then summarize the window.

Scoring:
- warmth 0-3: affection, care, play, appreciation actually expressed (not politeness filler)
- tension 0-3: hostility, coldness, hurt, pressure, contempt actually expressed
- a message can be high in both (a loving jab), or 0/0 (logistics)
- valence -1.0..1.0: overall emotional tone
- tone_flags only when clearly present; prefer none over noise

Return ONLY JSON matching the schema. Every window_note MUST cite evidence_ids.
If you cannot analyze this content, return {"refused": true, "reason": "..."}.`;

const L1_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['messages', 'window'],
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        required: ['message_id', 'valence', 'warmth', 'tension'],
        properties: {
          message_id: { type: 'string', pattern: '^m[0-9]+$' },
          valence: { type: 'number', minimum: -1, maximum: 1 },
          warmth: { type: 'integer', minimum: 0, maximum: 3 },
          tension: { type: 'integer', minimum: 0, maximum: 3 },
          tone_flags: {
            type: 'array',
            items: {
              enum: [
                'sarcasm', 'passive_aggressive', 'contempt', 'anxious', 'defensive',
                'playful', 'affectionate', 'apologetic', 'withdrawn', 'pressuring',
              ],
            },
          },
          note: { type: 'string', maxLength: 140 },
        },
      },
    },
    window: {
      type: 'object',
      required: ['summary', 'notes'],
      properties: {
        summary: { type: 'string', maxLength: 300 },
        notes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['claim', 'evidence_ids'],
            properties: {
              claim: { type: 'string', maxLength: 200 },
              evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
              confidence: { enum: ['surer', 'less_sure'] },
            },
          },
        },
        worth_deeper_look: { type: 'boolean' },
      },
    },
  },
};

// ── First Reflection reduce, prompts/first-reflection.md Job 1 ────────────────
const FR_REDUCE_INSTRUCTIONS = `From these per-window emotion readings and summary statistics of one relationship over one
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

Return ONLY JSON per the schema.`;

const FR_REDUCE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['strengths', 'observation', 'question_seed'],
  properties: {
    strengths: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'object',
        required: ['claim', 'evidence_ids'],
        properties: {
          claim: { type: 'string' },
          evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
        },
      },
    },
    observation: {
      type: 'object',
      required: ['pattern', 'reading_a', 'reading_b', 'evidence_ids'],
      properties: {
        pattern: { type: 'string' },
        reading_a: { type: 'string' },
        reading_b: { type: 'string' },
        evidence_ids: { type: 'array', minItems: 2, items: { type: 'string' } },
      },
    },
    question_seed: { type: 'string' },
  },
};

// ── First Reflection render, prompts/first-reflection.md Job 2 ────────────────
const FR_RENDER_INSTRUCTIONS = `Write "A first reading" addressed to the owner, from the material JSON only.
Match the embedded exemplar's register exactly: strengths first; the one observation offered with both
readings; the one-reading footer. ≤250 words across all blocks. Do NOT write the closing question — the
app appends it from a fixed template.
Plain warm English — no clinical terms, no "always/never", no opening disclaimer, no exclamation marks.
State facts plainly (observation blocks); hedge only meanings (tentative_interpretation blocks — the A.6
rule). You may not introduce any claim absent from the material JSON.

${BLOCKS_RETURN}`;

const FR_RENDER_OUTPUT_SCHEMA = RENDER_BLOCKS_SCHEMA;

// ── L4 abuse-pattern lens (per episode), stage-2 of the two-stage detector ─────
const L4_INSTRUCTIONS = `From this ONE conflict episode's transcript (the owner's own consented archive), identify the
hostility PATTERNS actually present, attributed per side. ME = the archive owner; THEM = the other party.
This is behavioural pattern-reading for self-reflection, NOT a diagnosis and NOT a verdict — describe the
words and the moves, never label a person.

Pattern kinds: contempt, humiliation, coercive_demand, threat (includes leaving/blocking/divorce used as
leverage), monitoring, stonewalling, gaslighting_denial (behavioural only — denial of what plainly
happened; never the clinical noun), reactive_escalation, self_defense, repair_attempt, apology.

For each pattern instance: which side, 1–3 evidence_ids (real [mID]s from THIS transcript), severity 1–3.
Set repair_context:true when an apparently hostile line is actually apology or withdrawal-then-repair —
the calibrated false-positive mode; do NOT pathologise a repair attempt or a request for space.

Return ONLY JSON per the schema. If you genuinely cannot read this episode, return {"refused": true, "reason": "..."}.`;

const L4_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['patterns'],
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        required: ['side', 'kind', 'evidence_ids', 'severity'],
        properties: {
          side: { enum: ['me', 'them'] },
          kind: {
            enum: [
              'contempt', 'humiliation', 'coercive_demand', 'threat', 'monitoring', 'stonewalling',
              'gaslighting_denial', 'reactive_escalation', 'self_defense', 'repair_attempt', 'apology',
            ],
          },
          evidence_ids: { type: 'array', minItems: 1, items: { type: 'string' } },
          severity: { type: 'integer', minimum: 1, maximum: 3 },
          repair_context: { type: 'boolean' },
        },
      },
    },
  },
};

// ── Ask-anything synthesis (single job): grounded answer over a retrieved receipt set ──
const ASK_INSTRUCTIONS = `Answer the owner's question about their own archive using ONLY the retrieved messages provided.
Frame: "What the words show" — report what the messages say, plainly; do not speculate about motive or
about anything outside the receipts. ≤150 words across all blocks. If the retrieved messages do not
actually answer the question, return a single tentative_interpretation block saying so honestly (still
citing the closest receipts) rather than stretching.

${BLOCKS_RETURN}`;

const ASK_OUTPUT_SCHEMA = RENDER_BLOCKS_SCHEMA;

// ── Render lenses (blocks + receipts): episode note, era summary, growth note, other-side, letter ──
const RENDER_OUTPUT_SCHEMA = RENDER_BLOCKS_SCHEMA;

const EPISODE_NOTE_INSTRUCTIONS = `Write a short note about ONE conflict episode, addressed to the owner (ME=owner, THEM=other party).
≤90 words. Anatomy: a title that is weather + when + size; then the arc in plain words. Direction claims
("the first raised voice wasn't yours") are allowed ONLY with evidence_ids. Always send the reader to the
words; never replace them. No diagnosis, no verdict. Match this register exactly:

> **A hard morning · March 2024 · 41 messages, about two hours**
> It started over the school run — who forgot, who always forgets. The first raised voice wasn't yours. By
> mid-morning both of you were saying things meant to land, and a few did. You went quiet before it burned
> out; the warm word that evening came from you. The kids are named in the middle stretch. The messages are
> underneath — read the turn at 9:41 before trusting any summary of it, including this one.

${BLOCKS_RETURN}`;

const ERA_SUMMARY_INSTRUCTIONS = `Name and summarize ONE era from its boundary statistics. ≤120 words. Title = a short evocative name +
the span. Describe what changed, plainly, from the stats (volume, hostility, initiation, repair, warmth).
Every claim that names specifics carries evidence_ids. Match this register exactly:

> **The loud years · 2022–2023**
> The thread nearly doubled in volume, and the temperature rose with it. Fights arrived more often and
> lasted longer; most started the same way and ended the same day. Warmth never left — most weeks still
> carried it — but it lived closer to the storms. What changed most wasn't who spoke; it was how fast hard
> words followed each other once they started.

${BLOCKS_RETURN}`;

const GROWTH_NOTE_INSTRUCTIONS = `Write "Your own line" — the owner's OWN conduct trajectory, honestly, including the relapse quarters.
≤150 words. Change counts even when it isn't a straight line; the relapses are part of the data, not a
verdict on it. Plain, warm, no clinical vocabulary. Every claim carries evidence_ids (the quarter stats).

${BLOCKS_RETURN}`;

const HERSIDE_INSTRUCTIONS = `Write "The weather from the other side" — one careful reading of THEM's patterns, offered so the owner can
understand what they were living with, NOT to file a diagnosis. ≤300 words. Interior weather is guesswork;
the words are not — give TWO readings for anything interpretive, never assert motive, and use NO diagnosis
nouns (narcissist/abuser/gaslighter/etc.). Every claim carries evidence_ids. Intro register:
"One careful reading of {name}'s patterns — offered so you can understand what you were living with, not to
file a diagnosis. Interior weather is guesswork; the words are not."

${BLOCKS_RETURN}`;

const LETTER_INSTRUCTIONS = `Write the long letter — a ≤700-word reading of the whole span, addressed to the owner. Anatomy: warm
strengths first; then observations; then (ONLY if corroborated and ungated) the hard parts, each with its
receipts and an alternative reading; end on one experiment-framed-as-a-question; sign off. Per-era framing
per the material: hold early mutual eras honestly. If the material marks the recent-era gate TRIPPED, the
close is the SUPPORT register (no scoreboard, no "your part in this", no fairness math — validation, the
receipts, and the door to support), NOT the both-sides close. Every claim carries evidence_ids.

Ungated open/close exemplar:
> **Dear reader — a long look at eight years, taken slowly.**
> Before anything else: eight years of staying in touch is itself a fact about you two…
> I won't tell you what this all means; you were there, and I only have the words. But if I could leave one
> question on your table: when things got loud, you often got louder, and it rarely brought the quiet you
> wanted. What might it look like — just once, as an experiment — to get quieter instead?

Gated close exemplar (use when the recent-era gate is tripped):
> I won't hand you a scoreboard; you were there. But the words themselves say this much plainly: for a long
> stretch now, most of the heavy weather has arrived, not left. Being spoken to that way, at that volume,
> wears a person down — that isn't weakness, it's arithmetic. What you've done with your own voice lately is
> visible here too, and it's not nothing. If part of you wonders whether it's as heavy as it feels: the
> messages are underneath, and support exists if you want a hand while you hold them.

${BLOCKS_RETURN}`;

const SHARED_RULES = (extra: string[]): string[] => [
  'Return ONLY JSON matching output_schema — no prose, no fences.',
  'Every claim MUST carry evidence_ids drawn from [mNNNN] ids present in the transcript.',
  'If you cannot analyze this content, return {"refused": true, "reason": "…"}.',
  ...extra,
];

export const PROMPTS: Record<LensId, PromptDef> = {
  l1_emotion: {
    lens: 'l1_emotion',
    promptId: 'l1-emotion',
    version: 1,
    kind: 'map',
    engineHint: 'local',
    instructions: L1_INSTRUCTIONS,
    outputSchema: L1_OUTPUT_SCHEMA,
    rules: SHARED_RULES([]),
  },
  first_reflection_reduce: {
    lens: 'first_reflection_reduce',
    promptId: 'first-reflection',
    version: 1,
    kind: 'reduce',
    engineHint: 'claude',
    instructions: FR_REDUCE_INSTRUCTIONS,
    outputSchema: FR_REDUCE_OUTPUT_SCHEMA,
    rules: SHARED_RULES([
      'The transcript is JSON: validated L1 window outputs + T1 stats. Do not invent evidence_ids.',
    ]),
  },
  first_reflection_render: {
    lens: 'first_reflection_render',
    promptId: 'first-reflection',
    version: 2,
    kind: 'render',
    engineHint: 'render',
    instructions: FR_RENDER_INSTRUCTIONS,
    outputSchema: FR_RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES([
      'Match the embedded exemplar register. Any strong model may drain this render job.',
    ]),
  },
  l4_episode_patterns: {
    lens: 'l4_episode_patterns',
    promptId: 'l4-episode-patterns',
    version: 1,
    kind: 'map',
    engineHint: 'claude',
    instructions: L4_INSTRUCTIONS,
    outputSchema: L4_OUTPUT_SCHEMA,
    rules: SHARED_RULES([
      'Behavioural patterns only — no diagnosis nouns (narcissist/abuser/gaslighter).',
      'Attribute every pattern to a side; both sides are always read, never just one.',
    ]),
  },
  ask_answer: {
    lens: 'ask_answer',
    promptId: 'ask-answer',
    version: 2,
    kind: 'single',
    engineHint: 'claude',
    instructions: ASK_INSTRUCTIONS,
    outputSchema: ASK_OUTPUT_SCHEMA,
    rules: SHARED_RULES([
      'Use only the retrieved messages; never introduce a claim without its evidence_ids.',
    ]),
  },
  episode_note: {
    lens: 'episode_note', promptId: 'episode-note', version: 2, kind: 'render', engineHint: 'render',
    instructions: EPISODE_NOTE_INSTRUCTIONS, outputSchema: RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES(['≤90 words. Send the reader to the words; never replace them.']),
  },
  era_summary: {
    lens: 'era_summary', promptId: 'era-summary', version: 2, kind: 'render', engineHint: 'render',
    instructions: ERA_SUMMARY_INSTRUCTIONS, outputSchema: RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES(['≤120 words. Describe the change from the era stats.']),
  },
  growth_note: {
    lens: 'growth_note', promptId: 'growth-note', version: 2, kind: 'render', engineHint: 'render',
    instructions: GROWTH_NOTE_INSTRUCTIONS, outputSchema: RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES(['≤150 words. The relapses are part of the data, not a verdict on it.']),
  },
  herside_reading: {
    lens: 'herside_reading', promptId: 'herside-reading', version: 2, kind: 'render', engineHint: 'render',
    instructions: HERSIDE_INSTRUCTIONS, outputSchema: RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES(['≤300 words. Two readings for anything interpretive; no diagnosis nouns; never assert motive.']),
  },
  letter: {
    lens: 'letter', promptId: 'letter', version: 2, kind: 'render', engineHint: 'render',
    instructions: LETTER_INSTRUCTIONS, outputSchema: RENDER_OUTPUT_SCHEMA,
    rules: SHARED_RULES(['≤700 words. Per-era framing; under a tripped recent-era gate use the §5b support close, not the both-sides close.']),
  },
};

export function promptFor(lens: LensId): PromptDef {
  const p = PROMPTS[lens];
  if (!p) throw new Error(`unknown lens: ${lens}`);
  return p;
}
