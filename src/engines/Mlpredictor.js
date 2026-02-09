/**
 * ═══ ML Predictor (Browser) — XGBoost Inference v5 ═══
 *
 * Supports both model formats:
 *   v1: 42 base features (old model)
 *   v2: 74 features (49 base + 25 engineered interaction features)
 *       49 base = 42 original + 2 time cyclical + 5 Polymarket features
 *
 * Auto-detects model version from xgboost_model.json.
 * Backward compatible — v1 models work without changes.
 *
 * v5 additions:
 *   - 5 Polymarket features (market price, momentum, orderbook, spread, divergence)
 *   - 3 new engineered features (crowd momentum, divergence×confidence, imbalance×vol)
 *   - Platt calibration (sigmoid rescaling of raw probabilities)
 *   - Time cyclical features (hour_sin, hour_cos)
 *
 * Performance optimizations:
 *   1. PRE-INDEXED TREES: Map<nodeid, node> for O(1) traversal
 *   2. PRE-ALLOCATED BUFFERS: Float64Array reused every prediction
 *   3. ITERATIVE TREE WALK: No recursion, no stack allocation
 *   4. IN-PLACE FEATURE ENGINEERING: 25 derived features computed in buffer
 */

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

// Feature counts
const BASE_FEATURES = 49; // 44 original + 5 Polymarket (market_yes_price, momentum, imbalance, spread, divergence)
const ENGINEERED_FEATURES = 25; // 22 original + 3 new crowd/orderbook interactions
const MAX_FEATURES = BASE_FEATURES + ENGINEERED_FEATURES; // 74

// ═══ Module state ═══
let processedTrees = null;
let numUsableTrees = 0;        // best_iteration+1 (excludes overfit trees)
let normMeans = null;
let normStds = null;
let isLoading = false;
let loadError = null;
let modelMemoryKB = 0;
let modelVersion = 1;          // 1 = 42 features, 2 = 58 features
let modelNumFeatures = 42;
let optimalThreshold = 0.65;   // From v2 training, auto-tuned
let modelMetrics = null;
let featureNameToIdx = null;   // Map<string, number> for named splits
let plattA = 1.0;             // Platt calibration coefficient A (default: identity)
let plattB = 0.0;             // Platt calibration coefficient B

// ═══ Pre-allocated buffer (ZERO allocation per prediction) ═══
const featureBuf = new Float64Array(MAX_FEATURES);

// ═══ Feature index mapping (base 42) ═══
const FI = {
  ptb_dist_pct: 0, rsi_norm: 1, rsi_slope: 2, macd_hist: 3, macd_line: 4,
  vwap_dist: 5, vwap_slope: 6, ha_signed_consec: 7, delta_1m_pct: 8,
  delta_3m_pct: 9, vol_ratio_norm: 10, minutes_left_norm: 11,
  rule_prob_up: 12, rule_confidence: 13, vwap_cross_count_norm: 14,
  best_edge: 15, regime_trending: 16, regime_choppy: 17,
  regime_mean_reverting: 18, regime_moderate: 19, session_asia: 20,
  session_europe: 21, session_us: 22, session_overlap: 23,
  session_offhours: 24, ha_is_green: 25, multi_tf_agreement: 26,
  failed_vwap_reclaim: 27, bb_width: 28, bb_percent_b: 29, bb_squeeze: 30,
  atr_pct_norm: 31, atr_ratio_norm: 32, atr_expanding: 33,
  vol_delta_buy_ratio: 34, vol_delta_accel: 35, ema_dist_norm: 36,
  ema_cross_signal: 37, stoch_k_norm: 38, stoch_kd_norm: 39,
  funding_rate_norm: 40, funding_sentiment: 41,
  hour_sin: 42, hour_cos: 43,
  market_yes_price: 44, market_price_momentum: 45, orderbook_imbalance: 46,
  spread_pct: 47, crowd_model_divergence: 48,
};

// ═══ Tree Processing ═══

function resolveFeatureIdx(splitName) {
  // Handle named features first (e.g. "multi_tf_agreement", "rsi_norm")
  if (featureNameToIdx) {
    const idx = featureNameToIdx.get(splitName);
    if (idx !== undefined) return idx;
  }
  // Fallback: "fN" format (e.g. "f0", "f26")
  if (splitName[0] === 'f') {
    const idx = parseInt(splitName.slice(1), 10);
    if (!isNaN(idx)) return idx;
  }
  return -1;
}

