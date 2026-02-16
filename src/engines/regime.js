/**
 * ═══ Market Regime Detection v2 ═══
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
 * Detect the current market regime.
 * @param {Object} params
 * @param {number} params.price - current price
 * @param {number|null} params.vwap - current VWAP
 * @param {number|null} params.vwapSlope - VWAP slope (per candle)
 * @param {number|null} params.vwapCrossCount - # of VWAP crosses in lookback
 * @param {number|null} params.volumeRecent - recent volume sum
 * @param {number|null} params.volumeAvg - average volume
 * @returns {{ regime: string, confidence: number, label: string }}
 */
export function detectRegime({ price, vwap, vwapSlope, vwapCrossCount, volumeRecent, volumeAvg }) {
  let regime = 'moderate';
  let confidence = 0.5;
  let label = 'Moderate';
  let direction = null; // 'UP', 'DOWN', or null (non-directional)

  const hasVwap = vwap !== null && vwap !== undefined && price !== null && price !== undefined;
  const hasSlope = vwapSlope !== null && vwapSlope !== undefined;
  const hasVolume = volumeRecent !== null && volumeAvg !== null && volumeAvg > 0;

  if (!hasVwap || vwap === 0) return { regime, confidence, label, direction };

  const vwapDist = Math.abs(price - vwap) / vwap;
  const volumeRatio = hasVolume ? volumeRecent / volumeAvg : 1;
  // Normalize slope to percentage of VWAP (raw slope is $/candle, varies with BTC price)
  const normalizedAbsSlope = hasSlope && vwap > 0 ? Math.abs(vwapSlope) / vwap : 0;

  // ═══ CHOPPY: Many VWAP crosses + price near VWAP ═══
  // v3: Raised cross threshold 3→4, dist 0.0015→0.002 (3 crosses too aggressive)
  if (vwapCrossCount !== null && vwapCrossCount >= 4 && vwapDist < 0.002) {
    regime = 'choppy';
    confidence = 0.3 + Math.min(vwapCrossCount / 8, 0.4);
    label = `Choppy (${vwapCrossCount} crosses)`;
    return { regime, confidence, label, direction };
  }

  // ═══ TRENDING: Price far from VWAP + directional slope ═══
  // v3: Normalized slope to % of VWAP (raw $/candle was always > 0.05 for BTC → false trending)
  if (vwapDist > 0.0008 && normalizedAbsSlope > 0.00005) {
    const volBoost = volumeRatio > 1.2 ? 0.10 : 0;
    regime = 'trending';
    confidence = Math.min(0.6 + vwapDist * 200 + volBoost, 0.95);
    // M3: Use dead zone for slope direction — near-zero slope should fall back to price vs VWAP
    // to avoid random direction flips from noise (e.g. slope +0.00005 * vwap ≈ 0).
    const slopeSignificant = hasSlope && normalizedAbsSlope > 0.0001; // 0.01% of VWAP per candle
    direction = slopeSignificant ? (vwapSlope > 0 ? 'UP' : 'DOWN') : (price > vwap ? 'UP' : 'DOWN');
    label = `Trending ${direction}`;
    return { regime, confidence, label, direction };
  }

  // Also trending if very far from VWAP regardless of slope (weaker — no slope confirmation)
  if (vwapDist > 0.002) {
    regime = 'trending';
    confidence = Math.min(0.50 + vwapDist * 80, 0.75); // lower cap: no slope = less certain
    direction = price > vwap ? 'UP' : 'DOWN';
    label = `Trending ${direction} (distance)`;
    return { regime, confidence, label, direction };
  }

  // ═══ MEAN REVERTING: Price near VWAP, low slope, few crosses ═══
  if (vwapDist < 0.0005 && normalizedAbsSlope < 0.00003 && (vwapCrossCount === null || vwapCrossCount < 3)) {
    regime = 'mean_reverting';
    confidence = 0.5;
    label = 'Mean Reverting';
    return { regime, confidence, label, direction };
  }

  // ═══ DEFAULT: Moderate ═══
  return { regime, confidence, label, direction };
}