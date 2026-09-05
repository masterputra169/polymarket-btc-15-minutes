/**
 * Dry-run-only entry-price cap override.
 *
 * Why it exists: in DRY_RUN the 68c hard cap was the single biggest gate — sole
 * blocker on 4,824 of 7,559 one-rule-away polls, with zero entries taken across
 * 46,629 polls. A dry run that never enters collects no evidence, and the
 * go-live decision needs >=30 resolved dry-run trades.
 *
 * Invariant under test, and the only reason this override is acceptable at all:
 * it MUST be impossible for it to loosen a live bot. With DRY_RUN=false the cap
 * stays 68c no matter what DRY_RUN_HARD_ENTRY_CAP says. It must also only ever
 * RAISE the cap, so a bad value cannot tighten the live path by a side door.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Load a fresh copy of the filter module under a specific env. */
async function loadFilters(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../tradeFilters.ts');
  return mod.applyTradeFilters;
}

/**
 * Baseline: everything permissive except the entry price, so the hard-cap
 * reason is the one we can assert on. PTB source must be exact or filter 1c
 * blocks everything (see tradeFilters.ptbSource.test.ts).
 */
function baseInput(overrides = {}) {
  return {
    mlConfidence: 0.70,      // below the 0.85/0.90 bypasses, so the base cap applies
    mlAvailable: true,
    marketPrice: 0.80,       // above 68c, below a raised 90c cap
    atrRatio: 1.0,
    timeLeftMin: 7,
    marketSlug: 'btc-updown-15m-1778902200',
    consecutiveLosses: 0,
    session: 'US',
    btcPrice: 79150,
    priceToBeat: 79500,
    tiltMlConfMin: null,
    bestEdge: 0.12,
    delta1m: 5,
    signalSide: 'UP',
    regime: 'moderate',
    etHour: 14,
    spread: 0.02,
    ptbSource: 'scheduled_ws',
    ...overrides,
  };
}

const capReason = (reasons: string[]) => reasons.filter(r => r.includes('hard cap'));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('dry-run entry-price cap override', () => {
  test('LIVE bot ignores the override entirely — 80c stays blocked at 68c', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'false',
      DRY_RUN_HARD_ENTRY_CAP: '0.90',
    });
    const { reasons } = applyTradeFilters(baseInput());
    const hits = capReason(reasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('68c hard cap');
    expect(hits[0]).not.toContain('dry-run cap');
  });

  test('DRY RUN with the override raises the cap and lets 80c through', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'true',
      DRY_RUN_HARD_ENTRY_CAP: '0.90',
    });
    const { reasons } = applyTradeFilters(baseInput());
    expect(capReason(reasons)).toHaveLength(0);
  });

  test('DRY RUN without the override keeps the original 68c cap', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'true',
      DRY_RUN_HARD_ENTRY_CAP: undefined,
    });
    const hits = capReason(applyTradeFilters(baseInput()).reasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('68c hard cap');
  });

  test('the override can only raise the cap, never tighten it', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'true',
      DRY_RUN_HARD_ENTRY_CAP: '0.50',   // below the 0.68 floor — must be rejected
    });
    const hits = capReason(applyTradeFilters(baseInput({ marketPrice: 0.60 })).reasons);
    expect(hits).toHaveLength(0);       // 60c still allowed, i.e. cap did not drop to 50c
  });

  test('a raised cap still blocks prices above it, and says it was the dry-run cap', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'true',
      DRY_RUN_HARD_ENTRY_CAP: '0.75',
    });
    const hits = capReason(applyTradeFilters(baseInput({ marketPrice: 0.82 })).reasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('75c hard cap');
    expect(hits[0]).toContain('[dry-run cap]');
  });

  test('a garbage value falls back to 68c rather than disabling the cap', async () => {
    const applyTradeFilters = await loadFilters({
      DRY_RUN: 'true',
      DRY_RUN_HARD_ENTRY_CAP: 'not-a-number',
    });
    const hits = capReason(applyTradeFilters(baseInput()).reasons);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('68c hard cap');
  });
});
