/**
 * Single-market arbitrage detector.
 *
 * From Polymarket math research (Part 1 & 2.5):
 * If YES_bestAsk + NO_bestAsk < $1.00, buying both guarantees riskless profit.
 * Research found 41% of markets show this at some point.
 * This is "Pattern 3: Structural Exploitation" — profit from math, not prediction.
 */

import { ARBITRAGE, polyTakerFeePerShare } from '../../../src/config.ts';

const { MIN_NET_PROFIT, MAX_SPREAD, MAX_SPREAD_HIGH_PROFIT } = ARBITRAGE;

/**
 * Detect if riskless arbitrage exists by buying both YES and NO at bestAsk.
 *
 * @param {Object} params
 * @param {Object|null} params.orderbookUp   - { bestAsk, bestBid, spread, ... }
 * @param {Object|null} params.orderbookDown - { bestAsk, bestBid, spread, ... }
 * @param {number|null} params.marketUp      - YES mid/last price (fallback)
 * @param {number|null} params.marketDown    - NO mid/last price (fallback)
 * @returns {{ found: boolean, totalCost: number, grossProfit: number, netProfit: number,
 *             profitPct: number, askUp: number, askDown: number, spreadHealthy: boolean,
 *             reason?: string }}
 */
export function detectArbitrage({ orderbookUp, orderbookDown, marketUp, marketDown }) {
  const noArb = {
    found: false,
    totalCost: 0,
    grossProfit: 0,
    netProfit: 0,
    profitPct: 0,
    askUp: null,
    askDown: null,
    spreadHealthy: false,
  };

  // Use bestAsk prices (what we'd actually PAY to buy)
  const askUp = orderbookUp?.bestAsk ?? marketUp;
  const askDown = orderbookDown?.bestAsk ?? marketDown;

  if (!Number.isFinite(askUp) || !Number.isFinite(askDown) || askUp <= 0 || askDown <= 0) return noArb;

  const totalCost = askUp + askDown;
  const grossProfit = 1.00 - totalCost;            // guaranteed payout = $1.00
  // Both legs are taker buys, and CLOB V2 charges each 0.07 × p × (1 − p) a share
  // at match — about 3.5c a pair near 50/50, so an arb needs asks summing under
  // ~0.965 before it pays. (Until 2026-09-26: the fee on one leg's profit only.)
  const fees = Math.round((polyTakerFeePerShare(askUp) + polyTakerFeePerShare(askDown)) * 10000) / 10000;
  const netProfit = grossProfit - fees;

  // Spread health — wide spreads mean bestAsk is unreliable.
  // Adaptive: high-profit arb (>3% net) tolerates wider spreads because imprecision
  // in bestAsk is small relative to the margin. Low-profit arb requires tighter book.
  // Whale bots (PBot1, gabagool22) routinely operate at 45-49c/side where spreads are 5-10%.
  // null spread = orderbook unavailable → treat as unhealthy (not 0)
  const spreadUp = orderbookUp?.spread;
  const spreadDown = orderbookDown?.spread;
  const isHighProfit = netProfit > 0.03;  // >3% net profit = high margin
  const spreadLimit = isHighProfit ? (MAX_SPREAD_HIGH_PROFIT ?? 0.12) : MAX_SPREAD;
  const spreadHealthy = spreadUp != null && spreadDown != null
    && Math.max(spreadUp, spreadDown) < spreadLimit;

  return {
    found: netProfit > MIN_NET_PROFIT,
    totalCost: Math.round(totalCost * 10000) / 10000,
    grossProfit: Math.round(grossProfit * 10000) / 10000,
    netProfit: Math.round(netProfit * 10000) / 10000,
    profitPct: totalCost > 0 ? Math.round((netProfit / totalCost) * 10000) / 100 : 0,
    askUp,
    askDown,
    spreadHealthy,
  };
}
