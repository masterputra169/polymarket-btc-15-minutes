/**
 * Arbitrage is two taker buys, and CLOB V2 charges each leg 0.07 × p × (1 − p) a
 * share at match — about 3.5c a pair near 50/50. An arb that clears the fee on
 * one leg's profit only (the pre-2026-09-26 model) can lose money for real.
 */
import { describe, test, expect } from 'vitest';
import { detectArbitrage } from '../arbitrage.ts';

const book = (bestAsk: number) => ({ bestAsk, spread: 0.01 });

describe('detectArbitrage — taker fee on both legs', () => {
  test('asks summing to 0.97 are not an arb: 3c gross, 3.5c of fees', () => {
    const r = detectArbitrage({ orderbookUp: book(0.48), orderbookDown: book(0.49), marketUp: 0.48, marketDown: 0.49 });
    // 0.07 × (0.48 × 0.52 + 0.49 × 0.51) = 0.034965
    expect(r.netProfit).toBeCloseTo(0.03 - 0.035, 4);
    expect(r.found).toBe(false);
  });

  test('asks summing to 0.92 are: 8c gross less 3.5c of fees', () => {
    const r = detectArbitrage({ orderbookUp: book(0.45), orderbookDown: book(0.47), marketUp: 0.45, marketDown: 0.47 });
    // 0.07 × (0.45 × 0.55 + 0.47 × 0.53) = 0.034762
    expect(r.netProfit).toBeCloseTo(0.08 - 0.0348, 4);
    expect(r.found).toBe(true);
  });
});
