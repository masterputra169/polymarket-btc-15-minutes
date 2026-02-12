/**
 * Safety guards: circuit breaker and pre-trade validation.
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Safety');

/**
 * Circuit breaker — should the bot halt trading?
 * @returns {{ halt: boolean, reason: string }}
 */
export function shouldHalt({ dailyPnLPct, bankroll, consecutiveLosses }) {
  if (dailyPnLPct <= -BOT_CONFIG.maxDailyLossPct) {
    const reason = `Daily loss ${dailyPnLPct.toFixed(1)}% exceeds max ${BOT_CONFIG.maxDailyLossPct}%`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  if (consecutiveLosses >= BOT_CONFIG.maxConsecutiveLosses) {
    const reason = `${consecutiveLosses} consecutive losses (max: ${BOT_CONFIG.maxConsecutiveLosses})`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  if (bankroll < 1) {
    const reason = `Bankroll depleted: $${bankroll.toFixed(2)}`;
    log.error(`CIRCUIT BREAKER: ${reason}`);
    return { halt: true, reason };
  }

  return { halt: false, reason: '' };
}

/**
 * Validate a trade before execution.
 * @returns {{ valid: boolean, reason: string }}
 */
export function validateTrade({ rec, betSizing, timeLeftMin, bankroll, hasPosition }) {
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

  if (betAmount < 0.50) {
    return { valid: false, reason: `Bet too small: $${betAmount.toFixed(2)} (min: $0.50)` };
  }

  if (betAmount > bankroll) {
    return { valid: false, reason: `Bet $${betAmount.toFixed(2)} exceeds bankroll $${bankroll.toFixed(2)}` };
  }

  return { valid: true, reason: 'OK' };
}

/**
 * Validate market price sanity.
 * @returns {{ valid: boolean, reason: string }}
 */
export function validatePrice(price) {
  if (price === null || price === undefined || !Number.isFinite(price)) {
    return { valid: false, reason: 'No market price available' };
  }
  if (price < 0.02 || price > 0.98) {
    return { valid: false, reason: `Price ${price.toFixed(3)} outside safe range (0.02-0.98)` };
  }
  return { valid: true, reason: 'OK' };
}
