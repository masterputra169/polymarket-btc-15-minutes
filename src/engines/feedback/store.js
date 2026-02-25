/**
 * Prediction recording, settling, and persistence.
 */

import { ensureLoaded, markDirty, MAX_HISTORY, clearPersistTimer } from './state.js';
import * as S from './state.js';
import { extractSignalSnapshot, updateSignalPerf } from './signalPerf.js';

export function recordPrediction({ side, modelProb, marketPrice, btcPrice, priceToBeat, marketSlug, regime, mlConfidence, mlSide, breakdown }) {
  ensureLoaded();

  const now = Date.now();
  for (let i = S.cache.length - 1; i >= Math.max(0, S.cache.length - 6); i--) {
    const p = S.cache[i];
    if (p.marketSlug === marketSlug && p.side === side && now - p.timestamp < 30_000) return;
  }

  S.cache.push({
    timestamp: now,
    side,
    modelProb,
    marketPrice,
    btcPrice,
    priceToBeat,
    marketSlug,
    regime: regime ?? null,
    mlConfidence: mlConfidence ?? null,
    mlSide: mlSide ?? null,
    signalSnapshot: extractSignalSnapshot(breakdown),
    settled: false,
    correct: null,
  });

  if (S.cache.length > MAX_HISTORY + 10) S.setCache(S.cache.slice(-MAX_HISTORY));
  markDirty();
}

export function settlePrediction(marketSlug, result) {
  ensureLoaded();
  let changed = false;
  for (let i = 0; i < S.cache.length; i++) {
    const pred = S.cache[i];
    if (pred.marketSlug === marketSlug && !pred.settled) {
      pred.settled = true;
      pred.correct = pred.side === result;
      pred.settledAt = Date.now();
      pred.actualResult = result;
      changed = true;
      updateSignalPerf(pred.signalSnapshot, pred.side, pred.correct, pred.modelProb);
    }
  }
  if (changed) markDirty();
}

export function autoSettle(currentSlug, btcPrice, priceToBeat, timeLeftMin) {
  // C4: Was 0.5 min (30s) — BTC can move $50-200 in 30s, so autoSettle with live
  // price was corrupting feedback accuracy data. Reduced to 0.05 min (3s) so
  // BTC price is very close to the actual settlement price.
  if (timeLeftMin > 0.05) return;
  ensureLoaded();

  let hasUnsettled = false;
  for (let i = 0; i < S.cache.length; i++) {
    if (!S.cache[i].settled) { hasUnsettled = true; break; }
  }
  if (!hasUnsettled) return;

  let changed = false;
  for (let i = 0; i < S.cache.length; i++) {
    const pred = S.cache[i];
    if (pred.settled) continue;

    // L5: Predictions without marketSlug can never match any slug → zombie entries.
    // Settle them as expired immediately.
    if (!pred.marketSlug) {
      pred.settled = true;
      pred.correct = null;
      pred.settledAt = Date.now();
      pred.actualResult = 'expired';
      changed = true;
      continue;
    }

    if (pred.marketSlug !== currentSlug) {
      pred.settled = true;
      pred.correct = null;
      pred.settledAt = Date.now();
      pred.actualResult = 'expired';
      changed = true;
      continue;
    }

    if (priceToBeat !== null && timeLeftMin <= 0.05 && pred.marketSlug === currentSlug) {
      const result = btcPrice >= priceToBeat ? 'UP' : 'DOWN';
      pred.settled = true;
      pred.correct = pred.side === result;
      pred.settledAt = Date.now();
      pred.actualResult = result;
      changed = true;
      updateSignalPerf(pred.signalSnapshot, pred.side, pred.correct, pred.modelProb);
    }
  }

  if (changed) markDirty();
}

export function loadHistory() {
  ensureLoaded();
  return S.cache;
}

export function flushHistory() {
  if (!S.dirty || !S.cache) return;
  clearPersistTimer();
  S.setDirty(false);
  try {
    const c = S.cache;
    if (c.length > MAX_HISTORY) S.setCache(c.slice(-MAX_HISTORY));
    localStorage.setItem('btc_prediction_tracker', JSON.stringify(S.cache));
  } catch { /* */ }
}

export function clearAll() {
  S.setCache([]);
  markDirty();
  try { localStorage.removeItem('btc_prediction_tracker'); } catch { /* */ }
  console.log('[Feedback] All prediction data cleared');
}
