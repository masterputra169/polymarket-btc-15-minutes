/**
 * ML model loader for Node.js bot.
 * Reads model files from disk instead of HTTP fetch.
 * After loading into shared state, all inference functions work unchanged.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

// Import ML internals to populate shared state
import * as S from '../../../src/engines/ml/state.js';
import { indexTree } from '../../../src/engines/ml/treeEval.js';
import { loadLgbModelFromData, isLgbReady } from '../../../src/engines/ml/lgbPredictor.js';

// Re-export all inference functions — they work unchanged after state is loaded
export {
  getMLPrediction,
  isMLReady,
  getMLStatus,
  predictML,
} from '../../../src/engines/Mlpredictor.js';

import { setEnsembleWeights } from '../../../src/engines/Mlpredictor.js';

const log = createLogger('ML');

/**
 * Load XGBoost + LightGBM models from disk into shared ML state.
 * Same logic as Mlpredictor.js loadMLModel() but uses fs.readFileSync().
 */
export function loadMLModelFromDisk() {
  if (S.processedTrees) return true;

  try {
    const rawModel = JSON.parse(readFileSync(BOT_CONFIG.modelPath, 'utf-8'));
    const rawNorm = JSON.parse(readFileSync(BOT_CONFIG.normPath, 'utf-8'));

    const version = rawModel.version || 1;
    const numFeatures = rawModel.num_features || S.BASE_FEATURES;
    const threshold = Math.max(rawModel.optimal_threshold || 0.65, 0.60);

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

    log.info(
      `XGBoost v${version} loaded: ${usable}/${totalTrees} trees (best_iter=${bestIter}), ${numFeatures} features, ~${memKB}KB`
    );
    if (rawModel.metrics && rawModel.metrics.accuracy != null) {
      log.info(
        `Metrics: ${(rawModel.metrics.accuracy * 100).toFixed(1)}% acc, ` +
        `${((rawModel.metrics.high_conf_accuracy || 0) * 100).toFixed(1)}% high-conf ` +
        `(threshold=${threshold})`
      );
    }

    // Load LightGBM model if available
    const lgbPath = join(dirname(BOT_CONFIG.modelPath), 'lightgbm_model.json');
    if (existsSync(lgbPath)) {
      try {
        const lgbData = JSON.parse(readFileSync(lgbPath, 'utf-8'));
        loadLgbModelFromData(lgbData);
        log.info(`LightGBM loaded: ${lgbData.num_trees} trees`);

        // Load ensemble weights from norm
        if (rawNorm.ensemble_weights) {
          setEnsembleWeights(rawNorm.ensemble_weights.xgb ?? 0.5, rawNorm.ensemble_weights.lgb ?? 0.5);
          log.info(`Ensemble weights: XGB=${rawNorm.ensemble_weights.xgb} LGB=${rawNorm.ensemble_weights.lgb}`);
        }
      } catch (lgbErr) {
        log.warn(`LightGBM not loaded: ${lgbErr.message}`);
      }
    }

    return true;
  } catch (err) {
    log.error(`Failed to load model: ${err.message}`);
    S.setState({ loadError: err.message, isLoading: false });
    return false;
  }
}
