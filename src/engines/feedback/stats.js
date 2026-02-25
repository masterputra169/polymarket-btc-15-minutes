/**
 * Accuracy statistics and calibration.
 */

import { ensureLoaded } from './state.js';
import * as S from './state.js';

function computeStreakFromCache() {
  for (let i = S.cache.length - 1; i >= 0; i--) {
    const p = S.cache[i];
    if (!p.settled || p.correct === null) continue;
    const streakType = p.correct;
    let count = 1;
    for (let j = i - 1; j >= 0; j--) {
      const q = S.cache[j];
      if (!q.settled || q.correct === null) continue;
      if (q.correct === streakType) count++;
      else break;
    }
    return { type: streakType ? 'win' : 'loss', count };
  }
  return { type: 'none', count: 0 };
}

export function getAccuracyStats(windowSize = 20) {
  ensureLoaded();
  // L4: Cache must match requested windowSize — different callers may use different windows
  if (!S.statsDirty && S.statsCache && S.statsCache._windowSize === windowSize) return S.statsCache;

  let settledCount = 0;
  for (let i = 0; i < S.cache.length; i++) {
    if (S.cache[i].settled && S.cache[i].correct !== null) settledCount++;
  }

  if (settledCount < 5) {
    let correctSoFar = 0;
    for (let i = 0; i < S.cache.length; i++) {
      if (S.cache[i].settled && S.cache[i].correct === true) correctSoFar++;
    }
    const streak = computeStreakFromCache();
    const result = {
      accuracy: null,
      total: settledCount,
      correct: correctSoFar,
      confidenceMultiplier: 1.0,
      streak,
      label: `Tracking (${settledCount}/5 minimum)`,
      _windowSize: windowSize,
    };
    S.setStatsCache(result);
    return result;
  }

  const windowLen = Math.min(windowSize, settledCount);
  let skip = settledCount - windowLen;
  let recentCorrect = 0;
  let recentTotal = 0;
  let streakType = null;
  let streakCount = 0;
  let streakDone = false;

  for (let i = 0; i < S.cache.length; i++) {
    const p = S.cache[i];
    if (!p.settled || p.correct === null) continue;
    if (skip > 0) { skip--; continue; }
    recentTotal++;
    if (p.correct) recentCorrect++;
  }

  for (let i = S.cache.length - 1; i >= 0 && !streakDone; i--) {
    const p = S.cache[i];
    if (!p.settled || p.correct === null) continue;
    if (streakType === null) { streakType = p.correct; streakCount = 1; }
    else if (p.correct === streakType) streakCount++;
    else streakDone = true;
  }

  const accuracy = recentTotal > 0 ? recentCorrect / recentTotal : null;
  const streak = { type: streakType === null ? 'none' : streakType ? 'win' : 'loss', count: streakCount };

  let confidenceMultiplier, label;
  const pct = accuracy !== null ? (accuracy * 100).toFixed(0) : '0';

  if (accuracy >= 0.70) { confidenceMultiplier = 1.15; label = `\uD83D\uDD25 Hot (${pct}% of last ${recentTotal})`; }
  else if (accuracy >= 0.55) { confidenceMultiplier = 1.05; label = `\u2705 Good (${pct}% of last ${recentTotal})`; }
  else if (accuracy >= 0.45) { confidenceMultiplier = 1.0; label = `\u2796 Average (${pct}% of last ${recentTotal})`; }
  else if (accuracy >= 0.35) { confidenceMultiplier = 0.85; label = `\u26A0\uFE0F Cold (${pct}% of last ${recentTotal})`; }
  else { confidenceMultiplier = 0.70; label = `\u2744\uFE0F Ice Cold (${pct}% of last ${recentTotal})`; }

  if (streak.type === 'loss' && streak.count >= 3) { confidenceMultiplier *= 0.90; label += ` | ${streak.count}L streak`; }
  else if (streak.type === 'win' && streak.count >= 3) { confidenceMultiplier *= 1.05; label += ` | ${streak.count}W streak`; }

  if (confidenceMultiplier < 0.50) confidenceMultiplier = 0.50;
  else if (confidenceMultiplier > 1.25) confidenceMultiplier = 1.25;

  // Short-term accuracy (last 10) for rapid sizing adaptation
  let shortTermAccuracy = null;
  if (settledCount >= 10) {
    let stSkip = settledCount - 10;
    let stCorrect = 0, stTotal = 0;
    for (let i = 0; i < S.cache.length; i++) {
      const p = S.cache[i];
      if (!p.settled || p.correct === null) continue;
      if (stSkip > 0) { stSkip--; continue; }
      stTotal++;
      if (p.correct) stCorrect++;
    }
    shortTermAccuracy = stTotal > 0 ? stCorrect / stTotal : null;
  }

  const result = { accuracy, total: recentTotal, correct: recentCorrect, confidenceMultiplier, streak, label, shortTermAccuracy, _windowSize: windowSize };
  S.setStatsCache(result);
  return result;
}

