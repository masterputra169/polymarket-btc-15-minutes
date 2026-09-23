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
 *
 * 2026-09-22 — the bounds themselves were re-examined against 410 resolved
 * dry-run rows and left alone; see the comment in tradeFilters.ts for why the
 * apparent "expensive entries lose" effect does not survive the correct
 * breakeven formula. What DID change is the failure mode: envNum() silently
 * returns its default for an out-of-range value, so an operator who set 0.99
 * would see a bot capped at 68c with nothing anywhere saying why. Out-of-range
 * and unparseable values are now refused out loud and reported.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Load a fresh copy of the filter module under a specific env. */
async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../tradeFilters.ts');
}

async function loadFilters(env: Record<string, string | undefined>) {
  return (await loadModule(env)).applyTradeFilters;
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

describe('a refused override is refused out loud, not silently', () => {
  test('an in-range value is applied and reports no refusal', async () => {
    const mod = await loadModule({ DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: '0.75' });
    expect(mod.getDryRunEntryCap()).toBe(0.75);
    expect(mod.getDryRunEntryCapRefusal()).toBeNull();
  });

  test('a value above the ceiling is refused, and says so', async () => {
    const mod = await loadModule({ DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: '0.99' });
    expect(mod.getDryRunEntryCap()).toBeNull();
    const refusal = mod.getDryRunEntryCapRefusal();
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('0.99');
    expect(refusal).toContain('68c');
  });

  test('a value below the floor is refused rather than quietly tightening the cap', async () => {
    const mod = await loadModule({ DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: '0.40' });
    expect(mod.getDryRunEntryCap()).toBeNull();
    expect(mod.getDryRunEntryCapRefusal()).toContain('0.40');
  });

  test('an unparseable value is refused and named, not treated as unset', async () => {
    const mod = await loadModule({ DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: 'seventy' });
    expect(mod.getDryRunEntryCap()).toBeNull();
    expect(mod.getDryRunEntryCapRefusal()).toContain('seventy');
  });

  test('unset is not a refusal — there is nothing to explain', async () => {
    const mod = await loadModule({ DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: undefined });
    expect(mod.getDryRunEntryCap()).toBeNull();
    expect(mod.getDryRunEntryCapRefusal()).toBeNull();
  });

  test('a live bot never reports a refusal — the override is not its business', async () => {
    const mod = await loadModule({ DRY_RUN: 'false', DRY_RUN_HARD_ENTRY_CAP: '0.99' });
    expect(mod.getDryRunEntryCap()).toBeNull();
    expect(mod.getDryRunEntryCapRefusal()).toBeNull();
  });
});
