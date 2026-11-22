/**
 * Stage-2 Online Meta-Labeler (López de Prado secondary take/skip model).
 *
 * Scores P(WIN | bot ENTER signal + decision-time features) using a small,
 * zero-dependency L2-regularized logistic regression fitted chronologically
 * on settled trades in `trade_journal.jsonl`.
 *
 * Default mode is SHADOW: logs `metaWinProb` on ENTER candidates and tracks
 * holdout ROC AUC without altering trade execution. Promotion to VETO mode
 * requires `samples >= minSamples` AND chronological holdout `auc >= minAuc`.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('MetaLabeler');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_JOURNAL_PATH = resolve(__dirname, '..', '..', 'data', 'trade_journal.jsonl');

export const META_FEATURE_NAMES = [
  'entryPrice',
  'mlConfidence',
  'rawMlEdge',
  'timeLeftMin',
  'isTrending',
  'isMeanReverting',
  'isModerateOrChoppy',
  'jevNetConvAligned',
] as const;

export interface MetaLabelFeatures {
  entryPrice: number;
  mlConfidence: number;
  rawMlEdge: number;
  timeLeftMin: number;
  regime: string | null | undefined;
  jevNetConvAligned?: number | null;
}

export interface MetaLabelSample {
  features: MetaLabelFeatures;
  won: 0 | 1;
}

export interface MetaLabelerModel {
  featureNames: readonly string[];
  means: number[];
  stds: number[];
  weights: number[];
  bias: number;
  samples: number;
  baseWinRate: number;
  holdoutAuc: number | null;
  holdoutBrier: number | null;
}

export interface MetaLabelScore {
  winProb: number | null;
  action: 'take' | 'skip' | 'passthrough';
  holdoutAuc: number | null;
  samples: number;
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

export function extractMetaVector(f: MetaLabelFeatures): number[] {
  const reg = String(f.regime ?? '').toLowerCase();
  const entryPrice = Number.isFinite(f.entryPrice) ? f.entryPrice : 0.60;
  const mlConf = Number.isFinite(f.mlConfidence) ? f.mlConfidence : 0.40;
  const rawEdge = Number.isFinite(f.rawMlEdge) ? f.rawMlEdge : 0;
  const tLeft = Number.isFinite(f.timeLeftMin) ? f.timeLeftMin : 7.5;
  const jevConv = f.jevNetConvAligned != null && Number.isFinite(f.jevNetConvAligned)
    ? Math.max(-1, Math.min(1, f.jevNetConvAligned))
    : 0;
  return [
    entryPrice,
    mlConf,
    rawEdge,
    tLeft,
    reg === 'trending' ? 1 : 0,
    reg === 'mean_reverting' ? 1 : 0,
    reg === 'moderate' || reg === 'choppy' ? 1 : 0,
    jevConv,
  ];
}

/** Exact Mann-Whitney U ROC AUC (returns null if only one class present). */
export function computeRocAuc(yTrue: readonly (0 | 1)[], yProb: readonly number[]): number | null {
  let pos = 0;
  let neg = 0;
  for (const y of yTrue) {
    if (y === 1) pos++;
    else neg++;
  }
  if (pos === 0 || neg === 0) return null;
  let wins = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (yTrue[i] !== 1) continue;
    for (let j = 0; j < yTrue.length; j++) {
      if (yTrue[j] !== 0) continue;
      if (yProb[i] > yProb[j]) wins += 1;
      else if (yProb[i] === yProb[j]) wins += 0.5;
    }
  }
  return +(wins / (pos * neg)).toFixed(4);
}

function fitLogisticStandardized(
  X: number[][],
  y: (0 | 1)[],
  l2 = 2.0,
  maxIter = 120,
): { means: number[]; stds: number[]; weights: number[]; bias: number } {
  const n = X.length;
  const d = X[0].length;
  const means = new Array<number>(d).fill(0);
  const stds = new Array<number>(d).fill(1);

  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    means[j] = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) {
      const diff = X[i][j] - means[j];
      v += diff * diff;
    }
    const sd = Math.sqrt(v / n);
    stds[j] = sd > 1e-6 ? sd : 1;
  }

  const Xs = X.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));
  const weights = new Array<number>(d).fill(0);
  const posRate = Math.max(0.05, Math.min(0.95, y.reduce<number>((a, b) => a + b, 0) / n));
  let bias = Math.log(posRate / (1 - posRate));
  const lr = 0.15;

  for (let iter = 0; iter < maxIter; iter++) {
    const gw = new Array<number>(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * Xs[i][j];
      const err = sigmoid(z) - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * Xs[i][j];
    }
    let maxStep = Math.abs(gb / n);
    bias -= lr * (gb / n);
    for (let j = 0; j < d; j++) {
      const grad = (gw[j] + l2 * weights[j]) / n;
      weights[j] -= lr * grad;
      if (Math.abs(grad) > maxStep) maxStep = Math.abs(grad);
    }
    if (maxStep < 1e-5) break;
  }
  return { means, stds, weights, bias };
}

