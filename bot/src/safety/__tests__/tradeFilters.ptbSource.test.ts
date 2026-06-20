/**
 * Lapis 0 safety gate — PTB source quality (filter 1c).
 *
 * Root cause (proven 2026-05-16): Polymarket removed eventMetadata.priceToBeat
 * from Gamma API → polymarket_gamma/page/page_prev died → PTB collapsed to
 * chainlink_round (±8-15s, $75-225 error). The old gate only *degraded*
 * chainlink_round (require ML≥75%), so the bot kept trading on wrong PTB and
 * lost systematically.
 *
 * Invariant under test: an entry may pass the PTB-source gate ONLY when the
 * source is in the exact-trust set. Every non-exact source — and an
 * unknown/missing source — MUST be blocked, regardless of how strong ML or
 * edge is. No emergency override (user decision: "blokir total").
 */

import { describe, test, expect } from 'vitest';
import { applyTradeFilters } from '../tradeFilters.ts';

const EXACT_SOURCES = [
  'data_streams',
  'polymarket_gamma',
  'polymarket_page',
  'polymarket_page_prev',
  'scheduled_ws',
];
const NON_EXACT_SOURCES = ['chainlink_round', 'polymarket_page_approx', 'pending', 'oracle'];

// Baseline input: strong ML + high edge so that, if the gate had any
// ML/edge-based override, a non-exact source would slip through. The fix must
// block it anyway. Other filters may add their own reasons — we assert ONLY on
// the PTB-source reason (filter 1c's contribution).
function baseInput(overrides = {}) {
  return {
    mlConfidence: 0.92,
    mlAvailable: true,
    marketPrice: 0.6,
    atrRatio: 0.01,
    timeLeftMin: 7,
    marketSlug: 'btc-updown-15m-1778902200',
    consecutiveLosses: 0,
    session: 'US',
    btcPrice: 79150,
    priceToBeat: 79140,
    tiltMlConfMin: null,
    bestEdge: 0.2,
    delta1m: 5,
    signalSide: 'UP',
    regime: 'moderate',
    etHour: 14,
    spread: 0.02,
    mlAccuracy: 0.8,
    buyRatio: 0.55,
    ...overrides,
  };
}

const ptbReason = (reasons) => reasons.find((r) => /PTB source/i.test(r));

describe('filter 1c — PTB source safety gate (Lapis 0)', () => {
  test.each(NON_EXACT_SOURCES)(
    "blocks entry when ptbSource is '%s' even with ML 92%% + 20%% edge",
    (src) => {
      const { reasons } = applyTradeFilters(baseInput({ ptbSource: src }));
      const r = ptbReason(reasons);
      expect(r, `expected a PTB-source block reason for '${src}'`).toBeDefined();
      expect(r).toMatch(/block/i);
    },
  );

  test('blocks entry when ptbSource is missing/unknown (no known exact source)', () => {
    const r1 = ptbReason(applyTradeFilters(baseInput({ ptbSource: null })).reasons);
    expect(r1, 'null ptbSource must be blocked').toBeDefined();
    expect(r1).toMatch(/block/i);

    const r2 = ptbReason(applyTradeFilters(baseInput({ ptbSource: 'something_new' })).reasons);
    expect(r2, 'unknown ptbSource must be blocked').toBeDefined();
    expect(r2).toMatch(/block/i);
  });

  test.each(EXACT_SOURCES)(
    "does NOT add a PTB-source block when ptbSource is exact '%s'",
    (src) => {
      const { reasons } = applyTradeFilters(baseInput({ ptbSource: src }));
      expect(ptbReason(reasons), `exact source '${src}' must not trip the PTB gate`).toBeUndefined();
    },
  );
});
