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
import { BOT_CONFIG } from '../config.js';
import { notify } from '../monitoring/notifier.js';
import { SIGNAL_CONFIRM_POLLS } from './signalStability.js';

const log = createLogger('TradePipeline');

// ── Execution quality tracking (rolling slippage) ──
const SLIPPAGE_BUF_SIZE = 20;
const slippageBuf = new Float64Array(SLIPPAGE_BUF_SIZE);
let slippageBufIdx = 0;
let slippageBufCount = 0;

function recordSlippage(pct) {
  if (!Number.isFinite(pct)) return;
  slippageBuf[slippageBufIdx] = pct;
  slippageBufIdx = (slippageBufIdx + 1) % SLIPPAGE_BUF_SIZE;
  if (slippageBufCount < SLIPPAGE_BUF_SIZE) slippageBufCount++;
}

export function getAvgSlippage() {
  if (slippageBufCount === 0) return null;
  let sum = 0;
  for (let i = 0; i < slippageBufCount; i++) sum += slippageBuf[i];
  return sum / slippageBufCount;
}

/**
 * Compute FOK buy limit price with adaptive slippage tolerance.
 * Audit fix H: Fixed slippage (1 cent) was 10% at $0.10 but only 1% at $0.90.
 * Now uses max(fixed minimum, 2% of target price) for proportional tolerance.
 * FOK fills at the best available price UP TO the limit — you still pay the actual ask.
 * Polymarket prices: [0.01, 0.99], precision 0.001.
 */