function predictStandardized(
  vec: number[],
  model: { means: number[]; stds: number[]; weights: number[]; bias: number },
): number {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    z += model.weights[j] * ((vec[j] - model.means[j]) / model.stds[j]);
  }
  return Math.max(0.05, Math.min(0.95, sigmoid(z)));
}

/** Fit Stage-2 L2 logistic meta-labeler with chronological 70/30 holdout AUC/Brier evaluation. */
export function fitMetaLabelerModel(
  samples: readonly MetaLabelSample[],
  opts: { minSamples?: number; l2?: number } = {},
): MetaLabelerModel | null {
  const minSamples = Math.max(20, opts.minSamples ?? 35);
  if (samples.length < minSamples) return null;

  const X = samples.map((s) => extractMetaVector(s.features));
  const y = samples.map((s) => s.won);
  const l2 = opts.l2 ?? 2.0;

  // Honest chronological 70/30 holdout evaluation before fitting full model
  const splitIdx = Math.max(15, Math.floor(samples.length * 0.7));
  let holdoutAuc: number | null = null;
  let holdoutBrier: number | null = null;
  if (samples.length - splitIdx >= 8) {
    const trainFit = fitLogisticStandardized(X.slice(0, splitIdx), y.slice(0, splitIdx), l2);
    const yTest = y.slice(splitIdx);
    const pTest = X.slice(splitIdx).map((v) => predictStandardized(v, trainFit));
    holdoutAuc = computeRocAuc(yTest, pTest);
    let bSum = 0;
    for (let i = 0; i < yTest.length; i++) bSum += (pTest[i] - yTest[i]) ** 2;
    holdoutBrier = +(bSum / yTest.length).toFixed(4);
  }

  const fullFit = fitLogisticStandardized(X, y, l2);
  const baseWinRate = +(y.reduce<number>((a, b) => a + b, 0) / y.length).toFixed(4);
  return {
    featureNames: META_FEATURE_NAMES,
    means: fullFit.means.map((v) => +v.toFixed(5)),
    stds: fullFit.stds.map((v) => +v.toFixed(5)),
    weights: fullFit.weights.map((v) => +v.toFixed(5)),
    bias: +fullFit.bias.toFixed(5),
    samples: samples.length,
    baseWinRate,
    holdoutAuc,
    holdoutBrier,
  };
}

let _samples: MetaLabelSample[] = [];
let _model: MetaLabelerModel | null = null;
let _lastScore: (MetaLabelScore & { slug: string | null; ts: number }) | null = null;
let _sinceFit = 0;

function parseJournalRowToSample(row: any): MetaLabelSample | null {
  const side = row?.entry?.side ?? row?.side;
  const outcome = row?.exit?.outcome ?? row?.outcome;
  if ((side !== 'UP' && side !== 'DOWN') || (outcome !== 'UP' && outcome !== 'DOWN')) return null;
  const entryPrice = Number(row?.entry?.tokenPrice ?? row?.entry?.entryPrice ?? row?.entry?.marketPrice ?? row?.entryPrice);
  const mlConf = Number(row?.entry?.mlConfidence ?? row?.mlConfidence ?? 0.40);
  const mlProbUp = row?.entry?.mlProbUp ?? row?.mlProbUp;
  const mlSideProb = typeof mlProbUp === 'number' && Number.isFinite(mlProbUp)
    ? (side === 'UP' ? mlProbUp : 1 - mlProbUp)
    : null;
  const rawMlEdge = mlSideProb != null && Number.isFinite(entryPrice) ? mlSideProb - entryPrice : 0;
  const timeLeftMin = Number(row?.entry?.timeLeftMin ?? row?.timeLeftMin ?? 7.5);
  const regime = row?.entry?.regime ?? row?.regime ?? null;
  return {
    features: {
      entryPrice: Number.isFinite(entryPrice) ? entryPrice : 0.60,
      mlConfidence: Number.isFinite(mlConf) ? mlConf : 0.40,
      rawMlEdge: Number.isFinite(rawMlEdge) ? rawMlEdge : 0,
      timeLeftMin: Number.isFinite(timeLeftMin) ? timeLeftMin : 7.5,
      regime,
      jevNetConvAligned: 0,
    },
    won: outcome === side ? 1 : 0,
  };
}

