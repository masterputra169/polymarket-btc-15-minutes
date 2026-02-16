/**
 * Position and bankroll tracker with JSON file persistence.
 *
 * Financial integrity:
 * - All money values rounded to 2 decimal places (cents) via roundMoney()
 * - Settlement deduplication via `settled` flag on positions
 * - Append-only audit log for all financial state changes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Position');

/** Round to 2 decimal places — prevents float drift in money calcs. */
const roundMoney = (n) => Math.round(n * 100) / 100;

/** Polymarket fee rate on profit (2%). */
const POLYMARKET_FEE_RATE = 0.02;

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
  lastSettledSlug: null,    // Double-settlement guard: last settled market slug
  lastSettledTs: 0,         // Double-settlement guard: timestamp of last settlement
  lastSettlementMs: 0,      // H3/M4: Track last settlement time for USDC sync cooldown (persisted)
  cutLossCount: 0,          // L4: Pre-computed count of CUT_LOSS trades (avoids scanning array)
};

// ── Sell guard: prevents dashboard sell and loop cut-loss from racing ──
let sellingInProgress = false;

// ── Audit log (append-only) ──
function auditLog(entry) {
  try {
    const auditPath = BOT_CONFIG.stateFile.replace('.json', '_audit.jsonl');
    const line = JSON.stringify({ ...entry, _ts: Date.now() }) + '\n';
    appendFileSync(auditPath, line);
  } catch (err) { log.warn(`Audit write failed (financial event may be unrecorded): ${err.message}`); }
}

/**
 * Load state from disk.
 */
