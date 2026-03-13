/**
 * USDC balance reconciliation — syncs local bankroll with on-chain USDC balance.
 *
 * Safety rules:
 * - Skip sync after settlement (on-chain USDC stale until ERC1155 tokens redeemed)
 * - Skip sync if bankroll changed during async fetch (trade happened during gap)
 * - Reject obviously invalid API responses (< 0 or > $100K)
 *
 * Extracted from loop.js lines 209, 249-251, 336-344, 600-641.
 */

import { createLogger } from '../logger.js';

const log = createLogger('UsdcSync');

const USDC_BALANCE_INTERVAL = 30_000;

// ── State ──
let pendingUsdcSync = null;
let usdcBalanceData = null;
let usdcBalanceLastFetchMs = 0;
let reconcileCooldownUntil = 0; // block syncs during/after reconciliation

/**
 * Apply any pending USDC sync (called at top of each poll).
 * @param {Function} getBankroll
 * @param {Function} setBankroll
 */
export function applyPendingSync(getBankroll, setBankroll) {
  if (pendingUsdcSync !== null) {
    // Block sync if reconciler recently adjusted bankroll — on-chain USDC doesn't
    // reflect reconciler P&L corrections, so syncing would revert them.
    if (Date.now() < reconcileCooldownUntil) {
      log.debug(`USDC sync blocked: reconcile cooldown active (${Math.ceil((reconcileCooldownUntil - Date.now()) / 1000)}s left)`);
      pendingUsdcSync = null;
      return;
    }
    const syncVal = pendingUsdcSync;
    pendingUsdcSync = null;
    const current = getBankroll();
    if (Math.abs(current - syncVal) > 0.01) {
      log.info(`USDC sync: $${current.toFixed(2)} → $${syncVal.toFixed(2)}`);
      setBankroll(syncVal);
    }
  }
}

/**
 * Schedule a non-blocking USDC balance check.
 * Runs in background via .then() — does not block the poll loop.
 *
 * @param {Object} params
 * @param {number} params.now
 * @param {boolean} params.settlementCooldownActive
 * @param {boolean} params.clientReady
 * @param {Function} params.fetchBalance - async () => { balance, allowance, fetchedAt } | null
 * @param {Function} params.getBankroll
 * @param {Function} params.getCurrentPosition
 * @param {Function} params.getPendingCost
 */
export function scheduleUsdcCheck({
  now, settlementCooldownActive, clientReady,
  fetchBalance, getBankroll, getCurrentPosition, getPendingCost,
}) {
  if (settlementCooldownActive) return;
  if (now < reconcileCooldownUntil) return; // skip fetch during reconcile cooldown
  if (now - usdcBalanceLastFetchMs <= USDC_BALANCE_INTERVAL) return;
  if (!clientReady) return;

  usdcBalanceLastFetchMs = now; // Set BEFORE fetch to prevent parallel fetches
  const snapshotBankroll = getBankroll(); // Capture BEFORE async fetch

  fetchBalance().then(result => {
    if (!result) return;
    const prev = usdcBalanceData;
    usdcBalanceData = result;
    const localBankroll = getBankroll();
    const onChain = result.balance;
    const drift = Math.abs(localBankroll - onChain);

    if (!prev) {
      log.info(`USDC balance: on-chain=$${onChain.toFixed(2)} | local=$${localBankroll.toFixed(2)} | drift=$${drift.toFixed(2)}`);
    }

    // Race guard: if bankroll changed between fetch start and callback,
    // a trade was recorded during the async gap — skip sync this cycle
    if (Math.abs(localBankroll - snapshotBankroll) > 0.01) {
      log.debug(`USDC sync skipped: bankroll changed during fetch ($${snapshotBankroll.toFixed(2)} -> $${localBankroll.toFixed(2)})`);
      return;
    }

    const pos = getCurrentPosition();
    const hasPos = pos && !pos.settled;
    const hasPendingCost = getPendingCost() > 0;

    // Sanity check: reject obviously invalid API responses
    if (onChain < 0 || onChain > 100_000) {
      log.warn(`SYNC REJECTED: on-chain=$${onChain.toFixed(2)} looks invalid (out of range)`);
    } else if (drift > 0.01 && !hasPos && !hasPendingCost) {
      log.info(`AUTO-SYNC queued: local=$${localBankroll.toFixed(2)} -> on-chain=$${onChain.toFixed(2)} (drift $${drift.toFixed(2)})`);
      pendingUsdcSync = onChain;
    } else if (drift > 1.0 && (hasPos || hasPendingCost)) {
      log.warn(`DRIFT: local=$${localBankroll.toFixed(2)} vs on-chain=$${onChain.toFixed(2)} (drift $${drift.toFixed(2)}, ${hasPos ? 'position open' : 'pending cost'} — deferring sync)`);
    }
  }).catch(err => { log.debug(`USDC balance error: ${err.message}`); });
}

