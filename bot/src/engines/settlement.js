/**
 * Position settlement — handles market expiry, switch, and stale positions.
 *
 * Stateless module: receives all dependencies via params/actions callbacks.
 * Side effects (trade recording, notifications) are performed by the caller
 * through the `actions` object (dependency injection).
 *
 * Extracted from loop.js lines 273-322, 418-489, 643-732, 736-808.
 */

import { createLogger } from '../logger.js';
import { CONFIG } from '../config.js';

const log = createLogger('Settlement');

/**
 * Settle a position using Polymarket oracle resolution.
 * Polls up to 3 attempts with exponential backoff, then falls back to BTC price comparison.
 *
 * @param {Object} pos - Position with { side, marketSlug, ... }
 * @param {string|null} conditionId - Polymarket condition ID for oracle query
 * @param {number|null} fallbackBtcPrice - BTC price for legacy fallback
 * @param {number|null} ptbValue - Price-to-beat for legacy fallback
 * @returns {Promise<{ won: boolean, outcome: string|null, source: string }>}
 */
export async function settleViaOracle(pos, conditionId, fallbackBtcPrice, ptbValue) {
  // Oracle with 2 retries + exponential backoff
  if (conditionId) {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `${CONFIG.clobBaseUrl}/markets/${conditionId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const market = await res.json();
          if (market.closed) {
            const tokens = Array.isArray(market.tokens) ? market.tokens : [];
            const winner = tokens.find(t => t.winner === true);
            if (winner) {
              const outcome = winner.outcome.toUpperCase();
              const won = pos.side === outcome;
              return { won, outcome, source: 'oracle' };
            }
          }
          // H6: Market not closed yet — retry after delay (oracle may need time to settle)
          if (attempt < MAX_RETRIES) {
            log.debug(`Oracle: market not closed yet (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying after ${(attempt + 1)}s`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          break; // All retries exhausted, market still not closed
        }
      } catch (err) {
        log.debug(`Oracle fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s backoff
        }
      }
    }
    log.warn('Oracle: market not closed or no winner after retries — falling back to BTC price comparison');
  }

  // 2. Fallback: BTC price comparison (legacy behavior)
  if (fallbackBtcPrice != null && ptbValue != null) {
    const outcome = fallbackBtcPrice >= ptbValue ? 'UP' : 'DOWN';
    return { won: pos.side === outcome, outcome, source: 'price_fallback' };
  }

  // 3. Last resort: unknown — settle as loss
  return { won: false, outcome: null, source: 'unknown' };
}

/**
 * Settle a regular (non-ARB) position with full side-effect handling.
 * Shared logic used by handleExpiry, handleSwitch, and handleStalePosition.
 *
 * @param {Object} pos - The position to settle
 * @param {string|null} conditionId - Oracle condition ID
 * @param {number} btcPrice - Current BTC price
 * @param {number|null} ptbValue - Price-to-beat (null if stale)
 * @param {string} priceSource - Source of BTC price ('oracle'|'binance'|'entry')
 * @param {string} context - Label for logging ('expired'|'switched'|'stale')
 * @param {Object} actions - Side-effect callbacks
 * @returns {Promise<{ won: boolean, pnl: number, outcome: string|null, source: string }>}
 */