function indexTree(rawTree) {
  const nodeMap = new Map();

  function walk(node) {
    if (node.leaf !== undefined) {
      nodeMap.set(node.nodeid, { leaf: node.leaf });
      return;
    }
    const featureIdx = resolveFeatureIdx(node.split);
    nodeMap.set(node.nodeid, {
      featureIdx,
      threshold: node.split_condition,
      yes: node.yes,
      no: node.no,
      missing: node.missing ?? node.yes,
    });
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }

  walk(rawTree);
  return nodeMap;
}

// ═══ XGBoost Evaluation ═══

function evaluateTreeFast(nodeMap, features) {
  let nodeId = 0;
  for (;;) {
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    if (node.leaf !== undefined) return node.leaf;
    const val = features[node.featureIdx];
    if (val !== val || val === undefined) { nodeId = node.missing; continue; }
    nodeId = val < node.threshold ? node.yes : node.no;
  }
}

function predictXGBoost(features, numFeatures) {
  if (!processedTrees) return null;

  // XGBoost is tree-based — trees were trained on raw feature values,
  // so we must NOT normalize. Pass features directly.
  // Only use trees up to best_iteration (early stopping — extra trees overfit).
  let logit = 0;
  const trees = processedTrees;
  const len = numUsableTrees;
  for (let i = 0; i < len; i++) {
    logit += evaluateTreeFast(trees[i], features);
  }

  return 1 / (1 + Math.exp(-logit));
}

// ═══ Engineered Features (v2 — 25 interaction features) ═══
// Computed IN-PLACE in featureBuf[49..73] from base features [0..48]
// (indices shifted +5 from v4 due to 5 Polymarket features at [44-48])