export function getDetailedStats() {
  ensureLoaded();

  const settled = [];
  for (let i = 0; i < S.cache.length; i++) {
    if (S.cache[i].settled && S.cache[i].correct !== null) settled.push(S.cache[i]);
  }

  const totalSettled = settled.length;

  function rollingAcc(n) {
    if (totalSettled < n) return null;
    let correct = 0;
    const start = totalSettled - n;
    for (let i = start; i < totalSettled; i++) {
      if (settled[i].correct) correct++;
    }
    return correct / n;
  }

  const rolling = {
    last20: rollingAcc(20),
    last50: rollingAcc(50),
    last100: rollingAcc(100),
  };

  const regimeMap = {};
  for (let i = 0; i < totalSettled; i++) {
    const r = settled[i].regime || 'unknown';
    if (!regimeMap[r]) regimeMap[r] = { correct: 0, total: 0 };
    regimeMap[r].total++;
    if (settled[i].correct) regimeMap[r].correct++;
  }
  const regimes = {};
  for (const [r, data] of Object.entries(regimeMap)) {
    regimes[r] = {
      accuracy: data.total > 0 ? data.correct / data.total : null,
      total: data.total,
      correct: data.correct,
    };
  }

  // M5: modelProb is already the probability for the PREDICTED side (stored by recordPrediction).
  // e.g. if predicted DOWN with 65% conf, modelProb = 0.65 (not 0.35).
  // Math.max(raw, 1-raw) was wrong: when ensemble disagrees (modelProb < 0.5),
  // it inflated 0.35 → 0.65 putting it in the wrong calibration bucket.
  // Use modelProb directly — it IS the confidence for the predicted side.
  const calBuckets = [
    { lo: 0.50, hi: 0.55 }, { lo: 0.55, hi: 0.60 },
    { lo: 0.60, hi: 0.65 }, { lo: 0.65, hi: 0.70 },
    { lo: 0.70, hi: 0.80 }, { lo: 0.80, hi: 1.00 },
  ];
  const calibration = calBuckets.map(({ lo, hi }) => {
    let correct = 0, total = 0, sumConf = 0;
    for (let i = 0; i < totalSettled; i++) {
      const p = settled[i];
      const conf = p.modelProb ?? 0.5;
      if (conf >= lo && conf < hi) {
        total++;
        sumConf += conf;
        if (p.correct) correct++;
      }
    }
    return {
      range: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`,
      // H5: Use actual avg confidence, not bucket midpoint — more accurate calibration ratio
      predicted: total > 0 ? sumConf / total : (lo + hi) / 2,
      actual: total > 0 ? correct / total : null,
      total,
    };
  });

  let streakType = null;
  let streakCount = 0;
  for (let i = totalSettled - 1; i >= 0; i--) {
    if (streakType === null) {
      streakType = settled[i].correct;
      streakCount = 1;
    } else if (settled[i].correct === streakType) {
      streakCount++;
    } else {
      break;
    }
  }

  return {
    totalSettled,
    rolling,
    regimes,
    calibration,
    streak: {
      type: streakType === null ? 'none' : streakType ? 'win' : 'loss',
      count: streakCount,
    },
  };
}

export function getMLAccuracy(windowSize = 20) {
  ensureLoaded();
  const mlSettled = [];
  for (let i = 0; i < S.cache.length; i++) {
    const p = S.cache[i];
    if (p.settled && p.correct !== null && p.mlSide != null) mlSettled.push(p);
  }
  if (mlSettled.length < 5) return null;
  const window = mlSettled.slice(-Math.min(windowSize, mlSettled.length));
  let correct = 0;
  for (const p of window) {
    if (p.mlSide === p.actualResult) correct++;
  }
  return correct / window.length;
}

export function computeKellyTune(baseKelly = 0.25) {
  const detailed = getDetailedStats();
  // Quant fix M6: lower minimum 30→15 — at 1 trade per 15min market, 30 trades = 7.5hr warmup.
  // 15 trades = ~3.75hr warmup, still statistically meaningful for initial calibration signal.
  if (detailed.totalSettled < 15) {
    return { kellyFraction: baseKelly, reason: 'insufficient_data', calibrationRatio: 1.0, sampleCount: detailed.totalSettled };
  }

  let weightedPredicted = 0, weightedActual = 0, totalWeight = 0;
  for (const bucket of detailed.calibration) {
    // Quant fix M6: lower per-bucket minimum 3→2 — small sample but better than skipping
    if (bucket.total < 2 || bucket.actual === null) continue;
    const w = bucket.total;
    weightedPredicted += bucket.predicted * w;
    weightedActual += bucket.actual * w;
    totalWeight += w;
  }

  if (totalWeight < 5) {
    return { kellyFraction: baseKelly, reason: 'sparse_buckets', calibrationRatio: 1.0, sampleCount: totalWeight };
  }

  const avgPredicted = weightedPredicted / totalWeight;
  const avgActual = weightedActual / totalWeight;

  if (avgPredicted < 0.01) {
    return { kellyFraction: baseKelly, reason: 'zero_predicted', calibrationRatio: 1.0, sampleCount: totalWeight };
  }

  const rawRatio = avgActual / avgPredicted;
  const clampedRatio = Math.min(Math.max(rawRatio, 0.50), 2.0);
  const kellyFraction = Math.round(baseKelly * clampedRatio * 1000) / 1000;

  let reason;
  if (clampedRatio < 0.85) reason = 'overconfident';
  else if (clampedRatio > 1.15) reason = 'underconfident';
  else reason = 'well_calibrated';

  return { kellyFraction, reason, calibrationRatio: Math.round(clampedRatio * 100) / 100, sampleCount: totalWeight };
}