async function settleRegularPosition(pos, conditionId, btcPrice, ptbValue, priceSource, context, actions) {
  const { won, outcome, source } = await settleViaOracle(pos, conditionId, btcPrice, ptbValue);

  if (source === 'price_fallback' && ptbValue != null && btcPrice != null) {
    const pctFromPtb = Math.abs(btcPrice - ptbValue) / ptbValue;
    if (pctFromPtb < 0.001) {
      log.warn(`Settlement UNCERTAIN: BTC $${btcPrice.toFixed(2)} within 0.1% of PTB $${ptbValue.toFixed(2)} (${priceSource})`);
    }
  }

  // FINTECH: Round P&L to cents to prevent floating-point noise in journal/dashboard
  const pnl = Math.round((won ? (pos.size - pos.cost) : -pos.cost) * 100) / 100;
  log.info(`Position ${context} — ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
  actions.settleTrade(won);
  actions.invalidateUsdcSync();
  actions.clearEntrySnapshot();
  actions.writeJournalEntry({
    outcome: won ? 'WIN' : 'LOSS',
    pnl,
    exitData: { outcome, source, btcPrice, priceToBeat: ptbValue, priceSource },
  });
  if (!won) actions.recordLoss();
  if (outcome) actions.settlePrediction(pos.marketSlug, outcome);
  if (actions.notifyTrade) {
    actions.notifyTrade(
      `${won ? '✅ WIN' : '❌ LOSS'}: ${pos.side} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | $${actions.getBankroll().toFixed(2)}`
    );
  }
  return { won, pnl, outcome, source };
}

/**
 * Settle an ARB position (guaranteed win).
 */
function settleArbPosition(pos, btcPrice, ptbValue, context, actions) {
  const arbPnl = Math.round((pos.size - pos.cost) * 100) / 100; // FINTECH: round to cents
  log.info(`ARB position settled (${context}) — guaranteed WIN | P&L: +$${arbPnl.toFixed(2)}`);
  actions.settleTrade(true);
  actions.invalidateUsdcSync();
  actions.clearEntrySnapshot();
  actions.writeJournalEntry({
    outcome: 'WIN', pnl: arbPnl,
    exitData: { btcPrice, priceToBeat: ptbValue },
  });
  if (actions.notifyTrade) {
    actions.notifyTrade(`✅ ARB WIN | P&L: +$${arbPnl.toFixed(2)} | $${actions.getBankroll().toFixed(2)}`);
  }
  return { won: true, pnl: arbPnl, outcome: 'ARB_WIN', source: 'arb' };
}

/**
 * Resolve BTC price + price-to-beat for settlement.
 * @returns {{ btcPrice: number, priceSource: string, ptbValue: number|null }}
 */
function resolveSettlementPrices(pos, slug, priceToBeat, getOraclePrice, getBinancePrice) {
  const oraclePrice = getOraclePrice();
  const wsPrice = getBinancePrice();
  const btcPrice = oraclePrice || wsPrice || pos.price;
  const priceSource = oraclePrice ? 'oracle' : wsPrice ? 'binance' : 'entry';
  const ptbValue = priceToBeat.value;
  const ptbFresh = ptbValue != null && priceToBeat.slug === slug;
  return { btcPrice, priceSource, ptbValue: ptbFresh ? ptbValue : null, ptbRaw: ptbValue };
}

/**
 * Check double-settlement guard.
 * @returns {boolean} true if settlement should be skipped
 */
function isDoubleSettlement(pos, now, getLastSettled) {
  const ls = getLastSettled();
  return pos.marketSlug === ls.slug && (now - ls.ts) < 30_000;
}

/**
 * Handle market expiry.
 * @param {Object} params - { pos, currentMarketSlug, currentConditionId, priceToBeat, now }
 * @param {Object} deps - { getLastSettled, setLastSettled, getOraclePrice, getBinancePrice }
 * @param {Object} actions - Side-effect callbacks
 */
export async function handleExpiry({ pos, currentMarketSlug, currentConditionId, priceToBeat, now }, deps, actions) {
  if (isDoubleSettlement(pos, now, deps.getLastSettled)) {
    log.warn(`Double settlement prevented for ${pos.marketSlug} (settled ${((now - deps.getLastSettled().ts) / 1000).toFixed(0)}s ago)`);
    if (!pos.settled) actions.unwindPosition();
    return;
  }

  if (pos.marketSlug !== currentMarketSlug) return;

  const { btcPrice, priceSource, ptbValue, ptbRaw } = resolveSettlementPrices(
    pos, currentMarketSlug, priceToBeat, deps.getOraclePrice, deps.getBinancePrice
  );
  const conditionId = pos.conditionId ?? currentConditionId;

  if (pos.side === 'ARB') {
    settleArbPosition(pos, btcPrice, ptbRaw, 'expired', actions);
  } else {
    await settleRegularPosition(pos, conditionId, btcPrice, ptbValue, priceSource, 'expired', actions);
  }
  deps.setLastSettled(pos.marketSlug, Date.now());
}

/**
 * Handle market switch settlement.
 * @param {Object} params - { pos, oldSlug, currentConditionId, priceToBeat, now }
 * @param {Object} deps - { getLastSettled, setLastSettled, getOraclePrice, getBinancePrice }
 * @param {Object} actions - Side-effect callbacks
 */
export async function handleSwitch({ pos, oldSlug, currentConditionId, priceToBeat, now }, deps, actions) {
  if (isDoubleSettlement(pos, now, deps.getLastSettled)) {
    log.warn(`Double settlement prevented on switch for ${pos.marketSlug} (settled ${((now - deps.getLastSettled().ts) / 1000).toFixed(0)}s ago)`);
    if (!pos.settled) actions.unwindPosition();
    return;
  }

  if (pos.marketSlug !== oldSlug) return;

  const { btcPrice, priceSource, ptbValue, ptbRaw } = resolveSettlementPrices(
    pos, oldSlug, priceToBeat, deps.getOraclePrice, deps.getBinancePrice
  );
  const conditionId = pos.conditionId ?? currentConditionId;

  if (pos.side === 'ARB') {
    settleArbPosition(pos, btcPrice, ptbRaw, 'switched', actions);
  } else {
    await settleRegularPosition(pos, conditionId, btcPrice, ptbValue, priceSource, 'switched', actions);
  }
  deps.setLastSettled(pos.marketSlug, Date.now());
}

/**
 * Handle stale position recovery (bot restart with position from past market).
 * @param {Object} params - { pos, currentMarketSlug }
 * @param {Object} deps - { getOraclePrice, getBinancePrice }
 * @param {Object} actions - Side-effect callbacks including setLastSettled
 */
export async function handleStalePosition({ pos, currentMarketSlug, now }, deps, actions) {
  // Double-settlement guard
  if (now && deps.getLastSettled && isDoubleSettlement(pos, now ?? Date.now(), deps.getLastSettled)) {
    log.warn(`Double settlement prevented for stale ${pos.marketSlug}`);
    if (!pos.settled) actions.unwindPosition();
    return;
  }

  log.warn(`STALE POSITION detected: ${pos.side} on ${pos.marketSlug} (current market: ${currentMarketSlug})`);

  const oracleCondId = pos.conditionId;
  if (oracleCondId) {
    // Has conditionId → try oracle settlement
    const oraclePrice = deps.getOraclePrice();
    const btcPrice = oraclePrice || deps.getBinancePrice();
    const { won, outcome, source } = await settleViaOracle(pos, oracleCondId, btcPrice, null);
    log.info(`Stale position settled: ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
    actions.settleTrade(won);
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({
      outcome: won ? 'WIN' : 'LOSS',
      pnl: Math.round((won ? (pos.size - pos.cost) : -pos.cost) * 100) / 100,
      exitData: { outcome, source, staleRecovery: true },
    });
    if (!won) actions.recordLoss();
    if (outcome) actions.settlePrediction(pos.marketSlug, outcome);
    actions.setLastSettled(pos.marketSlug, Date.now());
    return;
  }

  if (!pos.fillConfirmed) {
    // No conditionId + fill never confirmed → order likely never filled → unwind
    log.warn('Stale position has no conditionId and fill was never confirmed — unwinding (returning $' + pos.cost.toFixed(2) + ')');
    actions.unwindPosition();
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: { staleRecovery: true, reason: 'no_conditionId_no_fill' } });
    return;
  }

  // Fill confirmed but no conditionId — try Gamma API lookup by slug
  log.warn('Stale position has no conditionId but fill confirmed — attempting Gamma API lookup');
  let fetchedConditionId = null;
  try {
    const gammaUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(pos.marketSlug)}`;
    const gammaRes = await fetch(gammaUrl, { signal: AbortSignal.timeout(5000) });
    if (gammaRes.ok) {
      const gammaMarkets = await gammaRes.json();
      fetchedConditionId = gammaMarkets?.[0]?.conditionId ?? gammaMarkets?.[0]?.condition_id ?? null;
      if (fetchedConditionId) log.info(`Gamma API found conditionId for stale position: ${fetchedConditionId}`);
    }
  } catch (err) {
    log.debug(`Gamma API lookup failed for stale position: ${err.message}`);
  }

  if (fetchedConditionId) {
    const oraclePrice = deps.getOraclePrice();
    const btcPrice = oraclePrice || deps.getBinancePrice();
    const { won, outcome, source } = await settleViaOracle(pos, fetchedConditionId, btcPrice, null);
    log.info(`Stale position (Gamma lookup) settled: ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
    actions.settleTrade(won);
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({
      outcome: won ? 'WIN' : 'LOSS',
      pnl: Math.round((won ? (pos.size - pos.cost) : -pos.cost) * 100) / 100,
      exitData: { outcome, source, staleRecovery: true, reason: 'gamma_lookup' },
    });
    if (!won) actions.recordLoss();
    if (outcome) actions.settlePrediction(pos.marketSlug, outcome);
  } else {
    // Truly no conditionId available → settle as LOSS (conservative)
    log.warn('Stale position: Gamma API lookup failed — settling as LOSS (conservative)');
    actions.settleTrade(false);
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({
      outcome: 'LOSS', pnl: Math.round(-pos.cost * 100) / 100,
      exitData: { staleRecovery: true, reason: 'no_conditionId_fill_confirmed' },
    });
    actions.recordLoss();
  }
  actions.setLastSettled(pos.marketSlug, Date.now());
}
