/**
 * Pure model/tree analytics extractor for POLY//15 Study Portal.
 * Walks XGBoost & LightGBM JSON trees to compute per-feature split counts,
 * root splits, split gains, calibration deciles, confidence buckets,
 * and full 27-model timeline lineage.
 */

export function classifyFeatureGroup(name, isEngineered = false) {
  if (isEngineered) return 'Engineered';
  if (/^(market_yes_price|market_price_momentum|orderbook_imbalance|spread_pct)$/.test(name)) return 'Polymarket CLOB';
  if (/^(vol_delta_|hurst_exponent|realized_vol_)/.test(name)) return 'Quant Microstructure';
  if (/^(ptb_dist_|price_to_vwap_|price_consistency|ema_dist_)/.test(name)) return 'Price & PTB';
  if (/^(delta_|momentum_|macd_|vwap_slope|heiken_|ema_cross_|multi_tf_|failed_vwap_)/.test(name)) return 'Momentum & Trend';
  if (/^(rsi_|stoch_|bb_|atr_|volume_|vwap_cross|volatility_|funding_rate)/.test(name)) return 'Oscillators & Vol';
  return 'Context / Regime';
}

export function extractXgbTreeStats(trees) {
  const splits = new Map();
  const rootSplits = new Map();
  let totalSplits = 0;
  if (!Array.isArray(trees)) return { splits, rootSplits, totalSplits };

  for (const root of trees) {
    if (!root || typeof root !== 'object') continue;
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.split === 'string') {
        totalSplits++;
        splits.set(node.split, (splits.get(node.split) || 0) + 1);
        if (node.depth === 0) {
          rootSplits.set(node.split, (rootSplits.get(node.split) || 0) + 1);
        }
      }
      if (Array.isArray(node.children)) {
        for (const ch of node.children) stack.push(ch);
      }
    }
  }
  return { splits, rootSplits, totalSplits };
}

export function extractLgbTreeStats(treeInfo, featureNames) {
  const splits = new Map();
  const gains = new Map();
  let totalSplits = 0;
  let totalGain = 0;
  if (!Array.isArray(treeInfo) || !Array.isArray(featureNames)) {
    return { splits, gains, totalSplits, totalGain };
  }

  for (const t of treeInfo) {
    const struct = t?.tree_structure;
    if (!struct || typeof struct !== 'object') continue;
    const stack = [struct];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.split_feature === 'number') {
        const fname = featureNames[node.split_feature] || `f${node.split_feature}`;
        const g = typeof node.split_gain === 'number' && Number.isFinite(node.split_gain) ? Math.max(0, node.split_gain) : 0;
        totalSplits++;
        totalGain += g;
        splits.set(fname, (splits.get(fname) || 0) + 1);
        gains.set(fname, (gains.get(fname) || 0) + g);
      }
      if (node.left_child) stack.push(node.left_child);
      if (node.right_child) stack.push(node.right_child);
    }
  }
  return { splits, gains, totalSplits, totalGain };
}

export function buildFeatureCatalog({ xgbJson, lgbJson, normJson, reportSummary }) {
  const featureNames = xgbJson?.feature_names || lgbJson?.feature_names;
  if (!Array.isArray(featureNames) || featureNames.length === 0) return [];

  const engCount = typeof xgbJson?.engineered_features === 'number' ? xgbJson.engineered_features : 0;
  const baseCount = engCount > 0 && featureNames.length > engCount ? featureNames.length - engCount : featureNames.length;

  const prunedSet = new Set(xgbJson?.pruned_features || reportSummary?.prunedFeatures || []);
  const preExclSet = new Set(xgbJson?.pre_excluded_features || []);
  const zeroSet = new Set(xgbJson?.zero_features || []);

  const xgbStats = extractXgbTreeStats(xgbJson?.trees);
  const lgbStats = extractLgbTreeStats(lgbJson?.tree_info, lgbJson?.feature_names || featureNames);
  const means = Array.isArray(normJson?.means) ? normJson.means : [];
  const stds = Array.isArray(normJson?.stds) ? normJson.stds : [];

  return featureNames.map((name, idx) => {
    const isEng = idx >= baseCount;
    const xgbS = xgbStats.splits.get(name) || 0;
    const xgbRoot = xgbStats.rootSplits.get(name) || 0;
    const lgbS = lgbStats.splits.get(name) || 0;
    const lgbG = lgbStats.gains.get(name) || 0;

    let status = 'active';
    if (preExclSet.has(name)) status = 'pre_excluded';
    else if (prunedSet.has(name)) status = 'pruned';
    else if (zeroSet.has(name) || (xgbS === 0 && lgbS === 0)) status = 'zero_split';

    return {
      idx,
      name,
      group: classifyFeatureGroup(name, isEng),
      isEngineered: isEng,
      status,
      xgbSplits: xgbS,
      xgbSharePct: xgbStats.totalSplits > 0 ? +((xgbS / xgbStats.totalSplits) * 100).toFixed(2) : 0,
      xgbRootSplits: xgbRoot,
      lgbSplits: lgbS,
      lgbGain: +lgbG.toFixed(1),
      lgbGainPct: lgbStats.totalGain > 0 ? +((lgbG / lgbStats.totalGain) * 100).toFixed(2) : 0,
      mean: typeof means[idx] === 'number' && Number.isFinite(means[idx]) ? +means[idx].toPrecision(4) : null,
      std: typeof stds[idx] === 'number' && Number.isFinite(stds[idx]) ? +stds[idx].toPrecision(4) : null,
    };
  });
}

