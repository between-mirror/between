// Between — pure formatting helpers. No side effects; safe to unit-test later.
import type { ReactionKind } from './api';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Initials for a monogram: first letters of up to two words, else first two chars. */
export function monogramInitials(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return '·';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const w = words[0];
  // strip a leading + for phone-number-shaped names before taking chars
  const bare = w.replace(/^\+/, '');
  return bare.slice(0, 2).toUpperCase() || '·';
}

/** Stable small hash → used only to pick a token tint, never a raw color. */
export function hashString(s: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV-1a 32-bit prime
  }
  return h >>> 0;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** Whole years spanned by an archive/thread, floored at 1 when any span exists. */
export function spanYears(firstMs: number | null, lastMs: number | null): number {
  if (firstMs == null || lastMs == null || lastMs <= firstMs) return 0;
  return Math.max(1, Math.round((lastMs - firstMs) / MS_PER_YEAR));
}

const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const yearOnly = new Intl.DateTimeFormat(undefined, { year: 'numeric' });
const dayFull = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
});
const timeShort = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric',
});

/** A calm date span for a conversation card: "Mar 2019 – May 2021" / "2020". */
export function formatSpan(firstMs: number | null, lastMs: number | null): string {
  if (firstMs == null && lastMs == null) return '';
  if (firstMs == null) return monthYear.format(new Date(lastMs as number));
  if (lastMs == null) return monthYear.format(new Date(firstMs));
  const a = new Date(firstMs);
  const b = new Date(lastMs);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return monthYear.format(a);
  }
  if (a.getFullYear() === b.getFullYear()) {
    return `${monthYear.format(a)} – ${monthYear.format(b)}`;
  }
  return `${yearOnly.format(a)} – ${yearOnly.format(b)}`;
}

/** Divider label above a day's first message. */
export function formatDayDivider(ms: number): string {
  return dayFull.format(new Date(ms));
}

/** Local day key so divider boundaries fall on the viewer's midnight. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatTime(ms: number): string {
  return timeShort.format(new Date(ms));
}

export function formatFullDate(ms: number): string {
  return monthDayYear.format(new Date(ms));
}

const REACTION_LABEL: Record<ReactionKind, string> = {
  liked: 'Liked',
  loved: 'Loved',
  emphasized: 'Emphasized',
  laughed: 'Laughed at',
  disliked: 'Disliked',
  questioned: 'Questioned',
};

const REACTION_GLYPH: Record<ReactionKind, string> = {
  liked: '\u{1F44D}',      // 👍
  loved: '♥',          // ♥
  emphasized: '‼',     // ‼
  laughed: '\u{1F642}',    // 🙂
  disliked: '\u{1F44E}',   // 👎
  questioned: '?',
};

export function reactionLabel(kind: ReactionKind | null): string {
  return kind ? REACTION_LABEL[kind] : 'Reacted to';
}

export function reactionGlyph(kind: ReactionKind | null): string {
  return kind ? REACTION_GLYPH[kind] : '•';
}

/** "photo" / "3 photos or media" — attachments are placeholders, never content. */
export function attachmentLabel(count: number): string {
  if (count <= 1) return 'Photo or media';
  return `${count} photos or media`;
}
