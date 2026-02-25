/**
 * Pre-market LONG strategy — US pre-market momentum trade.
 *
 * Strategy: One LONG (UP) trade per day during 09:00-09:15 EST window.
 * Rationale: US pre-market (09:00-09:15 EST) has heightened volatility as
 * traders position before NYSE open (09:30 EST). BTC tends to see directional
 * momentum in this window, favoring LONG (UP) entries.
 *
 * Parameters:
 *   - Window:   09:00-09:15 EST (configurable)
 *   - Direction: Always UP (LONG)
 *   - Sizing:   20% of bankroll (configurable)
 *   - Take-profit: 50% of invested amount (configurable)
 *   - Limit:    1 trade per day, weekdays only
 *
 * Expected compounding: $100 × 1.10^22 weekdays ≈ $814 (+714% monthly)
 * (20% risk × 50% profit target = 10% net return per win, assuming ~100% WR in window)
 */

import { createLogger } from '../logger.js';

const log = createLogger('PreMarketLong');

// ── State ──
let tradedToday = false;
let lastTradeDateStr = null;  // 'YYYY-MM-DD' in ET
let entryPrice = null;        // token price at entry (for take-profit calc)
let entryMarketSlug = null;   // market slug where entry was made

/**
 * Get current Eastern Time (EST/EDT-aware) date parts.
 * Uses Intl API for reliable DST detection — handles EST (UTC-5) and EDT (UTC-4).
 * EDT runs Mar 2nd Sunday – Nov 1st Sunday; critical for pre-market window timing.
 */
function getETNow() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etDate = new Date(etStr);
  return {
    dateStr: etDate.getFullYear() + '-' +
      String(etDate.getMonth() + 1).padStart(2, '0') + '-' +
      String(etDate.getDate()).padStart(2, '0'),
    hour: etDate.getHours(),
    minute: etDate.getMinutes(),
    dayOfWeek: etDate.getDay(), // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  };
}

/**
 * Check if pre-market LONG entry conditions are met.
 *
 * @param {Object} params
 * @param {boolean} params.hasPosition - Whether bot already has an open position
 * @param {number} params.bankroll - Current bankroll
 * @param {boolean} params.settlementPending - Whether settlement is in progress
 * @param {Object} params.config - preMarketLong config from BOT_CONFIG
 * @returns {{ shouldEnter: boolean, reason: string }}
 */
export function checkPreMarketEntry({ hasPosition, bankroll, settlementPending, config }) {
  if (!config.enabled) return { shouldEnter: false, reason: 'disabled' };
  if (hasPosition) return { shouldEnter: false, reason: 'has_position' };
  if (settlementPending) return { shouldEnter: false, reason: 'settlement_pending' };
  if (bankroll < 2) return { shouldEnter: false, reason: 'low_bankroll' };

  const et = getETNow();

  // Weekdays only (Mon=1 through Fri=5)
  if (et.dayOfWeek < 1 || et.dayOfWeek > 5) {
    return { shouldEnter: false, reason: 'weekend' };
  }

  // Daily limit reset on new day
  if (lastTradeDateStr !== et.dateStr) {
    tradedToday = false;
    entryPrice = null;
    entryMarketSlug = null;
  }

  // Already traded today
  if (tradedToday) return { shouldEnter: false, reason: 'already_traded_today' };

  // Check time window
  const etMinutes = et.hour * 60 + et.minute;
  const windowStart = config.windowStartH * 60 + config.windowStartM;
  const windowEnd = config.windowEndH * 60 + config.windowEndM;

  if (etMinutes < windowStart || etMinutes >= windowEnd) {
    return { shouldEnter: false, reason: `outside_window (${et.hour}:${String(et.minute).padStart(2, '0')} ET)` };
  }

  return { shouldEnter: true, reason: 'pre_market_window' };
}

/**
 * Compute bet sizing for pre-market trade.
 *
 * @param {number} bankroll - Current bankroll
 * @param {number} marketPrice - Current UP token price
 * @param {Object} config - preMarketLong config
 * @returns {{ betAmount: number, shares: number, valid: boolean, reason: string }}
 */
export function getPreMarketSizing(bankroll, marketPrice, config) {
  const betAmount = Math.round(bankroll * config.riskPct * 100) / 100;
  const shares = Math.floor(betAmount / marketPrice);

  if (shares <= 0) return { betAmount, shares: 0, valid: false, reason: 'zero_shares' };
  if (betAmount < 1.00) return { betAmount, shares: 0, valid: false, reason: 'below_minimum' };

  return { betAmount, shares, valid: true, reason: 'ok' };
}

/**
 * Record that a pre-market trade was executed.
 */
