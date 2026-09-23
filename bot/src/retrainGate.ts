/**
 * Deploy gate for a freshly trained model: pure, so it can be tested without
 * importing autoRetrain.ts (which starts its scheduler on import).
 *
 * tests/test_model_contract.py reads the `audit.` / `ens.` field names out of
 * THIS file and asserts the Python trainer exports every one of them, so a
 * rename on either side fails a test instead of silently disabling a gate.
 *
 * 2026-09-23 — two changes, both about comparing like with like:
 *   - market_skill: the model must predict the resolution better than the
 *     Polymarket price at the same instant (brier_skill_vs_market > min).
 *     Accuracy and AUC could not see that the deployed model did not: it
 *     reported 78% / AUC 0.87, while the market out-predicted it and live it
 *     claimed 88% and won 68%.
 *   - rel_accuracy / rel_auc compare against the deployed model's numbers.
 *     Those are only comparable when both models were measured on rows built
 *     the same way. Across a feature-pipeline change (the old rows carried a
 *     60s look-ahead) they are skipped, and say why; the absolute floors and
 *     market_skill still apply.
 */

export interface GateConfig {
  minAccuracy: number;
  minAuc: number;
  minHighConfAccuracy: number;
  minHighConfCoverage: number;
  maxHighConfCoverage: number;
  maxCalibrationEce: number;
  maxCvTestAccGap: number;
  maxTestHoldoutAccGap: number;
  maxAccDrop: number;
  maxAucDrop: number;
  requireStrictHoldout: boolean;
  /** Minimum Brier skill vs the same-instant market price; the model must be strictly above it. */
  minMarketSkill: number;
}

export interface GateCheck { name: string; pass: boolean; detail: string }