function computeEngineeredFeaturesInPlace() {
  const sign = (v) => v > 0 ? 1 : v < 0 ? -1 : 0;

  const delta1m   = featureBuf[FI.delta_1m_pct];
  const delta3m   = featureBuf[FI.delta_3m_pct];
  const rsi       = featureBuf[FI.rsi_norm];
  const rsiSlope  = featureBuf[FI.rsi_slope];
  const vwapDist  = featureBuf[FI.vwap_dist];
  const vwapSlope = featureBuf[FI.vwap_slope];
  const macdLine  = featureBuf[FI.macd_line];
  const volRatio  = featureBuf[FI.vol_ratio_norm];
  const multiTf   = featureBuf[FI.multi_tf_agreement];
  const bbPctB    = featureBuf[FI.bb_percent_b];
  const bbSqueeze = featureBuf[FI.bb_squeeze];
  const atrPct    = featureBuf[FI.atr_pct_norm];
  const volBuy    = featureBuf[FI.vol_delta_buy_ratio];
  const emaCross  = featureBuf[FI.ema_cross_signal];
  const stochK    = featureBuf[FI.stoch_k_norm];
  const haConsec  = featureBuf[FI.ha_signed_consec];
  const regTrend  = featureBuf[FI.regime_trending];
  const regChop   = featureBuf[FI.regime_choppy];
  const regMR     = featureBuf[FI.regime_mean_reverting];

  // [49] delta_1m_capped — clip extreme spikes
  const clip = 0.003;
  featureBuf[49] = Math.max(-clip, Math.min(clip, delta1m));

  // [50] momentum_accel — is momentum accelerating?
  featureBuf[50] = delta1m - (delta3m / 3);

  // [51] rsi_x_trending — RSI means different things per regime
  featureBuf[51] = rsi * regTrend;

  // [52] rsi_x_choppy
  featureBuf[52] = rsi * regChop;

  // [53] rsi_x_mean_rev
  featureBuf[53] = rsi * regMR;

  // [54] delta1m_x_multitf — momentum confirmed by multi-timeframe
  featureBuf[54] = delta1m * multiTf;

  // [55] bb_pctb_x_squeeze — BB position during squeeze = breakout signal
  featureBuf[55] = bbPctB * bbSqueeze;

  // [56] vol_buy_x_delta — volume confirms price direction
  featureBuf[56] = volBuy * sign(delta1m);

  // [57] vwap_trend_strength — distance × slope direction
  featureBuf[57] = vwapDist * sign(vwapSlope);

  // [58] rsi_divergence — price up but RSI down = bearish divergence
  featureBuf[58] = sign(delta3m) * (-rsiSlope);

  // [59] combined_oscillator — average of 3 oscillators
  featureBuf[59] = (rsi + stochK + bbPctB) / 3;

  // [60] ha_delta_agree — Heiken Ashi agrees with delta direction
  featureBuf[60] = (sign(haConsec) === sign(delta1m)) ? 1 : 0;

  // [61] delta_1m_atr_adj — volatility-normalized momentum
  const atrSafe = Math.max(atrPct, 0.01);
  featureBuf[61] = delta1m / atrSafe;

  // [62] price_position_score — combined VWAP + BB + EMA position
  featureBuf[62] = sign(vwapDist) * 0.4 + (bbPctB - 0.5) * 0.3 + (emaCross - 0.5) * 0.3;

  // [63] vol_weighted_momentum
  featureBuf[63] = delta1m * volRatio;

  // [64] macd_x_rsi_slope — trend confirmation
  featureBuf[64] = sign(macdLine) * rsiSlope;

  // ═══ 6 agreement/confirmation features ═══

  // [65] trend_alignment_score — all trend indicators aligned
  featureBuf[65] = regTrend * multiTf * sign(delta1m);

  // [66] oscillator_extreme — RSI in extreme zones (>0.7 or <0.3)
  featureBuf[66] = Math.max(rsi - 0.7, 0) + Math.max(0.3 - rsi, 0);

  // [67] vol_momentum_confirm — volume confirms momentum with magnitude
  featureBuf[67] = volBuy * sign(delta1m) * volRatio;

  // [68] squeeze_breakout_potential — StochRSI extremes during BB squeeze
  featureBuf[68] = bbSqueeze * Math.abs(stochK - 0.5) * 2;

  // [69] multi_indicator_agree — count indicators agreeing on direction
  const deltaDir = sign(delta1m);
  const macdHist = featureBuf[FI.macd_hist];
  const agreeCount = (
    (sign(haConsec) === deltaDir ? 1 : 0) +
    (sign(macdHist) === deltaDir ? 1 : 0) +
    (sign(featureBuf[FI.vwap_dist]) === deltaDir ? 1 : 0) +
    ((rsi > 0.5 ? 1 : -1) === deltaDir ? 1 : 0) +
    multiTf
  );
  featureBuf[69] = agreeCount / 5;

  // [70] stoch_rsi_extreme — extreme StochRSI zones
  featureBuf[70] = Math.max(stochK - 0.8, 0) * 5 + Math.max(0.2 - stochK, 0) * 5;

  // ═══ 3 NEW Polymarket crowd/orderbook interaction features ═══

  // [71] crowd_agree_momentum — crowd momentum agrees with price momentum
  const mktMomentum = featureBuf[FI.market_price_momentum];
  featureBuf[71] = sign(mktMomentum) * sign(delta1m);

  // [72] divergence_x_confidence — model-crowd divergence weighted by confidence
  const crowdDiv = featureBuf[FI.crowd_model_divergence];
  const ruleConf = featureBuf[FI.rule_confidence];
  featureBuf[72] = crowdDiv * ruleConf;

  // [73] imbalance_x_vol_delta — orderbook imbalance × volume buy ratio
  const obImbalance = featureBuf[FI.orderbook_imbalance];
  featureBuf[73] = obImbalance * volBuy;
}

// ═══ Public API ═══

