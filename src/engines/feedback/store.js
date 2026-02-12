/**
 * Prediction recording, settling, and persistence.
 */

import { ensureLoaded, markDirty, MAX_HISTORY, clearPersistTimer } from './state.js';
import * as S from './state.js';

export function recordPrediction({ side, modelProb, marketPrice, btcPrice, priceToBeat, marketSlug, regime, mlConfidence }) {
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
    }
  }
  if (changed) markDirty();
}

export function autoSettle(currentSlug, btcPrice, priceToBeat, timeLeftMin) {
  if (timeLeftMin > 0.5) return;
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

    if (pred.marketSlug && pred.marketSlug !== currentSlug) {
      pred.settled = true;
      pred.correct = null;
      pred.settledAt = Date.now();
      pred.actualResult = 'expired';
      changed = true;
      continue;
    }

    if (priceToBeat !== null && timeLeftMin <= 0.5 && pred.marketSlug === currentSlug) {
      const result = btcPrice >= priceToBeat ? 'UP' : 'DOWN';
      pred.settled = true;
      pred.correct = pred.side === result;
      pred.settledAt = Date.now();
      pred.actualResult = result;
      changed = true;
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
