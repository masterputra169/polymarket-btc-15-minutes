/**
 * ═══ REWORKED Probability Engine v2 for 15-Minute Polymarket ═══
 *
 * v2 additions:
 * 5. Orderbook signal (bid/ask imbalance from CLOB WebSocket)
 * 6. Volatility-adaptive PTB thresholds (session-aware)
 * 7. Multi-timeframe confirmation (1m + 5m agreement)
 * 8. Feedback confidence adjustment (recent accuracy tracking)
 *
 * WEIGHT TABLE:
 *   Price to PTB distance:    +5  (adaptive thresholds per session)
 *   Delta momentum (1m/3m):   +3
 *   Orderbook imbalance:      +2  (NEW — real money signal)
 *   Multi-TF confirmation:    +2  (NEW — 1m+5m agreement)
 *   RSI + Slope:              +2
 *   MACD Histogram:           +1
 *   MACD Line:                +1
 *   VWAP position:            +1
 *   VWAP Slope:               +1
 *   Heiken Ashi:              +1
 *   Failed VWAP Reclaim:      +2
 *   Total possible per side:  ~21
 *
 *   Post-scoring multipliers:
 *   - Regime:     0.60x (choppy) to 1.25x (trending)
 *   - Volatility: 0.90x (high vol) to 1.10x (low vol)
 *   - Feedback:   0.70x (ice cold) to 1.15x (hot streak)
 */

/**
 * Score directional bias based on all indicators + orderbook + multi-TF.
 */
