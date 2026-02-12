/**
 * Position and bankroll tracker with JSON file persistence.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Position');

let state = {
  bankroll: BOT_CONFIG.bankroll,
  startOfDayBankroll: BOT_CONFIG.bankroll,
  dayStartMs: Date.now(),
  currentPosition: null,    // { side, tokenId, price, size, marketSlug, enteredAt }
  consecutiveLosses: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  trades: [],               // recent trade log
};

/**
 * Load state from disk.
 */
export function loadState() {
  try {
    if (existsSync(BOT_CONFIG.stateFile)) {
      const data = JSON.parse(readFileSync(BOT_CONFIG.stateFile, 'utf-8'));
      state = { ...state, ...data };

      // Reset daily P&L if new day
      const dayMs = 24 * 60 * 60 * 1000;
      if (Date.now() - state.dayStartMs > dayMs) {
        state.startOfDayBankroll = state.bankroll;
        state.dayStartMs = Date.now();
        state.consecutiveLosses = 0;
        log.info('New trading day — daily stats reset');
      }

      log.info(`State loaded: bankroll=$${state.bankroll.toFixed(2)}, trades=${state.totalTrades}, W/L=${state.wins}/${state.losses}`);
    } else {
      log.info(`No state file found, starting fresh with $${state.bankroll.toFixed(2)} bankroll`);
    }
  } catch (err) {
    log.warn(`Could not load state: ${err.message}`);
  }
}

/**
 * Save state to disk.
 */
export function saveState() {
  try {
    const dir = dirname(BOT_CONFIG.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BOT_CONFIG.stateFile, JSON.stringify(state, null, 2));
    log.debug('State saved to disk');
  } catch (err) {
    log.warn(`Could not save state: ${err.message}`);
  }
}

/**
 * Record a new trade (position entry).
 */
export function recordTrade({ side, tokenId, price, size, marketSlug, orderId }) {
  state.currentPosition = {
    side,
    tokenId,
    price,
    size,
    marketSlug,
    orderId: orderId ?? null,
    enteredAt: Date.now(),
    cost: price * size,
  };

  state.bankroll -= price * size;
  state.totalTrades++;

  state.trades.push({
    type: 'ENTER',
    side,
    price,
    size,
    marketSlug,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  // Keep only last 100 trades
  if (state.trades.length > 100) state.trades = state.trades.slice(-100);

  log.info(`Position opened: ${side} ${size} shares @ $${price.toFixed(3)} ($${(price * size).toFixed(2)}) | Bankroll: $${state.bankroll.toFixed(2)}`);
  saveState();
}

/**
 * Settle current position (market resolved).
 * @param {boolean} won - Whether the position won
 */
export function settleTrade(won) {
  if (!state.currentPosition) return;

  const pos = state.currentPosition;
  const payout = won ? pos.size : 0; // Binary: win = $1/share, lose = $0

  state.bankroll += payout;

  if (won) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;
  }

  const pnl = payout - pos.cost;

  state.trades.push({
    type: 'SETTLE',
    side: pos.side,
    won,
    payout,
    pnl,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  log.info(
    `Position settled: ${won ? 'WIN' : 'LOSS'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ` +
    `Bankroll: $${state.bankroll.toFixed(2)} | Streak: ${state.consecutiveLosses} consec losses`
  );

  state.currentPosition = null;
  saveState();
}

/**
 * Check if we have an open position for a given market.
 */
export function hasOpenPosition(marketSlug) {
  return state.currentPosition !== null && state.currentPosition.marketSlug === marketSlug;
}

export function getCurrentPosition() {
  return state.currentPosition;
}

export function getBankroll() {
  return state.bankroll;
}

export function getDailyPnL() {
  return state.bankroll - state.startOfDayBankroll;
}

export function getDailyPnLPct() {
  if (state.startOfDayBankroll <= 0) return 0;
  return ((state.bankroll - state.startOfDayBankroll) / state.startOfDayBankroll) * 100;
}

export function getConsecutiveLosses() {
  return state.consecutiveLosses;
}

export function setBankroll(value) {
  if (!Number.isFinite(value) || value < 0) {
    log.warn(`Invalid bankroll value: ${value} — ignored`);
    return;
  }
  state.bankroll = value;
  saveState();
  log.info(`Bankroll updated to $${value.toFixed(2)} (via dashboard)`);
}

export function getStats() {
  return {
    bankroll: state.bankroll,
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    winRate: state.totalTrades > 0 ? state.wins / state.totalTrades : 0,
    consecutiveLosses: state.consecutiveLosses,
    dailyPnL: getDailyPnL(),
    dailyPnLPct: getDailyPnLPct(),
    hasPosition: state.currentPosition !== null,
  };
}
