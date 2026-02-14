/**
 * Position and bankroll tracker with JSON file persistence.
 *
 * Financial integrity:
 * - All money values rounded to 2 decimal places (cents) via roundMoney()
 * - Settlement deduplication via `settled` flag on positions
 * - Append-only audit log for all financial state changes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Position');

/** Round to 2 decimal places — prevents float drift in money calcs. */
const roundMoney = (n) => Math.round(n * 100) / 100;

let state = {
  bankroll: BOT_CONFIG.bankroll,
  startOfDayBankroll: BOT_CONFIG.bankroll,
  dayStartMs: Date.now(),
  currentPosition: null,    // { side, tokenId, price, size, marketSlug, enteredAt, cost, settled, fillConfirmed }
  pendingCost: 0,           // Bankroll allocated to pending (unfilled) orders
  consecutiveLosses: 0,
  totalTrades: 0,
  wins: 0,
  losses: 0,
  trades: [],               // recent trade log
};

// ── Audit log (append-only) ──
function auditLog(entry) {
  try {
    const auditPath = BOT_CONFIG.stateFile.replace('.json', '_audit.jsonl');
    const line = JSON.stringify({ ...entry, _ts: Date.now() }) + '\n';
    appendFileSync(auditPath, line);
  } catch { /* audit should never break trading */ }
}

/**
 * Load state from disk.
 */
