// Between — the dated-rates source. Rates must resolve by short OR full id, the Batch API must halve
// the bill, and the staleness clock must trip at 90 days — so a cost estimate is never a magic constant
// nor a silently-stale one.
import { describe, it, expect } from 'vitest';
import {
  PRICES_AS_OF, rateFor, estimateUsd, pricingStaleDays, pricingIsStale,
} from '../src/pricing';

describe('pricing rateFor', () => {
  it('resolves short and full ids to the same rate', () => {
    expect(rateFor('haiku')).toEqual({ input: 1, output: 5 });
    expect(rateFor('claude-haiku-4-5')).toEqual({ input: 1, output: 5 });
    expect(rateFor('opus')).toEqual({ input: 5, output: 25 });
    expect(rateFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(rateFor('fable')).toEqual({ input: 10, output: 50 });
    expect(rateFor('claude-fable-5')).toEqual({ input: 10, output: 50 });
  });

  it('falls back to the Haiku floor for an unknown model', () => {
    expect(rateFor('gpt-9')).toEqual({ input: 1, output: 5 });
  });
});

describe('pricing estimateUsd', () => {
  it('prices in/out tokens at list rate, rounded to cents', () => {
    // 2M in @ $5 + 1M out @ $25 = 10 + 25 = $35 on Opus.
    expect(estimateUsd('opus', 2_000_000, 1_000_000)).toBe(35);
  });

  it('halves the bill under the Batch discount', () => {
    const std = estimateUsd('claude-haiku-4-5', 4_000_000, 2_000_000);       // 4 + 10 = $14
    const batch = estimateUsd('claude-haiku-4-5', 4_000_000, 2_000_000, { batch: true });
    expect(std).toBe(14);
    expect(batch).toBe(7);
    expect(batch).toBeCloseTo(std * 0.5, 10);
  });
});

describe('pricing staleness', () => {
  const asOf = Date.parse(PRICES_AS_OF);
  const day = 24 * 60 * 60 * 1000;

  it('is fresh on the as-of date and within 90 days', () => {
    expect(pricingStaleDays(asOf)).toBe(0);
    expect(pricingIsStale(asOf)).toBe(false);
    expect(pricingStaleDays(asOf + 30 * day)).toBe(30);
    expect(pricingIsStale(asOf + 90 * day)).toBe(false); // exactly 90 days is not yet stale
  });

  it('goes stale past 90 days', () => {
    expect(pricingIsStale(asOf + 91 * day)).toBe(true);
    expect(pricingStaleDays(asOf + 91 * day)).toBe(91);
  });

  it('never reports negative age for a clock before the as-of date', () => {
    expect(pricingStaleDays(asOf - 5 * day)).toBe(0);
    expect(pricingIsStale(asOf - 5 * day)).toBe(false);
  });
});
