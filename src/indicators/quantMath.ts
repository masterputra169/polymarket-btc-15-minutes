/**
 * ═══ Quantitative Mathematical Engine (QuantMath) ═══
 *
 * Implements high-value quantitative formulas (Opsi B & Opsi C) adapted
 * specifically for high-frequency binary option trading on Polymarket BTC 15m.
 *
 * Formulas included:
 *  1. Bad Tick Filter (6-Sigma outlier rejection)
 *  2. Microprice (orderbook quantity-weighted fair price)
 *  3. Bayesian Beta Win Rate Smoothing
 *  4. Logit & Sigmoid Transforms (Log-odds for binary probabilities)
 *  5. Hurst Exponent (Rescaled Range R/S analysis for regime detection)
 *  6. EWMA Volatility (RiskMetrics exponential weighting)
 *  7. Half-Life Ornstein-Uhlenbeck (Mean-reversion decay)
 *  8. Risk of Ruin Dynamic Guard (Kelly bankroll unit bounding)
 *  9. Late-Phase Gamma Sizing Dampener (Non-linear expiry dampening)
 * 10. Binomial Proportion Z-Test (Statistical proof of edge over breakeven)
 * 11. Multiple Testing Correction & Data Mining Noise Discount
 * 12. Expiry-Scaled Volatility
 */