export async function loadMLModel(
  modelPath = '/ml/xgboost_model.json',
  normPath = '/ml/norm_browser.json'
) {
  if (processedTrees) return true;
  if (isLoading) return false;

  isLoading = true;
  loadError = null;

  try {
    const [modelResp, normResp] = await Promise.all([
      fetch(modelPath), fetch(normPath),
    ]);

    if (!modelResp.ok) throw new Error(`Model fetch failed: ${modelResp.status}`);
    if (!normResp.ok) throw new Error(`Norm fetch failed: ${normResp.status}`);

    const [rawModel, rawNorm] = await Promise.all([
      modelResp.json(), normResp.json(),
    ]);

    // Detect model version
    modelVersion = rawModel.version || 1;
    modelNumFeatures = rawModel.num_features || BASE_FEATURES;
    optimalThreshold = Math.max(rawModel.optimal_threshold || 0.65, 0.60); // min 0.60
    modelMetrics = rawModel.metrics || null;

    // Platt calibration params (v4+)
    plattA = rawModel.platt_a ?? 1.0;
    plattB = rawModel.platt_b ?? 0.0;

    // Build feature name → index lookup (for models with named splits)
    if (rawModel.feature_names && rawModel.feature_names.length > 0) {
      featureNameToIdx = new Map();
      for (let i = 0; i < rawModel.feature_names.length; i++) {
        featureNameToIdx.set(rawModel.feature_names[i], i);
      }
    }

    // Pre-index trees (only up to best_iteration to exclude overfit trees)
    const totalTrees = rawModel.trees.length;
    const bestIter = rawModel.best_iteration;
    numUsableTrees = (bestIter != null && bestIter < totalTrees)
      ? bestIter + 1
      : totalTrees;

    processedTrees = new Array(numUsableTrees);
    for (let i = 0; i < numUsableTrees; i++) {
      processedTrees[i] = indexTree(rawModel.trees[i]);
    }

    // Copy norm params into TypedArrays
    const nf = rawNorm.means.length;
    normMeans = new Float64Array(nf);
    normStds = new Float64Array(nf);
    for (let i = 0; i < nf; i++) {
      normMeans[i] = rawNorm.means[i];
      normStds[i] = rawNorm.stds[i] || 1;
    }

    // Memory estimate
    let totalNodes = 0;
    for (let i = 0; i < numUsableTrees; i++) totalNodes += processedTrees[i].size;
    modelMemoryKB = Math.round((totalNodes * 80 + nf * 16) / 1024);

    console.log(
      `[ML] XGBoost v${modelVersion} loaded: ${numUsableTrees}/${totalTrees} trees (best_iter=${bestIter}), ${modelNumFeatures} features, ~${modelMemoryKB}KB`
    );
    if (modelMetrics) {
      console.log(
        `[ML] Metrics: ${(modelMetrics.accuracy * 100).toFixed(1)}% acc, ` +
        `${((modelMetrics.high_conf_accuracy || 0) * 100).toFixed(1)}% high-conf ` +
        `(threshold=${optimalThreshold})`
      );
    }

    isLoading = false;
    return true;
  } catch (err) {
    console.warn('[ML] Failed to load model:', err.message);
    loadError = err.message;
    isLoading = false;
    return false;
  }
}

export function isMLReady() {
  return processedTrees !== null;
}

export function getMLStatus() {
  if (processedTrees) {
    return {
      status: 'ready',
      version: modelVersion,
      trees: numUsableTrees,
      features: modelNumFeatures,
      threshold: optimalThreshold,
      memoryKB: modelMemoryKB,
      metrics: modelMetrics,
      error: null,
    };
  }
  if (isLoading) return { status: 'loading', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: null };
  if (loadError) return { status: 'error', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: loadError };
  return { status: 'not_loaded', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: null };
}

export function unloadMLModel() {
  processedTrees = null;
  numUsableTrees = 0;
  normMeans = null;
  normStds = null;
  featureNameToIdx = null;
  modelMemoryKB = 0;
  modelVersion = 1;
  modelNumFeatures = BASE_FEATURES;
  modelMetrics = null;
  plattA = 1.0;
  plattB = 0.0;
  if (IS_DEV) console.log('[ML] Model unloaded');
}

/**
 * Extract 49 base features into featureBuf (in-place, zero alloc).
 * If model is v2, also computes 25 engineered features [49-73].
 */