export function loadState() {
  try {
    if (existsSync(BOT_CONFIG.stateFile)) {
      const data = JSON.parse(readFileSync(BOT_CONFIG.stateFile, 'utf-8'));
      state = { ...state, ...data };
      state.pendingCost = state.pendingCost ?? 0;

      // Reset daily P&L if new day (UTC-based for consistency)
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const todayStartUtc = now - (now % dayMs);
      const stateDay = state.dayStartMs - (state.dayStartMs % dayMs);
      if (todayStartUtc > stateDay) {
        state.startOfDayBankroll = state.bankroll;
        state.dayStartMs = now;
        state.consecutiveLosses = 0;
        log.info('New trading day (UTC) — daily stats reset');
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
 * Bankroll deducted immediately. If order later fails to fill, call unwindPosition().
 */
export function recordTrade({ side, tokenId, price, size, marketSlug, orderId }) {
  const cost = roundMoney(price * size);

  state.currentPosition = {
    side,
    tokenId,
    price,
    size,
    marketSlug,
    orderId: orderId ?? null,
    enteredAt: Date.now(),
    cost,
    settled: false,        // C3: dedup flag — prevents double settlement
    fillConfirmed: false,  // C4: true once fill is verified on-chain
  };

  state.bankroll = roundMoney(state.bankroll - cost);
  state.pendingCost = 0; // Position recorded, no longer "pending"
  state.totalTrades++;

  state.trades.push({
    type: 'ENTER',
    side,
    price,
    size,
    cost,
    marketSlug,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  if (state.trades.length > 100) state.trades = state.trades.slice(-100);

  auditLog({ type: 'ENTER', side, price, size, cost, marketSlug, orderId, bankrollAfter: state.bankroll });

  log.info(`Position opened: ${side} ${size} shares @ $${price.toFixed(3)} ($${cost.toFixed(2)}) | Bankroll: $${state.bankroll.toFixed(2)}`);
  saveState();
}

/**
 * Mark current position's fill as confirmed (order verified filled on-chain).
 */
export function confirmFill() {
  if (state.currentPosition && !state.currentPosition.fillConfirmed) {
    state.currentPosition.fillConfirmed = true;
    auditLog({ type: 'FILL_CONFIRMED', orderId: state.currentPosition.orderId });
    log.debug('Position fill confirmed');
  }
}

/**
 * Settle current position (market resolved).
 * @param {boolean} won - Whether the position won
 * @returns {boolean} Whether settlement actually occurred (false if already settled or no position)
 */
export function settleTrade(won) {
  if (!state.currentPosition) return false;

  // C3: Double-settlement prevention — skip if already settled
  if (state.currentPosition.settled) {
    log.warn('Settlement skipped — position already settled (dedup)');
    return false;
  }

  const pos = state.currentPosition;
  const payout = roundMoney(won ? pos.size : 0); // Binary: win = $1/share, lose = $0

  // Mark as settled BEFORE modifying bankroll (prevents re-entry on async race)
  state.currentPosition.settled = true;
  state.currentPosition.settledAt = Date.now();

  state.bankroll = roundMoney(state.bankroll + payout);

  if (won) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;
  }

  const pnl = roundMoney(payout - pos.cost);

  state.trades.push({
    type: 'SETTLE',
    side: pos.side,
    won,
    payout,
    pnl,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  auditLog({ type: 'SETTLE', side: pos.side, won, payout, pnl, cost: pos.cost, bankrollAfter: state.bankroll });

  log.info(
    `Position settled: ${won ? 'WIN' : 'LOSS'} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ` +
    `Bankroll: $${state.bankroll.toFixed(2)} | Streak: ${state.consecutiveLosses} consec losses`
  );

  state.currentPosition = null;
  saveState();
  return true;
}

/**
 * Check if we have an open position for a given market.
 */
export function hasOpenPosition(marketSlug) {
  return state.currentPosition !== null &&
    !state.currentPosition.settled &&
    state.currentPosition.marketSlug === marketSlug;
}

export function getCurrentPosition() {
  return state.currentPosition;
}

/**
 * Unwind a position (e.g. stale order cancelled before fill).
 * Returns the cost back to bankroll and clears the position.
 * Will NOT unwind if position was already settled (prevents double-credit).
 */
export function unwindPosition() {
  if (!state.currentPosition) return;

  // C3/C4: Don't unwind if already settled — would double-credit
  if (state.currentPosition.settled) {
    log.warn('Unwind skipped — position already settled');
    state.currentPosition = null;
    return;
  }

  const pos = state.currentPosition;
  state.bankroll = roundMoney(state.bankroll + pos.cost);
  state.totalTrades = Math.max(0, state.totalTrades - 1);

  state.trades.push({
    type: 'UNWIND',
    side: pos.side,
    price: pos.price,
    size: pos.size,
    marketSlug: pos.marketSlug,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  auditLog({ type: 'UNWIND', side: pos.side, cost: pos.cost, bankrollAfter: state.bankroll });

  log.info(
    `Position unwound (stale cancel): ${pos.side} ${pos.size}@$${pos.price.toFixed(3)} | ` +
    `Returned $${pos.cost.toFixed(2)} | Bankroll: $${state.bankroll.toFixed(2)}`
  );

  state.currentPosition = null;
  saveState();
}

/**
 * Track pending order cost (reserved bankroll before fill confirmation).
 * Used by guards to prevent overspend on concurrent orders.
 */
export function setPendingCost(cost) {
  state.pendingCost = roundMoney(cost);
}

export function getPendingCost() {
  return state.pendingCost;
}

/**
 * Get available bankroll (total minus pending allocations).
 */
export function getAvailableBankroll() {
  return roundMoney(state.bankroll - state.pendingCost);
}

export function getBankroll() {
  return state.bankroll;
}

export function getDailyPnL() {
  return roundMoney(state.bankroll - state.startOfDayBankroll);
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
  const prev = state.bankroll;
  state.bankroll = roundMoney(value);
  auditLog({ type: 'SET_BANKROLL', prev, next: state.bankroll, source: 'dashboard' });
  saveState();
  log.info(`Bankroll updated to $${state.bankroll.toFixed(2)} (via dashboard)`);
}

export function getStats() {
  return {
    bankroll: state.bankroll,
    availableBankroll: getAvailableBankroll(),
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    winRate: state.totalTrades > 0 ? state.wins / state.totalTrades : 0,
    consecutiveLosses: state.consecutiveLosses,
    dailyPnL: getDailyPnL(),
    dailyPnLPct: getDailyPnLPct(),
    hasPosition: state.currentPosition !== null && !state.currentPosition?.settled,
    pendingCost: state.pendingCost,
  };
}