/** Standard normal CDF approximation (Abramowitz & Stegun 7.1.26 via erf; |err| < 1.5e-7). */
export function standardNormalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Bad Tick Filter (Formula 1.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a tick is an anomalous outlier (> 6 sigma) from a rolling window.
 * Protects feeds against temporary flash-glitches that could trigger false signals.
 */
export function isBadTick(
  currentPrice: number,
  rollingPrices: readonly number[],
  thresholdSigma = 5.0
): boolean {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return true;
  if (!rollingPrices || rollingPrices.length < 5) return false;

  const sorted = [...rollingPrices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const devs = sorted.map(p => Math.abs(p - median)).sort((a, b) => a - b);
  const mad = devs.length % 2 === 0 ? (devs[mid - 1] + devs[mid]) / 2 : devs[mid];
  const robustSigma = 1.4826 * mad;

  if (robustSigma < 1e-4) {
    // Negligible dispersion -> instantaneous move > 0.5% without support is a bad tick
    return Math.abs(currentPrice - median) / median > 0.005;
  }

  const z = Math.abs(currentPrice - median) / robustSigma;
  return z > thresholdSigma;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Orderbook Microprice (Formula 6.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quantity-weighted fair microprice.
 * P_micro = (P_bid * Q_ask + P_ask * Q_bid) / (Q_bid + Q_ask)
 *
 * When bids are heavy (Q_bid >> Q_ask), price tilts toward Ask.
 * When asks are heavy (Q_ask >> Q_bid), price tilts toward Bid.
 */
export function computeMicroprice(
  bestBid: number | null | undefined,
  bestAsk: number | null | undefined,
  bidLiquidity: number,
  askLiquidity: number
): number | null {
  if (bestBid == null || bestAsk == null) return null;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (bestBid <= 0 || bestAsk <= 0) return null;

  const totalQty = (bidLiquidity > 0 ? bidLiquidity : 0) + (askLiquidity > 0 ? askLiquidity : 0);
  if (totalQty <= 0) return (bestBid + bestAsk) / 2;

  return (bestBid * askLiquidity + bestAsk * bidLiquidity) / totalQty;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Bayesian Beta Win Rate Smoothing (Formula 4.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bayesian win rate estimator with Beta(alpha, beta) conjugate prior.
 * p_hat = (alpha + wins) / (alpha + beta + total)
 *
 * Default prior: alpha=12, beta=8 (mean = 12/20 = 60%, pseudo-sample size = 20 trades).
 * Prevents overreacting to tiny sample streaks (e.g. 2 wins in 2 trades != 100%).
 */
export function bayesianWinRate(
  wins: number,
  losses: number,
  priorAlpha = 12,
  priorBeta = 8
): number {
  const w = Math.max(0, wins);
  const l = Math.max(0, losses);
  return (priorAlpha + w) / (priorAlpha + priorBeta + w + l);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Logit & Sigmoid Probability Transforms (Formula C-1 / Mod 1.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log-Odds (logit) transform: logit(p) = ln(p / (1 - p)).
 * Clamped to [-10, 10] to avoid infinity at p=0 or p=1.
 */
export function logit(p: number): number {
  const clamped = Math.max(1e-5, Math.min(1 - 1e-5, p));
  return Math.log(clamped / (1 - clamped));
}

/**
 * Standard logistic sigmoid: sigmoid(x) = 1 / (1 + exp(-x)).
 */
export function sigmoid(x: number): number {
  if (x > 40) return 1.0;
  if (x < -40) return 0.0;
  return 1 / (1 + Math.exp(-x));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Hurst Exponent (Formula 3.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes Hurst Exponent using Rescaled Range (R/S) analysis.
 * H < 0.45: Mean-Reverting
 * 0.45 <= H <= 0.55: Random Walk / Choppy
 * H > 0.55: Trending / Persistent Momentum
 *
 * @param prices - Series of prices (at least 24 points)
 * @returns Hurst Exponent in [0.01, 0.99] or null if insufficient data
 */
export function computeHurstExponent(prices: readonly number[]): number | null {
  if (!prices || prices.length < 24) return null;

  const N = prices.length;
  // Select sub-period lengths (powers or divisors)
  const subPeriods = [8, 12, 16, Math.floor(N / 2), N].filter((s, idx, arr) => s >= 8 && s <= N && arr.indexOf(s) === idx);
  if (subPeriods.length < 3) return null;

  const logN: number[] = [];
  const logRS: number[] = [];

  for (const tau of subPeriods) {
    const numChunks = Math.floor(N / tau);
    if (numChunks < 1) continue;

    let rsSum = 0;
    let validChunks = 0;

    for (let c = 0; c < numChunks; c++) {
      const chunk = prices.slice(c * tau, (c + 1) * tau);
      const mean = chunk.reduce((a, b) => a + b, 0) / tau;

      // Cumulative deviate
      let cum = 0;
      let minCum = 0;
      let maxCum = 0;
      let varSum = 0;

      for (let i = 0; i < tau; i++) {
        const diff = chunk[i] - mean;
        cum += diff;
        if (cum > maxCum) maxCum = cum;
        if (cum < minCum) minCum = cum;
        varSum += diff * diff;
      }

      const R = maxCum - minCum;
      const S = Math.sqrt(varSum / tau);

      if (S > 1e-9 && R > 0) {
        rsSum += R / S;
        validChunks++;
      }
    }

    if (validChunks > 0) {
      logN.push(Math.log(tau));
      logRS.push(Math.log(rsSum / validChunks));
    }
  }

  if (logN.length < 3) return null;

  // Linear regression of log(RS) on log(N)
  const meanX = logN.reduce((a, b) => a + b, 0) / logN.length;
  const meanY = logRS.reduce((a, b) => a + b, 0) / logRS.length;

  let num = 0;
  let den = 0;
  for (let i = 0; i < logN.length; i++) {
    const dx = logN[i] - meanX;
    num += dx * (logRS[i] - meanY);
    den += dx * dx;
  }

  if (den === 0) return 0.50;
  const H = num / den;

  // Bounded between 0.01 and 0.99
  return Math.max(0.01, Math.min(0.99, H));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. EWMA Volatility (Formula 1.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exponentially Weighted Moving Average (EWMA) volatility.
 * sigma^2_t = lambda * sigma^2_{t-1} + (1 - lambda) * r^2_t
 * Standard RiskMetrics default: lambda = 0.94.
 */
export function computeEwmaVolatility(returns: readonly number[], lambda = 0.94): number | null {
  if (!returns || returns.length < 5) return null;

  // Initialize with variance of first 5 returns
  let initVar = 0;
  for (let i = 0; i < 5; i++) {
    initVar += returns[i] * returns[i];
  }
  let varT = initVar / 5;

  for (let i = 5; i < returns.length; i++) {
    const r2 = returns[i] * returns[i];
    varT = lambda * varT + (1 - lambda) * r2;
  }

  return Math.sqrt(varT);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Half-Life of Mean Reversion (Formula C-4 / Mod 3.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes Ornstein-Uhlenbeck half-life from price series.
 * Delta y_t = alpha + lambda * y_{t-1} + epsilon
 * half-life = -ln(2) / lambda (when lambda < 0).
 *
 * @returns Half-life in number of bars, or null if non-reverting / trending.
 */
export function computeHalfLife(prices: readonly number[]): number | null {
  if (!prices || prices.length < 15) return null;

  const y = prices;
  const dy: number[] = [];
  const lagY: number[] = [];

  for (let i = 1; i < y.length; i++) {
    dy.push(y[i] - y[i - 1]);
    lagY.push(y[i - 1]);
  }

  const n = dy.length;
  const meanLag = lagY.reduce((a, b) => a + b, 0) / n;
  const meanDy = dy.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const diff = lagY[i] - meanLag;
    num += diff * (dy[i] - meanDy);
    den += diff * diff;
  }

  if (den === 0) return null;
  const lambda = num / den;

  // Mean-reversion requires lambda < 0
  if (lambda >= 0) return null;

  const halfLife = -Math.LN2 / lambda;
  return Number.isFinite(halfLife) && halfLife > 0 ? halfLife : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Risk of Ruin Dynamic Guard (Formula 7.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates max bet amount such that the theoretical probability of ruin <= maxRuinProb.
 * Ruin = ((1 - p) / p)^N <= maxRuinProb
 * N_min = ln(maxRuinProb) / ln((1 - p) / p)
 * maxBet = bankroll / N_min
 *
 * @param bankroll Current bankroll in USD
 * @param conservativeWinRate Expected conservative win rate (e.g. 0.58)
 * @param maxRuinProb Target maximum probability of ruin (default 0.005 = 0.5%)
 */
export function maxBetForRiskOfRuin(
  bankroll: number,
  conservativeWinRate = 0.58,
  maxRuinProb = 0.005
): number {
  if (bankroll <= 0) return 0;
  const p = Math.max(0.51, Math.min(0.95, conservativeWinRate));
  const oddsRatio = (1 - p) / p;
  const lnRatio = Math.log(oddsRatio);

  if (lnRatio >= 0) return bankroll * 0.01; // No edge -> 1% absolute floor
  const nMin = Math.log(maxRuinProb) / lnRatio;
  return Math.max(0.50, bankroll / Math.max(1, nMin));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Late-Phase Gamma Sizing Dampener (Formula C-7 / Mod 5.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Non-linear bet size dampener as expiry approaches.
 * In the final minutes of a binary option, Gamma approaches infinity near strike.
 * Multiplier = min(1.0, sqrt(timeLeftMin / refMin))
 */
export function gammaSizingDampener(timeLeftMin: number, refMin = 5.0): number {
  if (!Number.isFinite(timeLeftMin) || timeLeftMin <= 0) return 0;
  if (timeLeftMin >= refMin) return 1.0;
  return Math.max(0.35, Math.sqrt(timeLeftMin / refMin));
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Binomial Proportion Z-Test (Formula C-11 / Mod 8.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface BinomialTestResult {
  z: number;
  pValue: number;
  significant95: boolean;
  significant99: boolean;
}

/**
 * One-sided Binomial Z-test: tests if realised win rate is statistically
 * significantly greater than the breakeven win rate pStar.
 * Z = (p_hat - pStar) / sqrt(pStar * (1 - pStar) / n)
 */
export function binomialZTest(
  wins: number,
  total: number,
  pStar: number
): BinomialTestResult | null {
  if (total < 10 || pStar <= 0 || pStar >= 1) return null;
  const pHat = wins / total;
  const se = Math.sqrt((pStar * (1 - pStar)) / total);
  if (se <= 0) return null;

  const z = (pHat - pStar) / se;
  const pValue = 1 - standardNormalCdf(z);

  return {
    z,
    pValue,
    significant95: z >= 1.645, // p < 0.05
    significant99: z >= 2.326, // p < 0.01
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Multiple Testing Correction & Data Mining Noise (Formula 8.3 & 8.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bonferroni-adjusted alpha threshold: alpha / N.
 */
export function bonferroniAlpha(alpha: number, numHypotheses: number): number {
  return alpha / Math.max(1, numHypotheses);
}

/**
 * Family-Wise Error Rate (probability of at least 1 false positive):
 * FWER = 1 - (1 - alpha)^N
 */
export function familyWiseErrorRate(alpha: number, numHypotheses: number): number {
  return 1 - Math.pow(1 - alpha, Math.max(1, numHypotheses));
}

/**
 * Best-of-N Noise Discount:
 * Expected maximum Sharpe ratio obtained purely from data mining noise:
 * E[max SR] = sigma_SR * sqrt(2 * ln(N))
 */
export function expectedMaxNoiseSharpe(numTrials: number, sigmaSR = 1.0): number {
  if (numTrials <= 1) return 0;
  return sigmaSR * Math.sqrt(2 * Math.log(numTrials));
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Expiry-Scaled Volatility (Formula C-2 / Mod 1.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scales 1-second spot volatility to the total remaining variance over T seconds left.
 * sigma_T = sigma_1s * sqrt(secondsLeft)
 */
export function expiryScaledVol(sigmaPerSecond: number, secondsLeft: number): number {
  if (sigmaPerSecond <= 0 || secondsLeft <= 0) return 0;
  return sigmaPerSecond * Math.sqrt(secondsLeft);
}
