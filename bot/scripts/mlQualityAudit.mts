import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { envNum as envNumFromValue } from '../src/utils/env.ts';

function envNum(key: string, def: number, min = -Infinity, max = Infinity) {
  return envNumFromValue(process.env[key], def, min, max);
}

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function pct(value) {
  return finite(value) ? `${(value * 100).toFixed(2)}%` : 'missing';
}

const strict = process.argv.includes('--strict');
const modelDir = resolve(process.cwd(), argValue('--dir', 'public/ml'));

const thresholds = {
  minAccuracy: envNum('RETRAIN_MIN_ACCURACY', 0.70, 0.50, 0.99),
  minAuc: envNum('RETRAIN_MIN_AUC', 0.80, 0.50, 0.99),
  minHighConfAccuracy: envNum('RETRAIN_MIN_HIGH_CONF_ACCURACY', 0.78, 0.50, 0.99),
  minHighConfCoverage: envNum('RETRAIN_MIN_HIGH_CONF_COVERAGE', 5, 0, 100),
  maxHighConfCoverage: envNum('RETRAIN_MAX_HIGH_CONF_COVERAGE', 98, 1, 100),
  maxCalibrationEce: envNum('RETRAIN_MAX_CALIBRATION_ECE', 0.08, 0, 0.50),
  maxCvTestAccGap: envNum('RETRAIN_MAX_CV_TEST_ACC_GAP', 0.04, 0, 0.30),
  maxTestHoldoutAccGap: envNum('RETRAIN_MAX_TEST_HOLDOUT_ACC_GAP', 0.08, 0, 0.50),
};

const xgb = readJson(resolve(modelDir, 'xgboost_model.json'));
const lgb = readJson(resolve(modelDir, 'lightgbm_model.json'));
const norm = readJson(resolve(modelDir, 'norm_browser.json'));

if (!xgb?.metrics) {
  console.error(`No xgboost_model.json metrics found in ${modelDir}`);
  process.exit(1);
}

const weights = norm?.ensemble_weights || lgb?.ensemble_weights || { xgb: 1, lgb: 0 };
const ensemble = norm?.ensemble_metrics || (lgb?.metrics ? {
  accuracy: weights.xgb * xgb.metrics.accuracy + weights.lgb * lgb.metrics.accuracy,
  auc: weights.xgb * xgb.metrics.auc + weights.lgb * lgb.metrics.auc,
} : xgb.metrics);

const checks = [
  {
    name: 'ensemble_accuracy',
    value: pct(ensemble.accuracy),
    pass: finite(ensemble.accuracy) && ensemble.accuracy >= thresholds.minAccuracy,
    required: true,
  },
  {
    name: 'ensemble_auc',
    value: finite(ensemble.auc) ? ensemble.auc.toFixed(4) : 'missing',
    pass: finite(ensemble.auc) && ensemble.auc >= thresholds.minAuc,
    required: true,
  },
  {
    name: 'high_conf_accuracy',
    value: pct(xgb.metrics.high_conf_accuracy),
    pass: finite(xgb.metrics.high_conf_accuracy) && xgb.metrics.high_conf_accuracy >= thresholds.minHighConfAccuracy,
    required: true,
  },
  {
    name: 'high_conf_coverage',
    value: finite(xgb.metrics.high_conf_ratio) ? `${xgb.metrics.high_conf_ratio.toFixed(2)}%` : 'missing',
    pass: finite(xgb.metrics.high_conf_ratio)
      && xgb.metrics.high_conf_ratio >= thresholds.minHighConfCoverage
      && xgb.metrics.high_conf_ratio <= thresholds.maxHighConfCoverage,
    required: true,
  },
  {
    name: 'calibration_ece',
    value: finite(xgb.metrics.calibration_ece) ? xgb.metrics.calibration_ece.toFixed(4) : 'missing',
    pass: finite(xgb.metrics.calibration_ece) && xgb.metrics.calibration_ece <= thresholds.maxCalibrationEce,
    required: strict,
  },
  {
    name: 'cv_test_acc_gap',
    value: finite(xgb.metrics.cv_test_acc_gap) ? `${(xgb.metrics.cv_test_acc_gap * 100).toFixed(2)}pp` : 'missing',
    pass: finite(xgb.metrics.cv_test_acc_gap) && xgb.metrics.cv_test_acc_gap <= thresholds.maxCvTestAccGap,
    required: strict,
  },
  {
    name: 'test_holdout_acc_gap',
    value: finite(xgb.metrics.test_holdout_acc_gap) ? `${(xgb.metrics.test_holdout_acc_gap * 100).toFixed(2)}pp` : 'missing',
    pass: finite(xgb.metrics.test_holdout_acc_gap) && xgb.metrics.test_holdout_acc_gap <= thresholds.maxTestHoldoutAccGap,
    required: strict,
  },
  {
    name: 'strict_holdout',
    value: xgb.validation?.strict_holdout === true ? 'enabled' : 'missing/disabled',
    pass: xgb.validation?.strict_holdout === true,
    required: strict,
  },
];

console.log(`ML Quality Audit: ${modelDir}`);
console.log(`XGB: acc=${pct(xgb.metrics.accuracy)} auc=${xgb.metrics.auc?.toFixed?.(4) ?? 'missing'} highConf=${pct(xgb.metrics.high_conf_accuracy)} coverage=${xgb.metrics.high_conf_ratio ?? 'missing'}%`);
if (lgb?.metrics) {
  console.log(`LGB: acc=${pct(lgb.metrics.accuracy)} auc=${lgb.metrics.auc?.toFixed?.(4) ?? 'missing'}`);
}
console.log(`Ensemble: acc=${pct(ensemble.accuracy)} auc=${ensemble.auc?.toFixed?.(4) ?? 'missing'} weights=${weights.xgb}/${weights.lgb}`);
console.log('');

let failed = false;
for (const check of checks) {
  const status = check.pass ? 'PASS' : check.required ? 'FAIL' : 'WARN';
  if (status === 'FAIL') failed = true;
  console.log(`[${status}] ${check.name}: ${check.value}`);
}

console.log('');
if (failed) {
  console.log('Result: BLOCKED. Model should not be deployed automatically.');
  process.exitCode = 1;
} else {
  console.log(strict ? 'Result: PASS.' : 'Result: PASS with legacy-metric warnings allowed.');
}