export function loadState() {
  try {
    if (existsSync(BOT_CONFIG.stateFile)) {
      const data = JSON.parse(readFileSync(BOT_CONFIG.stateFile, 'utf-8'));
      state = { ...state, ...data };

      // L5: Validate critical state fields after merge
      if (!Number.isFinite(state.bankroll) || state.bankroll < 0) {
        log.warn(`Invalid bankroll in state.json: ${state.bankroll} — resetting to 0`);
        state.bankroll = 0;
      }
      if (!Array.isArray(state.trades)) {
        log.warn('Invalid trades in state.json — resetting to []');
        state.trades = [];
      }

      // H2: Validate pendingCost — reject NaN/Infinity from corrupted state
      if (!Number.isFinite(state.pendingCost) || state.pendingCost < 0) {
        log.warn(`Invalid pendingCost in state.json: ${state.pendingCost} — resetting to 0`);
        state.pendingCost = 0;
      }
      // Clear stale pendingCost — any pending order from a previous session is dead
      if (state.pendingCost > 0) {
        log.info(`Clearing stale pendingCost $${state.pendingCost.toFixed(2)} from previous session`);
        state.pendingCost = 0;
      }

      // Reset daily P&L if new day (UTC-based for consistency)
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const todayStartUtc = now - (now % dayMs);
      const stateDay = state.dayStartMs - (state.dayStartMs % dayMs);
      if (todayStartUtc > stateDay) {
        // If there's an open position, bankroll has already been reduced by pos.cost.
        // Add it back so daily P&L baseline reflects true account value.
        const openCost = (state.currentPosition && !state.currentPosition.settled)
          ? (state.currentPosition.cost ?? 0) : 0;
        state.startOfDayBankroll = roundMoney(state.bankroll + openCost);
        state.dayStartMs = now;
        state.consecutiveLosses = 0;
        log.info(`New trading day (UTC) — daily stats reset (baseline $${state.startOfDayBankroll.toFixed(2)}${openCost > 0 ? `, incl $${openCost.toFixed(2)} open` : ''})`);
      }

      log.info(`State loaded: bankroll=$${state.bankroll.toFixed(2)}, trades=${state.totalTrades}, W/L=${state.wins}/${state.losses}`);
      auditLog({ type: 'STATE_LOADED', bankroll: state.bankroll, totalTrades: state.totalTrades, wins: state.wins, losses: state.losses });
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
    const data = JSON.stringify(state, null, 2);
    // Atomic write: write to temp file, then rename over actual file.
    // Prevents corruption if process crashes mid-write.
    const tmpPath = BOT_CONFIG.stateFile + '.tmp';
    writeFileSync(tmpPath, data);
    try {
      renameSync(tmpPath, BOT_CONFIG.stateFile);
    } catch {
      // Fallback: direct overwrite (rename may fail cross-device on some OS)
      writeFileSync(BOT_CONFIG.stateFile, data);
    }
    log.debug('State saved to disk');
  } catch (err) {
    log.warn(`Could not save state: ${err.message}`);
  }
}

/**
 * Record a new trade (position entry).
 * Bankroll deducted immediately. If order later fails to fill, call unwindPosition().
 */
export function recordTrade({ side, tokenId, conditionId, price, size, marketSlug, orderId, actualCost }) {
  // NaN guard — reject invalid inputs before they corrupt bankroll
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
    log.error(`recordTrade REJECTED: invalid params price=${price} size=${size} — trade NOT recorded`);
    return;
  }
  if (actualCost != null && (!Number.isFinite(actualCost) || actualCost <= 0)) {
    log.warn(`recordTrade: invalid actualCost=${actualCost} — using theoretical cost`);
    actualCost = null;
  }

  // SAFETY: If there's an unsettled position from a DIFFERENT market, force-settle it first.
  // This prevents silent cost loss when a stale position gets overwritten.
  if (state.currentPosition && !state.currentPosition.settled && state.currentPosition.marketSlug !== marketSlug) {
    const stale = state.currentPosition;
    log.warn(
      `OVERWRITE GUARD: unsettled ${stale.side} position on ${stale.marketSlug} (cost $${stale.cost.toFixed(2)}) — ` +
      `force-unwinding before recording new trade on ${marketSlug}`
    );
    // Unwind inline (return cost to bankroll) — we can't determine outcome here
    state.bankroll = roundMoney(state.bankroll + stale.cost);
    state.trades.push({
      type: 'FORCE_UNWIND',
      side: stale.side,
      cost: stale.cost,
      marketSlug: stale.marketSlug,
      reason: 'overwritten_by_new_trade',
      bankrollAfter: state.bankroll,
      timestamp: Date.now(),
    });
    auditLog({ type: 'FORCE_UNWIND', side: stale.side, cost: stale.cost, marketSlug: stale.marketSlug, reason: 'overwritten_by_new_trade', bankrollAfter: state.bankroll });
    state.currentPosition = null;
  }

  // Use actual fill cost from CLOB response when available, fallback to theoretical
  const cost = actualCost != null ? roundMoney(actualCost) : roundMoney(price * size);

  state.currentPosition = {
    side,
    tokenId,
    conditionId: conditionId ?? null,
    price: Math.round(price * 1e8) / 1e8,  // Prevent float drift (e.g. 0.21000000000000002)
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

  auditLog({ type: 'ENTER', side, price, size, cost, marketSlug, orderId, conditionId: conditionId ?? null, bankrollAfter: state.bankroll });

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
    saveState(); // Persist immediately so fillConfirmed survives restart
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

  // H4: NaN guard — reject settlement if position data is corrupted
  if (!Number.isFinite(pos.size) || !Number.isFinite(pos.cost)) {
    log.error(`Settlement ABORTED: pos.size=${pos.size} pos.cost=${pos.cost} is not finite — would corrupt bankroll`);
    auditLog({ type: 'SETTLE_ABORTED', reason: 'NaN_guard', size: pos.size, cost: pos.cost });
    return false;
  }

  // H6: Polymarket charges 2% fee on profit at redemption
  const grossPayout = won ? pos.size : 0; // Binary: win = $1/share, lose = $0

  // ARB fee: Polymarket charges 2% on the WINNING TOKEN's profit, not net arb profit.
  // For ARB, we don't know which side won, so use worst-case (cheaper leg wins = larger profit = larger fee).
  // Example: arb cost $97 (UP $46 + DOWN $51), payout $100 → worst-case fee = ($100-$46)×2% = $1.08
  let profit;
  if (pos.side === 'ARB' && pos.arbUpCost != null && pos.arbDownCost != null) {
    const minLegCost = Math.min(pos.arbUpCost, pos.arbDownCost);
    profit = Math.max(0, grossPayout - minLegCost); // Worst-case winning token profit
  } else {
    profit = Math.max(0, grossPayout - pos.cost);
  }
  const fee = roundMoney(profit * POLYMARKET_FEE_RATE);
  const payout = roundMoney(grossPayout - fee);

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

  state.lastSettlementMs = Date.now(); // H3/M4: Track for USDC sync cooldown (persisted)
  state.currentPosition = null;
  saveState();
  return true;
}

/**
 * Settle current position via early exit (cut-loss).
 * Partial recovery — not binary win/loss. Bankroll gets back whatever
 * USDC was recovered from selling the tokens early.
 *
 * @param {number} recoveredUsdc - Actual USDC recovered from the FOK sell
 * @returns {boolean} Whether settlement occurred
 */
export function settleTradeEarlyExit(recoveredUsdc) {
  if (!state.currentPosition) return false;

  // NaN guard — prevent bankroll corruption from malformed CLOB response
  if (!Number.isFinite(recoveredUsdc) || recoveredUsdc < 0) {
    log.error(`settleTradeEarlyExit ABORTED: invalid recoveredUsdc=${recoveredUsdc}`);
    return false;
  }

  // Dedup guard — same as settleTrade
  if (state.currentPosition.settled) {
    log.warn('Cut-loss settlement skipped — position already settled (dedup)');
    return false;
  }

  const pos = state.currentPosition;
  const recovered = roundMoney(Math.max(0, recoveredUsdc));

  // Mark as settled before modifying bankroll
  state.currentPosition.settled = true;
  state.currentPosition.settledAt = Date.now();

  state.bankroll = roundMoney(state.bankroll + recovered);

  const pnl = roundMoney(recovered - pos.cost);
  const isWin = pnl >= 0;

  // Cut-loss is typically a loss, but if recovered >= cost, count as win
  if (isWin) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;
  }

  state.cutLossCount = (state.cutLossCount || 0) + 1; // L4: pre-computed counter

  state.trades.push({
    type: 'CUT_LOSS',
    side: pos.side,
    won: isWin,
    payout: recovered,
    pnl,
    cost: pos.cost,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  auditLog({
    type: 'CUT_LOSS',
    side: pos.side,
    recovered,
    pnl,
    cost: pos.cost,
    entryPrice: pos.price,
    size: pos.size,
    bankrollAfter: state.bankroll,
  });

  // L2: Show correct sign prefix (+ or -) based on actual P&L
  log.info(
    `CUT-LOSS settled: ${pos.side} | Recovered $${recovered.toFixed(2)} of $${pos.cost.toFixed(2)} | ` +
    `P&L: ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}${pnl < 0 ? ` (saved $${(pos.cost - Math.abs(pnl)).toFixed(2)} vs full loss)` : ''} | ` +
    `Bankroll: $${state.bankroll.toFixed(2)}`
  );

  state.lastSettlementMs = Date.now(); // H3/M4: Track for USDC sync cooldown (persisted)
  state.currentPosition = null;
  saveState();
  return true;
}

/**
 * Record an arbitrage trade (both legs filled — guaranteed profit).
 *
 * Binary market arb: buy UP + DOWN for < $1.00 combined → guaranteed $1/share payout.
 * Tracks as a position (side='ARB') so USDC auto-sync defers until settlement.
 * Payout credited at market expiry/switch via settleTrade(true).
 *
 * @param {Object} params
 * @param {number} params.upCost - Actual USDC spent on UP leg
 * @param {number} params.downCost - Actual USDC spent on DOWN leg
 * @param {number} params.shares - Number of arb pairs
 * @param {string} params.marketSlug - Market identifier
 * @param {string|null} params.orderId - Order ID from first leg
 */
export function recordArbTrade({ upCost, downCost, shares, marketSlug, orderId, conditionId }) {
  // NaN guard — reject invalid arb costs before they corrupt bankroll
  if (!Number.isFinite(upCost) || upCost < 0 || !Number.isFinite(downCost) || downCost < 0 || !Number.isFinite(shares) || shares <= 0) {
    log.error(`recordArbTrade REJECTED: invalid params upCost=${upCost} downCost=${downCost} shares=${shares}`);
    return;
  }
  const totalCost = roundMoney(upCost + downCost);

  // Track arb as a position so USDC auto-sync defers until settlement.
  // Without this, auto-sync overwrites bankroll with on-chain balance (lower
  // because USDC was spent but tokens not yet redeemed), erasing arb profit.
  // Settlement happens at market expiry/switch via the pos.side === 'ARB' branch.
  state.currentPosition = {
    side: 'ARB',
    tokenId: null,  // ARB holds tokens on both sides
    conditionId: conditionId ?? null,  // H5: store for oracle settlement
    price: shares > 0 ? Math.round(totalCost / shares * 1e8) / 1e8 : 0,
    size: shares,   // $1/share guaranteed payout at settlement
    marketSlug,
    orderId: orderId ?? null,
    enteredAt: Date.now(),
    cost: totalCost,
    arbUpCost: roundMoney(upCost),    // H3: individual leg costs for correct fee calculation
    arbDownCost: roundMoney(downCost), // H3: Polymarket charges 2% on winning token profit, not net arb profit
    settled: false,
    fillConfirmed: true,  // Both legs verified by successful placement
  };

  state.bankroll = roundMoney(state.bankroll - totalCost);
  state.pendingCost = 0; // Clear pending reservation
  state.totalTrades++;
  // Don't increment wins here — settleTrade(true) at market expiry handles it

  state.trades.push({
    type: 'ARB_ENTRY',
    cost: totalCost,
    shares,
    marketSlug,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  if (state.trades.length > 100) state.trades = state.trades.slice(-100);

  auditLog({ type: 'ARB_ENTRY', cost: totalCost, shares, upCost, downCost, marketSlug, orderId, bankrollAfter: state.bankroll });

  log.info(
    `ARB entered: ${shares} pairs @ $${(totalCost / shares).toFixed(3)} (cost $${totalCost.toFixed(2)}) | Bankroll: $${state.bankroll.toFixed(2)}`
  );
  saveState();
}

/**
 * Partial early exit — sell some shares, keep rest riding to settlement.
 * Reduces position size + cost proportionally, adds recovery to bankroll.
 *
 * @param {number} sellSize - Number of shares to sell
 * @param {number} recoveredUsdc - Actual USDC recovered from the sell
 * @returns {boolean} Whether partial exit occurred
 */
export function partialExit(sellSize, recoveredUsdc) {
  if (!state.currentPosition || state.currentPosition.settled) return false;

  const pos = state.currentPosition;

  // If selling all remaining shares, delegate to full exit
  if (sellSize >= pos.size) {
    return settleTradeEarlyExit(recoveredUsdc);
  }

  const fractionSold = sellSize / pos.size;
  const costPortion = roundMoney(pos.cost * fractionSold);
  const recovered = roundMoney(Math.max(0, recoveredUsdc));
  const pnl = roundMoney(recovered - costPortion);

  // Update position in-place (reduce size + cost)
  // Round size to prevent float drift (e.g. 10 - 7.5 = 2.4999999...)
  const prevSize = pos.size;
  pos.size = Math.round((pos.size - sellSize) * 1e8) / 1e8;
  pos.cost = roundMoney(pos.cost - costPortion);

  // Add recovery to bankroll
  state.bankroll = roundMoney(state.bankroll + recovered);

  state.trades.push({
    type: 'PARTIAL_CUT',
    side: pos.side,
    sellSize,
    remainingSize: pos.size,
    recovered,
    costPortion,
    pnl,
    bankrollAfter: state.bankroll,
    timestamp: Date.now(),
  });

  if (state.trades.length > 100) state.trades = state.trades.slice(-100);

  auditLog({
    type: 'PARTIAL_CUT', side: pos.side,
    sellSize, remainingSize: pos.size,
    recovered, costPortion, pnl,
    bankrollAfter: state.bankroll,
  });

  log.info(
    `PARTIAL CUT: sold ${sellSize}/${prevSize} shares | ` +
    `recovered $${recovered.toFixed(2)} of $${costPortion.toFixed(2)} portion | ` +
    `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ` +
    `${pos.size} shares remain (cost $${pos.cost.toFixed(2)}) | ` +
    `Bankroll: $${state.bankroll.toFixed(2)}`
  );

  saveState();
  return true;
}

/**
 * Check if we have an open (unsettled) position.
 * Checks ANY market, not just the given slug — prevents new trades
 * while a stale position from a different market exists.
 */
export function hasOpenPosition(marketSlug) {
  if (!state.currentPosition || state.currentPosition.settled) return false;
  // Warn if position is from a different market (stale)
  if (state.currentPosition.marketSlug !== marketSlug) {
    log.warn(`hasOpenPosition: stale position from ${state.currentPosition.marketSlug} (current: ${marketSlug}) — blocking new trades`);
  }
  return true;
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
  const c = roundMoney(cost);
  state.pendingCost = (Number.isFinite(c) && c >= 0) ? c : 0;
}

export function getPendingCost() {
  return state.pendingCost;
}

/**
 * Get available bankroll (total minus pending allocations).
 * M6: Floor at 0 — negative available bankroll should never allow new trades.
 */
export function getAvailableBankroll() {
  return Math.max(0, roundMoney(state.bankroll - state.pendingCost));
}

/**
 * H3/M4: Get timestamp of last settlement (for USDC sync cooldown).
 * Now persisted in state.json so it survives restarts.
 */
export function getLastSettlementMs() {
  return state.lastSettlementMs || 0;
}

export function getBankroll() {
  return state.bankroll;
}

export function getDailyPnL() {
  // Add back open position's cost — deployed capital is not a realized loss
  const openCost = (state.currentPosition && !state.currentPosition.settled)
    ? (state.currentPosition.cost ?? 0) : 0;
  return roundMoney(state.bankroll + openCost - state.startOfDayBankroll);
}

export function getDailyPnLPct() {
  if (state.startOfDayBankroll <= 0) return 0;
  // Add back open position's cost so circuit breaker doesn't trigger on entry alone
  const openCost = (state.currentPosition && !state.currentPosition.settled)
    ? (state.currentPosition.cost ?? 0) : 0;
  return ((state.bankroll + openCost - state.startOfDayBankroll) / state.startOfDayBankroll) * 100;
}

export function getConsecutiveLosses() {
  return state.consecutiveLosses;
}

export function setBankroll(value) {
  if (!Number.isFinite(value) || value < 0) {
    log.warn(`Invalid bankroll value: ${value} — ignored (must be >= 0)`);
    return;
  }
  if (value === 0) log.warn('Bankroll set to $0 — bot will not place new trades');
  const prev = state.bankroll;
  state.bankroll = roundMoney(value);
  auditLog({ type: 'SET_BANKROLL', prev, next: state.bankroll, source: 'dashboard' });
  saveState();
  log.info(`Bankroll updated to $${state.bankroll.toFixed(2)} (via dashboard)`);
}

/**
 * Sell guard: prevents dashboard sell and loop cut-loss from racing on the same position.
 * Returns true if the lock was acquired, false if a sell is already in progress.
 */
export function acquireSellLock() {
  if (sellingInProgress) return false;
  sellingInProgress = true;
  return true;
}

export function releaseSellLock() {
  sellingInProgress = false;
}

export function isSelling() {
  return sellingInProgress;
}

/**
 * Double-settlement guard: persisted to state.json so bot restart can't double-settle.
 */
export function getLastSettled() {
  return { slug: state.lastSettledSlug, ts: state.lastSettledTs };
}

export function setLastSettled(slug, ts) {
  state.lastSettledSlug = slug;
  state.lastSettledTs = ts;
  saveState();
}

export function getStats() {
  return {
    bankroll: state.bankroll,
    availableBankroll: getAvailableBankroll(),
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    cutLosses: state.cutLossCount || 0, // L4: pre-computed counter instead of scanning trades[]
    winRate: (state.wins + state.losses) > 0 ? state.wins / (state.wins + state.losses) : 0,
    consecutiveLosses: state.consecutiveLosses,
    dailyPnL: getDailyPnL(),
    dailyPnLPct: getDailyPnLPct(),
    hasPosition: state.currentPosition !== null && !state.currentPosition?.settled,
    pendingCost: state.pendingCost,
  };
}