export function scoreDirection({
  price,
  priceToBeat = null,
  vwap = null,
  vwapSlope = null,
  rsi = null,
  rsiSlope = null,
  macd = null,
  heikenColor = null,
  heikenCount = 0,
  failedVwapReclaim = false,
  delta1m = null,
  delta3m = null,
  regime = null,
  // ═══ NEW v2 params ═══
  orderbookSignal = null,   // from analyzeOrderbook()
  volProfile = null,        // from getVolatilityProfile()
  multiTfConfirm = null,    // { signal: 'UP'|'DOWN'|'NEUTRAL', agreement: bool }
  feedbackStats = null,     // from getAccuracyStats()
}) {
  let upScore = 1;   // base
  let downScore = 1;  // base
  const breakdown = {};

  // ═══ 1. DISTANCE TO PRICE TO BEAT (weight: 5) ═══
  // Thresholds are now ADAPTIVE based on session volatility.
  // Asia: 0.1% is big → lower thresholds. US overlap: 0.3% is normal → higher thresholds.
  if (priceToBeat !== null && price !== null && priceToBeat > 0) {
    const distance = price - priceToBeat;
    const distPct = distance / priceToBeat;

    // Use session-adaptive thresholds if available, else defaults
    const thr = volProfile?.ptbThresholds ?? { strong: 0.003, moderate: 0.0015, slight: 0.0005 };

    if (Math.abs(distPct) > thr.strong) {
      if (distance > 0) upScore += 5;
      else downScore += 5;
      breakdown.ptbDistance = { signal: distance > 0 ? 'STRONG UP' : 'STRONG DOWN', weight: 5, distPct };
    } else if (Math.abs(distPct) > thr.moderate) {
      if (distance > 0) upScore += 3;
      else downScore += 3;
      breakdown.ptbDistance = { signal: distance > 0 ? 'UP' : 'DOWN', weight: 3, distPct };
    } else if (Math.abs(distPct) > thr.slight) {
      if (distance > 0) upScore += 1.5;
      else downScore += 1.5;
      breakdown.ptbDistance = { signal: distance > 0 ? 'LEAN UP' : 'LEAN DOWN', weight: 1.5, distPct };
    } else {
      breakdown.ptbDistance = { signal: 'NEUTRAL', weight: 0, distPct };
    }
  } else {
    breakdown.ptbDistance = { signal: 'N/A', weight: 0 };
  }

  // ═══ 2. DELTA MOMENTUM 1m/3m (weight: 3) ═══
  // Short-term momentum is highly predictive for 15-minute settlement
  if (delta1m !== null && delta3m !== null) {
    const bothUp = delta1m > 0 && delta3m > 0;
    const bothDown = delta1m < 0 && delta3m < 0;
    const accelerating1m = Math.abs(delta1m) > Math.abs(delta3m) / 3;

    if (bothUp && accelerating1m) {
      upScore += 3;
      breakdown.momentum = { signal: 'STRONG UP', weight: 3 };
    } else if (bothDown && accelerating1m) {
      downScore += 3;
      breakdown.momentum = { signal: 'STRONG DOWN', weight: 3 };
    } else if (bothUp) {
      upScore += 2;
      breakdown.momentum = { signal: 'UP', weight: 2 };
    } else if (bothDown) {
      downScore += 2;
      breakdown.momentum = { signal: 'DOWN', weight: 2 };
    } else if (delta1m > 0) {
      upScore += 1;
      breakdown.momentum = { signal: 'LEAN UP', weight: 1 };
    } else if (delta1m < 0) {
      downScore += 1;
      breakdown.momentum = { signal: 'LEAN DOWN', weight: 1 };
    } else {
      breakdown.momentum = { signal: 'NEUTRAL', weight: 0 };
    }
  } else if (delta1m !== null) {
    if (delta1m > 0) { upScore += 1; breakdown.momentum = { signal: 'LEAN UP', weight: 1 }; }
    else if (delta1m < 0) { downScore += 1; breakdown.momentum = { signal: 'LEAN DOWN', weight: 1 }; }
    else breakdown.momentum = { signal: 'NEUTRAL', weight: 0 };
  } else {
    breakdown.momentum = { signal: 'N/A', weight: 0 };
  }

  // ═══ 3. RSI + Slope (weight: 2) ═══
  if (rsi !== null) {
    // RSI thresholds adjusted for period 8 (more volatile, wider bands)
    if (rsi >= 60 && (rsiSlope === null || rsiSlope >= 0)) {
      upScore += 2;
      breakdown.rsi = { signal: 'UP', weight: 2 };
    } else if (rsi <= 40 && (rsiSlope === null || rsiSlope <= 0)) {
      downScore += 2;
      breakdown.rsi = { signal: 'DOWN', weight: 2 };
    } else if (rsi >= 55) {
      upScore += 1;
      breakdown.rsi = { signal: 'LEAN UP', weight: 1 };
    } else if (rsi <= 45) {
      downScore += 1;
      breakdown.rsi = { signal: 'LEAN DOWN', weight: 1 };
    } else {
      breakdown.rsi = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.rsi = { signal: 'N/A', weight: 0 };
  }

  // ═══ 4. MACD Histogram (weight: 1, reduced from 2) ═══
  if (macd !== null) {
    const expanding = macd.histDelta !== null &&
      ((macd.hist > 0 && macd.histDelta > 0) || (macd.hist < 0 && macd.histDelta < 0));

    if (macd.hist > 0) {
      upScore += expanding ? 1 : 0.5;
      breakdown.macdHist = { signal: expanding ? 'UP (expanding)' : 'UP', weight: expanding ? 1 : 0.5 };
    } else if (macd.hist < 0) {
      downScore += expanding ? 1 : 0.5;
      breakdown.macdHist = { signal: expanding ? 'DOWN (expanding)' : 'DOWN', weight: expanding ? 1 : 0.5 };
    } else {
      breakdown.macdHist = { signal: 'NEUTRAL', weight: 0 };
    }

    // MACD line (weight: 1)
    if (macd.line > 0) {
      upScore += 1;
      breakdown.macdLine = { signal: 'UP', weight: 1 };
    } else if (macd.line < 0) {
      downScore += 1;
      breakdown.macdLine = { signal: 'DOWN', weight: 1 };
    } else {
      breakdown.macdLine = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.macdHist = { signal: 'N/A', weight: 0 };
    breakdown.macdLine = { signal: 'N/A', weight: 0 };
  }

  // ═══ 5. VWAP Position (weight: 1, reduced from 2) ═══
  if (vwap !== null && price !== null) {
    if (price > vwap) {
      upScore += 1;
      breakdown.vwapPos = { signal: 'UP', weight: 1 };
    } else if (price < vwap) {
      downScore += 1;
      breakdown.vwapPos = { signal: 'DOWN', weight: 1 };
    } else {
      breakdown.vwapPos = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.vwapPos = { signal: 'N/A', weight: 0 };
  }

  // ═══ 6. VWAP Slope (weight: 1, reduced from 2) ═══
  if (vwapSlope !== null) {
    if (vwapSlope > 0.1) {
      upScore += 1;
      breakdown.vwapSlope = { signal: 'UP', weight: 1 };
    } else if (vwapSlope < -0.1) {
      downScore += 1;
      breakdown.vwapSlope = { signal: 'DOWN', weight: 1 };
    } else {
      breakdown.vwapSlope = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.vwapSlope = { signal: 'N/A', weight: 0 };
  }

  // ═══ 7. Heiken Ashi Consecutive (weight: 1) ═══
  if (heikenColor && heikenCount >= 2) {
    if (heikenColor.toLowerCase() === 'green') {
      upScore += 1;
      breakdown.heikenAshi = { signal: 'UP', weight: 1, count: heikenCount };
    } else if (heikenColor.toLowerCase() === 'red') {
      downScore += 1;
      breakdown.heikenAshi = { signal: 'DOWN', weight: 1, count: heikenCount };
    } else {
      breakdown.heikenAshi = { signal: 'NEUTRAL', weight: 0, count: heikenCount };
    }
  } else {
    breakdown.heikenAshi = { signal: 'NEUTRAL', weight: 0, count: heikenCount };
  }

  // ═══ 8. Failed VWAP Reclaim (weight: 2, reduced from 3) ═══
  if (failedVwapReclaim) {
    downScore += 2;
    breakdown.failedVwap = { signal: 'DOWN', weight: 2 };
  } else {
    breakdown.failedVwap = { signal: 'N/A', weight: 0 };
  }

  // ═══ 9. ORDERBOOK IMBALANCE (weight: 2) — NEW ═══
  // Real money signal from Polymarket CLOB WebSocket.
  // Bid/ask imbalance shows what traders are actually doing.
  if (orderbookSignal && orderbookSignal.signal !== 'NEUTRAL' && orderbookSignal.weight > 0) {
    if (orderbookSignal.signal === 'UP') {
      upScore += orderbookSignal.weight;
    } else if (orderbookSignal.signal === 'DOWN') {
      downScore += orderbookSignal.weight;
    }
    breakdown.orderbook = {
      signal: orderbookSignal.signal,
      weight: orderbookSignal.weight,
      detail: orderbookSignal.detail,
    };
  } else {
    breakdown.orderbook = { signal: orderbookSignal?.signal ?? 'N/A', weight: 0, detail: orderbookSignal?.detail ?? '' };
  }

  // ═══ 10. MULTI-TIMEFRAME CONFIRMATION (weight: 2) — NEW ═══
  // When 1m and 5m candles agree on direction, signal is more reliable.
  // When they disagree, reduce confidence.
  if (multiTfConfirm && multiTfConfirm.signal !== 'NEUTRAL') {
    if (multiTfConfirm.agreement) {
      // 5m confirms 1m direction → boost
      if (multiTfConfirm.signal === 'UP') {
        upScore += 2;
        breakdown.multiTf = { signal: 'UP (confirmed)', weight: 2 };
      } else {
        downScore += 2;
        breakdown.multiTf = { signal: 'DOWN (confirmed)', weight: 2 };
      }
    } else {
      // 5m contradicts 1m → this is actually a counter-signal, don't add weight
      breakdown.multiTf = { signal: `CONFLICT (1m vs 5m)`, weight: 0 };
    }
  } else {
    breakdown.multiTf = { signal: multiTfConfirm?.signal ?? 'N/A', weight: 0 };
  }

  // ═══ CALCULATE RAW PROBABILITY ═══
  const totalWeight = upScore + downScore;
  let rawUp = totalWeight > 0 ? upScore / totalWeight : 0.5;

  // ═══ 11. REGIME ADJUSTMENT ═══
  let regimeMultiplier = 1.0;
  let regimeEffect = 'NONE';

  if (regime && regime.regime) {
    switch (regime.regime) {
      case 'trending':
        regimeMultiplier = 1.25;
        regimeEffect = `BOOST (${regime.label})`;
        break;
      case 'choppy':
        regimeMultiplier = 0.60;
        regimeEffect = `DAMPEN (${regime.label})`;
        break;
      case 'mean_reverting':
        regimeMultiplier = 0.80;
        regimeEffect = `SLIGHT DAMPEN (${regime.label})`;
        break;
      default:
        regimeMultiplier = 1.0;
        regimeEffect = 'NEUTRAL';
        break;
    }
    rawUp = Math.max(0.02, Math.min(0.98, 0.5 + (rawUp - 0.5) * regimeMultiplier));
  }
  breakdown.regime = { effect: regimeEffect, multiplier: regimeMultiplier };

  // ═══ 12. VOLATILITY SESSION ADJUSTMENT — NEW ═══
  const volMultiplier = volProfile?.confidenceMultiplier ?? 1.0;
  if (volMultiplier !== 1.0) {
    rawUp = Math.max(0.02, Math.min(0.98, 0.5 + (rawUp - 0.5) * volMultiplier));
  }
  breakdown.volatility = {
    session: volProfile?.session ?? 'unknown',
    multiplier: volMultiplier,
    label: volProfile?.label ?? '',
  };

  // ═══ 13. FEEDBACK ACCURACY ADJUSTMENT — NEW ═══
  const fbMultiplier = feedbackStats?.confidenceMultiplier ?? 1.0;
  if (fbMultiplier !== 1.0) {
    rawUp = Math.max(0.02, Math.min(0.98, 0.5 + (rawUp - 0.5) * fbMultiplier));
  }
  breakdown.feedback = {
    multiplier: fbMultiplier,
    accuracy: feedbackStats?.accuracy ?? null,
    label: feedbackStats?.label ?? 'No data',
  };

  // Clamp to valid probability range
  rawUp = Math.max(0.02, Math.min(0.98, rawUp));

  const rawDown = 1 - rawUp;

  return { upScore, downScore, totalWeight, rawUp, rawDown, breakdown };
}

/**
 * Apply time-awareness to raw probability.
 *
 * ═══ REWORKED TIME DECAY ═══
 * Old: linear decay → killed all signals in LATE phase
 * New: sqrt curve with floor → still allows confident signals near settlement
 *
 * Formula: timeDecay = max(FLOOR, sqrt(timeLeft / totalWindow))
 *
 * | Time Left | Old Decay | New Decay | rawUp 70% → adjusted |
 * |-----------|-----------|-----------|----------------------|
 * | 15 min    | 1.00      | 1.00      | 70% → 70%            |
 * | 10 min    | 0.67      | 0.82      | 70% → 66%            |
 * | 7 min     | 0.47      | 0.68      | 70% → 64%            |
 * | 5 min     | 0.33      | 0.58      | 70% → 62%            |
 * | 3 min     | 0.20      | 0.45      | 70% → 59%            |
 * | 1 min     | 0.07      | 0.35*     | 70% → 57%            |
 *   * = clamped to floor of 0.35
 *
 * This means LATE phase (< 5 min) still has meaningful signal strength,
 * especially when Price to Beat distance is large.
 *
 * @param {number} rawUp - raw probability (0-1)
 * @param {number} timeLeftMin - minutes until settlement
 * @param {number} totalWindowMin - total market window (15)
 * @returns {{ adjustedUp: number, adjustedDown: number, timeDecay: number }}
 */
export function applyTimeAwareness(rawUp, timeLeftMin, totalWindowMin = 15) {
  const FLOOR = 0.35;  // minimum decay — never fully flatten

  if (timeLeftMin === null || timeLeftMin === undefined || !Number.isFinite(timeLeftMin)) {
    return { adjustedUp: rawUp, adjustedDown: 1 - rawUp, timeDecay: 1 };
  }

  const ratio = Math.max(0, Math.min(1, timeLeftMin / totalWindowMin));
  const rawDecay = Math.sqrt(ratio);  // sqrt curve — much gentler than linear
  const timeDecay = Math.max(FLOOR, rawDecay);

  const adjustedUp = 0.5 + (rawUp - 0.5) * timeDecay;
  const adjustedDown = 1 - adjustedUp;

  return { adjustedUp, adjustedDown, timeDecay };
}