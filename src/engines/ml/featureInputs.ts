/**
 * One definition of the ML feature inputs, shared by the live bot AND the
 * training-data generator (backtest/ml_training/generateTrainingData.mts).
 *
 * Why this module exists (2026-09-23). The generator used to rebuild every
 * feature with its own code, "mirroring" the live path by hand, and the two
 * had drifted apart in ways that together made the deployed model look far
 * better offline than it was live (claimed 88%, won 68% over 438 dry-run
 * trades; the market price predicted better than the model):
 *
 *   - BTC features came from a candle's CLOSE while the row's time came from
 *     its OPEN: a 60s look-ahead on every row.
 *   - "Price to beat" was the close 15 candles back (a rolling return), not
 *     the price at the window start that the market actually resolves on.
 *   - Market features used the window-OPEN token price; live passes the
 *     current price into the same slots.
 *   - rule_prob_up / best_edge came from a simplified 8-factor score; live
 *     feeds the full scoring engine with live modifiers and orderbooks.
 *   - Indicator parameters, regime detection and multi-TF logic differed.
 *
 * Mirroring by hand drifts, so this module removes the second copy. Both sides
 * build a FeatureSnapshot from what they know at one instant and call
 * buildMlFeatureInputs(). Every input that cannot be reproduced offline
 * (orderbook, feedback stats, live signal modifiers) is deliberately neutral
 * here on BOTH sides, so it cannot differ between them.
 *
 * Known residual: offline data has only whole 1-minute candles, so training
 * rows sit exactly on a candle close while live polls can land inside a
 * forming candle, where delta_1m is smaller. The model can only under-react to
 * that, never over-react.
 */

import { computeAllIndicators, type MarketCandle } from '../../hooks/computeIndicators.ts';
import { scoreDirection, applyTimeAwareness } from '../probability.ts';
import { computeEdge } from '../edge.ts';
import { getVolatilityProfile } from '../volatility.ts';
import { getSessionName } from '../../utils.ts';

/**
 * Bump when the meaning of any feature changes. A model records the version
 * it was trained on (norm_browser.json `feature_pipeline`) and the live bot
 * only builds features this way for a model that declares it (any v >= 2).
 *
 * v3 (2026-09-25): the same builder as v2. What changed is the training-side
 * market price: per-second trade prints (fetchTradeHistory.mts) instead of the
 * ~1/min lookup series, whose last print could be 60 s older than the other
 * inputs — the reason v2's offline skill vs the market read +7% and its
 * fresh-price backtest weight on the model only 0.21. v2 metrics carried that
 * staleness, so the retrain gate skips the relative pair across v2 → v3.
 */
export const FEATURE_PIPELINE_VERSION = 3;

/** Pipeline v4: shared builder extended with 1 Hz Chainlink-native, TWAP physics, basis & real L2 orderbook. */
export const FEATURE_PIPELINE_V4 = 4;

/** Training rows built from the ~1/min lookup series (generator without --trade-history). */
export const LOOKUP_PRICE_PIPELINE_VERSION = 2;

/** Lookback for market_price_momentum, the same on both sides. */
export const MARKET_MOMENTUM_WINDOW_MS = 60_000;

/** Length of one Polymarket BTC up/down window. */
export const WINDOW_MINUTES = 15;

/** What is known at one instant, from the same feeds live and offline. */
export interface FeatureSnapshot {
  /** 1m candles, oldest first; the last one contains `nowMs`. */
  candles1m: MarketCandle[];
  /** 5m candles, oldest first; the last one contains `nowMs`. */
  candles5m: MarketCandle[];
  /** BTC price at `nowMs`, same feed as the candles. */
  lastPrice: number;
  /**
   * BTC price at the start of the market window, same feed as `lastPrice`.
   * Using one feed for both ends keeps the Binance/Chainlink basis out of
   * ptb_dist_pct; the move itself is what predicts the resolution.
   */
  windowOpenPrice: number | null;
  /** Minutes until the window resolves. */
  minutesLeft: number | null;
  /** The instant being described, epoch ms. */
  nowMs: number;
  /** UP-token price at `nowMs`. */
  marketUp: number | null;
  /** UP-token price MARKET_MOMENTUM_WINDOW_MS before `nowMs`, same market; null if unknown. */
  marketUpLag: number | null;
  /** Funding rate, or null when unavailable. */
  fundingRate?: { ratePct: number } | null;
  /** Pipeline version (>=4 passes live L2 orderbook and Chainlink-native telemetry). */
  featurePipeline?: number;
  /** Pipeline v4: Live L2 orderbook imbalance [-1..1] and spread [0..1]. */
  orderbookImbalance?: number | null;
  spreadPct?: number | null;
  /** Pipeline v4: Chainlink spot price (BTC/USD). */
  oraclePrice?: number | null;
  /** Pipeline v4: Settlement estimate (Chainlink spot or final-minute TWAP projection). */
  settlePrice?: number | null;
  /** Pipeline v4: Exact Chainlink 60s TWAP Price-To-Beat for the active window. */
  exactPtb?: number | null;
  /** Pipeline v4: TWAP physics z-score = (settlePrice - exactPtb) / (sigma * sqrt(T_eff)). */
  twapPhysicsZ?: number | null;
  /** Pipeline v4: Fractional 3-second BTC return on Binance vs Chainlink oracle. */
  binanceDelta3s?: number | null;
  oracleDelta3s?: number | null;
}

