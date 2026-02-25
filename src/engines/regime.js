/**
 * ═══ Market Regime Detection v3 ═══
 *
 * v3: Added price return autocorrelation (ACF lag-1).
 *   ACF > 0.3  → momentum (strengthens trending)
 *   ACF < -0.2 → mean-reverting (reversals follow moves)
 *   ACF ~ 0    → random walk (strengthens choppy / skip signal)
 *
 * v2: More sensitive thresholds.
 * v1 was 100% "moderate" because vwapSlope threshold (0.5) was too high.
 *
 * Regimes:
 *   trending       → boost confidence 1.25x (strong directional move)
 *   choppy         → dampen confidence 0.60x (oscillating, no direction)
 *   mean_reverting → slight dampen 0.80x (returning to VWAP)
 *   moderate       → neutral 1.00x (default)
 */

/**
 * Compute lag-1 autocorrelation of price returns.
 * ACF(1) = Σ((r[t] - μ)(r[t-1] - μ)) / Σ((r[t] - μ)²)
 *
 * @param {number[]} closes - array of close prices (at least 10 needed)
 * @returns {number|null} ACF lag-1 value (-1 to +1), or null if insufficient data
 */
export function computeAutocorrelation(closes) {
  if (!closes || closes.length < 12) return null;

  // Use last 30 candles (or all if fewer)
  const n = Math.min(closes.length, 30);
  const start = closes.length - n;

  // Compute returns
  const returns = [];
  for (let i = start + 1; i < closes.length; i++) {
    if (closes[i - 1] === 0) continue;
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  if (returns.length < 8) return null;

  // Mean of returns
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

  // Compute ACF lag-1
  let numerator = 0;
  let denominator = 0;
  for (let i = 1; i < returns.length; i++) {
    numerator += (returns[i] - mean) * (returns[i - 1] - mean);
    denominator += (returns[i] - mean) ** 2;
  }

  if (denominator === 0) return 0;
  const acf = numerator / denominator;

  // Clamp to [-1, 1] for safety
  return Math.max(-1, Math.min(1, acf));
}

/**
 * Detect the current market regime.
 *
 * H4 FIX: Enriched with ATR ratio and volume ratio to reduce the "moderate"
 * dead zone. ATR > 1.2 confirms trending; ATR < 0.8 confirms choppy.
 * Lower VWAP-distance thresholds also narrow the moderate zone.
 *
 * @param {Object} params
 * @param {number} params.price - current price
 * @param {number|null} params.vwap - current VWAP
 * @param {number|null} params.vwapSlope - VWAP slope (per candle)
 * @param {number|null} params.vwapCrossCount - # of VWAP crosses in lookback
 * @param {number|null} params.volumeRecent - recent volume sum
 * @param {number|null} params.volumeAvg - average volume
 * @param {number|null} [params.atrRatio] - ATR ratio (current / avg), >1 = expanding vol
 * @param {number|null} [params.volumeRatioOverride] - explicit volume ratio if pre-computed
 * @param {number|null} [params.acf] - lag-1 autocorrelation of price returns (-1 to +1)
 * @returns {{ regime: string, confidence: number, label: string, direction: string|null, acf: number|null }}
 */
export function detectRegime({ price, vwap, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg, atrRatio = null, volumeRatioOverride = null, acf = null }) {
  let regime = 'moderate';
  let confidence = 0.5;
  let label = 'Moderate';
  let direction = null; // 'UP', 'DOWN', or null (non-directional)

  const hasVwap = vwap !== null && vwap !== undefined && price !== null && price !== undefined;
  const hasSlope = vwapSlope !== null && vwapSlope !== undefined;
  const hasVolume = volumeRecent !== null && volumeAvg !== null && volumeAvg > 0;
  const hasAtr = atrRatio !== null && Number.isFinite(atrRatio);
  const hasAcf = acf !== null && Number.isFinite(acf);

  if (!hasVwap || vwap === 0) return { regime, confidence, label, direction, acf };

  const vwapDist = Math.abs(price - vwap) / vwap;
  const volumeRatio = volumeRatioOverride ?? (hasVolume ? volumeRecent / volumeAvg : 1);
  // Normalize slope to percentage of VWAP (raw slope is $/candle, varies with BTC price)
  const normalizedAbsSlope = hasSlope && vwap > 0 ? Math.abs(vwapSlope) / vwap : 0;

  // ═══ CHOPPY: Many VWAP crosses + price near VWAP ═══
  // v3: Raised cross threshold 3→4, dist 0.0015→0.002 (3 crosses too aggressive)
  // H4: ATR < 0.8 strengthens choppy confidence (low volatility = range-bound)
  // v3 ACF: |ACF| < 0.15 → random walk confirms choppy (+0.08)
  if (vwapCrossCount !== null && vwapCrossCount >= 4 && vwapDist < 0.002) {
    const atrChoppyBoost = (hasAtr && atrRatio < 0.8) ? 0.10 : 0;
    const acfChoppyBoost = (hasAcf && Math.abs(acf) < 0.15) ? 0.08 : 0;
    regime = 'choppy';
    confidence = Math.min(0.3 + Math.min(vwapCrossCount / 8, 0.4) + atrChoppyBoost + acfChoppyBoost, 0.90);
    label = `Choppy (${vwapCrossCount} crosses${atrChoppyBoost > 0 ? ', low ATR' : ''}${acfChoppyBoost > 0 ? ', ACF~0' : ''})`;
    return { regime, confidence, label, direction, acf };
  }

  // H4: ATR-confirmed choppy — low ATR + low slope + near VWAP, even without many crosses
  // This catches range-bound markets that haven't had enough crosses yet.
  if (hasAtr && atrRatio < 0.7 && vwapDist < 0.001 && normalizedAbsSlope < 0.00005) {
    const acfChoppyBoost = (hasAcf && Math.abs(acf) < 0.15) ? 0.08 : 0;
    regime = 'choppy';
    confidence = Math.min(0.45 + (0.7 - atrRatio) * 0.5 + acfChoppyBoost, 0.90);
    label = `Choppy (low ATR ${atrRatio.toFixed(2)}${acfChoppyBoost > 0 ? ', ACF~0' : ''})`;
    return { regime, confidence, label, direction, acf };
  }

  // ═══ TRENDING: Price far from VWAP + directional slope ═══
  // v3: Normalized slope to % of VWAP (raw $/candle was always > 0.05 for BTC → false trending)
  // H4: Lower VWAP distance threshold when ATR confirms (0.0008 → 0.0005 with ATR > 1.2)
  const trendDistThreshold = (hasAtr && atrRatio > 1.2) ? 0.0005 : 0.0008;
  const trendSlopeThreshold = (hasAtr && atrRatio > 1.2) ? 0.00003 : 0.00005;

  // v3 ACF: ACF > 0.3 confirms momentum (+0.08), ACF < -0.2 opposes trend (-0.05)
  if (vwapDist > trendDistThreshold && normalizedAbsSlope > trendSlopeThreshold) {
    const volBoost = volumeRatio > 1.2 ? 0.10 : 0;
    // H4: ATR > 1.2 boosts trending confidence
    const atrTrendBoost = (hasAtr && atrRatio > 1.2) ? Math.min((atrRatio - 1.2) * 0.3, 0.15) : 0;
    const acfTrendBoost = hasAcf ? (acf > 0.3 ? 0.08 : (acf < -0.2 ? -0.05 : 0)) : 0;
    regime = 'trending';
    confidence = Math.min(Math.max(0.6 + vwapDist * 200 + volBoost + atrTrendBoost + acfTrendBoost, 0.30), 0.95);
    // M3: Use dead zone for slope direction — near-zero slope should fall back to price vs VWAP
    // to avoid random direction flips from noise (e.g. slope +0.00005 * vwap ~ 0).
    const slopeSignificant = hasSlope && normalizedAbsSlope > 0.0001; // 0.01% of VWAP per candle
    direction = slopeSignificant ? (vwapSlope > 0 ? 'UP' : 'DOWN') : (price > vwap ? 'UP' : 'DOWN');
    label = `Trending ${direction}${atrTrendBoost > 0 ? ' (ATR confirmed)' : ''}${acfTrendBoost > 0 ? ' (momentum)' : ''}`;
    return { regime, confidence, label, direction, acf };
  }

  // Also trending if very far from VWAP regardless of slope (weaker — no slope confirmation)
  if (vwapDist > 0.002) {
    const acfTrendBoost = hasAcf ? (acf > 0.3 ? 0.06 : (acf < -0.2 ? -0.05 : 0)) : 0;
    regime = 'trending';
    confidence = Math.min(Math.max(0.50 + vwapDist * 80 + acfTrendBoost, 0.30), 0.75);
    direction = price > vwap ? 'UP' : 'DOWN';
    label = `Trending ${direction} (distance)${acfTrendBoost > 0 ? ' (momentum)' : ''}`;
    return { regime, confidence, label, direction, acf };
  }

  // H4: ATR-confirmed trending — high ATR + directional slope, even if VWAP distance is small
  // (catches early-stage trends before price has moved far from VWAP)
  if (hasAtr && atrRatio > 1.3 && normalizedAbsSlope > 0.00005 && volumeRatio > 1.0) {
    const acfTrendBoost = hasAcf ? (acf > 0.3 ? 0.08 : (acf < -0.2 ? -0.05 : 0)) : 0;
    regime = 'trending';
    confidence = Math.min(Math.max(0.50 + (atrRatio - 1.0) * 0.2 + (volumeRatio - 1.0) * 0.1 + acfTrendBoost, 0.30), 0.80);
    const slopeSignificant = hasSlope && normalizedAbsSlope > 0.0001;
    direction = slopeSignificant ? (vwapSlope > 0 ? 'UP' : 'DOWN') : (price > vwap ? 'UP' : 'DOWN');
    label = `Trending ${direction} (ATR breakout)${acfTrendBoost > 0 ? ' (momentum)' : ''}`;
    return { regime, confidence, label, direction, acf };
  }

  // ═══ MEAN REVERTING: Price near VWAP, low slope, few crosses ═══
  // H4: Slightly relaxed distance threshold (0.0005 → 0.0008) to catch more mean-reversion
  // v3 ACF: ACF < -0.2 confirms mean-reversion (+0.10), ACF > 0.3 opposes (-0.05)
  if (vwapDist < 0.0008 && normalizedAbsSlope < 0.00003 && (vwapCrossCount === null || vwapCrossCount < 3)) {
    const acfMrBoost = hasAcf ? (acf < -0.2 ? 0.10 : (acf > 0.3 ? -0.05 : 0)) : 0;
    regime = 'mean_reverting';
    confidence = Math.min(Math.max(0.5 + (hasAtr && atrRatio < 1.0 ? 0.10 : 0) + acfMrBoost, 0.30), 0.85);
    label = `Mean Reverting${acfMrBoost > 0 ? ' (ACF confirmed)' : ''}`;
    return { regime, confidence, label, direction, acf };
  }

  // ═══ DEFAULT: Moderate ═══
  return { regime, confidence, label, direction, acf };
}