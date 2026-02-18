/**
 * Trade execution pipeline — handles arb and directional trade entry.
 *
 * Stateless module: no owned state. Receives all dependencies via params.
 * Side effects (order placement, position recording) performed via callbacks.
 *
 * Extracted from loop.js lines 1167-1452.
 */

import { createLogger } from '../logger.js';
import { getSessionName } from '../../../src/utils.js';
import { EXECUTION } from '../../../src/config.js';

const log = createLogger('TradePipeline');

/**
 * Compute FOK buy limit price with adaptive slippage tolerance.
 * Audit fix H: Fixed slippage (1 cent) was 10% at $0.10 but only 1% at $0.90.
 * Now uses max(fixed minimum, 2% of target price) for proportional tolerance.
 * FOK fills at the best available price UP TO the limit — you still pay the actual ask.
 * Polymarket prices: [0.01, 0.99], precision 0.001.
 */
function fokBuyPrice(targetPrice, spread) {
  const fixedSlippage = EXECUTION.FOK_SLIPPAGE ?? 0.01;
  const pctSlippage = targetPrice * 0.02; // 2% of target price
  const spreadSlippage = (spread != null && Number.isFinite(spread)) ? spread * 0.5 : 0;
  const slippage = Math.max(fixedSlippage, pctSlippage, spreadSlippage);
  // Round to Polymarket's 0.001 tick size, cap at 0.99
  return Math.min(Math.round((targetPrice + slippage) * 1000) / 1000, 0.99);
}

/**
 * Safely parse a CLOB amount field (makingAmount / takingAmount).
 * Returns null if the value is missing, NaN, negative, or unreasonably large.
 */
function parseClobAmount(value, fallback = null) {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return fallback;
  return n;
}

/**
 * Execute arbitrage trade (buy UP + DOWN for riskless profit).
 *
 * @param {Object} params
 * @param {Object} params.arb - Arbitrage detection result
 * @param {Object} params.poly - Polymarket snapshot (for token IDs)
 * @param {string} params.marketSlug - Current market slug
 * @param {string|null} params.currentConditionId - Oracle condition ID
 * @param {Object} params.regimeInfo - Current regime
 * @param {Object} params.rec - Decision recommendation
 * @param {Object} params.priceToBeat - { slug, value }
 * @param {number} params.lastPrice - Current BTC price
 * @param {boolean} params.dryRun - Whether in dry-run mode
 * @param {Object} deps - Dependencies (functions)
 */
