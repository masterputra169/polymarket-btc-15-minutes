/**
 * Safety guards: circuit breaker and pre-trade validation.
 *
 * Financial integrity:
 * - M2: Epsilon comparison for float thresholds (avoids equality edge cases)
 * - C6: Uses availableBankroll (minus pending allocations) for bet validation
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Safety');

/** M2: Epsilon for float comparison — prevents boundary edge cases */
const EPSILON = 1e-9;

// H7: Hourly trade frequency limiter — prevents death by a thousand cuts
const MAX_TRADES_PER_HOUR = 10;
const tradeTimestamps = []; // ring buffer of recent trade timestamps

/**
 * Circuit breaker — should the bot halt trading?
 * @returns {{ halt: boolean, reason: string }}
 */
export function shouldHalt({ dailyPnLPct, bankroll, consecutiveLosses, drawdownPct }) {
  // Validate inputs — missing data means we can't verify safety
  if (!Number.isFinite(dailyPnLPct) || !Number.isFinite(bankroll) || !Number.isFinite(consecutiveLosses) || !Number.isFinite(drawdownPct)) {
    return { halt: true, reason: 'Circuit breaker inputs invalid (missing bankroll, PnL, loss streak, or drawdown data)' };
  }

  if (dailyPnLPct <= -(BOT_CONFIG.maxDailyLossPct - EPSILON)) {
    const reason = `Daily loss ${dailyPnLPct.toFixed(1)}% exceeds max ${BOT_CONFIG.maxDailyLossPct}%`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  // Max drawdown from peak bankroll (catches slow multi-day bleed)
  if (drawdownPct >= BOT_CONFIG.maxDrawdownPct - EPSILON) {
    const reason = `Drawdown ${drawdownPct.toFixed(1)}% from peak exceeds max ${BOT_CONFIG.maxDrawdownPct}%`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  if (consecutiveLosses >= BOT_CONFIG.maxConsecutiveLosses) {
    const reason = `${consecutiveLosses} consecutive losses (max: ${BOT_CONFIG.maxConsecutiveLosses})`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  if (bankroll < 1 + EPSILON) {
    const reason = `Bankroll depleted: $${bankroll.toFixed(2)}`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  return { halt: false, reason: '' };
}

/**
 * Audit fix M: Emergency cut-loss check — circuit breaker re-evaluated while position is open.
 * Returns true if drawdown/daily loss exceeds thresholds, meaning caller should initiate cut-loss.
 * @returns {{ shouldCut: boolean, reason: string }}
 */
export function shouldEmergencyCut({ dailyPnLPct, drawdownPct }) {
  if (!Number.isFinite(dailyPnLPct) || !Number.isFinite(drawdownPct)) {
    return { shouldCut: false, reason: '' };
  }
  // Audit v2 M4: 90%→75% — old 90% left only $0.67 gap from circuit breaker (one trade).
  // 75% gives ~4% buffer ($1.69 at $45 bankroll) — enough time to actually execute the cut.
  const dailyThreshold = BOT_CONFIG.maxDailyLossPct * 0.75;
  const drawdownThreshold = BOT_CONFIG.maxDrawdownPct * 0.75;

  if (dailyPnLPct <= -(dailyThreshold - EPSILON)) {
    const reason = `Emergency: daily loss ${dailyPnLPct.toFixed(1)}% approaching circuit breaker (${BOT_CONFIG.maxDailyLossPct}%)`;
    log.warn(`EMERGENCY CUT: ${reason}`);
    return { shouldCut: true, reason };
  }
  if (drawdownPct >= drawdownThreshold - EPSILON) {
    const reason = `Emergency: drawdown ${drawdownPct.toFixed(1)}% approaching circuit breaker (${BOT_CONFIG.maxDrawdownPct}%)`;
    log.warn(`EMERGENCY CUT: ${reason}`);
    return { shouldCut: true, reason };
  }
  return { shouldCut: false, reason: '' };
}

/**
 * Validate a trade before execution.
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateTrade({ rec, betSizing, timeLeftMin, bankroll, availableBankroll, hasPosition }) {
  if (!rec || rec.action !== 'ENTER') {
    return { valid: false, reason: 'No ENTER signal' };
  }

  if (!betSizing || !betSizing.shouldBet) {
    return { valid: false, reason: `Bet sizing rejected: ${betSizing?.rationale ?? 'no data'}` };
  }

  if (hasPosition) {
    return { valid: false, reason: 'Already have open position' };
  }

  if (timeLeftMin !== null && timeLeftMin < 0.5) {
    return { valid: false, reason: `Too close to settlement: ${timeLeftMin.toFixed(1)}min left` };
  }

  const betAmount = betSizing.betAmount;
  if (!Number.isFinite(betAmount)) {
    return { valid: false, reason: `Bet amount is not a valid number: ${betAmount}` };
  }

  if (betAmount < 0.50) {
    return { valid: false, reason: `Bet too small: $${betAmount.toFixed(2)} (min: $0.50)` };
  }

  // C6: Check against available bankroll (excludes pending order allocations)
  const effectiveBankroll = availableBankroll ?? bankroll;
  if (betAmount > effectiveBankroll + EPSILON) {
    return { valid: false, reason: `Bet $${betAmount.toFixed(2)} exceeds available bankroll $${effectiveBankroll.toFixed(2)}` };
  }

  // H7: Hourly trade frequency limit — prevents rapid-fire losses
  const oneHourAgo = Date.now() - 3600_000;
  const recentTrades = tradeTimestamps.filter(ts => ts > oneHourAgo);
  if (recentTrades.length >= MAX_TRADES_PER_HOUR) {
    return { valid: false, reason: `Trade frequency limit: ${recentTrades.length}/${MAX_TRADES_PER_HOUR} trades in last hour` };
  }

  return { valid: true, reason: 'OK' };
}

/**
 * H7: Record a trade timestamp for frequency tracking.
 */
export function recordTradeTimestamp() {
  tradeTimestamps.push(Date.now());
  // Keep only last hour + small buffer
  while (tradeTimestamps.length > MAX_TRADES_PER_HOUR + 5) {
    tradeTimestamps.shift();
  }
}

/**
 * Validate market price sanity.
 * @returns {{ valid: boolean, reason: string }}
 */
export function validatePrice(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return { valid: false, reason: 'No market price available' };
  }
  // H5: Tightened from 0.02-0.98 — blocks toxic 2-5c entries and 95-98c leveraged bets
  if (price < 0.05 || price > 0.95) {
    return { valid: false, reason: `Price ${price.toFixed(3)} outside safe range (0.05-0.95)` };
  }
  return { valid: true, reason: 'OK' };
}