export function initMetaLabeler(journalPath = DEFAULT_JOURNAL_PATH): MetaLabelerModel | null {
  _samples = [];
  if (existsSync(journalPath)) {
    try {
      const lines = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let row: any = null;
        try { row = JSON.parse(line); } catch { row = null; }
        const s = parseJournalRowToSample(row);
        if (s) _samples.push(s);
      }
      const minSamples = BOT_CONFIG.metaLabeler?.minSamples ?? 35;
      _model = fitMetaLabelerModel(_samples, { minSamples });
    } catch {
      _model = null;
    }
  }
  const mode = BOT_CONFIG.metaLabeler?.mode ?? 'shadow';
  log.info(
    `Stage-2 Meta-Labeler [${mode.toUpperCase()}]: samples=${_samples.length}` +
    (_model
      ? ` baseWR=${(_model.baseWinRate * 100).toFixed(1)}% holdoutAUC=${_model.holdoutAuc ?? 'n/a'} holdoutBrier=${_model.holdoutBrier ?? 'n/a'}`
      : ' (warmup)'),
  );
  return _model;
}

export function recordMetaLabelerOutcome(features: MetaLabelFeatures, won: boolean): void {
  _samples.push({ features, won: won ? 1 : 0 });
  if (_samples.length > 500) _samples.shift();
  _sinceFit++;
  const minSamples = BOT_CONFIG.metaLabeler?.minSamples ?? 35;
  if (_samples.length >= minSamples && (_model == null || _sinceFit >= 10)) {
    _model = fitMetaLabelerModel(_samples, { minSamples });
    _sinceFit = 0;
  }
}

export function scoreMetaLabeler(
  features: MetaLabelFeatures,
  opts: { slug?: string | null; modelOverride?: MetaLabelerModel | null } = {},
): MetaLabelScore {
  const model = opts.modelOverride !== undefined ? opts.modelOverride : _model;
  if (!model) {
    return { winProb: null, action: 'passthrough', holdoutAuc: null, samples: _samples.length };
  }
  const winProb = +predictStandardized(extractMetaVector(features), model).toFixed(4);
  const cfg = BOT_CONFIG.metaLabeler;
  const mode = cfg?.mode ?? 'shadow';
  const minWinProb = cfg?.minWinProb ?? 0.55;
  const minAuc = cfg?.minAuc ?? 0.56;
  const aucPass = model.holdoutAuc != null && model.holdoutAuc >= minAuc;
  const action: 'take' | 'skip' | 'passthrough' =
    mode !== 'veto' || !aucPass
      ? 'passthrough'
      : winProb < minWinProb ? 'skip' : 'take';

  const result: MetaLabelScore = {
    winProb,
    action,
    holdoutAuc: model.holdoutAuc,
    samples: model.samples,
  };
  if (opts.slug !== undefined) {
    _lastScore = { ...result, slug: opts.slug, ts: Date.now() };
  }
  return result;
}

export function checkMetaLabelerAdvisory(
  features: MetaLabelFeatures,
  slug?: string | null,
): { action: 'block'; reason: string; winProb: number } | null {
  const res = scoreMetaLabeler(features, { slug });
  if (res.action !== 'skip' || res.winProb == null) return null;
  const minWinProb = BOT_CONFIG.metaLabeler?.minWinProb ?? 0.55;
  return {
    action: 'block',
    winProb: res.winProb,
    reason: `Meta-Labeler skip: P(WIN)=${(res.winProb * 100).toFixed(1)}% < ${(minWinProb * 100).toFixed(0)}% (AUC=${res.holdoutAuc})`,
  };
}

export function getMetaLabelerStatus() {
  return {
    mode: BOT_CONFIG.metaLabeler?.mode ?? 'shadow',
    samples: _samples.length,
    baseWinRate: _model?.baseWinRate ?? null,
    holdoutAuc: _model?.holdoutAuc ?? null,
    holdoutBrier: _model?.holdoutBrier ?? null,
    lastScore: _lastScore,
  };
}

export function resetMetaLabelerForTests(): void {
  _samples = [];
  _model = null;
  _lastScore = null;
  _sinceFit = 0;
}
