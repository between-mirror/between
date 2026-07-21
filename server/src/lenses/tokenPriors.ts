// Between — self-improving cost estimates. estimateBatch() (airlock/batch.ts) guesses tokens from
// chars/4; those guesses drift. Here we record the tokens the Batch API ACTUALLY billed, per
// lens×model, as an exponential moving average so future estimates can lean on measured reality
// instead of a heuristic. Priors live in app_meta ('token_priors', JSON: { '<lens>|<model>': prior });
// the app is the sole writer (HANDOFF invariant 2), so we read-modify-write through db.setMeta.
import type { BetweenDB } from '../store/db';

/** EMA of input/output tokens per call for one lens×model, plus how many samples fed it. */
export interface TokenPrior { inTokens: number; outTokens: number; n: number }

// How much each new sample moves the average. 0.3 ≈ "trust the last ~3 calls most" — quick to adapt
// to a prompt change, slow enough that one dense window doesn't whiplash the estimate.
const ALPHA = 0.3;

const key = (lens: string, model: string): string => `${lens}|${model}`;

type PriorMap = Record<string, TokenPrior>;

/** Parse app_meta 'token_priors'; unparseable/absent → empty map (fall back to the heuristic). */
function readAll(db: BetweenDB): PriorMap {
  const raw = db.getMeta('token_priors');
  if (!raw) return {};
  try { return JSON.parse(raw) as PriorMap; } catch { return {}; }
}

/** Fold one measured call into the EMA for its lens×model and persist. First sample seeds the mean;
 *  later samples move it by ALPHA toward the new value. Called per succeeded Batch result. */
export function recordUsage(db: BetweenDB, lens: string, model: string, inTokens: number, outTokens: number): void {
  const all = readAll(db);
  const k = key(lens, model);
  const prev = all[k];
  all[k] = prev
    ? {
        inTokens: prev.inTokens + ALPHA * (inTokens - prev.inTokens),
        outTokens: prev.outTokens + ALPHA * (outTokens - prev.outTokens),
        n: prev.n + 1,
      }
    : { inTokens, outTokens, n: 1 };
  db.setMeta('token_priors', JSON.stringify(all));
}

/** The recorded prior for a lens×model, or null if nothing has been measured yet. */
export function getPrior(db: BetweenDB, lens: string, model: string): TokenPrior | null {
  return readAll(db)[key(lens, model)] ?? null;
}
