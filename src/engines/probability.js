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
 *   Price to PTB distance:    +1.5..5 (constant — time decay via applyTimeAwareness)
 *   PTB momentum:             +1.5  (price moving away/toward PTB)
 *   Delta momentum (1m/3m):   +3
 *   Orderbook imbalance:      +2    (real money signal)
 *   Multi-TF confirmation:    +2    (1m+5m agreement)
 *   RSI + Slope:              +2
 *   MACD Histogram:           +1
 *   MACD Line:                +1
 *   VWAP position:            +1
 *   VWAP Slope:               +1
 *   Heiken Ashi:              +1
 *   Failed VWAP Reclaim:      +2
 *   Total possible per side:  ~22.5
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
  minutesLeft = null,       // minutes until settlement (for time-adaptive PTB weight)
  signalModifiers = null,   // from getSignalModifiers() — dynamic weight adaptation
  bb = null,                // from computeBollinger() — { percentB, squeeze, squeezeIntensity }
  atr = null,               // from computeATR() — { atrRatio, expanding }
}) {
  let upScore = 1;   // base
  let downScore = 1;  // base
  const breakdown = {};

  // Apply per-signal modifier to base weight
  const mod = (key, baseWeight) => {
    if (!signalModifiers) return baseWeight;
    const m = signalModifiers[key];
    return (m != null && Number.isFinite(m)) ? +(baseWeight * m).toFixed(2) : baseWeight;
  };

  // ═══ 1. DISTANCE TO PRICE TO BEAT (weight: 1.5-5) ═══
  // Audit M fix: removed ptbTimeScale to fix double-count with applyTimeAwareness().
  // Both were scaling PTB by time remaining — net effect was double-decay near expiry.
  // Now PTB uses constant base weights; applyTimeAwareness() handles global time decay.

  if (priceToBeat !== null && price !== null && priceToBeat > 0) {
    const distance = price - priceToBeat;
    const distPct = distance / priceToBeat;

    // Use session-adaptive thresholds if available, else defaults
    const thr = volProfile?.ptbThresholds ?? { strong: 0.003, moderate: 0.0015, slight: 0.0005 };

    const wStrong = mod('ptbDistance', 5);
    const wModerate = mod('ptbDistance', 3);
    const wSlight = mod('ptbDistance', 1.5);

    if (Math.abs(distPct) > thr.strong) {
      if (distance > 0) upScore += wStrong;
      else downScore += wStrong;
      breakdown.ptbDistance = { signal: distance > 0 ? 'STRONG UP' : 'STRONG DOWN', weight: +wStrong.toFixed(1), distPct };
    } else if (Math.abs(distPct) > thr.moderate) {
      if (distance > 0) upScore += wModerate;
      else downScore += wModerate;
      breakdown.ptbDistance = { signal: distance > 0 ? 'UP' : 'DOWN', weight: +wModerate.toFixed(1), distPct };
    } else if (Math.abs(distPct) > thr.slight) {
      if (distance > 0) upScore += wSlight;
      else downScore += wSlight;
      breakdown.ptbDistance = { signal: distance > 0 ? 'LEAN UP' : 'LEAN DOWN', weight: +wSlight.toFixed(1), distPct };
    } else {
      breakdown.ptbDistance = { signal: 'NEUTRAL', weight: 0, distPct };
    }

    // ═══ 1b. PTB MOMENTUM (weight: 1.5) ═══
    // Is price moving AWAY from PTB (reinforcing) or TOWARD PTB (reverting)?
    // delta1m > 0 while above PTB = moving away = bullish
    // delta1m < 0 while above PTB = moving toward = bearish
    if (delta1m !== null && Math.abs(distPct) > thr.slight) {
      const movingAway = (distance > 0 && delta1m > 0) || (distance < 0 && delta1m < 0);
      const movingToward = (distance > 0 && delta1m < 0) || (distance < 0 && delta1m > 0);

      if (movingAway) {
        // Reinforcing: price extending lead over PTB → boost direction
        const wAway = mod('ptbMomentum', 1.5);
        if (distance > 0) upScore += wAway;
        else downScore += wAway;
        breakdown.ptbMomentum = { signal: distance > 0 ? 'EXTENDING UP' : 'EXTENDING DOWN', weight: wAway };
      } else if (movingToward) {
        // Reverting: price closing gap to PTB → counter-signal
        const wToward = mod('ptbMomentum', 1);
        if (distance > 0) downScore += wToward;
        else upScore += wToward;
        breakdown.ptbMomentum = { signal: distance > 0 ? 'REVERTING (down toward PTB)' : 'REVERTING (up toward PTB)', weight: wToward };
      } else {
        breakdown.ptbMomentum = { signal: 'FLAT', weight: 0 };
      }
    } else {
      breakdown.ptbMomentum = { signal: delta1m === null ? 'N/A' : 'TOO CLOSE', weight: 0 };
    }
  } else {
    breakdown.ptbDistance = { signal: 'N/A', weight: 0 };
    breakdown.ptbMomentum = { signal: 'N/A', weight: 0 };
  }

  // ═══ 2. DELTA MOMENTUM 1m/3m (weight: 3) ═══
  // Short-term momentum is highly predictive for 15-minute settlement
  if (delta1m !== null && delta3m !== null) {
    const bothUp = delta1m > 0 && delta3m > 0;
    const bothDown = delta1m < 0 && delta3m < 0;
    const accelerating1m = Math.abs(delta1m) > Math.abs(delta3m) / 3;

    if (bothUp && accelerating1m) {
      const w = mod('momentum', 3);
      upScore += w;
      breakdown.momentum = { signal: 'STRONG UP', weight: w };
    } else if (bothDown && accelerating1m) {
      const w = mod('momentum', 3);
      downScore += w;
      breakdown.momentum = { signal: 'STRONG DOWN', weight: w };
    } else if (bothUp) {
      const w = mod('momentum', 2);
      upScore += w;
      breakdown.momentum = { signal: 'UP', weight: w };
    } else if (bothDown) {
      const w = mod('momentum', 2);
      downScore += w;
      breakdown.momentum = { signal: 'DOWN', weight: w };
    } else if (delta1m > 0) {
      const w = mod('momentum', 1);
      upScore += w;
      breakdown.momentum = { signal: 'LEAN UP', weight: w };
    } else if (delta1m < 0) {
      const w = mod('momentum', 1);
      downScore += w;
      breakdown.momentum = { signal: 'LEAN DOWN', weight: w };
    } else {
      breakdown.momentum = { signal: 'NEUTRAL', weight: 0 };
    }
  } else if (delta1m !== null) {
    if (delta1m > 0) { const w = mod('momentum', 1); upScore += w; breakdown.momentum = { signal: 'LEAN UP', weight: w }; }
    else if (delta1m < 0) { const w = mod('momentum', 1); downScore += w; breakdown.momentum = { signal: 'LEAN DOWN', weight: w }; }
    else breakdown.momentum = { signal: 'NEUTRAL', weight: 0 };
  } else {
    breakdown.momentum = { signal: 'N/A', weight: 0 };
  }

  // ═══ 3. RSI + Slope (weight: 2) ═══
  if (rsi !== null) {
    // RSI thresholds adjusted for period 8 (more volatile, wider bands)
    if (rsi >= 60 && (rsiSlope === null || rsiSlope >= 0)) {
      const w = mod('rsi', 2);
      upScore += w;
      breakdown.rsi = { signal: 'UP', weight: w };
    } else if (rsi <= 40 && (rsiSlope === null || rsiSlope <= 0)) {
      const w = mod('rsi', 2);
      downScore += w;
      breakdown.rsi = { signal: 'DOWN', weight: w };
    } else if (rsi >= 55) {
      const w = mod('rsi', 1);
      upScore += w;
      breakdown.rsi = { signal: 'LEAN UP', weight: w };
    } else if (rsi <= 45) {
      const w = mod('rsi', 1);
      downScore += w;
      breakdown.rsi = { signal: 'LEAN DOWN', weight: w };
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
      const w = mod('macdHist', expanding ? 1 : 0.5);
      upScore += w;
      breakdown.macdHist = { signal: expanding ? 'UP (expanding)' : 'UP', weight: w };
    } else if (macd.hist < 0) {
      const w = mod('macdHist', expanding ? 1 : 0.5);
      downScore += w;
      breakdown.macdHist = { signal: expanding ? 'DOWN (expanding)' : 'DOWN', weight: w };
    } else {
      breakdown.macdHist = { signal: 'NEUTRAL', weight: 0 };
    }

    // MACD line (weight: 1)
    if (macd.line > 0) {
      const w = mod('macdLine', 1);
      upScore += w;
      breakdown.macdLine = { signal: 'UP', weight: w };
    } else if (macd.line < 0) {
      const w = mod('macdLine', 1);
      downScore += w;
      breakdown.macdLine = { signal: 'DOWN', weight: w };
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
      const w = mod('vwapPos', 1);
      upScore += w;
      breakdown.vwapPos = { signal: 'UP', weight: w };
    } else if (price < vwap) {
      const w = mod('vwapPos', 1);
      downScore += w;
      breakdown.vwapPos = { signal: 'DOWN', weight: w };
    } else {
      breakdown.vwapPos = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.vwapPos = { signal: 'N/A', weight: 0 };
  }

  // ═══ 6. VWAP Slope (weight: 1, reduced from 2) ═══
  // Normalize slope to % of VWAP to be price-independent (raw $/candle always > 0.1 for BTC)
  if (vwapSlope !== null && vwap !== null && vwap > 0) {
    const normalizedSlope = vwapSlope / vwap;
    if (normalizedSlope > 0.000001) {
      const w = mod('vwapSlope', 1);
      upScore += w;
      breakdown.vwapSlope = { signal: 'UP', weight: w };
    } else if (normalizedSlope < -0.000001) {
      const w = mod('vwapSlope', 1);
      downScore += w;
      breakdown.vwapSlope = { signal: 'DOWN', weight: w };
    } else {
      breakdown.vwapSlope = { signal: 'NEUTRAL', weight: 0 };
    }
  } else {
    breakdown.vwapSlope = { signal: 'N/A', weight: 0 };
  }

  // ═══ 7. Heiken Ashi Consecutive (weight: 1) ═══
  if (heikenColor && heikenCount >= 2) {
    if (heikenColor.toLowerCase() === 'green') {
      const w = mod('heikenAshi', 1);
      upScore += w;
      breakdown.heikenAshi = { signal: 'UP', weight: w, count: heikenCount };
    } else if (heikenColor.toLowerCase() === 'red') {
      const w = mod('heikenAshi', 1);
      downScore += w;
      breakdown.heikenAshi = { signal: 'DOWN', weight: w, count: heikenCount };
    } else {
      breakdown.heikenAshi = { signal: 'NEUTRAL', weight: 0, count: heikenCount };
    }
  } else {
    breakdown.heikenAshi = { signal: 'NEUTRAL', weight: 0, count: heikenCount };
  }

  // ═══ 8. Failed VWAP Reclaim (weight: 2, reduced from 3) ═══
  if (failedVwapReclaim) {
    const w = mod('failedVwap', 2);
    downScore += w;
    breakdown.failedVwap = { signal: 'DOWN', weight: w };
  } else {
    breakdown.failedVwap = { signal: 'N/A', weight: 0 };
  }

  // ═══ 9. ORDERBOOK IMBALANCE (weight: 2) — NEW ═══
  // Real money signal from Polymarket CLOB WebSocket.
  // Bid/ask imbalance shows what traders are actually doing.
  if (orderbookSignal && orderbookSignal.signal !== 'NEUTRAL' && orderbookSignal.weight > 0) {
    const w = mod('orderbook', orderbookSignal.weight);
    if (orderbookSignal.signal === 'UP') {
      upScore += w;
    } else if (orderbookSignal.signal === 'DOWN') {
      downScore += w;
    }
    breakdown.orderbook = {
      signal: orderbookSignal.signal,
      weight: w,
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
      const w = mod('multiTf', 2);
      if (multiTfConfirm.signal === 'UP') {
        upScore += w;
        breakdown.multiTf = { signal: 'UP (confirmed)', weight: w };
      } else {
        downScore += w;
        breakdown.multiTf = { signal: 'DOWN (confirmed)', weight: w };
      }
    } else {
      // 5m contradicts 1m → penalize the majority direction
      const w = mod('multiTf', 1);
      if (multiTfConfirm.signal === 'UP') downScore += w;
      else if (multiTfConfirm.signal === 'DOWN') upScore += w;
      breakdown.multiTf = { signal: `CONFLICT (1m vs 5m)`, weight: -w };
    }
  } else {
    breakdown.multiTf = { signal: multiTfConfirm?.signal ?? 'N/A', weight: 0 };
  }

  // ═══ 10b. BOLLINGER BANDS (weight: 1) — L1 fix ═══
  // %B > 0.8 = price near upper band (bullish momentum), < 0.2 = near lower (bearish)
  // Squeeze = bands tightening → breakout imminent, boost current direction
  if (bb && bb.percentB != null) {
    if (bb.percentB > 0.8) {
      const w = mod('bbPos', bb.squeeze ? 1 : 0.5);
      upScore += w;
      breakdown.bbPos = { signal: bb.squeeze ? 'UP (squeeze)' : 'UP', weight: w, percentB: bb.percentB };
    } else if (bb.percentB < 0.2) {
      const w = mod('bbPos', bb.squeeze ? 1 : 0.5);
      downScore += w;
      breakdown.bbPos = { signal: bb.squeeze ? 'DOWN (squeeze)' : 'DOWN', weight: w, percentB: bb.percentB };
    } else {
      breakdown.bbPos = { signal: 'NEUTRAL', weight: 0, percentB: bb.percentB };
    }
  } else {
    breakdown.bbPos = { signal: 'N/A', weight: 0 };
  }

  // ═══ 10c. ATR EXPANSION (weight: 0.5) — L1 fix ═══
  // Expanding ATR = strong directional move in progress → boost momentum direction
  if (atr && atr.expanding && delta1m !== null && delta1m !== 0) {
    const w = mod('atrExpand', 0.5);
    if (delta1m > 0) upScore += w;
    else downScore += w;
    breakdown.atrExpand = { signal: delta1m > 0 ? 'UP' : 'DOWN', weight: w, atrRatio: atr.atrRatio };
  } else {
    breakdown.atrExpand = { signal: atr?.expanding ? 'NO DIR' : 'N/A', weight: 0, atrRatio: atr?.atrRatio ?? null };
  }

  // ═══ CALCULATE RAW PROBABILITY ═══
  const totalWeight = upScore + downScore;
  let rawUp = totalWeight > 0 ? upScore / totalWeight : 0.5;

  // ═══ 11. REGIME ADJUSTMENT ═══
  let regimeMultiplier = 1.0;
  let regimeEffect = 'NONE';

  if (regime && regime.regime) {
    switch (regime.regime) {
      case 'trending': {
        // M7: Direction-aware — boost when signal aligns with trend, dampen when counter-trend
        const trendUp = regime.direction === 'UP';
        const trendDown = regime.direction === 'DOWN';
        const signalUp = upScore > downScore;
        const aligned = (trendUp && signalUp) || (trendDown && !signalUp);
        regimeMultiplier = aligned ? 1.25 : 0.90;  // v3: counter-trend 0.85→0.90 (less harsh)
        regimeEffect = aligned
          ? `BOOST (${regime.label}, aligned)`
          : `DAMPEN (${regime.label}, counter-trend)`;
        break;
      }
      case 'choppy':
        regimeMultiplier = 0.70;  // v3: 0.60→0.70 (0.60 was killing all signals in choppy)
        regimeEffect = `DAMPEN (${regime.label})`;
        break;
      case 'mean_reverting':
        regimeMultiplier = 0.85;  // v3: 0.80→0.85 (mean reversion has edge from VWAP signals)
        regimeEffect = `SLIGHT DAMPEN (${regime.label})`;
        break;
      default:
        regimeMultiplier = 1.0;
        regimeEffect = 'NEUTRAL';
        break;
    }
  }
  breakdown.regime = { effect: regimeEffect, multiplier: regimeMultiplier };

  // ═══ 12. VOLATILITY SESSION ADJUSTMENT — NEW ═══
  const volMultiplier = volProfile?.confidenceMultiplier ?? 1.0;
  breakdown.volatility = {
    session: volProfile?.session ?? 'unknown',
    multiplier: volMultiplier,
    label: volProfile?.label ?? '',
  };

  // ═══ 13. FEEDBACK ACCURACY ADJUSTMENT ═══
  // Audit fix M: Use accuracy-only multiplier for probability scoring.
  // Win/loss streak effects should only affect bet SIZING (via asymmetricBet.js),
  // not probability estimation — applying streaks to both is double-counting.
  const fbMultiplierRaw = feedbackStats?.confidenceMultiplier ?? 1.0;
  const fbAccuracy = feedbackStats?.accuracy ?? null;
  // Strip streak component: compute accuracy-only multiplier directly
  let fbMultiplier;
  if (fbAccuracy == null) fbMultiplier = 1.0;
  else if (fbAccuracy >= 0.70) fbMultiplier = 1.15;
  else if (fbAccuracy >= 0.55) fbMultiplier = 1.05;
  else if (fbAccuracy >= 0.45) fbMultiplier = 1.0;
  else if (fbAccuracy >= 0.35) fbMultiplier = 0.85;
  else fbMultiplier = 0.70;
  // Clamp same as stats.js
  fbMultiplier = Math.max(0.50, Math.min(1.25, fbMultiplier));
  breakdown.feedback = {
    multiplier: fbMultiplier,
    accuracy: fbAccuracy,
    label: feedbackStats?.label ?? 'No data',
  };

  // Apply all post-scoring multipliers in one step (avoids per-step clamping
  // artifacts when intermediate values hit [0.02, 0.98] bounds)
  // H4: Cap combined multiplier to [0.50, 1.50] to prevent extreme swings
  const rawCombined = regimeMultiplier * volMultiplier * fbMultiplier;
  const combinedMultiplier = Math.max(0.50, Math.min(1.50, rawCombined));
  breakdown.combinedMultiplier = { raw: +rawCombined.toFixed(4), clamped: +combinedMultiplier.toFixed(4) };
  rawUp = Math.max(0.02, Math.min(0.98, 0.5 + (rawUp - 0.5) * combinedMultiplier));

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

  if (!Number.isFinite(timeLeftMin) || !Number.isFinite(totalWindowMin) || totalWindowMin <= 0) {
    return { adjustedUp: rawUp, adjustedDown: 1 - rawUp, timeDecay: 1 };
  }

  const ratio = Math.max(0, Math.min(1, timeLeftMin / totalWindowMin));
  const rawDecay = Math.sqrt(ratio);  // sqrt curve — much gentler than linear
  const timeDecay = Math.max(FLOOR, rawDecay);

  const adjustedUp = 0.5 + (rawUp - 0.5) * timeDecay;
  const adjustedDown = 1 - adjustedUp;

  return { adjustedUp, adjustedDown, timeDecay };
}