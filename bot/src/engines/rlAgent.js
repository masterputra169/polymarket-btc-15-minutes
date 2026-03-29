/**
 * RL Agent — Contextual Bandit for bet sizing.
 *
 * 2-layer MLP (16→64→64→5) trained offline via REINFORCE.
 * Takes current market state → outputs sizing multiplier scalar.
 * Actions: [0.5, 0.75, 1.0, 1.25, 1.5] applied to Kelly base amount.
 *
 * Phases:
 *   shadowMode=true:      logs decisions but does NOT modify bet size (default)
 *   conservativeMode=true: restricts actions to [0.75, 1.0, 1.25] (indices 1-3)
 *   full mode:            all 5 actions allowed
 *
 * Session names (from utils.getSessionName):
 *   'Asia', 'Europe', 'EU/US Overlap', 'US', 'Off-hours'
 *
 * Reward: pnl / betAmount, clipped [-3, 3]
 */

import { readFileSync, appendFileSync, existsSync } from 'fs';
import { createLogger } from '../logger.js';
import { BOT_CONFIG } from '../config.js';

const log = createLogger('RLAgent');

// ── Action space ──
export const RL_ACTIONS = [0.5, 0.75, 1.0, 1.25, 1.5];
const CONSERVATIVE_MIN_IDX = 1;  // 0.75
const CONSERVATIVE_MAX_IDX = 3;  // 1.25
const FEATURE_DIM = 16;
const HIDDEN_DIM = 64;
const N_ACTIONS = 5;

// ── Module state ──
let weights = null;          // { w1, b1, w2, b2, w3, b3, version, trainedAt }
let _lastScalar = null;
let _totalDecisions = 0;
const _actionCounts = new Array(N_ACTIONS).fill(0);

// ── Math helpers ──
function relu(v) { return v > 0 ? v : 0; }

function softmax(logits) {
  const maxL = Math.max(...logits);
  const exp = logits.map(l => Math.exp(l - maxL));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map(e => e / sum);
}

/**
 * Forward pass: 16 → 64 (ReLU) → 64 (ReLU) → 5 (softmax)
 * Weights stored row-major: w1[j * FEATURE_DIM + i] = W[j][i]
 */
function forward(state) {
  const { w1, b1, w2, b2, w3, b3 } = weights;

  // Layer 1: 16 → 64
  const h1 = new Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) {
    let s = b1[j];
    for (let i = 0; i < FEATURE_DIM; i++) s += state[i] * w1[j * FEATURE_DIM + i];
    h1[j] = relu(s);
  }

  // Layer 2: 64 → 64
  const h2 = new Array(HIDDEN_DIM);
  for (let j = 0; j < HIDDEN_DIM; j++) {
    let s = b2[j];
    for (let i = 0; i < HIDDEN_DIM; i++) s += h1[i] * w2[j * HIDDEN_DIM + i];
    h2[j] = relu(s);
  }

  // Layer 3: 64 → 5
  const logits = new Array(N_ACTIONS);
  for (let j = 0; j < N_ACTIONS; j++) {
    let s = b3[j];
    for (let i = 0; i < HIDDEN_DIM; i++) s += h2[i] * w3[j * HIDDEN_DIM + i];
    logits[j] = s;
  }

  return softmax(logits);
}

/**
 * Load RL weights from disk.
 * Expected format: { w1, b1, w2, b2, w3, b3, version, trainedAt, trainSamples }
 * @param {string} path
 * @returns {boolean} success
 */
export function loadRLWeights(path) {
  try {
    if (!existsSync(path)) {
      log.info(`RL weights not found at ${path} — agent disabled`);
      return false;
    }
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    for (const key of ['w1', 'b1', 'w2', 'b2', 'w3', 'b3']) {
      if (!Array.isArray(raw[key])) throw new Error(`Missing array field: ${key}`);
    }
    if (raw.w1.length !== HIDDEN_DIM * FEATURE_DIM)
      throw new Error(`w1 shape mismatch: expected ${HIDDEN_DIM * FEATURE_DIM}, got ${raw.w1.length}`);
    weights = raw;
    log.info(`RL weights loaded: v${raw.version ?? '?'} trained ${raw.trainedAt ?? 'unknown'} on ${raw.trainSamples ?? '?'} samples`);
    return true;
  } catch (err) {
    log.warn(`Failed to load RL weights: ${err.message}`);
    weights = null;
    return false;
  }
}

/**
 * Extract 16-feature normalized state vector from current trade context.
 * All features in [0, 1] range.
 */
