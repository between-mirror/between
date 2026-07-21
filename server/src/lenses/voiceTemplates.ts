// Between Mirror — the connective-tissue templates. VOICE DATA, mirrored into code.
//
// Receipts absolutism: the model may only author evidence-bearing blocks (see airlock/schemas.ts).
// The sentences that assert nothing — bridges between observations, and the question that closes a
// reading (VOICE §2 rule 4) — are composed by the app from the fixed sets below.
//
// These strings are authored in docs/VOICE.md §6b and MUST match it verbatim; templates.test.ts fails
// if they drift. VOICE is data, not code: edit the document, then mirror it here — never the reverse,
// and never paraphrase.
//
// The constraint that makes this safe: a template is incapable of carrying a fact. No numbers, no
// dates, no names, no placeholders. It has to read as true of any reading, including a hard one.

/** ≤2 per reading, placed between surviving observations. VOICE.md §6b. */
export const BRIDGES: readonly string[] = [
  'There is more, and it sits alongside that rather than after it.',
  'The next part is quieter, and worth the same attention.',
  "That isn't the whole of it.",
  'Something else runs through the same stretch.',
  'Worth slowing down here.',
  'Held next to that, one more thing.',
];

/** Exactly one per non-empty reading, last. VOICE.md §6b. */
export const CLOSING_QUESTIONS: readonly string[] = [
  'A question to sit with, rather than answer today: which part of this would you want the other person to have read too?',
  'If you keep one thing from this, what would you want it to be — and what would you rather leave here?',
  "Reading this back — what surprised you least?",
  'What would you want to be true of this a year from now, and what would have to be different for it?',
  'Nothing here needs deciding. Still — what would you want to look at more closely?',
];

/** FNV-1a over the reading's own text. Small, stable, and dependency-free — the only property that
 *  matters is that it is a pure function of the content, so the same reading always reads the same. */
function contentHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic template choice — no RNG, ever. A reading regenerated from the same evidence composes
 * the same prose, which is what makes a frozen reading reproducible rather than merely repeatable.
 *
 * `slot` separates the two bridge positions in one reading. The stride is 7 and the bridge set has 6
 * entries — coprime, so consecutive slots can never land on the same line.
 */
export function pickTemplate(set: readonly string[], content: string, slot = 0): string {
  return set[(contentHash(content) + slot * 7) % set.length];
}