function extractLiveFeaturesInPlace({
  price, priceToBeat, rsi, rsiSlope, macd, vwap, vwapSlope,
  heikenColor, heikenCount, delta1m, delta3m, volumeRecent, volumeAvg,
  regime, session, minutesLeft, ruleProbUp, ruleConfidence,
  vwapCrossCount, bestEdge, multiTfAgreement, failedVwapReclaim,
  bbWidth, bbPercentB, bbSqueeze, bbSqueezeIntensity,
  atrPct, atrRatio,
  volDeltaBuyRatio, volDeltaAccel,
  emaDistPct, emaCrossSignal,
  stochK, stochKD,
  fundingRatePct, fundingSentiment,
  marketYesPrice, marketPriceMomentum, orderbookImbalance, spreadPct,
}) {
  const ptbDistPct = priceToBeat ? (price - priceToBeat) / priceToBeat : 0;
  const isGreen = heikenColor === 'green';
  const haSignedConsec = isGreen ? (heikenCount || 0) : -(heikenCount || 0);
  const volRatio = volumeAvg > 0 ? (volumeRecent || 0) / volumeAvg : 1;

  // [0-15] Numerical
  featureBuf[0]  = ptbDistPct;
  featureBuf[1]  = (rsi ?? 50) / 100;
  featureBuf[2]  = rsiSlope ?? 0;
  featureBuf[3]  = macd?.histogram ?? 0;
  featureBuf[4]  = macd?.macd ?? 0;
  featureBuf[5]  = vwap ? (price - vwap) / vwap : 0;
  featureBuf[6]  = vwapSlope ?? 0;
  featureBuf[7]  = haSignedConsec / 15;
  featureBuf[8]  = delta1m ? delta1m / price : 0;
  featureBuf[9]  = delta3m ? delta3m / price : 0;
  featureBuf[10] = Math.min(volRatio, 5) / 5;
  featureBuf[11] = (minutesLeft ?? 7.5) / 15;
  featureBuf[12] = ruleProbUp ?? 0.5;
  featureBuf[13] = ruleConfidence ?? 0;
  featureBuf[14] = Math.min(vwapCrossCount ?? 0, 10) / 10;
  featureBuf[15] = Math.min(bestEdge ?? 0, 0.5);

  // [16-19] Regime one-hot
  featureBuf[16] = regime === 'trending'       ? 1 : 0;
  featureBuf[17] = regime === 'choppy'         ? 1 : 0;
  featureBuf[18] = regime === 'mean_reverting' ? 1 : 0;
  featureBuf[19] = regime === 'moderate'       ? 1 : 0;

  // [20-24] Session one-hot
  featureBuf[20] = session === 'Asia'           ? 1 : 0;
  featureBuf[21] = session === 'Europe'         ? 1 : 0;
  featureBuf[22] = session === 'US'             ? 1 : 0;
  featureBuf[23] = session === 'EU/US Overlap'  ? 1 : 0;
  featureBuf[24] = session === 'Off-hours'      ? 1 : 0;

  // [25-27] Binary flags
  featureBuf[25] = isGreen                      ? 1 : 0;
  featureBuf[26] = multiTfAgreement             ? 1 : 0;
  featureBuf[27] = failedVwapReclaim            ? 1 : 0;

  // [28-30] Bollinger Bands
  featureBuf[28] = bbWidth ?? 0;
  featureBuf[29] = bbPercentB != null ? bbPercentB : 0.5;
  featureBuf[30] = bbSqueeze ? 1 : 0;

  // [31-33] ATR
  featureBuf[31] = atrPct != null ? Math.min(atrPct, 2) / 2 : 0.5;
  featureBuf[32] = atrRatio != null ? Math.min(atrRatio, 3) / 3 : 0.33;
  featureBuf[33] = (atrRatio ?? 1) > 1.1 ? 1 : 0;

  // [34-35] Volume Delta
  featureBuf[34] = volDeltaBuyRatio != null ? volDeltaBuyRatio : 0.5;
  featureBuf[35] = volDeltaAccel != null ? Math.max(-0.5, Math.min(0.5, volDeltaAccel)) + 0.5 : 0.5;

  // [36-37] EMA Crossover
  featureBuf[36] = emaDistPct != null ? Math.max(-1, Math.min(1, emaDistPct * 10)) / 2 + 0.5 : 0.5;
  featureBuf[37] = emaCrossSignal != null ? (emaCrossSignal + 1) / 2 : 0.5;

  // [38-39] Stochastic RSI
  featureBuf[38] = stochK != null ? stochK / 100 : 0.5;
  featureBuf[39] = stochKD != null ? Math.max(-50, Math.min(50, stochKD)) / 100 + 0.5 : 0.5;

  // [40-41] Funding Rate
  featureBuf[40] = fundingRatePct != null ? Math.max(-0.1, Math.min(0.1, fundingRatePct)) * 5 + 0.5 : 0.5;
  featureBuf[41] = fundingSentiment === 'BULLISH' ? 1 : fundingSentiment === 'BEARISH' ? 0 : 0.5;

  // [42-43] Time cyclical encoding (hour of day as sin/cos)
  const now = new Date();
  const hourUTC = now.getUTCHours() + now.getUTCMinutes() / 60;
  featureBuf[42] = Math.sin(hourUTC / 24 * 2 * Math.PI);
  featureBuf[43] = Math.cos(hourUTC / 24 * 2 * Math.PI);

  // [44-48] Polymarket features
  const mktYes = marketYesPrice ?? 0.5;
  featureBuf[44] = Math.max(0.01, Math.min(0.99, mktYes));
  featureBuf[45] = Math.max(-0.1, Math.min(0.1, marketPriceMomentum ?? 0));
  featureBuf[46] = Math.max(-1, Math.min(1, orderbookImbalance ?? 0));
  featureBuf[47] = Math.max(0, Math.min(1, spreadPct ?? 0.02));
  featureBuf[48] = Math.abs((ruleProbUp ?? 0.5) - mktYes);

  // [49-73] Engineered features (v2 only — computed from base features above)
  if (modelVersion >= 2) {
    computeEngineeredFeaturesInPlace();
  }

  return featureBuf;
}

