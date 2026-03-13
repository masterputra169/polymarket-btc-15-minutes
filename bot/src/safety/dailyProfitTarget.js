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
export function initDayBaseline(onChainBalance, deployedCapital = 0) {
  if (!Number.isFinite(onChainBalance) || onChainBalance < 0) return false;

  const deployed = Number.isFinite(deployedCapital) && deployedCapital > 0 ? deployedCapital : 0;
  const effectiveBalance = onChainBalance + deployed;
  const today = getWibDate();

  if (currentWibDate !== today) {
    // New WIB day — reset baseline (include deployed capital so open positions don't count as profit)
    const prevDate = currentWibDate;
    const prevBaseline = startOfDayBalance;
    startOfDayBalance = effectiveBalance;
    currentWibDate = today;
    targetReached = false;
    lastProfit = 0;
    saveState();
    log.info(
      `New WIB day (${today}) — profit target baseline: $${effectiveBalance.toFixed(2)}` +
      (deployed > 0 ? ` (on-chain $${onChainBalance.toFixed(2)} + deployed $${deployed.toFixed(2)})` : '') +
      `, target: +$${BOT_CONFIG.dailyProfitTargetUsd.toFixed(2)}` +
      (prevDate ? ` (prev: ${prevDate}, $${prevBaseline?.toFixed(2) ?? '?'})` : '')
    );
    return true;
  }

  // Same day — set baseline only if not yet set (first startup of the day)
  if (startOfDayBalance === null) {
    startOfDayBalance = effectiveBalance;
    currentWibDate = today;
    saveState();
    log.info(
      `Profit target baseline set: $${effectiveBalance.toFixed(2)}` +
      (deployed > 0 ? ` (on-chain $${onChainBalance.toFixed(2)} + deployed $${deployed.toFixed(2)})` : '') +
      ` (${today} WIB), target: +$${BOT_CONFIG.dailyProfitTargetUsd.toFixed(2)}`
    );
    return true;
  }

  return false;
}

/**
 * Check if daily profit target has been reached.
 *
 * Effective balance = on-chain USDC + open position cost + unredeemed settled winnings.
 * This captures the full account value even when ERC-1155 tokens haven't been redeemed yet.
 *
 * @param {number} onChainBalance - Current on-chain USDC balance
 * @param {number} [positionCost=0] - Cost of open position (deployed capital on-chain as tokens)
 * @param {number} [pendingRedeemValue=0] - Value of settled winning positions awaiting on-chain redeem
 * @returns {{ reached: boolean, profit: number, target: number, baseline: number }}
 */
export function checkProfitTarget(onChainBalance, positionCost = 0, pendingRedeemValue = 0) {
  const target = BOT_CONFIG.dailyProfitTargetUsd;

  if (target <= 0) {
    return { reached: false, profit: 0, target: 0, baseline: 0 };
  }

  // Handle day rollover (pass deployed capital so baseline includes open positions)
  const deployedCapital = Number.isFinite(positionCost) && positionCost > 0 ? positionCost : 0;
  const pendingRedeem = Number.isFinite(pendingRedeemValue) && pendingRedeemValue > 0 ? pendingRedeemValue : 0;
  initDayBaseline(onChainBalance, deployedCapital);

  if (startOfDayBalance === null || !Number.isFinite(onChainBalance)) {
    return { reached: false, profit: 0, target, baseline: 0 };
  }

  // Effective balance = on-chain USDC + deployed capital + unredeemed settled winnings
  const effectiveBalance = onChainBalance + deployedCapital + pendingRedeem;
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
      (pendingRedeem > 0 ? ` + $${pendingRedeem.toFixed(2)} unredeemed` : '') +
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
