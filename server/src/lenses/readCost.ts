// Between — the cost side of the estimate-first gate (P3, the "$30→$44 lesson"). The capacity estimate
// (windows/sittings/time) already existed; this adds the DOLLARS and the honest mode-awareness, so the
// owner sees a price and the engine before any paid work — never a surprise bill. The range is p50-ish
// ±30%, never false precision, and prefers the owner's own MEASURED token priors over the heuristic.
import type { BetweenDB } from '../store/db';
import { estimateUsd } from '../pricing';
import { getPrior } from './tokenPriors';
import { getEngineMode, paidBatchAllowed, type EngineMode } from './engineMode';

export interface ReadCost {
  engineMode: EngineMode;
  model: string;
  /** true only when this run would actually bill an API key (api-key mode + real work). */
  spends: boolean;
  usdLow: number | null;   // null when not applicable (nothing to run, or local/subscription)
  usdHigh: number | null;
  measured: boolean;       // true when the estimate used the owner's recorded token priors
  note: string;            // one honest line for the mode
}

// L1 grunt per-window token prior (fallback when nothing measured yet). These MUST track the biller —
// the same L1 jobs are priced by airlock/batch.ts estimateBatch (output ≈ msgs*50 + windows*400, so
// ~2.9k out/window at ~50 msgs; input ≈ the ~7k-token window budget). An earlier, far-too-low prior
// (520 out) understated the real Batch bill ~5x — the exact "$30→$44 surprise" this file exists to
// prevent — so keep this aligned to batch.ts. Slightly generous is correct; consent should never undershoot.
const L1_FALLBACK = { inTokens: 7000, outTokens: 2900, model: 'claude-haiku-4-5' };

/** A dollar + engine-mode read on a planned run. `toRun` = un-cached windows for the L1 grunt; it is
 *  IGNORED for the prose reading, which is a fixed couple of calls. Pure read of app_meta. */
export function estimateReadCost(db: BetweenDB, lens: string, toRun: number): ReadCost {
  const mode = getEngineMode(db);

  // The written reading (reduce + render) is TWO short prose calls that run on the subscription / local
  // engine — NOT the paid Batch key — regardless of how many L1 windows still need reading. So it never
  // "spends" the API key, and its cost is the two-call figure, not the L1 backlog. (Pricing the reflection
  // off the L1 window count was wrong in both directions: hundreds of dollars, or a false $0 once L1 was read.)
  if (lens === 'first_reflection') {
    const model = 'claude-opus-4-8';
    const twoCalls = estimateUsd(model, 7000 * 2, 450 * 2, { batch: false }); // reduce + render
    return {
      engineMode: mode, model, spends: false, usdLow: 0, usdHigh: twoCalls, measured: false,
      note: mode === 'local-only'
        ? 'The written reading needs a writing engine — connect a subscription or key, or it declines. Nothing is billed.'
        : 'The written reading is a couple of short calls on your Claude subscription (or local model) — no per-run API-key charge.',
    };
  }

  const model = L1_FALLBACK.model;
  if (toRun <= 0) {
    return { engineMode: mode, model, spends: false, usdLow: 0, usdHigh: 0, measured: false, note: 'Everything here is already read — no new work, no cost.' };
  }

  const prior = getPrior(db, lens, model);
  const inPer = prior?.inTokens ?? L1_FALLBACK.inTokens;
  const outPer = prior?.outTokens ?? L1_FALLBACK.outTokens;
  const mid = estimateUsd(model, inPer * toRun, outPer * toRun, { batch: true });
  const usdLow = Math.round(mid * 0.7 * 100) / 100;
  const usdHigh = Math.round(mid * 1.3 * 100) / 100;

  // The dollars are real only in api-key mode; local-only spends nothing, subscription runs interactively.
  const spends = paidBatchAllowed(mode) && usdHigh > 0;
  const note =
    mode === 'api-key'
      ? `Billed to your Anthropic API key (${model}, Batch API 50% off).`
      : mode === 'subscription'
        ? 'Runs on your Claude subscription — no per-run charge, but it uses real capacity and time.'
        : 'Local-only mode: runs on your local model for $0, or declines until you connect a key. Nothing is billed.';
  return { engineMode: mode, model, spends, usdLow, usdHigh, measured: !!prior, note };
}
