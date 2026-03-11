/**
 * Daily profit target — pauses bot when on-chain USDC profit reaches target.
 *
 * Uses WIB (UTC+7, Asia/Jakarta) timezone for day boundaries (00:00 - 23:59 WIB).
 * Profit calculated from real on-chain USDC balance.
 * When position is open, adds position cost as deployed capital estimate.
 *
 * Persistence: saves baseline to bot/data/profit_target.json so it survives restarts.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('ProfitTarget');

const STATE_FILE = resolve(BOT_CONFIG.dataDir, 'profit_target.json');

// ── State ──
let startOfDayBalance = null;   // On-chain USDC baseline at start of WIB day
let currentWibDate = null;      // 'YYYY-MM-DD' in WIB
let targetReached = false;      // Prevents repeated pause calls
let lastProfit = 0;             // Last computed profit (for dashboard)

/**
 * Get current date string in WIB timezone (Asia/Jakarta = UTC+7).
 * Uses Intl API for DST-safe timezone handling.
 */
function getWibDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()); // returns 'YYYY-MM-DD'
}

/**
 * Load persisted state from disk.
 */
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (data.wibDate && Number.isFinite(data.baseline)) {
        currentWibDate = data.wibDate;
        startOfDayBalance = data.baseline;
        targetReached = data.targetReached === true;
        log.info(`Loaded profit target state: baseline=$${startOfDayBalance.toFixed(2)}, date=${currentWibDate}, reached=${targetReached}`);
      }
    }
  } catch (err) {
    log.warn(`Could not load profit target state: ${err.message}`);
  }
}

/**
 * Save state to disk for persistence across restarts.
 */
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      wibDate: currentWibDate,
      baseline: startOfDayBalance,
      targetReached,
      savedAt: Date.now(),
    }, null, 2));
  } catch (err) {
    log.warn(`Could not save profit target state: ${err.message}`);
  }
}

/**
 * Initialize or reset the daily baseline when a new WIB day starts.
 * Called with on-chain USDC balance.
 *
 * @param {number} onChainBalance - Current on-chain USDC balance
 * @returns {boolean} Whether baseline was (re)set
 */
export function initDayBaseline(onChainBalance) {
  if (!Number.isFinite(onChainBalance) || onChainBalance < 0) return false;

  const today = getWibDate();

  if (currentWibDate !== today) {
    // New WIB day — reset baseline
    const prevDate = currentWibDate;
    const prevBaseline = startOfDayBalance;
    startOfDayBalance = onChainBalance;
    currentWibDate = today;
    targetReached = false;
    lastProfit = 0;
    saveState();
    log.info(
      `New WIB day (${today}) — profit target baseline: $${onChainBalance.toFixed(2)}, ` +
      `target: +$${BOT_CONFIG.dailyProfitTargetUsd.toFixed(2)}` +
      (prevDate ? ` (prev: ${prevDate}, $${prevBaseline?.toFixed(2) ?? '?'})` : '')
    );
    return true;
  }

  // Same day — set baseline only if not yet set (first startup of the day)
  if (startOfDayBalance === null) {
    startOfDayBalance = onChainBalance;
    currentWibDate = today;
    saveState();
    log.info(
      `Profit target baseline set: $${onChainBalance.toFixed(2)} ` +
      `(${today} WIB), target: +$${BOT_CONFIG.dailyProfitTargetUsd.toFixed(2)}`
    );
    return true;
  }

  return false;
}

/**
 * Check if daily profit target has been reached.
 *
 * @param {number} onChainBalance - Current on-chain USDC balance
 * @param {number} [positionCost=0] - Cost of open position (deployed capital on-chain as tokens)
 * @returns {{ reached: boolean, profit: number, target: number, baseline: number }}
 */
export function checkProfitTarget(onChainBalance, positionCost = 0) {
  const target = BOT_CONFIG.dailyProfitTargetUsd;

  if (target <= 0) {
    return { reached: false, profit: 0, target: 0, baseline: 0 };
  }

  // Handle day rollover
  initDayBaseline(onChainBalance);

  if (startOfDayBalance === null || !Number.isFinite(onChainBalance)) {
    return { reached: false, profit: 0, target, baseline: 0 };
  }

  // Effective balance = on-chain USDC + deployed capital in tokens
  // Conservative: position cost is lower bound of token value
  const deployedCapital = Number.isFinite(positionCost) && positionCost > 0 ? positionCost : 0;
  const effectiveBalance = onChainBalance + deployedCapital;
  const profit = effectiveBalance - startOfDayBalance;
  lastProfit = profit;
  const reached = profit >= target;

  if (reached && !targetReached) {
    targetReached = true;
    saveState();
    log.info(
      `DAILY PROFIT TARGET REACHED! +$${profit.toFixed(2)} >= $${target.toFixed(2)} target | ` +
      `Baseline: $${startOfDayBalance.toFixed(2)} | On-chain: $${onChainBalance.toFixed(2)}` +
      (deployedCapital > 0 ? ` + $${deployedCapital.toFixed(2)} deployed` : '') +
      ` | Bot will pause trading for the rest of this WIB day`
    );
  }

  return { reached, profit, target, baseline: startOfDayBalance };
}

/**
 * Whether target was already reached today.
 */
export function isTargetReached() {
  return targetReached;
}

/**
 * Get status for dashboard broadcast.
 */
export function getProfitTargetStatus() {
  return {
    enabled: BOT_CONFIG.dailyProfitTargetUsd > 0,
    target: BOT_CONFIG.dailyProfitTargetUsd,
    baseline: startOfDayBalance,
    profit: lastProfit,
    currentDate: currentWibDate,
    targetReached,
    timezone: 'WIB (UTC+7)',
  };
}

/**
 * Force reset — allows manual resume (e.g. user raises target mid-day).
 */
export function resetProfitTarget() {
  targetReached = false;
  saveState();
  log.info('Profit target reset — trading can resume');
}

// Load persisted state on module init
loadState();
