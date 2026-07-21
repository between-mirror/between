// Between — S3 ask-anything, v1 retriever. Deterministic: FTS (messages_fts) + structured filters
// (range, direction, tension/warmth bounds, kid flag) → an ordered RECEIPT set. The app executes the
// retrieval; only the optional synthesis (ask_answer) is a model job, and it may cite nothing outside
// this set. "Show me every time …" is receipts first; the words carry the answer.
import type { BetweenDB } from '../store/db';
import { emotionByMessage } from './l1';
import { kidNameMatcher } from './episodes';

export interface AskFilters {
  fromMs?: number | null;
  toMs?: number | null;
  direction?: 'me' | 'them';
  minTension?: number;
  maxTension?: number;
  minWarmth?: number;
  kidOnly?: boolean;
  limit?: number;
}

// An unscored message has NULL tension/warmth — it is NOT neutral (0). The DTO and UI render it as an
// em-dash, never a zero (P2-14). "Unscored" and "scored calm" are different facts and must read differently.
export interface AskReceipt { id: number; ms: number; dir: 'me' | 'them'; tension: number | null; warmth: number | null; text: string }

/** The retrieval cap. We query one past it (RETRIEVAL_CAP + 1) so we can tell "exactly the cap" from
 *  "more than we're showing" and report the count honestly as "{cap}+" (P1-13). */
export const RETRIEVAL_CAP = 500;
/** VOICE-register copy shown when the match set is truncated at the cap. */
export const ASK_TRUNCATED_COPY = `At least ${RETRIEVAL_CAP} — narrow the range or the words.`;

export interface AskPlan {
  query: string;
  filters: AskFilters;
  count: number;         // matches, capped at RETRIEVAL_CAP
  countLabel: string;    // "N" or "500+" when truncated — the honest display count
  truncated: boolean;    // more than RETRIEVAL_CAP matched; the count is a floor, not a total
  receipts: AskReceipt[];
  sufficient: boolean;   // false → the UI shows the VOICE insufficient-evidence line, not a stretch
}

interface Row { id: number; ms: number; dir: string; body: string }

export function planAsk(db: BetweenDB, threadId: number, query: string, filters: AskFilters = {}): AskPlan {
  const scores = emotionByMessage(db, threadId);
  const kidRe = kidNameMatcher(db);
  const limit = filters.limit ?? 50;
  const q = (query ?? '').trim();

  const empty = (): AskPlan => ({ query: q, filters, count: 0, countLabel: '0', truncated: false, receipts: [], sufficient: false });

  let rows: Row[];
  // A tension/warmth filter can only be evaluated on a scored message; an unscored one is unknown, not
  // passing — so such filters exclude unscored messages (never treat unknown as if it were 0).
  const hasScoreFilter = filters.minTension != null || filters.maxTension != null || filters.minWarmth != null;
  if (q) {
    const hits = db.searchMessages(q, { threadId, limit: RETRIEVAL_CAP + 1 });
    if (!hits.length) return empty();
    const ids = hits.map((h) => h.messageId);
    const ph = ids.map(() => '?').join(',');
    rows = db.raw
      .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages WHERE id IN (${ph}) AND is_reaction = 0`)
      .all(...ids) as Row[];
  } else {
    const clauses = ['thread_id = @t', 'is_reaction = 0', "trim(coalesce(body_text,'')) != ''"];
    if (filters.fromMs != null) clauses.push('sent_at_ms >= @from');
    if (filters.toMs != null) clauses.push('sent_at_ms <= @to');
    rows = db.raw
      .prepare(`SELECT id, sent_at_ms AS ms, direction AS dir, body_text AS body FROM messages WHERE ${clauses.join(' AND ')} ORDER BY sent_at_ms ASC LIMIT @cap`)
      .all({ t: threadId, from: filters.fromMs ?? null, to: filters.toMs ?? null, cap: RETRIEVAL_CAP + 1 }) as Row[];
  }

  const receipts: AskReceipt[] = [];
  for (const r of rows) {
    const me = r.dir === 'outgoing' || r.dir === 'draft';
    if (filters.direction === 'me' && !me) continue;
    if (filters.direction === 'them' && me) continue;
    if (filters.fromMs != null && r.ms < filters.fromMs) continue;
    if (filters.toMs != null && r.ms > filters.toMs) continue;
    const s = scores.get(r.id);
    const tension = s ? s.tension : null;
    const warmth = s ? s.warmth : null;
    if (hasScoreFilter && s == null) continue; // unscored ≠ passes a tension/warmth threshold
    if (filters.minTension != null && (tension == null || tension < filters.minTension)) continue;
    if (filters.maxTension != null && (tension == null || tension > filters.maxTension)) continue;
    if (filters.minWarmth != null && (warmth == null || warmth < filters.minWarmth)) continue;
    if (filters.kidOnly && !(kidRe && kidRe.test(r.body ?? ''))) continue;
    receipts.push({ id: r.id, ms: r.ms, dir: me ? 'me' : 'them', tension, warmth, text: r.body });
  }
  receipts.sort((a, b) => a.ms - b.ms);

  const truncated = receipts.length > RETRIEVAL_CAP;
  const capped = truncated ? receipts.slice(0, RETRIEVAL_CAP) : receipts;
  return {
    query: q,
    filters,
    count: capped.length,
    countLabel: truncated ? `${RETRIEVAL_CAP}+` : String(capped.length),
    truncated,
    receipts: capped.slice(0, limit),
    sufficient: capped.length > 0,
  };
}