/**
 * Make ML prediction.
 * @returns {{ probUp, confidence, side, isHighConfidence, threshold }} or null
 */
export function predictML(features) {
  if (!processedTrees) return null;

  const numFeat = modelVersion >= 2 ? MAX_FEATURES : BASE_FEATURES;
  let probUp = predictXGBoost(features, numFeat);
  if (probUp === null) return null;

  // Apply Platt calibration if available (v4+)
  // calibrated = sigmoid(A * rawProb + B)
  if (plattA !== 1.0 || plattB !== 0.0) {
    probUp = 1 / (1 + Math.exp(-(plattA * probUp + plattB)));
  }

  const confidence = Math.abs(probUp - 0.5) * 2;
  const side = probUp >= 0.5 ? 'UP' : 'DOWN';
  const isHighConfidence = probUp > optimalThreshold || probUp < (1 - optimalThreshold);

  return { probUp, confidence, side, isHighConfidence, threshold: optimalThreshold };
}

// Backward compat export
export function extractLiveFeatures(params) {
  return extractLiveFeaturesInPlace(params);
}

/**
 * ═══ ENSEMBLE: ML + Rule-based ═══
 * v2: Higher alpha when ML is high-confidence (trained threshold)
 */
export function ensemblePrediction(mlProbUp, mlConfidence, ruleProbUp, isHighConfidence) {
  let alpha, source;

  if (isHighConfidence && mlConfidence >= 0.4) {
    alpha = 0.80;
    source = 'ML-high-conf';
  } else if (mlConfidence >= 0.4) {
    alpha = 0.70;
    source = 'ML-dominant';
  } else if (mlConfidence >= 0.2) {
    alpha = 0.50;
    source = 'Equal blend';
  } else {
    alpha = 0.30;
    source = 'Rule-dominant';
  }

  const mlSide = mlProbUp >= 0.5;
  const ruleSide = ruleProbUp >= 0.5;

  let ensembleProbUp = alpha * mlProbUp + (1 - alpha) * ruleProbUp;

  if (mlSide === ruleSide) {
    ensembleProbUp += (mlSide ? 1 : -1) * 0.03;
    source += '+agree';
  } else {
    ensembleProbUp = 0.5 + (ensembleProbUp - 0.5) * 0.75;
    source += '+conflict';
  }

  ensembleProbUp = Math.max(0.01, Math.min(0.99, ensembleProbUp));

  return { ensembleProbUp, alpha, source };
}

/**
 * ═══ Full Pipeline: Extract → Engineer → Predict → Ensemble ═══
 */
export function getMLPrediction(marketState, ruleProbUp) {
  if (!isMLReady()) {
    return {
      available: false,
      ensembleProbUp: ruleProbUp,
      mlProbUp: null,
      mlConfidence: null,
      mlSide: null,
      isHighConfidence: false,
      alpha: 0,
      source: 'Rule-only (ML not loaded)',
      modelVersion: 0,
    };
  }

  extractLiveFeaturesInPlace({
    ...marketState,
    ruleProbUp,
    ruleConfidence: Math.abs(ruleProbUp - 0.5) * 2,
  });

  const mlResult = predictML(featureBuf);
  if (!mlResult) {
    return {
      available: false,
      ensembleProbUp: ruleProbUp,
      mlProbUp: null,
      mlConfidence: null,
      mlSide: null,
      isHighConfidence: false,
      alpha: 0,
      source: 'Rule-only (ML failed)',
      modelVersion,
    };
  }

  const ensemble = ensemblePrediction(
    mlResult.probUp, mlResult.confidence, ruleProbUp, mlResult.isHighConfidence
  );

  return {
    available: true,
    ensembleProbUp: ensemble.ensembleProbUp,
    mlProbUp: mlResult.probUp,
    mlConfidence: mlResult.confidence,
    mlSide: mlResult.side,
    isHighConfidence: mlResult.isHighConfidence,
    alpha: ensemble.alpha,
    source: ensemble.source,
    modelVersion,
  };
}