export async function executeArbitrage({
  arb, poly, marketSlug, currentConditionId, regimeInfo, rec, priceToBeat, lastPrice,
  orderbookUp, orderbookDown, dryRun,
}, deps) {
  const arbBudget = deps.getAvailableBankroll() * 0.10; // 10% of available bankroll

  // Cap arb size to available orderbook liquidity at the target price.
  // Without this, we'd try to fill more shares than what's available at the ask,
  // causing FOK rejection or worse price fills.
  const upAskLiq = orderbookUp?.askLiquidity ?? Infinity;
  const downAskLiq = orderbookDown?.askLiquidity ?? Infinity;
  const minAskLiq = Math.min(upAskLiq, downAskLiq);

  const budgetShares = Math.floor(arbBudget / arb.totalCost);
  const liqShares = Number.isFinite(minAskLiq) && minAskLiq > 0
    ? Math.floor(minAskLiq) // askLiquidity is in dollar terms (top 5 levels)
    : budgetShares;
  const arbShares = Math.min(budgetShares, liqShares);

  if (liqShares < budgetShares && Number.isFinite(minAskLiq)) {
    log.info(`ARB size capped by liquidity: ${budgetShares} → ${arbShares} shares (ask liq: UP=$${upAskLiq.toFixed(0)} DOWN=$${downAskLiq.toFixed(0)})`);
  }

  const estCost = Math.round(arbShares * arb.totalCost * 100) / 100;

  if (arbShares <= 0) return;

  if (dryRun) {
    log.info(
      `[DRY RUN] ARB: Would BUY ${arbShares} UP@${arb.askUp.toFixed(3)} + ${arbShares} DOWN@${arb.askDown.toFixed(3)} | ` +
      `Cost: $${estCost.toFixed(2)} | Net profit: $${(arbShares * arb.netProfit).toFixed(2)} (${arb.profitPct.toFixed(1)}%)`
    );
    return;
  }

  // Reserve capital before arb attempt
  deps.setPendingCost(estCost);
  try {
    // Leg 1: Buy UP (FOK with slippage to prevent rejection on tiny price moves)
    const upResult = await deps.placeBuyOrder({
      tokenId: poly.tokens.upTokenId,
      price: fokBuyPrice(arb.askUp),
      size: arbShares,
    });
    const upFillCost = parseClobAmount(upResult?.makingAmount, arbShares * arb.askUp);
    const upOrderId = upResult?.orderId ?? null;

    // Leg 2: Buy DOWN
    let arbLeg2Failed = false;
    try {
      const downResult = await deps.placeBuyOrder({
        tokenId: poly.tokens.downTokenId,
        price: fokBuyPrice(arb.askDown),
        size: arbShares,
      });
      const downFillCost = parseClobAmount(downResult?.makingAmount, arbShares * arb.askDown);
      const downOrderId = downResult?.orderId ?? null;

      // Both legs succeeded — record arb with actual fill costs
      deps.setPendingCost(0);
      try {
        deps.recordArbTrade({
          upCost: upFillCost,
          downCost: downFillCost,
          shares: arbShares,
          marketSlug,
          orderId: upOrderId,
          conditionId: currentConditionId ?? poly?.market?.conditionId ?? poly?.market?.condition_id ?? null,
        });
        deps.recordTradeForMarket(marketSlug);
      } catch (recErr) {
        log.error(`Arb recording failed (trades placed but not tracked): ${recErr.message}`);
      }
      // Track fills for both orders — mark confirmed if CLOB response had fill data
      const upConfirmed = !!(upResult?.makingAmount || upResult?.takingAmount);
      const downConfirmed = !!(downResult?.makingAmount || downResult?.takingAmount);
      if (upOrderId) deps.trackOrderPlacement(upOrderId, { tokenId: poly.tokens.upTokenId, price: arb.askUp, size: arbShares, side: 'ARB_UP', confirmed: upConfirmed });
      if (downOrderId) deps.trackOrderPlacement(downOrderId, { tokenId: poly.tokens.downTokenId, price: arb.askDown, size: arbShares, side: 'ARB_DOWN', confirmed: downConfirmed });
    } catch (downErr) {
      // ONE-LEGGED: Only UP bought, DOWN failed.
      // Audit fix C9: Attempt to UNWIND leg 1 instead of holding unvalidated directional exposure.
      // The UP position was entered without any signal validation (edge, ML, stability gates).
      arbLeg2Failed = true;
      deps.setPendingCost(0);
      log.error(`ARB leg 2 (DOWN) failed: ${downErr.message} — attempting to unwind leg 1 (UP)`);

      let unwindSucceeded = false;
      try {
        // Try to sell the UP tokens back at a slight discount
        const unwindResult = await deps.placeSellOrder?.({
          tokenId: poly.tokens.upTokenId,
          price: Math.max(0.01, Math.round((arb.askUp - 0.02) * 1000) / 1000), // 2 cent discount for fast fill
          size: arbShares,
        });
        if (unwindResult) {
          unwindSucceeded = true;
          const recovered = parseClobAmount(unwindResult?.takingAmount, arbShares * (arb.askUp - 0.02));
          log.info(`ARB leg 1 unwound: recovered $${(recovered || 0).toFixed(2)} of $${upFillCost.toFixed(2)}`);
        }
      } catch (unwindErr) {
        log.warn(`ARB leg 1 unwind failed: ${unwindErr.message} — falling back to directional position`);
      }

      if (!unwindSucceeded) {
        // Fallback: record as directional position (legacy behavior)
        const actualPrice = upFillCost / arbShares;
        deps.recordTrade({
          side: 'UP',
          tokenId: poly.tokens.upTokenId,
          conditionId: currentConditionId ?? poly?.market?.conditionId ?? poly?.market?.condition_id ?? null,
          price: actualPrice,
          size: arbShares,
          marketSlug,
          orderId: upOrderId,
          actualCost: upFillCost,
        });
        deps.setEntryRegime(regimeInfo?.regime ?? 'moderate');
        deps.recordTradeForMarket(marketSlug);
        if (upOrderId) deps.trackOrderPlacement(upOrderId, { tokenId: poly.tokens.upTokenId, price: arb.askUp, size: arbShares, side: 'UP', confirmed: !!(upResult?.makingAmount || upResult?.takingAmount) });
        deps.captureEntrySnapshot({
          side: 'UP', tokenPrice: arb.askUp, btcPrice: lastPrice,
          priceToBeat: priceToBeat.value, marketSlug,
          cost: upFillCost, size: arbShares,
          confidence: 'ARB_ONE_LEG', phase: rec?.phase, reason: 'arb_leg2_failed_unwind_failed',
          timeLeftMin: null, session: getSessionName(),
        });
        log.warn('One-legged arb: unwind failed — recorded as directional UP position');
      }
    }
  } catch (err) {
    deps.setPendingCost(0); // Release reservation on leg 1 failure
    log.error(`ARB leg 1 (UP) failed: ${err.message}`);
  }
}

