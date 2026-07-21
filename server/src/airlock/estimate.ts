// Between — capacity honesty (HANDOFF invariant 6, TEST T2.9). Before any run the planner shows
// "N windows ≈ X drains ≈ ~Y". The estimate is deliberately conservative and framed in the VOICE
// §6 microcopy ("This will read {n} stretches … about {drains} sittings, roughly {time}").
import type { Estimate } from './types';
import { estimateCopy } from './voice';

/** Engine batch size — the drain protocol processes ≤ 20 jobs per invocation (airlock §"Engine"). */
export const DRAIN_BATCH = 20;

/** Rough wall-clock per un-cached window (seconds); tuned to be honest-generous, not precise. */
const SECONDS_PER_WINDOW = 25;

function humanTime(toRun: number): string {
  if (toRun <= 0) return 'no time — everything is remembered';
  const secs = toRun * SECONDS_PER_WINDOW;
  if (secs < 90) return 'about a minute';
  if (secs < 3600) return `about ${Math.round(secs / 60)} minutes`;
  const hours = secs / 3600;
  return hours < 1.5 ? 'about an hour' : `about ${hours.toFixed(1)} hours`;
}

export interface EstimateCounts {
  windowCount: number;
  cached: number;
  toRun: number;
  skipped: number;
}

export function buildEstimate(counts: EstimateCounts): Estimate {
  const drains = Math.max(0, Math.ceil(counts.toRun / DRAIN_BATCH));
  const timeEstimate = humanTime(counts.toRun);
  return {
    windowCount: counts.windowCount,
    cached: counts.cached,
    toRun: counts.toRun,
    skipped: counts.skipped,
    drains,
    timeEstimate,
    copy: estimateCopy(counts.windowCount, drains, timeEstimate),
  };
}
