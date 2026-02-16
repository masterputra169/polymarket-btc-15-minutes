/**
 * ═══ Volatility & Session Awareness Engine ═══
 *
 * BTC volatility berbeda drastis per session:
 * - Asia (00-08 UTC): Low vol, range kecil ~0.05-0.15%
 * - Europe (08-16 UTC): Medium vol, mulai bergerak ~0.1-0.25%
 * - US (13-22 UTC): High vol, range besar ~0.15-0.4%
 * - Overlap EU/US (13-16 UTC): Highest vol, bisa >0.3%
 *
 * Ini mempengaruhi:
 * 1. PTB distance thresholds (0.1% di Asia = besar, di US = kecil)
 * 2. Confidence multiplier (signal di high-vol kurang reliable)
 * 3. VWAP significance (VWAP distance artinya berbeda per session)
 */

/**
 * Detect current BTC trading session and return volatility profile.
 * @param {Date} [now] - current time (defaults to now)
 * @returns {Object} session profile
 */
export function getVolatilityProfile(now = new Date()) {
  const h = now.getUTCHours();

  // Session detection
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 8 && h < 16;
  const inUs = h >= 13 && h < 22;
  const inOverlap = inEurope && inUs; // 13-16 UTC

  if (inOverlap) {
    return {
      session: 'EU/US Overlap',
      volatility: 'very_high',
      // PTB distance: 0.3% in overlap is "normal" so need bigger move to be confident
      ptbThresholds: { strong: 0.005, moderate: 0.0025, slight: 0.001 },
      // Signals slightly less reliable in high vol
      confidenceMultiplier: 0.90,
      // Typical 15-min range in this session
      expectedRangePct: 0.003,
      label: '🔥 EU/US Overlap (Highest Vol)',
    };
  }

  if (inUs) {
    return {
      session: 'US',
      volatility: 'high',
      ptbThresholds: { strong: 0.004, moderate: 0.002, slight: 0.0008 },
      confidenceMultiplier: 0.93,
      expectedRangePct: 0.0025,
      label: '🇺🇸 US Session (High Vol)',
    };
  }

  if (inEurope) {
    return {
      session: 'Europe',
      volatility: 'medium',
      ptbThresholds: { strong: 0.003, moderate: 0.0015, slight: 0.0006 },
      confidenceMultiplier: 1.0,
      expectedRangePct: 0.0018,
      label: '🇪🇺 Europe Session (Med Vol)',
    };
  }

  if (inAsia) {
    return {
      session: 'Asia',
      volatility: 'low',
      // In Asia, 0.1% move is significant! Lower thresholds
      ptbThresholds: { strong: 0.002, moderate: 0.001, slight: 0.0004 },
      // Signals MORE reliable in low vol (less noise)
      confidenceMultiplier: 1.10,
      expectedRangePct: 0.001,
      label: '🌏 Asia Session (Low Vol)',
    };
  }

  // Off-hours (22-00 UTC)
  return {
    session: 'Off-hours',
    volatility: 'very_low',
    ptbThresholds: { strong: 0.0015, moderate: 0.0008, slight: 0.0003 },
    confidenceMultiplier: 1.10,
    expectedRangePct: 0.0008,
    label: '🌙 Off-hours (Very Low Vol)',
  };
}

/**
 * Compute realized volatility from recent candles.
 * Uses standard deviation of returns.
 * @param {number[]} closes - close prices
 * @param {number} [lookback=15] - number of candles
 * @returns {{ realizedVol: number|null, realizedVolPct: number|null, isAboveExpected: boolean }}
 */
export function computeRealizedVol(closes, lookback = 15) {
  if (!closes || closes.length < lookback + 1) {
    return { realizedVol: null, realizedVolPct: null, isAboveExpected: false };
  }

  const recent = closes.slice(-lookback - 1);
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    if (recent[i - 1] > 0) {
      returns.push((recent[i] - recent[i - 1]) / recent[i - 1]);
    }
  }

  if (returns.length === 0) {
    return { realizedVol: null, realizedVolPct: null, isAboveExpected: false };
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Scale to 15-min window (sqrt of number of periods)
  const vol15m = stdDev * Math.sqrt(lookback);

  const profile = getVolatilityProfile();

  return {
    realizedVol: stdDev,
    realizedVolPct: vol15m,
    // L2: vol15m is stdDev-scaled (~1σ), expectedRangePct is a range (~2-3σ).
    // Old: vol15m > range * 1.5 → almost never true (comparing σ to 1.5× range).
    // Fix: compare σ to half the expected range (≈ 1σ equivalent).
    isAboveExpected: vol15m > profile.expectedRangePct * 0.5,
  };
}