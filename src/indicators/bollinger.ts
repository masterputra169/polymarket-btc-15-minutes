/**
 * Bollinger Bands with Squeeze Detection
 *
 * - BB Width (bandwidth): measures volatility envelope
 * - BB %B: where price sits relative to bands (0=lower, 1=upper)
 * - Squeeze: when bandwidth contracts below its own moving average
 *   → signals imminent breakout, highly predictive for 15-min moves
 */

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
  width: number;
  percentB: number;
  squeeze: boolean;
  squeezeIntensity: number;
}

/**
 * Compute Bollinger Bands for the last candle.
 * @param {number[]} closes - Array of closing prices
 * @param {number} period - BB period (default 20)
 * @param {number} stdMult - Standard deviation multiplier (default 2)
 * @returns {{ upper, middle, lower, width, percentB, squeeze, squeezeIntensity } | null}
 */
export function computeBollingerBands(
  closes: number[] | null | undefined,
  period = 20,
  stdMult = 2
): BollingerBandsResult | null {
  if (!closes || closes.length < period) return null;

  const len = closes.length;

  // SMA (middle band)
  let sum = 0;
  for (let i = len - period; i < len; i++) sum += closes[i];
  const middle = sum / period;

  // Standard deviation
  let sqSum = 0;
  for (let i = len - period; i < len; i++) {
    const diff = closes[i] - middle;
    sqSum += diff * diff;
  }
  const std = Math.sqrt(sqSum / period);

  const upper = middle + stdMult * std;
  const lower = middle - stdMult * std;
  const price = closes[len - 1];

  // Bandwidth (width) = (upper - lower) / middle
  const width = middle !== 0 ? (upper - lower) / middle : 0;

  // %B = (price - lower) / (upper - lower)
  const range = upper - lower;
  const percentB = range !== 0 ? (price - lower) / range : 0.5;

  // ═══ Squeeze Detection ═══
  // Compute bandwidth for last N periods and check if current is below average
  const squeezeLookback = Math.min(50, len - period);
  let squeeze = false;
  let squeezeIntensity = 0; // 0-1, higher = tighter squeeze

  if (squeezeLookback >= 10) {
    const widths: number[] = [];
    for (let offset = 0; offset < squeezeLookback; offset++) {
      const end = len - offset;
      const start = end - period;
      if (start < 0) break;

      let s = 0;
      for (let i = start; i < end; i++) s += closes[i];
      const m = s / period;

      let sq = 0;
      for (let i = start; i < end; i++) {
        const d = closes[i] - m;
        sq += d * d;
      }
      const sd = Math.sqrt(sq / period);
      const w = m !== 0 ? (2 * stdMult * sd) / m : 0;
      widths.push(w);
    }

    // Average bandwidth
    let avgWidth = 0;
    for (let i = 0; i < widths.length; i++) avgWidth += widths[i];
    avgWidth /= widths.length;

    // Squeeze = current width below 75% of average
    squeeze = width < avgWidth * 0.75;

    // Intensity: how tight (0 = no squeeze, 1 = very tight)
    squeezeIntensity = avgWidth > 0
      ? Math.max(0, Math.min(1, 1 - (width / avgWidth)))
      : 0;
  }

  return {
    upper,
    middle,
    lower,
    width,        // bandwidth as ratio (e.g. 0.012 = 1.2%)
    percentB,     // 0-1 range, >1 = above upper, <0 = below lower
    squeeze,      // boolean
    squeezeIntensity, // 0-1
  };
}