/**
 * Queue a specific USDC balance for sync (e.g. from startup reconciliation).
 */
export function queueSync(value) {
  pendingUsdcSync = value;
}

/**
 * Invalidate any pending sync (e.g. after settlement).
 */
export function invalidateSync() {
  pendingUsdcSync = null;
}

/**
 * Block USDC syncs for `durationMs` — used by reconciler to prevent
 * on-chain USDC balance from overwriting reconciler P&L corrections.
 * On-chain USDC doesn't include unredeemed ERC-1155 token value,
 * so syncing during/after reconciliation would revert corrections.
 */
export function setReconcileCooldown(durationMs) {
  reconcileCooldownUntil = Date.now() + durationMs;
  pendingUsdcSync = null; // also clear any stale queued sync
  log.debug(`Reconcile cooldown set: ${(durationMs / 1000).toFixed(0)}s`);
}

/**
 * Check if reconcile cooldown is active.
 */
export function isReconcileCooldownActive() {
  return Date.now() < reconcileCooldownUntil;
}

/**
 * Get current USDC balance data for dashboard broadcast.
 */
export function getUsdcBalanceData() {
  return usdcBalanceData;
}

/**
 * Force the next USDC check to run immediately by resetting the fetch timer.
 * Called by redeemer after successful on-chain redemption so bankroll syncs
 * within ~30s instead of waiting for settlement cooldown to expire.
 */
export function queueUsdcSyncAfterRedeem() {
  usdcBalanceLastFetchMs = 0; // Reset timer — next scheduleUsdcCheck will fetch immediately
  reconcileCooldownUntil = 0; // Clear reconcile cooldown
  log.info('USDC sync queued after redeem — will fetch on next poll');
}

/**
 * Force-sync local bankroll with on-chain USDC balance.
 * Bypasses all guards (settlement cooldown, open position, race detection).
 * Used by dashboard forceSync command for manual reconciliation.
 *
 * @param {Function} fetchBalance - async () => { balance, allowance, fetchedAt } | null
 * @param {Function} getBankroll
 * @param {Function} setBankroll
 * @returns {{ ok, action?, prev?, onChain?, drift?, error? }}
 */
export async function forceUsdcSync(fetchBalance, getBankroll, setBankroll) {
  let result;
  try {
    result = await fetchBalance();
  } catch (err) {
    log.warn(`forceSync fetch error: ${err.message}`);
    return { ok: false, error: 'fetch_failed' };
  }
  if (!result || !Number.isFinite(result.balance)) {
    return { ok: false, error: 'fetch_failed' };
  }
  const onChain = result.balance;
  if (onChain < 0 || onChain > 100_000) {
    return { ok: false, error: 'invalid_balance', balance: onChain };
  }
  const prev = getBankroll();
  const drift = Math.abs(prev - onChain);
  if (drift < 0.01) {
    log.info(`forceSync: no change needed (local=$${prev.toFixed(2)}, on-chain=$${onChain.toFixed(2)})`);
    return { ok: true, action: 'no_change', local: prev, onChain, drift };
  }
  setBankroll(onChain);
  usdcBalanceData = result;   // update cached data
  pendingUsdcSync = null;     // clear any queued sync
  log.info(`forceSync: $${prev.toFixed(2)} → $${onChain.toFixed(2)} (drift $${drift.toFixed(2)})`);
  return { ok: true, action: 'synced', prev, onChain, drift };
}
