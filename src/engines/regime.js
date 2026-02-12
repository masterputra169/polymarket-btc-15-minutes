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

  const hasVwap = vwap !== null && vwap !== undefined && price !== null && price !== undefined;
  const hasSlope = vwapSlope !== null && vwapSlope !== undefined;
  const hasVolume = volumeRecent !== null && volumeAvg !== null && volumeAvg > 0;

  if (!hasVwap) return { regime, confidence, label };

  const vwapDist = Math.abs(price - vwap) / vwap;
  const volumeRatio = hasVolume ? volumeRecent / volumeAvg : 1;
  const absSlope = hasSlope ? Math.abs(vwapSlope) : 0;

  // ═══ CHOPPY: Many VWAP crosses + price near VWAP ═══
  // v2: Lowered cross threshold from 4→3, dist from 0.001→0.0015
  if (vwapCrossCount !== null && vwapCrossCount >= 3 && vwapDist < 0.0015) {
    regime = 'choppy';
    confidence = 0.3 + Math.min(vwapCrossCount / 8, 0.4);
    label = `Choppy (${vwapCrossCount} crosses)`;
    return { regime, confidence, label };
  }

  // ═══ TRENDING: Price far from VWAP + directional slope ═══
  // v2: Lowered slope threshold from 0.5→0.05 (slope is tiny per-candle value)
  if (vwapDist > 0.0008 && absSlope > 0.05) {
    const volBoost = volumeRatio > 1.2 ? 0.10 : 0;
    regime = 'trending';
    confidence = Math.min(0.6 + vwapDist * 200 + volBoost, 0.95);
    label = (hasSlope && vwapSlope > 0) ? 'Trending UP' : 'Trending DOWN';
    return { regime, confidence, label };
  }

  // Also trending if very far from VWAP regardless of slope (weaker — no slope confirmation)
  if (vwapDist > 0.002) {
    regime = 'trending';
    confidence = Math.min(0.50 + vwapDist * 80, 0.75); // lower cap: no slope = less certain
    label = price > vwap ? 'Trending UP (distance)' : 'Trending DOWN (distance)';
    return { regime, confidence, label };
  }

  // ═══ MEAN REVERTING: Price near VWAP, low slope, few crosses ═══
  if (vwapDist < 0.0005 && absSlope < 0.03 && (vwapCrossCount === null || vwapCrossCount < 3)) {
    regime = 'mean_reverting';
    confidence = 0.5;
    label = 'Mean Reverting';
    return { regime, confidence, label };
  }

  // ═══ DEFAULT: Moderate ═══
  return { regime, confidence, label };
}