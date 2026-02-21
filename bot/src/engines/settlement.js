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
import { notify } from '../monitoring/notifier.js';

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
  // Fix: 7 retries, ~135s total — Polymarket BTC 15m oracle typically closes 1-3 min after expiry.
  // Delays: 5, 10, 15, 20, 25, 30, 30 = 135s before falling back to Gamma API / price_fallback.
  if (conditionId) {
    const MAX_RETRIES = 7;
    const RETRY_DELAYS_MS = [5000, 10000, 15000, 20000, 25000, 30000, 30000];
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const url = `${CONFIG.clobBaseUrl}/markets/${conditionId}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
          const market = await res.json();
          if (market.closed) {
            const tokens = Array.isArray(market.tokens) ? market.tokens : [];
            const winner = tokens.find(t => t.winner === true);
            if (winner) {
              const outcome = winner.outcome.toUpperCase();
              const won = pos.side === outcome;
              log.info(`Oracle (CLOB): ${outcome} — ${won ? 'WIN' : 'LOSS'} (attempt ${attempt + 1})`);
              return { won, outcome, source: 'oracle' };
            }
          }
          // Market not closed yet — retry after delay
          if (attempt < MAX_RETRIES) {
            const delayMs = RETRY_DELAYS_MS[attempt] ?? 30000;
            log.debug(`Oracle: market not closed yet (attempt ${attempt + 1}/${MAX_RETRIES + 1}) — retrying after ${delayMs / 1000}s`);
            await new Promise(r => setTimeout(r, delayMs));
            continue;
          }
          break; // All retries exhausted, market still not closed
        }
      } catch (err) {
        log.debug(`Oracle fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          const delayMs = RETRY_DELAYS_MS[attempt] ?? 30000;
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }
    log.warn('Oracle (CLOB): market not closed after 135s — trying Gamma API oracle');

    // ── Gamma API as secondary oracle ──
    // Gamma API often has market resolution data even when CLOB is lagging.
    // Query by conditionId → check closed + outcomePrices (1.00 = winner, 0.00 = loser).
    if (pos.marketSlug) {
      try {
        const gammaUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(pos.marketSlug)}`;
        const gammaRes = await fetch(gammaUrl, { signal: AbortSignal.timeout(8000) });
        if (gammaRes.ok) {
          const gammaData = await gammaRes.json();
          const gm = Array.isArray(gammaData) ? gammaData[0] : gammaData;

          if (gm?.closed === true) {
            // Try tokens array first (same format as CLOB)
            const tokens = Array.isArray(gm.tokens) ? gm.tokens : [];
            const winner = tokens.find(t => t.winner === true);
            if (winner) {
              const outcome = winner.outcome.toUpperCase();
              const won = pos.side === outcome;
              log.info(`Oracle (Gamma tokens): ${outcome} — ${won ? 'WIN' : 'LOSS'}`);
              return { won, outcome, source: 'gamma_oracle' };
            }

            // Try outcomePrices: ["1", "0"] or ["0", "1"] — winner has price ~1.00
            const rawOutcomes = gm.outcomes;
            const rawPrices = gm.outcomePrices;
            const outcomes = Array.isArray(rawOutcomes) ? rawOutcomes
              : (typeof rawOutcomes === 'string' ? (() => { try { return JSON.parse(rawOutcomes); } catch { return []; } })() : []);
            const prices = Array.isArray(rawPrices) ? rawPrices
              : (typeof rawPrices === 'string' ? (() => { try { return JSON.parse(rawPrices); } catch { return []; } })() : []);

            for (let i = 0; i < outcomes.length; i++) {
              if (parseFloat(prices[i]) > 0.99) {
                const outcome = String(outcomes[i]).toUpperCase();
                const won = pos.side === outcome;
                log.info(`Oracle (Gamma outcomePrices): ${outcome} — ${won ? 'WIN' : 'LOSS'}`);
                return { won, outcome, source: 'gamma_oracle' };
              }
            }

            log.warn('Gamma API: market closed but no winner found in tokens/outcomePrices');
          } else {
            log.debug(`Gamma API: market not closed yet (closed=${gm?.closed})`);
          }
        }
      } catch (err) {
        log.debug(`Gamma API oracle failed: ${err.message}`);
      }
    }

    log.warn('Oracle (CLOB + Gamma): both exhausted — falling back to BTC price comparison');
  }

  // 3. Fallback: BTC price comparison (legacy behavior)
  if (fallbackBtcPrice != null && ptbValue != null) {
    const outcome = fallbackBtcPrice >= ptbValue ? 'UP' : 'DOWN';
    return { won: pos.side === outcome, outcome, source: 'price_fallback' };
  }

  // 4. Last resort: unknown — settle as loss
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
    const gapPct = (pctFromPtb * 100).toFixed(3);
    // Risk label based on gap from PTB (closer = less reliable)
    const riskLabel = pctFromPtb < 0.001 ? '🔴 SANGAT BERISIKO (gap <0.1%)' :
                      pctFromPtb < 0.005 ? '🟠 Berisiko (gap <0.5%)' :
                      pctFromPtb < 0.01  ? '🟡 Hati-hati (gap <1%)' : '🟢 Gap cukup aman';
    log.warn(`Settlement price_fallback: BTC $${btcPrice.toFixed(2)} vs PTB $${ptbValue.toFixed(2)} (${gapPct}% gap) | ${riskLabel}`);
    notify('warn', [
      `⚠️ Settlement <b>price_fallback</b>`,
      `Oracle CLOB + Gamma gagal setelah ~2 menit`,
      ``,
      `Sisi: <b>${pos.side}</b> | Hasil: <b>${won ? 'WIN' : 'LOSS'}</b>`,
      `₿ BTC: $${btcPrice.toFixed(0)} vs PTB: $${ptbValue.toFixed(0)}`,
      `Gap: ${gapPct}% | ${riskLabel}`,
      ``,
      `<i>journalReconciler akan verifikasi ulang dalam ~30 menit</i>`,
    ].join('\n'), { key: `fallback:${pos.marketSlug ?? conditionId}` }).catch(() => {});
  }

  // FINTECH: Round P&L to cents. Subtract 2% Polymarket fee on profit (matches positionTracker math).
  // Without this, journal shows gross profit but bankroll gets net profit after fee.
  const POLY_FEE_RATE = 0.02;
  let pnl;
  if (won) {
    const grossProfit = Math.max(0, pos.size - pos.cost);
    const fee = Math.round(grossProfit * POLY_FEE_RATE * 100) / 100;
    pnl = Math.round((pos.size - pos.cost - fee) * 100) / 100;
  } else {
    pnl = Math.round(-pos.cost * 100) / 100;
  }
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
    // H7: Apply 2% Polymarket fee on profit consistently (matches settleRegularPosition)
    const POLY_FEE_RATE_STALE = 0.02;
    let stalePnl;
    if (won) {
      const grossProfit = Math.max(0, pos.size - pos.cost);
      const fee = Math.round(grossProfit * POLY_FEE_RATE_STALE * 100) / 100;
      stalePnl = Math.round((pos.size - pos.cost - fee) * 100) / 100;
    } else {
      stalePnl = Math.round(-pos.cost * 100) / 100;
    }
    actions.settleTrade(won);
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({
      outcome: won ? 'WIN' : 'LOSS',
      pnl: stalePnl,
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
    // H7: Apply 2% fee consistently (matches settleRegularPosition)
    let gammaPnl;
    if (won) {
      const gp = Math.max(0, pos.size - pos.cost);
      const gFee = Math.round(gp * 0.02 * 100) / 100;
      gammaPnl = Math.round((pos.size - pos.cost - gFee) * 100) / 100;
    } else {
      gammaPnl = Math.round(-pos.cost * 100) / 100;
    }
    log.info(`Stale position (Gamma lookup) settled: ${outcome ?? '?'} → ${won ? 'WIN' : 'LOSS'} (${source})`);
    actions.settleTrade(won);
    actions.invalidateUsdcSync();
    actions.clearEntrySnapshot();
    actions.writeJournalEntry({
      outcome: won ? 'WIN' : 'LOSS',
      pnl: gammaPnl,
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