/**
 * Execute directional trade (buy UP or DOWN based on signal).
 *
 * @param {Object} params - Signal data
 * @param {Object} deps - Dependencies (functions)
 * @returns {boolean} Whether trade was executed
 */
export async function executeDirectionalTrade({
  rec, betSide, betMarketPrice, betEnsembleProb, betSizing, edge,
  ensembleUp, timeAware, mlResult, mlAgreesWithRules,
  regimeInfo, poly, marketSlug, currentConditionId, priceToBeat,
  lastPrice, timeLeftMin, dryRun,
  // Signal stability
  signalConfirmCount, recentFlipCount,
  // Tilt
  tiltMarketsLeft, tiltMlConfMin,
  // Indicators for entry data
  rsiNow, rsiSlope, macd, vwapDist, vwapSlope,
  bb, atr, stochRsi, emaCross, volDelta,
  consec, delta1m, delta3m, orderbookSignal, orderbookUp,
  marketUp, marketDown, obFlow,
}, deps) {
  // ── Signal Confirmation Gate ──
  deps.updateConfirmation(rec.side);

  if (!deps.isSignalStable()) {
    const reasons = deps.getInstabilityReasons();
    log.info(`Signal unstable, holding: ${reasons.join(' | ')}`);
    return false;
  }

  // ── Tilt protection ──
  const effectiveMlConf = mlResult.available ? mlResult.mlConfidence : null;
  if (tiltMarketsLeft > 0 && effectiveMlConf != null && effectiveMlConf < tiltMlConfMin) {
    log.info(`Tilt protection active: ML conf ${(effectiveMlConf * 100).toFixed(0)}% < ${tiltMlConfMin * 100}% (${tiltMarketsLeft} markets left) — will raise threshold in filters`);
  }

  // ── Smart trade filters ──
  const filterResult = deps.applyTradeFilters({
    mlConfidence: effectiveMlConf,
    mlAvailable: mlResult.available,
    marketPrice: betMarketPrice,
    atrRatio: atr?.atrRatio ?? null,
    timeLeftMin,
    marketSlug,
    consecutiveLosses: deps.getConsecutiveLosses(),
    session: getSessionName(),
    btcPrice: lastPrice,
    priceToBeat: priceToBeat.value,
    tiltMlConfMin: tiltMarketsLeft > 0 ? tiltMlConfMin : null,
    bestEdge: edge.bestEdge,
    delta1m,
    signalSide: rec.side,
    regime: regimeInfo?.regime ?? 'moderate',
  });

  // Orderbook flow alignment check
  const flowAlign = deps.checkFlowAlignment(betSide);

  if (!filterResult.pass) {
    log.info(`Smart filter blocked: ${filterResult.reasons.join(' | ')}`);
    return false;
  }

  const priceCheck = deps.validatePrice(betMarketPrice);
  const tradeCheck = deps.validateTrade({
    rec, betSizing, timeLeftMin,
    bankroll: deps.getBankroll(),
    availableBankroll: deps.getAvailableBankroll(),
    hasPosition: deps.hasOpenPosition(marketSlug),
  });

  if (!priceCheck.valid || !tradeCheck.valid) {
    log.info(`Trade blocked: ${!priceCheck.valid ? priceCheck.reason : tradeCheck.reason}`);
    return false;
  }

  const tokenId = betSide === 'UP' ? poly.tokens.upTokenId : poly.tokens.downTokenId;
  const shares = Math.floor(betSizing.betAmount / betMarketPrice);

  // H9: Guard against 0 shares (e.g. betAmount < marketPrice)
  if (shares <= 0) {
    log.info(`Trade skipped: 0 shares (betAmount=$${betSizing.betAmount.toFixed(2)} / price=$${betMarketPrice.toFixed(3)})`);
    return false;
  }

  // Flow alignment info for logging
  const flowTag = flowAlign.signal !== 'INSUFFICIENT_DATA'
    ? ` | Flow:${flowAlign.signal}${flowAlign.agrees ? '(agree)' : '(DISAGREE)'}`
    : '';

  // Reserve bankroll — FINTECH: round to cents to prevent float drift in available bankroll
  const orderCost = Math.round(shares * betMarketPrice * 100) / 100;
  deps.setPendingCost(orderCost);

  // Build entry snapshot data (shared by DRY_RUN + live paths)
  const session = getSessionName();
  const entryData = {
    side: betSide, tokenPrice: betMarketPrice, btcPrice: lastPrice,
    priceToBeat: priceToBeat.value, marketSlug, cost: orderCost, size: shares,
    confidence: rec.confidence, phase: rec.phase, reason: rec.reason,
    edgeUp: edge.edgeUp, edgeDown: edge.edgeDown, bestEdge: edge.bestEdge,
    ensembleUp, ruleUp: timeAware.adjustedUp,
    mlProbUp: mlResult.mlProbUp, mlConfidence: mlResult.mlConfidence,
    mlSide: mlResult.mlSide, mlAgreesWithRules,
    rsiNow, rsiSlope, macdHist: macd?.hist, macdLine: macd?.line,
    vwapDist, vwapSlope,
    bbPercentB: bb?.percentB, bbWidth: bb?.width, bbSqueeze: bb?.squeeze,
    atrPct: atr?.atrPct, atrRatio: atr?.atrRatio,
    stochK: stochRsi?.k, stochD: stochRsi?.d,
    emaCrossSignal: emaCross?.cross, emaDistPct: emaCross?.distancePct,
    volDeltaBuyRatio: volDelta?.buyRatio,
    haColor: consec.color, haCount: consec.count,
    delta1m, delta3m,
    regime: regimeInfo.regime, regimeConfidence: regimeInfo.confidence,
    marketUp, marketDown,
    orderbookImbalance: orderbookSignal?.imbalance, spread: orderbookUp?.spread,
    timeLeftMin, session,
    betAmount: betSizing.betAmount, kellyFraction: betSizing.kellyFraction,
    riskLevel: betSizing.riskLevel, expectedValue: betSizing.expectedValue,
    signalConfirmCount, recentFlips: recentFlipCount,
  };

  if (dryRun) {
    deps.setPendingCost(0);
    deps.setEntryRegime(regimeInfo?.regime ?? 'moderate');
    // H8: Don't call recordTradeForMarket in dry-run — inflates counter, blocks real entries
    log.info(
      `[DRY RUN] Would BUY ${betSide}: ${shares} shares @ $${betMarketPrice.toFixed(3)} = $${(shares * betMarketPrice).toFixed(2)} | ` +
      `Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% (spread: -${(((edge.spreadPenaltyUp ?? 0) + (edge.spreadPenaltyDown ?? 0)) * 50).toFixed(1)}%) | ` +
      `Conf: ${rec.confidence}${flowTag} | ${betSizing.rationale}`
    );
    // Record prediction for accuracy tracking
    try {
      deps.recordPrediction({
        side: betSide, modelProb: betEnsembleProb,
        marketPrice: betMarketPrice, btcPrice: lastPrice,
        priceToBeat: priceToBeat.value, marketSlug,
        regime: regimeInfo.regime,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
      });
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }
    if (deps.notifyTrade) {
      deps.notifyTrade(
        `[DRY] ENTRY ${betSide} @ $${betMarketPrice.toFixed(3)} | ${shares} shares ($${(shares * betMarketPrice).toFixed(2)}) | Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% | ML: ${mlResult.available ? (mlResult.mlConfidence * 100).toFixed(0) + '%' : 'off'} | $${deps.getBankroll().toFixed(2)}`
      );
    }
    return true;
  }

  // ── Live order (FOK with slippage to prevent rejection on tiny price moves) ──
  try {
    const orderResult = await deps.placeBuyOrder({
      tokenId,
      price: fokBuyPrice(betMarketPrice, orderbookUp?.spread),
      size: shares,
    });
    const orderId = orderResult?.orderId ?? orderResult?.orderID ?? orderResult?.id ?? null;

    const fillCost = parseClobAmount(orderResult?.makingAmount, null);
    const fillShares = parseClobAmount(orderResult?.takingAmount, null);
    const actualSize = (fillShares && fillShares > 0) ? fillShares : shares;
    const actualPrice = (fillCost && actualSize > 0) ? fillCost / actualSize : betMarketPrice;
    const actualCost = (fillCost && fillCost > 0) ? fillCost : null;

    deps.setPendingCost(0);
    deps.recordTrade({
      side: betSide, tokenId,
      conditionId: currentConditionId,
      price: actualPrice, size: actualSize,
      marketSlug, orderId, actualCost,
    });
    deps.setEntryRegime(regimeInfo?.regime ?? 'moderate');
    if (orderId) {
      const fillConfirmed = !!(orderResult?.makingAmount || orderResult?.takingAmount);
      deps.trackOrderPlacement(orderId, { tokenId, price: actualPrice, size: actualSize, side: betSide, confirmed: fillConfirmed });
    }
    deps.recordTradeForMarket(marketSlug);
    deps.captureEntrySnapshot(entryData);
    // Record prediction for accuracy tracking
    try {
      deps.recordPrediction({
        side: betSide, modelProb: betEnsembleProb,
        marketPrice: betMarketPrice, btcPrice: lastPrice,
        priceToBeat: priceToBeat.value, marketSlug,
        regime: regimeInfo.regime,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
      });
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }
    if (deps.notifyTrade) {
      const cost = actualCost ?? (actualPrice * actualSize);
      deps.notifyTrade(
        `ENTRY ${betSide} @ $${actualPrice.toFixed(3)} | ${actualSize} shares ($${cost.toFixed(2)}) | Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% | ML: ${mlResult.available ? (mlResult.mlConfidence * 100).toFixed(0) + '%' : 'off'} | $${deps.getBankroll().toFixed(2)}`
      );
    }
    return true;
  } catch (err) {
    deps.setPendingCost(0);
    log.error(`Order failed: ${err.message}`);
    return false;
  }
}
