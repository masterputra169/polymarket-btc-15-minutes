/**
 * Per-signal accuracy tracking, CRPS scoring & dynamic weight modifiers.
 *
 * Separate localStorage key 'btc_signal_perf' — decoupled from the 30-record
 * prediction cache so signal stats accumulate over days/weeks.
 */

const STORAGE_KEY = 'btc_signal_perf';
const PERSIST_DEBOUNCE_MS = 10_000;
const VERSION = 1;

const SIGNAL_KEYS = [
  'ptbDistance', 'ptbMomentum', 'momentum', 'rsi', 'macdHist', 'macdLine',
  'vwapPos', 'vwapSlope', 'heikenAshi', 'failedVwap', 'orderbook', 'multiTf',
];

const EMA_ALPHA = 0.05;          // ~20 effective samples
const MODIFIER_MIN = 0.70;
const MODIFIER_MAX = 1.30;
const MIN_SAMPLES = 15;          // per signal before adapting
const DECAY_AGE_MS = 7 * 24 * 3600_000; // 7 days

// ── In-memory state ──
let store = null;
let dirty = false;
let persistTimer = null;

// ── Helpers ──

function emptySignal() {
  return { fired: 0, correct: 0, emaAccuracy: 0.5, crpsSum: 0, crpsCount: 0, modifier: 1.0, lastUpdated: 0 };
}

function emptyStore() {
  const signals = {};
  for (const k of SIGNAL_KEYS) signals[k] = emptySignal();
  return { version: VERSION, updatedAt: Date.now(), signals };
}

function ensureLoaded() {
  if (store !== null) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === VERSION && parsed.signals) {
        store = parsed;
        // Ensure all signal keys exist (forward compat)
        for (const k of SIGNAL_KEYS) {
          if (!store.signals[k]) store.signals[k] = emptySignal();
        }
        maybeDecay();
        return;
      }
    }
  } catch { /* corrupt data */ }
  store = emptyStore();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty || !store) return;
    dirty = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch { /* full or disabled */ }
  }, PERSIST_DEBOUNCE_MS);
}

