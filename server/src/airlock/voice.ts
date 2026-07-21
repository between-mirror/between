// Between — VOICE.md as data (HANDOFF invariant 7). Every string here is copied VERBATIM from
// docs/VOICE.md §4/§6 and enforced by T-VOICE. Do not paraphrase, reflow, or "improve" — if
// something is missing, flag it; the voice author fills gaps, nobody else.
//
// Non-ASCII glyphs are intentional and load-bearing: em dash U+2014 (—), en dash U+2013 (–),
// middot U+00B7 (·). They are written as literals so a snapshot diff catches any drift.

/** VOICE §4 — First Reflection exemplar (the render template's register anchor), verbatim. */
export const FIRST_REFLECTION_EXEMPLAR = `**A first reading · {name} · March–May 2021 · generated July 9, 2026**

The first thing worth saying: you show up. Across these three months, when a day went quiet, it was usually you who broke the silence — small openers, a photo, a *thinking of you*. That's not nothing. Reaching first, over and over, is a kind of steadiness.

One thing I noticed, offered gently: in the harder weeks of April, your messages came faster and longer — four, five in a row before a reply. The replies that followed tended to arrive slower, not quicker. One reading is that the pace itself was saying *don't go anywhere*, and it may have been landing as pressure. Another is that April was simply a loud month, on both ends. The messages are underneath this note; you were there, and you'll know which it was.

A question to sit with, next time the quiet starts: what would it be like to say the feeling once — *I miss you, today is hard* — and then let the silence do some of the talking?

*One reading, from the words alone. Texts carry less than half of any conversation.*`;

/** The epistemic footer line (VOICE §4 exemplar close). Rendered prose ends on this + a date. */
export const FIRST_REFLECTION_FOOTER =
  'One reading, from the words alone. Texts carry less than half of any conversation.';

/** VOICE §6 — below the evidence floor. */
export const DECLINE_BELOW_FLOOR =
  "There isn't enough here yet for an honest reading. A longer range would say more.";

/** VOICE §6 (P3) — the prose lens can't run because no writing engine is connected. NOT a lack of
 *  evidence: the counting views all work; the owner just hasn't connected a key/subscription/local model. */
export const DECLINE_NO_ENGINE =
  'This reading needs a writing engine. The counting views work without one — connect a key or subscription when you want the prose.';

/** VOICE §6 — refused window. */
export const REFUSED_WINDOW =
  "Couldn't score this stretch. The messages are still here to read yourself.";

/** VOICE §6 — grief mode banner (grief-marked contact → reflection suppressed). */
export function griefBanner(name: string): string {
  return `Remembering ${name}. This space is for the warmth — nothing here gets scored.`;
}

/** VOICE §6 — the pre-run capacity estimate microcopy. */
export function estimateCopy(
  windowCount: number,
  drainCount: number,
  timeEstimate: string,
): string {
  return `This will read ${windowCount} stretches of conversation — about ${drainCount} sittings, roughly ${timeEstimate}. Nothing is ever read twice.`;
}

/** VOICE §6 — drain complete summary. */
export function drainCompleteCopy(newCount: number, cachedCount: number): string {
  return `Done. ${newCount} new readings, ${cachedCount} remembered from before.`;
}