export function extractRLState({
  mlConfidence, bestEdge, tokenPrice,
  regime, session,
  rsiNow, macdHist,
  spread, atrRatio, delta1m,
  timeLeftMin, consecutiveLosses,
  orderbookImbalance, recentFlips,
}) {
  const sess = session ?? '';
  const isUS = sess === 'US' || sess === 'EU/US Overlap' || sess === 'Europe/US Overlap';
  const isAsia = sess === 'Asia' || sess === 'Asia/Europe Overlap';

  return [
    // ML signal [0]
    mlConfidence != null ? Math.min(1, Math.max(0, mlConfidence)) : 0.5,
    // Edge — scale [-0.10..0.20] → [0..1], center at 0.5 [1]
    bestEdge != null ? Math.min(1, Math.max(0, bestEdge * 4 + 0.5)) : 0.5,
    // Token price [2]
    tokenPrice != null ? Math.min(1, Math.max(0, tokenPrice)) : 0.65,

    // Regime one-hot [3,4]
    regime === 'trending' ? 1 : 0,
    regime === 'choppy' ? 1 : 0,

    // Session one-hot [5,6]
    isUS ? 1 : 0,
    isAsia ? 1 : 0,

    // RSI normalized [7]
    rsiNow != null ? Math.min(1, Math.max(0, rsiNow / 100)) : 0.5,
    // MACD histogram direction: DOWN=0, FLAT=0.5, UP=1 [8]
    macdHist != null ? (macdHist > 0 ? 1 : macdHist < 0 ? 0 : 0.5) : 0.5,

    // Spread: narrow=1, wide=0, scale [0..0.05] → [1..0] [9]
    spread != null ? Math.min(1, Math.max(0, 1 - spread * 20)) : 0.5,
    // ATR ratio: low=0, high=1, scale [0..3] → [0..1] [10]
    atrRatio != null ? Math.min(1, Math.max(0, atrRatio / 3)) : 0.3,

    // delta1m direction [11]
    delta1m != null ? (delta1m > 0 ? 1 : delta1m < 0 ? 0 : 0.5) : 0.5,

    // Time remaining [12]
    timeLeftMin != null ? Math.min(1, Math.max(0, timeLeftMin / 15)) : 0.5,
    // Consecutive losses normalized [13]
    consecutiveLosses != null ? Math.min(1, consecutiveLosses / 5) : 0,

    // Orderbook imbalance: ask-heavy=0, bid-heavy=1 [14]
    orderbookImbalance != null ? Math.min(1, Math.max(0, (orderbookImbalance + 1) / 2)) : 0.5,
    // Recent flips normalized [15]
    recentFlips != null ? Math.min(1, recentFlips / 10) : 0,
  ];
}

/**
 * Get RL sizing scalar for current trade.
 *
 * @param {Object} stateFeatures - raw features (see extractRLState params)
 * @returns {{ scalar: number, actionIdx: number, probs: number[] } | null}
 *   null if weights not loaded, not enabled, or shadow mode (logs but no effect).
 */
export function getRLScalar(stateFeatures) {
  if (!weights) return null;

  try {
    const state = extractRLState(stateFeatures);
    const probs = forward(state);

    // Select best action within allowed range
    let actionIdx;
    if (BOT_CONFIG.rl.conservativeMode) {
      let maxP = -1;
      for (let i = CONSERVATIVE_MIN_IDX; i <= CONSERVATIVE_MAX_IDX; i++) {
        if (probs[i] > maxP) { maxP = probs[i]; actionIdx = i; }
      }
    } else {
      let maxP = -1;
      for (let i = 0; i < N_ACTIONS; i++) {
        if (probs[i] > maxP) { maxP = probs[i]; actionIdx = i; }
      }
    }

    const scalar = RL_ACTIONS[actionIdx];
    _lastScalar = scalar;
    _totalDecisions++;
    _actionCounts[actionIdx]++;

    const probStr = probs.map(p => p.toFixed(2)).join(',');

    if (BOT_CONFIG.rl.shadowMode) {
      log.info(`[RL Shadow] Would ×${scalar} (action ${actionIdx}, probs: [${probStr}])`);
      _appendTrace({ actionIdx, scalar, probs, shadow: true, ts: Date.now() });
      return null; // Shadow: log only, don't modify bet
    }

    log.info(`[RL_SCALE] ×${scalar} (action ${actionIdx}/${N_ACTIONS - 1}, probs: [${probStr}])`);
    _appendTrace({ actionIdx, scalar, probs, shadow: false, ts: Date.now() });
    return { scalar, actionIdx, probs };
  } catch (err) {
    log.warn(`RL scalar error (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Record trade settlement outcome to close the reward loop.
 * @param {{ pnl: number, betAmount: number, won: boolean, rlActionIdx: number }} outcome
 */
export function recordRLOutcome({ pnl, betAmount, won, rlActionIdx }) {
  if (rlActionIdx == null || !Number.isFinite(pnl) || !Number.isFinite(betAmount) || betAmount <= 0) return;

  const reward = Math.max(-3, Math.min(3, pnl / betAmount));
  const scalar = RL_ACTIONS[rlActionIdx] ?? null;

  if (!BOT_CONFIG.rl.traceFile) return;
  try {
    appendFileSync(
      BOT_CONFIG.rl.traceFile,
      JSON.stringify({ type: 'outcome', ts: Date.now(), rlActionIdx, scalar, pnl, betAmount, reward, won }) + '\n',
    );
  } catch { /* non-fatal */ }

  log.info(`[RL] Outcome recorded: action=${rlActionIdx} (×${scalar}) pnl=$${pnl.toFixed(2)} reward=${reward.toFixed(2)} ${won ? 'WIN' : 'LOSS'}`);
}

/** Get RL status for dashboard broadcast. */
export function getRLStatus() {
  const actionDist = _actionCounts.map((c, i) => ({
    scalar: RL_ACTIONS[i],
    count: c,
    pct: _totalDecisions > 0 ? Math.round(c / _totalDecisions * 100) : 0,
  }));
  return {
    loaded: weights !== null,
    shadowMode: BOT_CONFIG.rl?.shadowMode ?? true,
    conservativeMode: BOT_CONFIG.rl?.conservativeMode ?? true,
    currentScalar: _lastScalar,
    totalDecisions: _totalDecisions,
    actionDist,
    version: weights?.version ?? null,
  };
}

/** Whether RL weights are currently loaded. */
export function isRLLoaded() { return weights !== null; }

// ── Internal trace append ──
function _appendTrace({ actionIdx, scalar, probs, shadow, ts }) {
  if (!BOT_CONFIG.rl?.traceFile) return;
  try {
    appendFileSync(
      BOT_CONFIG.rl.traceFile,
      JSON.stringify({ type: 'state', ts, actionIdx, scalar, probs, shadow }) + '\n',
    );
  } catch { /* non-fatal */ }
}
