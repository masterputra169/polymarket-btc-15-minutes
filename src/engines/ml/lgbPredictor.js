/**
 * LightGBM browser-side inference.
 *
 * Loads lightgbm_model.json exported by trainXGBoost_v3.py,
 * traverses trees iteratively, sums leaf values + init_score,
 * applies sigmoid → Platt calibration.
 */

// ═══ Module state ═══
let lgbTrees = null;       // Array of pre-indexed tree Maps
let lgbNumTrees = 0;
let lgbInitScore = 0;
let lgbPlattA = 1.0;
let lgbPlattB = 0.0;
let lgbPlattOnLogits = false; // v9: Platt on raw logits
let lgbLoading = false;
let lgbError = null;

/**
 * Pre-index a LightGBM tree for fast iterative traversal.
 * Assigns integer nodeIds and flattens into a Map.
 */
function indexLgbTree(treeStructure) {
  const nodeMap = new Map();
  let nextId = 0;

  function walk(node) {
    const id = nextId++;

    if (node.leaf_value !== undefined) {
      nodeMap.set(id, { leaf: node.leaf_value });
      return id;
    }

    const leftId = walk(node.left_child);
    const rightId = walk(node.right_child);

    nodeMap.set(id, {
      featureIdx: node.split_feature,
      threshold: node.threshold,
      defaultLeft: node.default_left === true, // strict: undefined → false (safer than !== false)
      yes: leftId,   // <= threshold
      no: rightId,   // > threshold
    });

    return id;
  }

  walk(treeStructure);
  return nodeMap;
}

/**
 * Evaluate a single LightGBM tree.
 */
function evaluateLgbTree(nodeMap, features) {
  let nodeId = 0;
  for (let depth = 0; depth < 200; depth++) {
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    if (node.leaf !== undefined) return node.leaf;

    const idx = node.featureIdx;
    if (idx < 0 || idx >= features.length) {
      nodeId = node.defaultLeft ? node.yes : node.no;
      continue;
    }

    const val = features[idx];
    if (val !== val || val === undefined) {
      // NaN or undefined → follow default direction
      nodeId = node.defaultLeft ? node.yes : node.no;
      continue;
    }

    nodeId = val <= node.threshold ? node.yes : node.no;
  }
  return 0;
}

/**
 * Initialize LightGBM from a pre-parsed JSON object (for Node.js bot).
 * @param {object} raw - parsed lightgbm_model.json
 * @returns {boolean}
 */
export function loadLgbModelFromData(raw) {
  if (lgbTrees) return true;

  lgbInitScore = raw.init_score ?? 0;
  lgbPlattA = raw.platt_a ?? 1.0;
  lgbPlattB = raw.platt_b ?? 0.0;
  lgbPlattOnLogits = raw.platt_on_logits ?? false;

  const treeInfos = raw.tree_info || [];
  const numTrees = Math.min(raw.num_trees ?? treeInfos.length, treeInfos.length);

  const trees = new Array(numTrees);
  for (let i = 0; i < numTrees; i++) {
    trees[i] = indexLgbTree(treeInfos[i].tree_structure);
  }

  lgbTrees = trees;
  lgbNumTrees = numTrees;
  return true;
}

/**
 * Load LightGBM model from JSON via HTTP fetch (for browser).
 * @param {string} modelPath - URL to lightgbm_model.json
 * @returns {Promise<boolean>}
 */
export async function loadLgbModel(modelPath = '/ml/lightgbm_model.json') {
  if (lgbTrees) return true;
  if (lgbLoading) return false;

  lgbLoading = true;
  lgbError = null;

  try {
    const resp = await fetch(modelPath);
    if (!resp.ok) throw new Error(`LGB fetch failed: ${resp.status}`);

    const raw = await resp.json();
    loadLgbModelFromData(raw);
    lgbLoading = false;

    const numTrees = lgbNumTrees;
    let totalNodes = 0;
    for (let i = 0; i < numTrees; i++) totalNodes += lgbTrees[i].size;
    const memKB = Math.round((totalNodes * 64) / 1024);

    console.log(
      `[ML] LightGBM loaded: ${numTrees} trees, ~${memKB}KB`
    );
    if (raw.metrics) {
      console.log(
        `[ML] LGB metrics: ${(raw.metrics.accuracy * 100).toFixed(1)}% acc, AUC=${raw.metrics.auc?.toFixed(4)}`
      );
    }

    return true;
  } catch (err) {
    console.warn('[ML] LightGBM not available:', err.message);
    lgbError = err.message;
    lgbLoading = false;
    return false;
  }
}

/**
 * Check if LightGBM model is loaded and ready.
 */
export function isLgbReady() {
  return lgbTrees !== null;
}

/**
 * Run LightGBM inference on feature buffer.
 * @param {Float64Array} features - normalized feature vector
 * @returns {number|null} - calibrated probability of UP
 */
export function predictLgb(features) {
  if (!lgbTrees) return null;

  let logit = lgbInitScore;
  for (let i = 0; i < lgbNumTrees; i++) {
    logit += evaluateLgbTree(lgbTrees[i], features);
  }

  let prob;
  if (lgbPlattOnLogits) {
    // v9: Platt on raw logits — sigmoid(A*logit + B)
    if (lgbPlattA !== 1.0 || lgbPlattB !== 0.0) {
      prob = 1 / (1 + Math.exp(-(lgbPlattA * logit + lgbPlattB)));
    } else {
      prob = 1 / (1 + Math.exp(-logit));
    }
  } else {
    // Legacy: sigmoid first, then Platt on probability (double-sigmoid)
    prob = 1 / (1 + Math.exp(-logit));
    if (lgbPlattA !== 1.0 || lgbPlattB !== 0.0) {
      prob = 1 / (1 + Math.exp(-(lgbPlattA * prob + lgbPlattB)));
    }
  }

  return prob;
}

/**
 * Unload LightGBM model to free memory.
 */
export function unloadLgbModel() {
  lgbTrees = null;
  lgbNumTrees = 0;
  lgbInitScore = 0;
  lgbPlattA = 1.0;
  lgbPlattB = 0.0;
  lgbPlattOnLogits = false;
}
