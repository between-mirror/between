// Between — the single source of dated model rates, so cost estimates are never magic constants.
//
// batch.ts currently inlines HAIKU_PRICE={in:1.0,out:5.0}; this module replaces that role for every
// caller that needs to put a dollar figure on a token count (batch go/no-go, reflection tier, etc.).
// Rates are Anthropic list prices per 1M tokens as of PRICES_AS_OF; the Batch API is 50% off. Prices
// drift, so the date is exported and staleness is checkable — an estimate quoted from months-old rates
// should announce itself rather than quietly mislead.

/** The date these list rates were last confirmed (ISO). Bump it whenever a rate below changes. */
export const PRICES_AS_OF = '2026-07-12';

/** Anthropic list price in USD per 1M tokens. */
export interface ModelRate {
  input: number;
  output: number;
}

// Keyed by the full model id; short aliases resolve to these below. Haiku is the L1 grunt tier;
// Opus/Fable are the reduce/render tiers. Prices per 1M tokens (docs/DEPLOY.md, claude-api skill).
const RATES: Record<string, ModelRate> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
};

// Short id → full id, so callers may pass either 'haiku' or 'claude-haiku-4-5'.
const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

const BATCH_DISCOUNT = 0.5; // Anthropic Batch API is half list price.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Rate for a model, accepting short or full ids. Unknown ids fall back to Haiku (the cheap grunt
 *  tier) so an estimate is never blocked — but the caller gets the conservative floor, not a guess high. */
export function rateFor(model: string): ModelRate {
  const id = ALIASES[model] ?? model;
  return RATES[id] ?? RATES['claude-haiku-4-5'];
}

/** Dollar estimate for a token count, rounded to whole cents. `opts.batch` applies the 50% Batch discount. */
export function estimateUsd(
  model: string,
  inTokens: number,
  outTokens: number,
  opts: { batch?: boolean } = {},
): number {
  const rate = rateFor(model);
  const raw = (inTokens / 1e6) * rate.input + (outTokens / 1e6) * rate.output;
  const usd = raw * (opts.batch ? BATCH_DISCOUNT : 1);
  return Math.round(usd * 100) / 100;
}

/** Whole days since PRICES_AS_OF (never negative). Server code MAY use the real clock. */
export function pricingStaleDays(nowMs: number = Date.now()): number {
  const asOf = Date.parse(PRICES_AS_OF);
  return Math.max(0, Math.floor((nowMs - asOf) / (24 * 60 * 60 * 1000)));
}

/** True once the list rates are more than 90 days old — a prompt to re-confirm them. */
export function pricingIsStale(nowMs: number = Date.now()): boolean {
  return nowMs - Date.parse(PRICES_AS_OF) > NINETY_DAYS_MS;
}