export function extractExperimentSummary(ev) {
  const base = {
    ts: ev.ts ?? null,
    date: typeof ev.ts === 'string' ? ev.ts.slice(0, 10) : null,
    modelId: ev.id ?? null,
    title: ev.note || ev.slice || ev.kind || 'Model Evaluation',
    actor: ev.actor ?? 'manual',
    verdict: null,
    highlights: [],
  };

  if (ev.id === '20261116-p2-ef8dfd' && ev.fullOos_acc != null) {
    base.title = `Group-1 Upgrade (${ev.id}) vs ${ev.vs_previous || 'previous'} on ${ev.slice}`;
    base.verdict = 'PROMOTED';
    base.highlights = [
      `OOS 2,267 Acc ${ev.fullOos_acc}% · AUC ${ev.fullOos_auc} · Brier ${ev.fullOos_brier}`,
      `Skill vs Mkt +${ev.fullOos_skillPct}% · LogLoss ${ev.fullOos_logloss} · ECE ${ev.fullOos_ece}`,
      `Exact 2,175 Slice: AUC ${ev.exact2175_auc} · Skill +${ev.exact2175_skillPct}%`,
    ];
    return base;
  }

  if (ev.fullOos?.n) {
    base.verdict = 'BENCHMARKED';
    base.highlights = [
      `Slice: ${ev.fullOos.slice} · Market Brier ${(ev.fullOos.brierMkt ?? 0).toFixed(4)}`,
    ];
    for (const [k, obj] of Object.entries(ev.fullOos)) {
      if (obj && typeof obj === 'object' && obj.acc != null) {
        base.highlights.push(`${obj.name || k}: Acc ${obj.acc}% · AUC ${obj.auc} · Skill +${obj.skillPct}% · ECE ${obj.ece}`);
      }
    }
    return base;
  }

  const s = ev.summary;
  if (!s || typeof s !== 'object') return base;
  if (typeof s.verdict === 'string') base.verdict = s.verdict;
  else if (typeof s.conclusion === 'string') base.verdict = s.conclusion;
  else if (typeof s.decision === 'string') base.verdict = s.decision;

  if (s.brier_model != null && s.brier_market != null) {
    base.highlights.push(`Brier Model ${Number(s.brier_model).toFixed(4)} vs Market ${Number(s.brier_market).toFixed(4)}`);
  }
  if (s.skill_vs_market != null) base.highlights.push(`Skill vs Market ${(Number(s.skill_vs_market) * 100).toFixed(2)}%`);
  if (s.brier_vs_fresh_market && typeof s.brier_vs_fresh_market === 'object') {
    for (const [k, v] of Object.entries(s.brier_vs_fresh_market)) {
      if (v && typeof v === 'object') base.highlights.push(`${k}: Brier ${v.brier ?? v} ${v.skill != null ? `(skill ${(v.skill * 100).toFixed(2)}%)` : ''}`);
      else base.highlights.push(`${k}: ${v}`);
    }
  }
  if (s.lambda_weight_on_model_vs_fresh_price != null) {
    base.highlights.push(`Model weight vs fresh price: ${s.lambda_weight_on_model_vs_fresh_price}`);
  }
  if (s.roi_validate && typeof s.roi_validate === 'object') {
    base.highlights.push(`Validate ROI: ${JSON.stringify(s.roi_validate).slice(0, 120)}`);
  }
  if (s.model_180d && s.model_365d) {
    base.highlights.push(`180d Acc ${(s.model_180d.acc * 100).toFixed(2)}% AUC ${s.model_180d.auc.toFixed(4)} Skill ${(s.model_180d.skill * 100).toFixed(2)}%`);
    base.highlights.push(`365d Acc ${(s.model_365d.acc * 100).toFixed(2)}% AUC ${s.model_365d.auc.toFixed(4)} Skill ${(s.model_365d.skill * 100).toFixed(2)}%`);
  }
  return base;
}
