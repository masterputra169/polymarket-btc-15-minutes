import { describe, test, expect } from 'vitest';
import {
  isBadTick,
  computeMicroprice,
  bayesianWinRate,
  logit,
  sigmoid,
  computeHurstExponent,
  computeEwmaVolatility,
  computeHalfLife,
  maxBetForRiskOfRuin,
  gammaSizingDampener,
  binomialZTest,
  bonferroniAlpha,
  familyWiseErrorRate,
  expectedMaxNoiseSharpe,
  expiryScaledVol,
  standardNormalCdf,
} from '../quantMath.ts';

describe('QuantMath Engine', () => {
  describe('isBadTick (Formula 1.5)', () => {
    const rolling = [80000, 80005, 79995, 80010, 80000, 79990, 80000, 80005, 80010, 79995];

    test('accepts normal price movement within 3 sigma', () => {
      expect(isBadTick(80015, rolling, 6.0)).toBe(false);
      expect(isBadTick(79985, rolling, 6.0)).toBe(false);
    });

    test('rejects flash glitch outlier exceeding 6 sigma', () => {
      // Mean ~80000, std ~7.6, so 81000 is >130 sigma!
      expect(isBadTick(81000, rolling, 6.0)).toBe(true);
      expect(isBadTick(78000, rolling, 6.0)).toBe(true);
    });

    test('handles edge cases safely (empty rolling, negative, NaN)', () => {
      expect(isBadTick(80000, [], 6.0)).toBe(false);
      expect(isBadTick(NaN, rolling, 6.0)).toBe(true);
      expect(isBadTick(-100, rolling, 6.0)).toBe(true);
    });
  });

  describe('computeMicroprice (Formula 6.2)', () => {
    test('equals midpoint when quantities are balanced', () => {
      // Bid 0.50 (qty 100), Ask 0.52 (qty 100) -> Microprice 0.51
      expect(computeMicroprice(0.50, 0.52, 100, 100)).toBeCloseTo(0.51, 4);
    });

    test('tilts toward ask when bids are heavy (bullish pressure)', () => {
      // Bid 0.50 (qty 900), Ask 0.52 (qty 100) -> Microprice (0.50*100 + 0.52*900)/1000 = 0.518
      expect(computeMicroprice(0.50, 0.52, 900, 100)).toBeCloseTo(0.518, 4);
    });

    test('tilts toward bid when asks are heavy (bearish pressure)', () => {
      // Bid 0.50 (qty 100), Ask 0.52 (qty 900) -> Microprice (0.50*900 + 0.52*100)/1000 = 0.502
      expect(computeMicroprice(0.50, 0.52, 100, 900)).toBeCloseTo(0.502, 4);
    });

    test('handles nulls or empty books', () => {
      expect(computeMicroprice(null, 0.52, 100, 100)).toBeNull();
      expect(computeMicroprice(0.50, 0.52, 0, 0)).toBeCloseTo(0.51, 4);
    });
  });

  describe('bayesianWinRate (Formula 4.5)', () => {
    test('shrinks small samples toward the 60% prior (alpha=12, beta=8)', () => {
      // Prior mean = 12 / 20 = 0.60
      expect(bayesianWinRate(0, 0)).toBeCloseTo(0.60, 4);

      // 3 wins in 3 trades -> instead of 100%, Bayes says (12+3)/(20+3) = 15/23 = 65.2%
      expect(bayesianWinRate(3, 0)).toBeCloseTo(15 / 23, 4);

      // 3 losses in 3 trades -> instead of 0%, Bayes says 12 / 23 = 52.2%
      expect(bayesianWinRate(0, 3)).toBeCloseTo(12 / 23, 4);
    });

    test('converges toward sample win rate as N becomes large', () => {
      // 700 wins in 1000 trades -> (12+700)/(20+1000) = 712/1020 = 69.8%
      expect(bayesianWinRate(700, 300)).toBeCloseTo(712 / 1020, 3);
    });
  });

  describe('logit & sigmoid (Formula C-1 / Mod 1.1)', () => {
    test('transforms probabilities symmetrically around 0.50', () => {
      expect(logit(0.50)).toBeCloseTo(0.0, 4);
      expect(sigmoid(0.0)).toBeCloseTo(0.50, 4);

      expect(logit(0.80)).toBeCloseTo(Math.log(4), 4);
      expect(logit(0.20)).toBeCloseTo(-Math.log(4), 4);

      // Inverse relationship
      expect(sigmoid(logit(0.65))).toBeCloseTo(0.65, 4);
      expect(sigmoid(logit(0.35))).toBeCloseTo(0.35, 4);
    });
  });

  describe('computeHurstExponent (Formula 3.4)', () => {
    test('detects strong persistent trend (H > 0.55)', () => {
      // Geometric random walk with strong positive drift and noise
      const trendPrices: number[] = [100];
      let p = 100;
      for (let i = 1; i < 64; i++) {
        const shock = (i % 3 === 0 ? 0.002 : 0.006);
        p *= (1 + shock);
        trendPrices.push(p);
      }
      const H = computeHurstExponent(trendPrices);
      expect(H).not.toBeNull();
      expect(H!).toBeGreaterThan(0.55);
    });

    test('detects mean-reversion (H < 0.45)', () => {
      // Oscillating sawtooth mean-reverting series
      const mrPrices: number[] = [];
      for (let i = 0; i < 64; i++) {
        mrPrices.push(100 + (i % 2 === 0 ? 2 : -2));
      }
      const H = computeHurstExponent(mrPrices);
      expect(H).not.toBeNull();
      expect(H!).toBeLessThan(0.45);
    });

    test('returns null for insufficient data', () => {
      expect(computeHurstExponent([100, 101, 102])).toBeNull();
    });
  });

  describe('computeEwmaVolatility (Formula 1.3)', () => {
    test('calculates dynamic volatility responding to recent returns', () => {
      const returns = [0.001, -0.002, 0.001, -0.001, 0.002, 0.05, -0.04];
      const vol = computeEwmaVolatility(returns, 0.94);
      expect(vol).not.toBeNull();
      expect(vol!).toBeGreaterThan(0.01);
    });
  });

  describe('computeHalfLife (Formula C-4 / Mod 3.3)', () => {
    test('estimates finite half-life for mean-reverting series', () => {
      // AR(1) process reverting from 120 toward 100 with noise: y_t - 100 = 0.7 * (y_{t-1} - 100)
      const prices: number[] = [120];
      for (let i = 1; i < 50; i++) {
        const noise = (i % 2 === 0 ? 0.5 : -0.5);
        prices.push(100 + (prices[i - 1] - 100) * 0.7 + noise);
      }
      const hl = computeHalfLife(prices);
      expect(hl).not.toBeNull();
      expect(hl!).toBeGreaterThan(0);
      expect(hl!).toBeLessThan(10);
    });
  });

  describe('maxBetForRiskOfRuin (Formula 7.5)', () => {
    test('caps bet size so ruin probability is under 0.5%', () => {
      const bankroll = 32.75;
      const maxBet = maxBetForRiskOfRuin(bankroll, 0.58, 0.005);
      // N_min ~ 16.4 -> max bet ~$1.99
      expect(maxBet).toBeGreaterThan(1.50);
      expect(maxBet).toBeLessThan(2.20);
    });
  });

  describe('gammaSizingDampener (Formula C-7 / Mod 5.4)', () => {
    test('dampens size as timeLeftMin approaches 0', () => {
      expect(gammaSizingDampener(10)).toBe(1.0);
      expect(gammaSizingDampener(5)).toBe(1.0);
      expect(gammaSizingDampener(2.5)).toBeCloseTo(Math.sqrt(0.5), 2);
      expect(gammaSizingDampener(0)).toBe(0);
    });
  });

  describe('binomialZTest (Formula C-11 / Mod 8.2)', () => {
    test('detects statistical significance when win rate is far above breakeven', () => {
      // 70 wins in 100 trades with breakeven at 60%
      const res = binomialZTest(70, 100, 0.60);
      expect(res).not.toBeNull();
      expect(res!.z).toBeCloseTo((0.70 - 0.60) / Math.sqrt(0.60 * 0.40 / 100), 2); // ~2.04
      expect(res!.significant95).toBe(true);
      expect(res!.pValue).toBeLessThan(0.05);
    });

    test('is not significant when win rate is near breakeven', () => {
      // 61 wins in 100 trades with breakeven at 60%
      const res = binomialZTest(61, 100, 0.60);
      expect(res!.significant95).toBe(false);
      expect(res!.pValue).toBeGreaterThan(0.05);
    });
  });

  describe('Multiple testing & Noise math (Formulas 8.3 & 8.4)', () => {
    test('bonferroniAlpha adjusts threshold', () => {
      expect(bonferroniAlpha(0.05, 10)).toBe(0.005);
    });

    test('familyWiseErrorRate calculates false discovery risk', () => {
      // 20 trials at 5% -> 1 - 0.95^20 ~ 64.1%
      expect(familyWiseErrorRate(0.05, 20)).toBeCloseTo(0.6415, 3);
    });

    test('expectedMaxNoiseSharpe computes noise hurdle', () => {
      // 1000 trials with sigma=1.0 -> sqrt(2*ln(1000)) ~ 3.71
      expect(expectedMaxNoiseSharpe(1000, 1.0)).toBeCloseTo(Math.sqrt(2 * Math.log(1000)), 2);
    });
  });

  describe('expiryScaledVol (Formula C-2)', () => {
    test('scales per-second volatility to remaining window seconds', () => {
      // $2/sec over 100 seconds -> 2 * sqrt(100) = $20
      expect(expiryScaledVol(2, 100)).toBe(20);
    });
  });
});
