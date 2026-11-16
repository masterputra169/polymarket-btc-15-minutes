/**
 * Pipeline v4 Hybrid Residual overlay: shallow depth-2 XGBoost trees anchored on
 * `base_margin = logit(v2_prob_up)` to adjust the 395d production v2 ensemble for
 * Chainlink PTB distance, 60s TWAP physics, BTC basis drift, 3s cross-feed lead,
 * and live CLOB L2 book microstructure.
 */

import { evaluateTreeFast, indexTree, type IndexedTree, type RawTreeNode } from './treeEval.ts';

export const HYBRID_RESIDUAL_FEATURES = [
  'oracle_ptb_dist_pct',
  'twap_physics_z',
  'basis_pct',
  'basis_drift_pct',
  'cross_feed_lead',
  'orderbook_imbalance',
  'spread_pct',
  'imb1',
  'imb5',
  'minutes_left_norm',
  'market_yes_price',
  'crowd_model_divergence',
  'v2_minus_mkt_logit',
] as const;

export interface HybridResidualInputs {
  oraclePtbDistPct: number;
  twapPhysicsZ: number;
  basisPct: number;
  basisDriftPct: number;
  crossFeedLead: number;
  orderbookImbalance: number;
  spreadPct: number;
  imb1: number;
  imb5: number;
  minutesLeftNorm: number;
  marketYesPrice: number;
  crowdModelDivergence: number;
}

export interface HybridResidualModelJson {
  schema_version?: number;
  id?: string;
  requires_base_model_id?: string | null;
  logit_eps?: number;
  feature_names?: string[];
  best_iteration?: number;
  trees: RawTreeNode[];
  metrics?: Record<string, unknown>;
}

export interface HybridResidualResult {
  probUp: number;
  deltaProb: number;
  active: boolean;
  id: string | null;
}

let enabled = true;
let loadedId: string | null = null;
let requiresBaseModelId: string | null = null;
let logitEps = 1e-4;
let featureNames: string[] = [...HYBRID_RESIDUAL_FEATURES];
let indexedTrees: IndexedTree[] | null = null;
let loadedMetrics: Record<string, unknown> | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function logit(p: number, eps = logitEps): number {
  const cp = clamp(p, eps, 1 - eps);
  return Math.log(cp / (1 - cp));
}

function sigmoid(x: number): number {
  const cx = clamp(x, -30, 30);
  return 1 / (1 + Math.exp(-cx));
}

/** Enable or disable applying the loaded Hybrid Residual overlay. */
export function setHybridResidualEnabled(flag: boolean): void {
  enabled = Boolean(flag);
}

/** Whether Hybrid Residual overlay is permitted by runtime config. */
export function isHybridResidualEnabled(): boolean {
  return enabled;
}

/** Parse, index, and activate an exported `hybrid_residual_v4.json` model payload. */
export function loadHybridResidualFromData(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as HybridResidualModelJson;
  if (!Array.isArray(obj.trees) || obj.trees.length === 0) return false;

  const names =
    Array.isArray(obj.feature_names) && obj.feature_names.length > 0
      ? obj.feature_names
      : [...HYBRID_RESIDUAL_FEATURES];

  const nameToIdx = new Map<string, number>();
  for (let i = 0; i < names.length; i++) nameToIdx.set(names[i], i);

  const bestIter = obj.best_iteration;
  const usableCount =
    bestIter != null && Number.isInteger(bestIter) && bestIter >= 0 && bestIter < obj.trees.length
      ? bestIter + 1
      : obj.trees.length;

  const trees = new Array<IndexedTree>(usableCount);
  for (let i = 0; i < usableCount; i++) {
    trees[i] = indexTree(obj.trees[i], (name) => nameToIdx.get(name) ?? -1);
  }

  featureNames = names;
  indexedTrees = trees;
  loadedId = typeof obj.id === 'string' && obj.id ? obj.id : 'v4-hybrid';
  requiresBaseModelId =
    typeof obj.requires_base_model_id === 'string' && obj.requires_base_model_id
      ? obj.requires_base_model_id
      : null;
  logitEps =
    typeof obj.logit_eps === 'number' && Number.isFinite(obj.logit_eps) && obj.logit_eps > 0 && obj.logit_eps < 0.1
      ? obj.logit_eps
      : 1e-4;
  loadedMetrics = obj.metrics && typeof obj.metrics === 'object' ? obj.metrics : null;
  return true;
}