export interface ModelMetrics {
  xgb: Record<string, any> | null;
  lgb: Record<string, any> | null;
  ensemble: Record<string, any> | null;
  /** norm_browser.json feature_pipeline; 1 when absent. */
  featurePipeline?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pctDetail(value: unknown, threshold: number, op = '>='): string {
  if (!isFiniteNumber(value)) return 'missing';
  return `${(value * 100).toFixed(2)}% ${op} ${(threshold * 100).toFixed(2)}%`;
}

export function qualityGate(current: ModelMetrics, fresh: ModelMetrics, cfg: GateConfig): { pass: boolean; checks: GateCheck[] } {
  const checks: GateCheck[] = [];
  const ens = fresh.ensemble;
  const audit = fresh.xgb || {};
  if (!ens) return { pass: false, checks: [{ name: 'no_metrics', pass: false, detail: 'No ensemble metrics in trained model' }] };

  // Absolute floors
  checks.push({
    name: 'abs_accuracy',
    pass: isFiniteNumber(ens.accuracy) && ens.accuracy >= cfg.minAccuracy,
    detail: isFiniteNumber(ens.accuracy) ? `${(ens.accuracy * 100).toFixed(2)}% >= ${(cfg.minAccuracy * 100).toFixed(0)}%` : 'missing',
  });
  checks.push({
    name: 'abs_auc',
    pass: isFiniteNumber(ens.auc) && ens.auc >= cfg.minAuc,
    detail: isFiniteNumber(ens.auc) ? `${ens.auc.toFixed(4)} >= ${cfg.minAuc.toFixed(2)}` : 'missing',
  });
  checks.push({
    name: 'market_skill',
    pass: isFiniteNumber(ens.brier_skill_vs_market) && ens.brier_skill_vs_market > cfg.minMarketSkill,
    detail: isFiniteNumber(ens.brier_skill_vs_market)
      ? `Brier skill vs same-instant market ${ens.brier_skill_vs_market >= 0 ? '+' : ''}${ens.brier_skill_vs_market.toFixed(4)} > ${cfg.minMarketSkill.toFixed(4)}`
      : 'missing (model predates the market-skill metric)',
  });
  checks.push({
    name: 'high_conf_accuracy',
    pass: isFiniteNumber(audit.high_conf_accuracy) && audit.high_conf_accuracy >= cfg.minHighConfAccuracy,
    detail: pctDetail(audit.high_conf_accuracy, cfg.minHighConfAccuracy),
  });
  checks.push({
    name: 'high_conf_coverage',
    pass: isFiniteNumber(audit.high_conf_ratio)
      && audit.high_conf_ratio >= cfg.minHighConfCoverage
      && audit.high_conf_ratio <= cfg.maxHighConfCoverage,
    detail: isFiniteNumber(audit.high_conf_ratio)
      ? `${audit.high_conf_ratio.toFixed(2)}% between ${cfg.minHighConfCoverage.toFixed(0)}%-${cfg.maxHighConfCoverage.toFixed(0)}%`
      : 'missing',
  });
  checks.push({
    name: 'calibration_ece',
    pass: isFiniteNumber(audit.calibration_ece) && audit.calibration_ece <= cfg.maxCalibrationEce,
    detail: isFiniteNumber(audit.calibration_ece)
      ? `${audit.calibration_ece.toFixed(4)} <= ${cfg.maxCalibrationEce.toFixed(4)}`
      : 'missing',
  });
  checks.push({
    name: 'cv_test_acc_gap',
    pass: isFiniteNumber(audit.cv_test_acc_gap) && audit.cv_test_acc_gap <= cfg.maxCvTestAccGap,
    detail: isFiniteNumber(audit.cv_test_acc_gap)
      ? `${(audit.cv_test_acc_gap * 100).toFixed(2)}pp <= ${(cfg.maxCvTestAccGap * 100).toFixed(2)}pp`
      : 'missing',
  });
  checks.push({
    name: 'test_holdout_acc_gap',
    pass: isFiniteNumber(audit.test_holdout_acc_gap) && audit.test_holdout_acc_gap <= cfg.maxTestHoldoutAccGap,
    detail: isFiniteNumber(audit.test_holdout_acc_gap)
      ? `${(audit.test_holdout_acc_gap * 100).toFixed(2)}pp <= ${(cfg.maxTestHoldoutAccGap * 100).toFixed(2)}pp`
      : 'missing',
  });
  if (cfg.requireStrictHoldout) {
    checks.push({
      name: 'strict_holdout',
      pass: audit.validation?.strict_holdout === true,
      detail: audit.validation?.strict_holdout === true ? 'enabled' : 'missing/disabled',
    });
  }

  // Relative checks (vs current deployed model) — only between like-for-like measurements.
  const curPipe = current.featurePipeline ?? 1;
  const freshPipe = fresh.featurePipeline ?? 1;
  if (!current.ensemble) {
    checks.push({ name: 'rel_skip', pass: true, detail: 'No current model to compare' });
  } else if (curPipe !== freshPipe) {
    checks.push({
      name: 'rel_skip',
      pass: true,
      detail: `current model measured on feature pipeline v${curPipe}, new on v${freshPipe} — `
        + 'accuracy/AUC not comparable; absolute floors and market_skill apply',
    });
  } else {
    const accDrop = current.ensemble.accuracy - ens.accuracy;
    const aucDrop = current.ensemble.auc - ens.auc;
    checks.push({
      name: 'rel_accuracy',
      pass: accDrop <= cfg.maxAccDrop,
      detail: `drop ${(accDrop * 100).toFixed(2)}pp <= ${(cfg.maxAccDrop * 100).toFixed(0)}pp`,
    });
    checks.push({
      name: 'rel_auc',
      pass: aucDrop <= cfg.maxAucDrop,
      detail: `drop ${(aucDrop * 10000).toFixed(0)}bp <= ${(cfg.maxAucDrop * 10000).toFixed(0)}bp`,
    });
  }

  return { pass: checks.every(c => c.pass), checks };
}