export interface MlFeatureInputs {
  /** Everything extractLiveFeaturesInPlace() reads, except the rule probability. */
  marketState: Record<string, unknown>;
  /** Rule-engine probability of UP, computed with neutral live-only inputs. */
  ruleProbUp: number;
}

/** UP-token price change over the momentum window; 0 when either end is unknown. */
export function marketMomentum(marketUp: number | null, marketUpLag: number | null): number {
  if (marketUp == null || marketUpLag == null) return 0;
  if (!Number.isFinite(marketUp) || !Number.isFinite(marketUpLag)) return 0;
  return marketUp - marketUpLag;
}

/**
 * Compute Pipeline v4 Chainlink-native ratios from live/tape inputs.
 * Units match ptb_dist_pct / delta_1m_pct (fractional returns, not * 100).
 */
export function computeChainlinkNativeFeatures(input: {
  binancePrice: number | null | undefined;
  binanceWindowOpen: number | null | undefined;
  oraclePrice: number | null | undefined;
  settlePrice: number | null | undefined;
  exactPtb: number | null | undefined;
  twapPhysicsZ: number | null | undefined;
  binanceDelta3s: number | null | undefined;
  oracleDelta3s: number | null | undefined;
}): {
  oraclePtbDistPct: number;
  twapPhysicsZ: number;
  basisPct: number;
  basisDriftPct: number;
  crossFeedLead: number;
} {
  const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const binOpenOk = pos(input.binancePrice) && pos(input.binanceWindowOpen);
  const oraOk = pos(input.settlePrice) && pos(input.exactPtb);

  const binancePtbDistPct = binOpenOk
    ? (input.binancePrice! - input.binanceWindowOpen!) / input.binanceWindowOpen!
    : 0;
  const oraclePtbDistPct = oraOk
    ? (input.settlePrice! - input.exactPtb!) / input.exactPtb!
    : binancePtbDistPct;

  const zRaw = typeof input.twapPhysicsZ === 'number' && Number.isFinite(input.twapPhysicsZ)
    ? input.twapPhysicsZ
    : 0;
  const twapPhysicsZ = Math.max(-8, Math.min(8, zRaw));

  const basisPct = pos(input.binancePrice) && pos(input.oraclePrice)
    ? Math.max(-0.02, Math.min(0.02, (input.binancePrice! - input.oraclePrice!) / input.oraclePrice!))
    : 0;

  const basisDriftPct = (binOpenOk && oraOk)
    ? Math.max(-0.02, Math.min(0.02, binancePtbDistPct - oraclePtbDistPct))
    : 0;

  const b3 = typeof input.binanceDelta3s === 'number' && Number.isFinite(input.binanceDelta3s) ? input.binanceDelta3s : 0;
  const o3 = typeof input.oracleDelta3s === 'number' && Number.isFinite(input.oracleDelta3s) ? input.oracleDelta3s : 0;
  const crossFeedLead = Math.max(-0.02, Math.min(0.02, b3 - o3));

  return {
    oraclePtbDistPct,
    twapPhysicsZ,
    basisPct,
    basisDriftPct,
    crossFeedLead,
  };
}

/**
 * Build the ML feature inputs for one instant. Pure: the result depends only
 * on `snapshot`, never on the wall clock or on module state.
 */
