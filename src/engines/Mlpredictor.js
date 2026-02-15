/**
 * ═══ ML Predictor (Browser) — XGBoost + LightGBM Ensemble v6 ═══
 *
 * Thin facade re-exporting the same public API from split modules.
 * Internal modules: ml/state, ml/featureMap, ml/featureExtract,
 *   ml/treeEval, ml/ensemble, ml/calibration, ml/lgbPredictor
 *
 * v6: Adds LightGBM as ensemble partner. Averages XGB and LGB
 * calibrated probabilities using trained weights. Falls back to
 * XGB-only if LGB model is not available.
 */

import { ML_CONFIDENCE } from '../config.js';
import * as S from './ml/state.js';
import { BASE_FEATURES } from './ml/state.js';
import { indexTree, predictXGBoost } from './ml/treeEval.js';
import { calibrate } from './ml/calibration.js';
import { featureBuf, extractLiveFeaturesInPlace } from './ml/featureExtract.js';
import { ensemblePrediction } from './ml/ensemble.js';
import { loadLgbModel, isLgbReady, predictLgb, unloadLgbModel } from './ml/lgbPredictor.js';

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';

// Ensemble weights (loaded from norm_browser.json or model metadata)
let ensembleWeightXgb = 0.5;
let ensembleWeightLgb = 0.5;

/** Set ensemble weights (used by bot's disk-based loader). */
export function setEnsembleWeights(xgb, lgb) {
  ensembleWeightXgb = xgb;
  ensembleWeightLgb = lgb;
}

// ═══ Public API ═══

export async function loadMLModel(
  modelPath = '/ml/xgboost_model.json',
) {
  if (S.processedTrees) return true;
  if (S.isLoading) return false;

  S.setState({ isLoading: true, loadError: null });

  try {
    const modelResp = await fetch(modelPath);
    if (!modelResp.ok) throw new Error(`Model fetch failed: ${modelResp.status}`);

    const rawModel = await modelResp.json();

    const version = rawModel.version ?? 1;
    const numFeatures = rawModel.num_features ?? BASE_FEATURES;
    const threshold = Math.max(rawModel.optimal_threshold ?? 0.65, 0.52);

    S.setState({
      modelVersion: version,
      modelNumFeatures: numFeatures,
      optimalThreshold: threshold,
      modelMetrics: rawModel.metrics || null,
      plattA: rawModel.platt_a ?? 1.0,
      plattB: rawModel.platt_b ?? 0.0,
    });

    // Build feature name → index lookup
    if (rawModel.feature_names && rawModel.feature_names.length > 0) {
      const map = new Map();
      for (let i = 0; i < rawModel.feature_names.length; i++) {
        map.set(rawModel.feature_names[i], i);
      }
      S.setState({ featureNameToIdx: map });
    }

    // Pre-index trees (only up to best_iteration)
    const totalTrees = rawModel.trees.length;
    const bestIter = rawModel.best_iteration;
    const usable = (bestIter != null && bestIter < totalTrees) ? bestIter + 1 : totalTrees;

    const trees = new Array(usable);
    for (let i = 0; i < usable; i++) {
      trees[i] = indexTree(rawModel.trees[i]);
    }

    let totalNodes = 0;
    for (let i = 0; i < usable; i++) totalNodes += trees[i].size;
    const memKB = Math.round((totalNodes * 80) / 1024);

    S.setState({
      processedTrees: trees,
      numUsableTrees: usable,
      modelMemoryKB: memKB,
      isLoading: false,
    });

    console.log(
      `[ML] XGBoost v${version} loaded: ${usable}/${totalTrees} trees (best_iter=${bestIter}), ${numFeatures} features, ~${memKB}KB`
    );
    if (rawModel.metrics) {
      console.log(
        `[ML] Metrics: ${(rawModel.metrics.accuracy * 100).toFixed(1)}% acc, ` +
        `${((rawModel.metrics.high_conf_accuracy || 0) * 100).toFixed(1)}% high-conf ` +
        `(threshold=${threshold})`
      );
    }

    // M13: Pre-load ensemble weights BEFORE LGB loads (prevents race with predictions)
    try {
      const normResp = await fetch('/ml/norm_browser.json');
      const norm = await normResp.json();
      if (norm.ensemble_weights) {
        ensembleWeightXgb = norm.ensemble_weights.xgb ?? 0.5;
        ensembleWeightLgb = norm.ensemble_weights.lgb ?? 0.5;
        console.log(`[ML] Ensemble weights: XGB=${ensembleWeightXgb} LGB=${ensembleWeightLgb}`);
      }
    } catch { /* use defaults */ }

    // Load LightGBM model (non-blocking, graceful degradation)
    loadLgbModel().then(ok => {
      if (ok) console.log(`[ML] LightGBM ready, ensemble: XGB=${ensembleWeightXgb} LGB=${ensembleWeightLgb}`);
    });

    return true;
  } catch (err) {
    console.warn('[ML] Failed to load model:', err.message);
    S.setState({ loadError: err.message, isLoading: false });
    return false;
  }
}

export function isMLReady() {
  return S.processedTrees !== null;
}

export function getMLStatus() {
  if (S.processedTrees) {
    return {
      status: 'ready',
      version: S.modelVersion,
      trees: S.numUsableTrees,
      features: S.modelNumFeatures,
      threshold: S.optimalThreshold,
      memoryKB: S.modelMemoryKB,
      metrics: S.modelMetrics,
      error: null,
      lgbReady: isLgbReady(),
    };
  }
  if (S.isLoading) return { status: 'loading', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: null, lgbReady: false };
  if (S.loadError) return { status: 'error', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: S.loadError, lgbReady: false };
  return { status: 'not_loaded', version: 0, trees: 0, features: 0, threshold: 0.65, memoryKB: 0, metrics: null, error: null, lgbReady: false };
}

export function unloadMLModel() {
  S.setState({
    processedTrees: null,
    numUsableTrees: 0,
    featureNameToIdx: null,
    modelMemoryKB: 0,
    modelVersion: 1,
    modelNumFeatures: BASE_FEATURES,
    modelMetrics: null,
    plattA: 1.0,
    plattB: 0.0,
  });
  unloadLgbModel();
  if (IS_DEV) console.log('[ML] Models unloaded');
}

export function predictML(features) {
  if (!S.processedTrees) return null;

  // XGBoost prediction
  let xgbProb = predictXGBoost(features);
  if (xgbProb === null) return null;
  xgbProb = calibrate(xgbProb);

  // LightGBM prediction (if available)
  let probUp;
  if (isLgbReady()) {
    const lgbProb = predictLgb(features);
    if (lgbProb !== null) {
      // Weighted ensemble
      probUp = ensembleWeightXgb * xgbProb + ensembleWeightLgb * lgbProb;
    } else {
      probUp = xgbProb;
    }
  } else {
    probUp = xgbProb;
  }

  const confidence = Math.abs(probUp - 0.5) * 2;
  const side = probUp >= 0.5 ? 'UP' : 'DOWN';
  const isHighConfidence = probUp > S.optimalThreshold || probUp < (1 - S.optimalThreshold);

  return { probUp, confidence, side, isHighConfidence, threshold: S.optimalThreshold };
}

// Backward compat export
export function extractLiveFeatures(params) {
  return extractLiveFeaturesInPlace(params);
}

// Re-export ensemble
export { ensemblePrediction } from './ml/ensemble.js';

/**
 * Full Pipeline: Extract -> Engineer -> Predict -> Ensemble
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
      modelVersion: S.modelVersion,
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
    modelVersion: S.modelVersion,
  };
}