function opposite(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

/**
 * Extract a directional snapshot from the scoring breakdown.
 * Returns { ptbDistance: 'UP', momentum: 'DOWN', rsi: null, ... }.
 * null = signal was neutral / N/A / weight 0.
 */
export function extractSignalSnapshot(breakdown) {
  if (!breakdown) return null;
  const snap = {};
  for (const key of SIGNAL_KEYS) {
    const entry = breakdown[key];
    if (!entry || entry.weight === 0) {
      snap[key] = null;
      continue;
    }
    const sig = String(entry.signal ?? '').toUpperCase();
    let dir = null;
    if (sig.includes('UP')) dir = 'UP';
    else if (sig.includes('DOWN')) dir = 'DOWN';
    // If weight is negative, the signal is penalizing (conflicting) — invert direction
    if (dir && entry.weight < 0) {
      dir = dir === 'UP' ? 'DOWN' : 'UP';
    }
    snap[key] = dir; // null if NEUTRAL / FLAT / CONFLICT etc
  }
  return snap;
}

/**
 * Update per-signal stats after a prediction settles.
 *
 * @param {Object|null} signalSnapshot - from extractSignalSnapshot
 * @param {string} predSide - 'UP' or 'DOWN'
 * @param {boolean} wasCorrect - did overall prediction match outcome?
 * @param {number} modelProb - the model probability for predSide (0-1)
 */
export function updateSignalPerf(signalSnapshot, predSide, wasCorrect, modelProb) {
  if (!signalSnapshot || !predSide) return;
  ensureLoaded();

  const actualOutcome = wasCorrect ? predSide : opposite(predSide);
  const now = Date.now();

  for (const key of SIGNAL_KEYS) {
    const dir = signalSnapshot[key];
    if (dir === null || dir === undefined) continue; // didn't fire

    const s = store.signals[key];
    s.fired++;
    const signalCorrect = (dir === actualOutcome);
    if (signalCorrect) s.correct++;

    // EMA accuracy
    s.emaAccuracy = s.emaAccuracy * (1 - EMA_ALPHA) + (signalCorrect ? 1 : 0) * EMA_ALPHA;

    // H3: Per-signal CRPS (Brier score) — uses overall modelProb since
    // we don't have signal-specific probability. Still useful for calibration.
    if (modelProb != null && Number.isFinite(modelProb)) {
      const actual = signalCorrect ? 1 : 0;
      const signalProb = dir === predSide ? modelProb : (1 - modelProb);
      s.crpsSum += (signalProb - actual) ** 2;
      s.crpsCount++;
    }

    // Recompute modifier
    if (s.fired >= MIN_SAMPLES) {
      s.modifier = Math.max(MODIFIER_MIN, Math.min(MODIFIER_MAX,
        1.0 + (s.emaAccuracy - 0.5) * 2
      ));
    }

    s.lastUpdated = now;
  }

  store.updatedAt = now;
  dirty = true;
  schedulePersist();
}

/**
 * Get signal weight modifiers for use in scoreDirection().
 * Returns { ptbDistance: 1.08, momentum: 0.92, ... }
 */
export function getSignalModifiers() {
  ensureLoaded();
  const mods = {};
  for (const key of SIGNAL_KEYS) {
    mods[key] = store.signals[key].modifier;
  }
  return mods;
}

/**
 * Get per-signal stats for dashboard display.
 * Returns array sorted by EMA accuracy descending.
 */
export function getSignalPerfStats() {
  ensureLoaded();
  const result = [];
  for (const key of SIGNAL_KEYS) {
    const s = store.signals[key];
    result.push({
      key,
      fired: s.fired,
      correct: s.correct,
      rawAccuracy: s.fired > 0 ? s.correct / s.fired : null,
      emaAccuracy: s.emaAccuracy,
      avgCrps: s.crpsCount > 0 ? s.crpsSum / s.crpsCount : null,
      modifier: s.modifier,
      hasEnoughData: s.fired >= MIN_SAMPLES,
    });
  }
  result.sort((a, b) => b.emaAccuracy - a.emaAccuracy);
  return result;
}

/**
 * Overall CRPS (binary Brier score) over last N settled predictions.
 * mean((modelProb - actual)^2). Lower = better. 0 = perfect, 0.25 = always-0.5.
 *
 * @param {Array} predictions - the prediction cache from loadHistory()
 * @param {number} windowSize - how many recent settled predictions to use
 */
export function computeOverallCRPS(predictions, windowSize = 20) {
  if (!predictions || !predictions.length) return null;

  const settled = [];
  for (let i = predictions.length - 1; i >= 0 && settled.length < windowSize; i--) {
    const p = predictions[i];
    if (p.settled && p.correct !== null) settled.push(p);
  }
  if (settled.length < 3) return null;

  let sum = 0;
  for (const p of settled) {
    const prob = p.modelProb ?? 0.5;
    const actual = p.correct ? 1 : 0;
    sum += (prob - actual) ** 2;
  }
  return +(sum / settled.length).toFixed(4);
}

/**
 * If no update in DECAY_AGE_MS, halve all counts (preserves ratios).
 */
function maybeDecay() {
  if (!store) return;
  const age = Date.now() - store.updatedAt;
  if (age < DECAY_AGE_MS) return;

  for (const key of SIGNAL_KEYS) {
    const s = store.signals[key];
    // H4: Use Math.floor (not Math.round) to prevent immortal entries.
    // Math.round(1/2)=1 creates entries that never decay (100% accuracy forever).
    s.fired = Math.floor(s.fired / 2);
    s.correct = Math.floor(s.correct / 2);
    s.crpsSum /= 2;
    s.crpsCount = Math.floor(s.crpsCount / 2);
    // If fired dropped to 0, reset modifier to neutral
    if (s.fired === 0) {
      s.modifier = 1.0;
      s.emaAccuracy = 0.5;
    }
  }
  store.updatedAt = Date.now();
  dirty = true;
  schedulePersist();
}

/**
 * Flush to localStorage immediately (for beforeunload).
 */
export function flushSignalPerf() {
  if (!dirty || !store) return;
  clearTimeout(persistTimer);
  persistTimer = null;
  dirty = false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* */ }
}

/**
 * Inject store data from external persistence (bot adapter).
 * Must be called before any other signalPerf function to bypass localStorage.
 */
export function injectStore(data) {
  if (data && data.version === VERSION && data.signals) {
    store = data;
    // Ensure all signal keys exist (forward compat)
    for (const k of SIGNAL_KEYS) {
      if (!store.signals[k]) store.signals[k] = emptySignal();
    }
    maybeDecay();
  } else {
    store = emptyStore();
  }
}

/**
 * Get a snapshot of the current store for external persistence (bot adapter).
 */
export function getStoreSnapshot() {
  ensureLoaded();
  return store ? JSON.parse(JSON.stringify(store)) : null;
}

/**
 * Clear all signal perf data (for dev/testing).
 */
export function clearSignalPerf() {
  store = emptyStore();
  dirty = false;
  clearTimeout(persistTimer);
  persistTimer = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}