export function onPreMarketEntry(price, marketSlug) {
  const et = getETNow();
  tradedToday = true;
  lastTradeDateStr = et.dateStr;
  entryPrice = price;
  entryMarketSlug = marketSlug;
  log.info(`Pre-market LONG entered: $${price.toFixed(3)} | ${marketSlug} | ${et.hour}:${String(et.minute).padStart(2, '0')} ET`);
}

/**
 * Check if pre-market take-profit should trigger.
 * Targets profitTargetPct (default 50%) return on the invested amount.
 *
 * Example: entry $0.55, target = $0.55 × 1.50 = $0.825
 *
 * @param {number} currentPrice - Current UP token price
 * @param {string} currentSlug - Current market slug
 * @param {Object} config - preMarketLong config
 * @returns {{ shouldTP: boolean, targetPrice: number|null, gainPct: number }}
 */
export function checkPreMarketTP(currentPrice, currentSlug, config) {
  if (!config.enabled || entryPrice === null) {
    return { shouldTP: false, targetPrice: null, gainPct: 0 };
  }
  // Only applies to the market where we entered
  if (currentSlug !== entryMarketSlug) {
    return { shouldTP: false, targetPrice: null, gainPct: 0 };
  }
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { shouldTP: false, targetPrice: null, gainPct: 0 };
  }

  const targetPrice = entryPrice * (1 + config.profitTargetPct);
  const gainPct = ((currentPrice - entryPrice) / entryPrice) * 100;

  if (currentPrice >= targetPrice) {
    log.info(
      `Pre-market TP HIT: $${currentPrice.toFixed(3)} >= target $${targetPrice.toFixed(3)} ` +
      `(entry $${entryPrice.toFixed(3)}, +${gainPct.toFixed(1)}%)`
    );
    return { shouldTP: true, targetPrice, gainPct };
  }

  return { shouldTP: false, targetPrice, gainPct };
}

/**
 * M3 audit fix: Check if pre-market position should be stopped out.
 * 20% bankroll at risk with no stop-loss = full loss on BTC crash.
 * Cut if token drops below entry × (1 - maxLossPct).
 *
 * @param {number} currentPrice - Current UP token price
 * @param {string} currentSlug - Current market slug
 * @param {Object} config - preMarketLong config
 * @returns {{ shouldCut: boolean, stopPrice: number|null, lossPct: number }}
 */
export function checkPreMarketSL(currentPrice, currentSlug, config) {
  if (!config.enabled || entryPrice === null) {
    return { shouldCut: false, stopPrice: null, lossPct: 0 };
  }
  if (currentSlug !== entryMarketSlug) {
    return { shouldCut: false, stopPrice: null, lossPct: 0 };
  }
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { shouldCut: false, stopPrice: null, lossPct: 0 };
  }

  const maxLossPct = config.maxLossPct ?? 0.30; // default 30% max loss on pre-market trade
  const stopPrice = entryPrice * (1 - maxLossPct);
  const lossPct = ((entryPrice - currentPrice) / entryPrice) * 100;

  if (currentPrice <= stopPrice) {
    log.info(
      `Pre-market STOP-LOSS: $${currentPrice.toFixed(3)} <= stop $${stopPrice.toFixed(3)} ` +
      `(entry $${entryPrice.toFixed(3)}, -${lossPct.toFixed(1)}%)`
    );
    return { shouldCut: true, stopPrice, lossPct };
  }

  return { shouldCut: false, stopPrice, lossPct };
}

/**
 * Clear entry state (called on settlement/close/market switch).
 */
export function clearPreMarketEntry() {
  entryPrice = null;
  entryMarketSlug = null;
}

/**
 * Check if a given position was entered by this strategy.
 */
export function isPreMarketPosition(marketSlug) {
  return tradedToday && entryMarketSlug === marketSlug && entryPrice !== null;
}

/**
 * Get status for logging/dashboard.
 */
export function getPreMarketStatus(config) {
  const et = getETNow();
  const etMinutes = et.hour * 60 + et.minute;
  const windowStart = config.windowStartH * 60 + config.windowStartM;
  const windowEnd = config.windowEndH * 60 + config.windowEndM;
  const inWindow = et.dayOfWeek >= 1 && et.dayOfWeek <= 5 &&
                   etMinutes >= windowStart && etMinutes < windowEnd;
  return {
    enabled: config.enabled,
    tradedToday,
    entryPrice,
    entryMarketSlug,
    etTime: `${et.hour}:${String(et.minute).padStart(2, '0')} ET`,
    isWeekday: et.dayOfWeek >= 1 && et.dayOfWeek <= 5,
    inWindow,
    dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][et.dayOfWeek],
  };
}
