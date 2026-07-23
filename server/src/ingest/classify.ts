// Ingest-time classifiers (GAMEPLAN §2.2a). Pure, deterministic, no model:
//  - reaction/tapback detection (excluded from all downstream metrics)
//  - per-message language tag (gates English-only lexicon metrics)
//  - per-thread coverage confidence (flags likely iMessage/RCS gaps, §2.1a)
import type { ReactionKind, MsgKind, Direction } from '../types';
import { detect } from 'tinyld';

// iPhone->Android tapbacks arrive as literal SMS. The verb set is closed and the
// original message follows in quotes. Map each verb to its ReactionKind.
const VERB_TO_KIND: Record<string, ReactionKind> = {
  Liked: 'liked',
  Loved: 'loved',
  Emphasized: 'emphasized',
  'Laughed at': 'laughed',
  Disliked: 'disliked',
  Questioned: 'questioned',
  // Not a relay shape: this is what the chat.db importer writes for a sticker or emoji tapback,
  // where the type says a reaction happened and nothing says which one.
  'Reacted to': 'other',
};

// Anchored at start, CASE-SENSITIVE on the verb, then a space and a quoted
// original. Accepts straight (") or curly (“ ”) quotes; the quoted body may span
// lines and may itself contain quotes (greedy match to the final closing quote).
const REACTION_RE =
  /^(Liked|Loved|Emphasized|Laughed at|Disliked|Questioned|Reacted to) ["“][\s\S]*["”]$/;

export function classifyReaction(bodyText: string | null): {
  isReaction: boolean;
  kind: ReactionKind | null;
} {
  if (!bodyText) return { isReaction: false, kind: null };
  const m = REACTION_RE.exec(bodyText);
  if (!m) return { isReaction: false, kind: null };
  return { isReaction: true, kind: VERB_TO_KIND[m[1]] };
}

// Per-message language tag. Short/empty text is undecidable — return null rather
// than let the detector guess. tinyld returns an ISO-639-1 code, or '' when it
// cannot decide (treated as null).
export function detectLanguage(bodyText: string | null): string | null {
  if (!bodyText) return null;
  const text = bodyText.trim();
  if (text.length < 4) return null;
  try {
    const lang = detect(text);
    return lang ? lang : null;
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

// Coverage confidence heuristic (§2.1a). The archive holds SMS/MMS only; when a
// thread that had been busy suddenly goes quiet for many months, the likeliest
// explanation is that the conversation moved to iMessage/RCS (which this backup
// cannot see) — not that the relationship actually went silent. We lower
// confidence for exactly that shape and leave every other thread fully trusted.
//
// Kept deliberately simple and documented:
//  - < 10 messages, or no multi-month gap  -> 1.0 (nothing to distrust)
//  - a >= 3-month gap that follows a busy run (>= 15 msgs in the 90 days before
//    it) -> 0.6, or 0.4 if the silence runs >= 6 months.
export function threadCoverage(
  msgs: { sentAtMs: number; kind: MsgKind; direction: Direction }[],
): { confidence: number; note: string | null } {
  if (msgs.length < 10) return { confidence: 1.0, note: null };

  const sorted = [...msgs].sort((x, y) => x.sentAtMs - y.sentAtMs);

  let gapMs = 0;
  let gapStartMs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const d = sorted[i].sentAtMs - sorted[i - 1].sentAtMs;
    if (d > gapMs) {
      gapMs = d;
      gapStartMs = sorted[i - 1].sentAtMs;
    }
  }

  if (gapMs < 3 * MONTH_MS) return { confidence: 1.0, note: null };

  const windowStart = gapStartMs - 3 * MONTH_MS;
  let priorCount = 0;
  for (const m of sorted) {
    if (m.sentAtMs > windowStart && m.sentAtMs <= gapStartMs) priorCount += 1;
  }
  if (priorCount < 15) return { confidence: 1.0, note: null };

  const months = Math.round(gapMs / MONTH_MS);
  const note =
    `An active stretch here goes quiet for about ${months} months. ` +
    `iMessage and RCS aren't in this archive, so part of this may be missing.`;
  const confidence = gapMs >= 6 * MONTH_MS ? 0.4 : 0.6;
  return { confidence, note };
}
