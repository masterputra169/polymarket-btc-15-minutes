/**
 * Single-market arbitrage detector.
 *
 * From Polymarket math research (Part 1 & 2.5):
 * If YES_bestAsk + NO_bestAsk < $1.00, buying both guarantees riskless profit.
 * Research found 41% of markets show this at some point.
 * This is "Pattern 3: Structural Exploitation" — profit from math, not prediction.
 */

import { ARBITRAGE } from '../../../src/config.js';

const { MIN_NET_PROFIT, FEE_RATE, MAX_SPREAD } = ARBITRAGE;

/**
 * Detect if riskless arbitrage exists by buying both YES and NO at bestAsk.
 *
 * @param {Object} params
 * @param {Object|null} params.orderbookUp   - { bestAsk, bestBid, spread, ... }
 * @param {Object|null} params.orderbookDown - { bestAsk, bestBid, spread, ... }
 * @param {number|null} params.marketUp      - YES mid/last price (fallback)
 * @param {number|null} params.marketDown    - NO mid/last price (fallback)
 * @returns {{ found: boolean, totalCost: number, grossProfit: number, netProfit: number,
 *             profitPct: number, askUp: number, askDown: number, spreadHealthy: boolean }}
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
  // Fee is on winning side's profit (1.00 - askWinner), not net arb profit.
  // Use max winning profit (= 1.00 - min(askUp, askDown)) for conservative estimate.
  const winnerProfit = grossProfit > 0 ? (1.00 - Math.min(askUp, askDown)) : 0;
  const fees = winnerProfit > 0 ? Math.round(winnerProfit * FEE_RATE * 10000) / 10000 : 0;
  const netProfit = grossProfit - fees;

  // Spread health — wide spreads mean bestAsk is unreliable
  // null spread = orderbook unavailable → treat as unhealthy (not 0)
  const spreadUp = orderbookUp?.spread;
  const spreadDown = orderbookDown?.spread;
  const spreadHealthy = spreadUp != null && spreadDown != null
    && Math.max(spreadUp, spreadDown) < MAX_SPREAD;

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