/** Clear loaded Hybrid Residual overlay from memory. */
export function unloadHybridResidual(): void {
  indexedTrees = null;
  loadedId = null;
  requiresBaseModelId = null;
  logitEps = 1e-4;
  featureNames = [...HYBRID_RESIDUAL_FEATURES];
  loadedMetrics = null;
}

/** True when Hybrid Residual overlay is enabled, loaded, and compatible with activeBaseModelId. */
export function isHybridResidualReady(activeBaseModelId?: string | null): boolean {
  if (!enabled || !indexedTrees || indexedTrees.length === 0) return false;
  if (requiresBaseModelId) {
    return typeof activeBaseModelId === 'string' && activeBaseModelId === requiresBaseModelId;
  }
  return true;
}

/** Inspection summary for startup logs and telemetry. */
export function getHybridResidualInfo(activeBaseModelId?: string | null) {
  return {
    enabled,
    loaded: Boolean(indexedTrees?.length),
    active: isHybridResidualReady(activeBaseModelId),
    id: loadedId,
    requiresBaseModelId,
    trees: indexedTrees?.length ?? 0,
    features: featureNames.length,
    metrics: loadedMetrics,
  };
}

/**
 * Evaluate the Hybrid Residual overlay on top of calibrated base probability `baseProbUp`.
 * Mirrors `bst_hybrid.predict(DMatrix(X, base_margin=logit(baseProbUp)))` to float precision.
 */
export function applyHybridResidual(
  baseProbUp: number,
  inputs: HybridResidualInputs | null | undefined,
  activeBaseModelId?: string | null,
): HybridResidualResult {
  if (!Number.isFinite(baseProbUp) || !inputs || !isHybridResidualReady(activeBaseModelId)) {
    return { probUp: baseProbUp, deltaProb: 0, active: false, id: null };
  }

  const baseMargin = logit(baseProbUp);
  const mktMid = clamp(
    Number.isFinite(inputs.marketYesPrice) ? inputs.marketYesPrice : 0.5,
    logitEps,
    1 - logitEps,
  );
  const byName: Record<string, number> = {
    oracle_ptb_dist_pct: inputs.oraclePtbDistPct,
    twap_physics_z: inputs.twapPhysicsZ,
    basis_pct: inputs.basisPct,
    basis_drift_pct: inputs.basisDriftPct,
    cross_feed_lead: inputs.crossFeedLead,
    orderbook_imbalance: inputs.orderbookImbalance,
    spread_pct: inputs.spreadPct,
    imb1: inputs.imb1,
    imb5: inputs.imb5,
    minutes_left_norm: inputs.minutesLeftNorm,
    market_yes_price: inputs.marketYesPrice,
    crowd_model_divergence: inputs.crowdModelDivergence,
    v2_minus_mkt_logit: baseMargin - logit(mktMid),
  };

  const vec = new Float32Array(featureNames.length);
  for (let i = 0; i < featureNames.length; i++) {
    const val = byName[featureNames[i]];
    vec[i] = typeof val === 'number' && Number.isFinite(val) ? Math.fround(val) : NaN;
  }

  let residualLogit = 0;
  const trees = indexedTrees!;
  for (let i = 0; i < trees.length; i++) {
    residualLogit += evaluateTreeFast(trees[i], vec);
  }

  const finalProbUp = clamp(sigmoid(baseMargin + residualLogit), 0.001, 0.999);
  return {
    probUp: finalProbUp,
    deltaProb: finalProbUp - baseProbUp,
    active: true,
    id: loadedId,
  };
}