export function buildMlFeatureInputs(snapshot: FeatureSnapshot): MlFeatureInputs {
  const {
    candles1m, candles5m, lastPrice, windowOpenPrice, minutesLeft, nowMs,
    marketUp, marketUpLag, fundingRate = null, featurePipeline = 2,
    orderbookImbalance = null, spreadPct = null,
    oraclePrice = null, settlePrice = null, exactPtb = null, twapPhysicsZ = null,
    binanceDelta3s = null, oracleDelta3s = null,
  } = snapshot;
  const at = new Date(nowMs);
  const isV4 = Number.isFinite(featurePipeline) && featurePipeline >= 4;

  const ind = computeAllIndicators({ candles: candles1m, klines5m: candles5m, lastPrice });

  // Rule probability with every live-only input neutral: no orderbook, no
  // feedback stats, no signal modifiers. The time-of-day volatility profile
  // is taken at `nowMs`, not at the moment this function happens to run.
  const scored = scoreDirection({
    price: lastPrice, priceToBeat: windowOpenPrice,
    vwap: ind.vwapNow, vwapSlope: ind.vwapSlope,
    rsi: ind.rsiNow, rsiSlope: ind.rsiSlope,
    macd: ind.macd, heikenColor: ind.consec.color, heikenCount: ind.consec.count,
    failedVwapReclaim: ind.failedVwapReclaim,
    delta1m: ind.delta1m, delta3m: ind.delta3m,
    regime: ind.regimeInfo,
    orderbookSignal: null,
    volProfile: getVolatilityProfile(at),
    multiTfConfirm: ind.multiTfConfirm,
    feedbackStats: null,
    minutesLeft,
    signalModifiers: null,
    bb: ind.bb, atr: ind.atr,
  });
  const ruleProbUp = applyTimeAwareness(scored.rawUp, minutesLeft, WINDOW_MINUTES).adjustedUp;

  // Rule edge against the token price, spread-agnostic: offline has no book.
  const ruleEdge = computeEdge({
    modelUp: ruleProbUp, modelDown: 1 - ruleProbUp,
    marketYes: marketUp, marketNo: marketUp != null ? 1 - marketUp : null,
    orderbookUp: null, orderbookDown: null,
  });

  const v4 = isV4
    ? computeChainlinkNativeFeatures({
        binancePrice: lastPrice,
        binanceWindowOpen: windowOpenPrice,
        oraclePrice,
        settlePrice,
        exactPtb,
        twapPhysicsZ,
        binanceDelta3s,
        oracleDelta3s,
      })
    : null;

  const emaCross = ind.emaCross?.cross;
  const marketState: Record<string, unknown> = {
    price: lastPrice,
    priceToBeat: windowOpenPrice,
    rsi: ind.rsiNow, rsiSlope: ind.rsiSlope,
    macd: ind.macd, vwap: ind.vwapNow, vwapSlope: ind.vwapSlope,
    heikenColor: ind.consec.color, heikenCount: ind.consec.count,
    delta1m: ind.delta1m, delta3m: ind.delta3m,
    volumeRecent: ind.volumeRecent, volumeAvg: ind.volumeAvg,
    regime: ind.regimeInfo?.regime, regimeConfidence: ind.regimeInfo?.confidence,
    session: getSessionName(at),
    minutesLeft,
    bestEdge: Math.max(ruleEdge.edgeUp ?? 0, ruleEdge.edgeDown ?? 0),
    vwapCrossCount: ind.vwapCrossCount,
    multiTfAgreement: ind.multiTfConfirm?.agreement ?? false,
    failedVwapReclaim: ind.failedVwapReclaim,
    bbWidth: ind.bb?.width ?? null, bbPercentB: ind.bb?.percentB ?? null,
    bbSqueeze: ind.bb?.squeeze ?? false, bbSqueezeIntensity: ind.bb?.squeezeIntensity ?? 0,
    atrPct: ind.atr?.atrPct ?? null, atrRatio: ind.atr?.atrRatio ?? null,
    volDeltaBuyRatio: ind.volDelta?.buyRatio ?? null,
    volDeltaAccel: ind.volDelta?.deltaAccel ?? null,
    volDeltaBuyRatio300s: ind.volDelta?.buyRatio300s ?? null,
    volDeltaBuyRatio60s: ind.volDelta?.buyRatio60s ?? null,
    hurstExponent: ind.regimeInfo?.hurst ?? null,
    realizedVolPct: ind.realizedVol?.realizedVolPct ?? null,
    emaDistPct: ind.emaCross?.distancePct ?? null,
    emaCrossSignal: emaCross === 'BULL_CROSS' ? 1 : emaCross === 'BEAR_CROSS' ? -1 : 0,
    stochK: ind.stochRsi?.k ?? null,
    stochKD: ind.stochRsi ? ind.stochRsi.k - ind.stochRsi.d : null,
    fundingRate,
    marketYesPrice: marketUp,
    marketPriceMomentum: marketMomentum(marketUp, marketUpLag),
    // v2/v3 leave L2 book neutral (no 395d offline history); v4 reads 1 Hz tape / live CLOB book.
    orderbookImbalance: isV4 ? orderbookImbalance : null,
    spreadPct: isV4 ? spreadPct : null,
    ...(v4 ? {
      oraclePtbDistPct: v4.oraclePtbDistPct,
      twapPhysicsZ: v4.twapPhysicsZ,
      basisPct: v4.basisPct,
      basisDriftPct: v4.basisDriftPct,
      crossFeedLead: v4.crossFeedLead,
    } : {}),
    momentum5CandleSlope: ind.momentum5CandleSlope,
    volatilityChangeRatio: ind.volatilityChangeRatio,
    priceConsistency: ind.priceConsistency,
    nowMs,
  };

  return { marketState, ruleProbUp };
}