function fokBuyPrice(targetPrice, spread) {
  // Audit v2 M2: Reduced slippage 2%→1% — systematic overpayment ≈ 0.5-1% per trade.
  // 1% still provides 6-7 ticks tolerance on a $0.65 token.
  const fixedSlippage = Math.max(0.005, targetPrice * 0.005);
  const pctSlippage = targetPrice * 0.005; // GC4: 1%→0.5% — reduces systematic overpayment ~$0.30/trade
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
  const arbBudget = deps.getAvailableBankroll() * 0.05; // Audit fix C1: 10→5% — arb is 2 legs, 5% total = Kelly max per trade

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
      price: fokBuyPrice(arb.askUp, orderbookUp?.spread), // M1: pass spread for proportional slippage
      size: arbShares,
    });
    const upFillCost = parseClobAmount(upResult?.makingAmount, arbShares * arb.askUp);
    const upOrderId = upResult?.orderId ?? null;

    // Leg 2: Buy DOWN
    let arbLeg2Failed = false;
    try {
      const downResult = await deps.placeBuyOrder({
        tokenId: poly.tokens.downTokenId,
        price: fokBuyPrice(arb.askDown, orderbookDown?.spread), // M1: pass spread for proportional slippage
        size: arbShares,
      });
      const downFillCost = parseClobAmount(downResult?.makingAmount, arbShares * arb.askDown);
      const downOrderId = downResult?.orderId ?? null;

      // Both legs succeeded — record arb with actual fill costs
      deps.setPendingCost(0);
      // H2 FIX: Track order placements BEFORE recording arb position.
      // If recordArbTrade throws (e.g. bankroll guard), orders are still tracked.
      // H9 FIX: Check amount > 0 not just truthy (CLOB could return "0")
      const upConfirmed = parseClobAmount(upResult?.makingAmount, 0) > 0 || parseClobAmount(upResult?.takingAmount, 0) > 0;
      const downConfirmed = parseClobAmount(downResult?.makingAmount, 0) > 0 || parseClobAmount(downResult?.takingAmount, 0) > 0;
      if (upOrderId) deps.trackOrderPlacement(upOrderId, { tokenId: poly.tokens.upTokenId, price: arb.askUp, size: arbShares, side: 'ARB_UP', confirmed: upConfirmed });
      if (downOrderId) deps.trackOrderPlacement(downOrderId, { tokenId: poly.tokens.downTokenId, price: arb.askDown, size: arbShares, side: 'ARB_DOWN', confirmed: downConfirmed });
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
        deps.recordTradeTimestamp?.(); // H7: hourly trade frequency tracking
        // RC3 Fix (ARB): ERC-1155 approval for both token sides after ARB BUY
        if (deps.updateConditionalApproval) {
          deps.updateConditionalApproval(poly.tokens.upTokenId).catch(e => log.debug(`ARB UP approval: ${e.message}`));
          deps.updateConditionalApproval(poly.tokens.downTokenId).catch(e => log.debug(`ARB DOWN approval: ${e.message}`));
        }
      } catch (recErr) {
        log.error(`Arb recording failed (trades placed but not tracked): ${recErr.message}`);
      }
    } catch (downErr) {
      // ONE-LEGGED: Only UP bought, DOWN failed.
      // Audit fix C9: Attempt to UNWIND leg 1 instead of holding unvalidated directional exposure.
      // The UP position was entered without any signal validation (edge, ML, stability gates).
      arbLeg2Failed = true;
      // C4 FIX: Don't clear pendingCost here — clear AFTER unwind succeeds or fallback completes.
      // Previously: cleared immediately → concurrent trade could enter during unwind attempt.
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
          deps.setPendingCost(0); // C4: Clear only after unwind succeeds
          const recovered = parseClobAmount(unwindResult?.takingAmount, arbShares * (arb.askUp - 0.02));
          log.info(`ARB leg 1 unwound: recovered $${(recovered || 0).toFixed(2)} of $${upFillCost.toFixed(2)}`);
        }
      } catch (unwindErr) {
        log.warn(`ARB leg 1 unwind failed: ${unwindErr.message} — falling back to directional position`);
      }

      if (!unwindSucceeded) {
        deps.setPendingCost(0); // C4: Clear now that we're committing to fallback
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
        // RC3 Fix (ARB one-leg): ERC-1155 approval for fallback directional position
        if (deps.updateConditionalApproval) {
          deps.updateConditionalApproval(poly.tokens.upTokenId).catch(e => log.debug(`ARB one-leg approval: ${e.message}`));
        }
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
  // Smart money flow
  smartFlowSignal,
  // Monte Carlo simulation
  mcResult,
}, deps) {
  // ── Signal Confirmation Gate ──
  // Audit v2 H3: Edge-adaptive confirmation. High edge (≥15%) or high ML (≥80%) → fast entry.
  // In a 15-min market, 3-poll wait (9s) can miss 2-5% price movement.
  const mlConf = mlResult.available ? mlResult.mlConfidence : null;
  const highEdge = edge.bestEdge != null && edge.bestEdge >= 0.15;
  const requiredPolls = (mlConf != null && mlConf >= 0.80) ? 1
    : highEdge ? Math.max(1, SIGNAL_CONFIRM_POLLS - 1)
    : SIGNAL_CONFIRM_POLLS;
  if (requiredPolls < SIGNAL_CONFIRM_POLLS) {
    const fastReason = (mlConf != null && mlConf >= 0.80)
      ? `ML conf ${(mlConf * 100).toFixed(0)}% ≥ 80%`
      : `high edge ${((edge.bestEdge ?? 0) * 100).toFixed(0)}% ≥ 15%`;
    log.info(`Fast-entry: ${fastReason} → confirm ${requiredPolls}/${SIGNAL_CONFIRM_POLLS} polls`);
  }

  deps.updateConfirmation(rec.side);

  if (!deps.isSignalStable(requiredPolls)) {
    const reasons = deps.getInstabilityReasons(requiredPolls);
    log.info(`Signal unstable, holding: ${reasons.join(' | ')}`);
    return false;
  }

  // ── Tilt protection ──
  const effectiveMlConf = mlResult.available ? mlResult.mlConfidence : null;
  if (tiltMarketsLeft > 0 && effectiveMlConf != null && effectiveMlConf < tiltMlConfMin) {
    log.info(`Tilt protection active: ML conf ${(effectiveMlConf * 100).toFixed(0)}% < ${tiltMlConfMin * 100}% (${tiltMarketsLeft} markets left) — will raise threshold in filters`);
  }

  // ── Smart trade filters ──
  // Compute ET hour for blackout filter (DST-aware via Intl API)
  const etHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);

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
    etHour,
    spread: orderbookUp?.spread ?? null,
    mlAccuracy: deps.getMLAccuracy?.() ?? null,
    buyRatio: volDelta?.buyRatio ?? null,
  });

  // Orderbook flow alignment check
  const flowAlign = deps.checkFlowAlignment(betSide);

  // Smart money flow gate: if early flow strongly disagrees, block the trade.
  // Only block when confidence is high (>0.5) and strength is strong (>0.4).
  // This prevents entering against the dominant early-market flow direction.
  if (smartFlowSignal && smartFlowSignal.confidence > 0.5 && smartFlowSignal.strength > 0.4) {
    const flowAgrees = smartFlowSignal.agreesWithSide?.(betSide) ?? true;
    if (!flowAgrees && smartFlowSignal.window === 'EARLY') {
      log.info(`Smart flow gate blocked: ${betSide} vs early flow ${smartFlowSignal.direction} (str=${smartFlowSignal.strength} conf=${smartFlowSignal.confidence})`);
      return false;
    }
  }

  // ── Monte Carlo Simulation Gate ──
  // Independent P(UP) from GBM price paths. Block when MC strongly disagrees or tail risk elevated.
  if (mcResult && BOT_CONFIG.monteCarlo.enabled) {
    const mcProbForSide = betSide === 'UP' ? mcResult.pUp : mcResult.pDown;
    const minAgree = BOT_CONFIG.monteCarlo.minAgreementProb;

    // Gate 1: MC direction disagreement (MC says <35% chance our side wins)
    if (mcProbForSide < minAgree) {
      log.info(`MC gate blocked: P(${betSide})=${(mcProbForSide * 100).toFixed(0)}% < ${(minAgree * 100).toFixed(0)}% min | BTC dist=${(mcResult.currentDistance * 100).toFixed(2)}%`);
      return false;
    }

    // Gate 2: Tail risk elevated (high probability of adverse extreme move)
    const adverseTailP = betSide === 'UP' ? mcResult.tailRisk.pBigDown : mcResult.tailRisk.pBigUp;
    if (adverseTailP > BOT_CONFIG.monteCarlo.maxTailRisk) {
      log.info(`MC tail risk blocked: P(adverse >0.5%)=${(adverseTailP * 100).toFixed(0)}% > ${(BOT_CONFIG.monteCarlo.maxTailRisk * 100).toFixed(0)}% | σ=${(mcResult.totalSigma * 100).toFixed(2)}%`);
      return false;
    }

    // Gate 3: Agent noise detection — token price diverges >15pp from MC fair value
    // Bypass when ML is very confident (>=85%) — ML trained on 45K real samples beats GBM random walk
    if (mcResult.priceEfficiency?.isNoisy && mcResult.priceEfficiency.absDivergence > 0.15) {
      if (mlConf != null && mlConf >= 0.85) {
        log.info(`MC noise gate BYPASSED (ML ${(mlConf * 100).toFixed(0)}%≥85%): token ${(mcResult.priceEfficiency.tokenPrice * 100).toFixed(0)}c vs MC fair ${(mcResult.priceEfficiency.mcFairValue * 100).toFixed(0)}c | div=${(mcResult.priceEfficiency.absDivergence * 100).toFixed(0)}pp`);
      } else {
        log.info(`MC noise gate: token ${(mcResult.priceEfficiency.tokenPrice * 100).toFixed(0)}c vs MC fair ${(mcResult.priceEfficiency.mcFairValue * 100).toFixed(0)}c | div=${(mcResult.priceEfficiency.absDivergence * 100).toFixed(0)}pp`);
        return false;
      }
    }
  }

  if (!filterResult.pass) {
    log.info(`Smart filter blocked: ${filterResult.reasons.join(' | ')}`);
    return false;
  }

  // ── MetEngine smart money gate (F1: consensus, F2: insider, F3: conviction wallet) ──
  // Pre-filter: query when prob >= 0.65 (lowered from 0.75 — catches more signals while
  // still avoiding marginal noise). Cached 90s so cost stays ~$0.50-1.00/day.
  // BOOST → +10% bet size (smart money confirms our direction → Kelly says size up).
  // BLOCK → return false immediately (smart money strongly opposes our signal).
  const ME_MIN_PROB = 0.65;
  const ME_BOOST_MULTIPLIER = 1.10; // +10% bet when smart money agrees
  let meBoostActive = false;
  let meConsensusStrength = 0;
  let meInsiderScore = 0;
  if (deps.querySmartMoney && betEnsembleProb >= ME_MIN_PROB) {
    try {
      const meResult = await deps.querySmartMoney(currentConditionId, betSide);
      if (meResult.blocked) {
        log.info(`[MetEngine] Gate blocked: ${meResult.reason}`);
        notify('warn', `🧠 MetEngine BLOCKED ${betSide}: ${meResult.reason}`, { key: `me:block:${currentConditionId}` }).catch(e => log.debug(`Notify ME block: ${e.message}`));
        return false;
      }
      if (meResult.boost) {
        log.info(`[MetEngine] Insider boost: ${meResult.reason}`);
        meBoostActive = true;
        meConsensusStrength = meResult.consensusStrength ?? 0;
        meInsiderScore = meResult.insiderScore ?? 0;
      }
    } catch (_e) { /* never propagate — MetEngine errors must not kill the trade loop */ }
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

  // Hard dollar cap from BOT_CONFIG (data shows ~$1.30 avg is most consistent)
  let effectiveBetAmount = betSizing.betAmount;

  // MetEngine BOOST: +10% bet when smart money confirms our direction.
  // Kelly Criterion rationale: when an independent high-quality signal agrees,
  // the edge is higher → optimal Kelly fraction increases proportionally.
  if (meBoostActive) {
    const boosted = Math.round(effectiveBetAmount * ME_BOOST_MULTIPLIER * 100) / 100;
    log.info(`[MetEngine] Bet boosted: $${effectiveBetAmount.toFixed(2)} → $${boosted.toFixed(2)} (smart money +${((ME_BOOST_MULTIPLIER - 1) * 100).toFixed(0)}%)`);
    effectiveBetAmount = boosted;
  }

  // Confidence-tiered Kelly cap — portfolio $100+: reduced for moderate risk.
  // LOW=1.5%, MEDIUM=2.5%, HIGH=3.5%, VERY_HIGH=4% of bankroll.
  const KELLY_CAP_BY_CONF = { VERY_HIGH: 0.04, HIGH: 0.035, MEDIUM: 0.025, LOW: 0.015 }; // Max 4% porto per entry
  const kellyCapPct = KELLY_CAP_BY_CONF[rec.confidence] ?? 0.03;
  const currentBankroll = deps.getBankroll();
  const kellyMaxBet = currentBankroll * kellyCapPct;
  if (effectiveBetAmount > kellyMaxBet && kellyMaxBet > 0) {
    log.info(`Kelly cap: $${effectiveBetAmount.toFixed(2)} → $${kellyMaxBet.toFixed(2)} (${(kellyCapPct * 100).toFixed(0)}% of $${currentBankroll.toFixed(0)}, conf=${rec.confidence})`);
    effectiveBetAmount = kellyMaxBet;
  }

  // C2 Audit fix: Session quality scaling (Kelly adjustment for session reliability).
  // Low-liquidity sessions (Asia/Off-hours) have wider spreads and less reliable signals.
  const sessionQuality = filterResult.sessionQuality ?? 1.0;
  if (sessionQuality < 1.0) {
    const sqScaled = Math.round(effectiveBetAmount * sessionQuality * 100) / 100;
    log.info(`Session quality: $${effectiveBetAmount.toFixed(2)} × ${sessionQuality} = $${sqScaled.toFixed(2)} (${getSessionName()})`);
    effectiveBetAmount = sqScaled;
  }

  // Solution D: Asymmetry-aware scaling — at higher entry prices, loss/win ratio worsens.
  // Binary option at price p: win payout = (1-p)/p of bet, loss = 100% of bet.
  // At 50c: symmetric. At 65c: loss 1.86× win. At 68c: loss 2.13× win.
  // Scale bet inversely: factor = max(0.60, 2 × (1 - price)).
  // 55c→0.90, 60c→0.80, 65c→0.70, 68c→0.64. Floor 0.60.
  // Equalizes dollar impact: smaller bets where losses are disproportionately large.
  const asymFactor = Math.max(0.85, Math.min(1.0, 2 * (1 - betMarketPrice))); // Audit v5 M2: 0.70→0.85 floor — Kelly already accounts for price asymmetry via b=(1/p-1), double-penalization was causing ~20-30% under-betting at 60-65¢
  if (asymFactor < 0.99) {
    const asymScaled = Math.round(effectiveBetAmount * asymFactor * 100) / 100;
    log.info(`Asymmetry adj: $${effectiveBetAmount.toFixed(2)} \u00d7 ${asymFactor.toFixed(2)} = $${asymScaled.toFixed(2)} (${(betMarketPrice * 100).toFixed(0)}c entry)`);
    effectiveBetAmount = asymScaled;
  }

  // Scale max bet with bankroll — fixed floor prevents Kelly-optimal sizing at very small bankrolls.
  // Use the LARGER of: (a) configured dollar floor, (b) bankroll × confidence tier %.
  // At $30 bankroll (HIGH): max(7, 30×0.035) = max(7, 1.05) = $7 (floor binds)
  // At $200 bankroll (HIGH): max(7, 200×0.035) = max(7, 7.00) = $7 (both equal, compounding kicks in above)
  const bankrollForCap = deps.getBankroll?.() ?? 0;
  const scaledMaxBet = Math.max(BOT_CONFIG.maxBetAmountUsd, bankrollForCap * kellyCapPct);
  if (scaledMaxBet > 0 && effectiveBetAmount > scaledMaxBet) {
    log.info(`Bet capped: $${effectiveBetAmount.toFixed(2)} → $${scaledMaxBet.toFixed(2)} (${bankrollForCap > 0 ? 'scaled' : 'fixed'} maxBet)`);
    effectiveBetAmount = scaledMaxBet;
  }

  const tokenId = betSide === 'UP' ? poly.tokens.upTokenId : poly.tokens.downTokenId;
  const shares = Math.floor(effectiveBetAmount / betMarketPrice);

  // H9: Guard against 0 shares (e.g. betAmount < marketPrice)
  if (shares <= 0) {
    log.info(`Trade skipped: 0 shares (betAmount=$${betSizing.betAmount.toFixed(2)} / price=$${betMarketPrice.toFixed(3)})`);
    return false;
  }

  // Flow alignment info for logging
  const flowTag = flowAlign.signal !== 'INSUFFICIENT_DATA'
    ? ` | Flow:${flowAlign.signal}${flowAlign.agrees ? '(agree)' : '(DISAGREE)'}`
    : '';
  const smartFlowTag = smartFlowSignal && smartFlowSignal.sampleCount >= 3
    ? ` | SmartFlow:${smartFlowSignal.direction}(${smartFlowSignal.strength})`
    : '';

  // Reserve bankroll — FINTECH: round to cents to prevent float drift in available bankroll
  const orderCost = Math.round(shares * betMarketPrice * 100) / 100;

  // Polymarket minimum order size: $1.00 USDC (makerAmount). Reject below this to avoid HTTP 400.
  const POLYMARKET_MIN_ORDER_USD = 1.00;
  if (orderCost < POLYMARKET_MIN_ORDER_USD) {
    log.info(`Trade skipped: orderCost $${orderCost.toFixed(2)} < $${POLYMARKET_MIN_ORDER_USD} Polymarket minimum`);
    return false;
  }

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
    smartFlowDirection: smartFlowSignal?.direction ?? null,
    smartFlowStrength: smartFlowSignal?.strength ?? null,
    smartFlowWindow: smartFlowSignal?.window ?? null,
    meBoost: meBoostActive,
    expectedPrice: betMarketPrice,
    slippagePct: null,     // populated after fill for live orders
    avgSlippage: null,     // populated after fill for live orders
  };

  if (dryRun) {
    deps.setPendingCost(0);
    deps.setEntryRegime(regimeInfo?.regime ?? 'moderate');
    // H8: Don't call recordTradeForMarket in dry-run — inflates counter, blocks real entries
    log.info(
      `[DRY RUN] Would BUY ${betSide}: ${shares} shares @ $${betMarketPrice.toFixed(3)} = $${(shares * betMarketPrice).toFixed(2)} | ` +
      `Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% (spread: -${(((edge.spreadPenaltyUp ?? 0) + (edge.spreadPenaltyDown ?? 0)) * 50).toFixed(1)}%) | ` +
      `Conf: ${rec.confidence}${flowTag}${smartFlowTag} | ${betSizing.rationale}`
    );
    // Record prediction for accuracy tracking
    try {
      deps.recordPrediction({
        side: betSide, modelProb: betEnsembleProb,
        marketPrice: betMarketPrice, btcPrice: lastPrice,
        priceToBeat: priceToBeat.value, marketSlug,
        regime: regimeInfo.regime,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlSide: mlResult.available ? mlResult.mlSide : null,
      });
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }
    if (deps.notifyTrade) {
      const marketUrl = `https://polymarket.com/event/${marketSlug}`;
      deps.notifyTrade(
        `[DRY] ENTRY ${betSide} @ $${betMarketPrice.toFixed(3)} | ${shares} shares ($${(shares * betMarketPrice).toFixed(2)}) | Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% | ML: ${mlResult.available ? (mlResult.mlConfidence * 100).toFixed(0) + '%' : 'off'} | $${deps.getBankroll().toFixed(2)}\n<a href="${marketUrl}">View Market</a>`
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

    // C5 FIX: Parse fill data with strict validation. If CLOB returns no fill data,
    // mark fill as unconfirmed so fill tracker will verify via getOpenOrders/trade history.
    const fillCost = parseClobAmount(orderResult?.makingAmount, null);
    const fillShares = parseClobAmount(orderResult?.takingAmount, null);
    const hasFillData = (fillCost != null && fillCost > 0) || (fillShares != null && fillShares > 0);
    if (!hasFillData) {
      log.warn(`Order ${orderId ?? 'unknown'}: no fill data in CLOB response — position will remain unconfirmed until fill tracker verifies (cost=$${(shares * betMarketPrice).toFixed(2)}, shares=${shares})`);
    }
    const actualSize = (fillShares != null && fillShares > 0) ? fillShares : shares;
    const actualPrice = (fillCost != null && fillCost > 0 && actualSize > 0) ? fillCost / actualSize : betMarketPrice;
    const actualCost = (fillCost != null && fillCost > 0) ? fillCost : null;

    // Execution quality tracking
    const slippagePct = betMarketPrice > 0
      ? ((actualPrice - betMarketPrice) / betMarketPrice) * 100
      : 0;
    recordSlippage(slippagePct);

    deps.setPendingCost(0);
    // H2/H9 FIX: Track order BEFORE recording trade (same pattern as arb fix above)
    // H9 FIX: Use parseClobAmount > 0 for fill confirmation (not just truthy)
    const fillConfirmed = parseClobAmount(orderResult?.makingAmount, 0) > 0 || parseClobAmount(orderResult?.takingAmount, 0) > 0;
    if (orderId) {
      deps.trackOrderPlacement(orderId, { tokenId, price: actualPrice, size: actualSize, side: betSide, confirmed: fillConfirmed });
    }
    deps.recordTrade({
      side: betSide, tokenId,
      conditionId: currentConditionId,
      price: actualPrice, size: actualSize,
      marketSlug, orderId, actualCost,
    });
    deps.setEntryRegime(regimeInfo?.regime ?? 'moderate');
    deps.recordTradeForMarket(marketSlug);
    deps.recordTradeTimestamp?.(); // H7: hourly trade frequency tracking
    // Populate execution quality fields before snapshot
    entryData.actualPrice = actualPrice;
    entryData.slippagePct = slippagePct;
    entryData.avgSlippage = getAvgSlippage();
    deps.captureEntrySnapshot(entryData);
    // RC3 Fix: ensure ERC-1155 setApprovalForAll is set for this token immediately after BUY
    // Prevents "not enough balance/allowance" errors on subsequent SELL (cut-loss) orders
    if (deps.updateConditionalApproval) {
      deps.updateConditionalApproval(tokenId).catch(err => log.debug(`Conditional approval (post-buy): ${err.message}`));
    }
    // Record prediction for accuracy tracking
    try {
      deps.recordPrediction({
        side: betSide, modelProb: betEnsembleProb,
        marketPrice: betMarketPrice, btcPrice: lastPrice,
        priceToBeat: priceToBeat.value, marketSlug,
        regime: regimeInfo.regime,
        mlConfidence: mlResult.available ? mlResult.mlConfidence : null,
        mlSide: mlResult.available ? mlResult.mlSide : null,
      });
    } catch (feedbackErr) { log.debug(`Feedback error: ${feedbackErr.message}`); }
    if (deps.notifyTrade) {
      const cost = actualCost ?? (actualPrice * actualSize);
      if (meBoostActive) {
        // Rich MetEngine aligned notification
        const sideArrow = betSide === 'UP' ? '↑' : '↓';
        const timeText = timeLeftMin != null
          ? timeLeftMin < 1 ? `${Math.round(timeLeftMin * 60)}s` : `${timeLeftMin.toFixed(1)}m`
          : '-';
        const mlStr = mlResult.available ? `${(mlResult.mlConfidence * 100).toFixed(0)}%` : 'off';
        const marketUrl = `https://polymarket.com/event/${marketSlug}`;
        notify('info', [
          `🧠 MetEngine + Bot ALIGNED!`,
          `${sideArrow} ${betSide} | $${cost.toFixed(2)} (smart money boost +${((ME_BOOST_MULTIPLIER - 1) * 100).toFixed(0)}%)`,
          ``,
          `Smart: ${betSide} ${(meConsensusStrength * 100).toFixed(0)}%${meInsiderScore > 0 ? ` | topInsider=${meInsiderScore}` : ''}`,
          `₿ BTC: $${lastPrice != null ? lastPrice.toFixed(0) : '?'} | Token: ${actualPrice.toFixed(3)}c`,
          `📐 Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% | 🤖 ML: ${mlStr}`,
          `⏱ Market ends in ${timeText}`,
          `<a href="${marketUrl}">View Market</a>`,
        ].join('\n'), { key: `me:align:${currentConditionId}` }).catch(e => log.debug(`Notify ME align: ${e.message}`));
      } else {
        const marketUrl = `https://polymarket.com/event/${marketSlug}`;
        deps.notifyTrade(
          `ENTRY ${betSide} @ $${actualPrice.toFixed(3)} | ${actualSize} shares ($${cost.toFixed(2)}) | Edge: ${((edge.bestEdge ?? 0) * 100).toFixed(1)}% | ML: ${mlResult.available ? (mlResult.mlConfidence * 100).toFixed(0) + '%' : 'off'} | $${deps.getBankroll().toFixed(2)}\n<a href="${marketUrl}">View Market</a>`
        );
      }
    }
    return true;
  } catch (err) {
    deps.setPendingCost(0);
    log.error(`Order failed: ${err.message}`);
    return false;
  }
}
