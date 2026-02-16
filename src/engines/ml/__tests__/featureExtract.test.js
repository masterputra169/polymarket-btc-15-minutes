/**
 * featureExtract unit tests.
 *
 * Tests feature extraction correctness: null handling, division-by-zero guards,
 * MACD field names (v8a bug regression), one-hot encoding, engineered features.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the state module so we can control modelVersion
vi.mock('../state.js', () => ({
  BASE_FEATURES: 54,
  ENGINEERED_FEATURES: 25,
  MAX_FEATURES: 79,
  modelVersion: 2,  // v2 enables engineered features
  featureNameToIdx: null,
}));

import { extractLiveFeaturesInPlace, featureBuf, computeEngineeredFeaturesInPlace } from '../featureExtract.js';
import { FI } from '../featureMap.js';

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function makeDefaultInput(overrides = {}) {
  return {
    price: 100000,
    priceToBeat: 99900,
    rsi: 55,
    rsiSlope: 0.02,
    macd: { hist: 0.001, line: 0.002 },
    vwap: 99950,
    vwapSlope: 0.001,
    heikenColor: 'green',
    heikenCount: 3,
    delta1m: 50,
    delta3m: 120,
    volumeRecent: 500,
    volumeAvg: 400,
    regime: 'trending',
    regimeConfidence: 0.8,
    session: 'US',
    minutesLeft: 10,
    ruleProbUp: 0.62,
    ruleConfidence: 0.7,
    vwapCrossCount: 2,
    bestEdge: 0.08,
    multiTfAgreement: true,
    failedVwapReclaim: false,
    bbWidth: 0.02,
    bbPercentB: 0.65,
    bbSqueeze: false,
    bbSqueezeIntensity: 0.3,
    atrPct: 0.5,
    atrRatio: 1.2,
    volDeltaBuyRatio: 0.6,
    volDeltaAccel: 0.05,
    emaDistPct: 0.002,
    emaCrossSignal: 0.5,
    stochK: 60,
    stochKD: 5,
    marketYesPrice: 0.55,
    marketPriceMomentum: 0.01,
    orderbookImbalance: 0.3,
    spreadPct: 0.02,
    momentum5CandleSlope: 0.001,
    volatilityChangeRatio: 1.2,
    priceConsistency: 0.7,
    fundingRate: { ratePct: 0.01 },
    ...overrides,
  };
}

// ────────────────────────────────────────────
// Feature count
// ────────────────────────────────────────────

describe('feature count', () => {
  it('returns exactly 79 features (54 base + 25 engineered)', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    expect(featureBuf.length).toBe(79);
  });

  it('all 79 features are populated (no undefined/NaN) with valid inputs', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    for (let i = 0; i < 79; i++) {
      expect(Number.isFinite(featureBuf[i])).toBe(true);
    }
  });
});

// ────────────────────────────────────────────
// Null/undefined input handling
// ────────────────────────────────────────────

describe('null/undefined inputs', () => {
  it('handles all-null inputs without NaN', () => {
    extractLiveFeaturesInPlace({
      price: 0, priceToBeat: null, rsi: undefined, rsiSlope: null,
      macd: null, vwap: null, vwapSlope: null,
      heikenColor: null, heikenCount: null,
      delta1m: null, delta3m: null,
      volumeRecent: 0, volumeAvg: 0,
      regime: null, regimeConfidence: null, session: null,
      minutesLeft: null, ruleProbUp: null, ruleConfidence: null,
      vwapCrossCount: null, bestEdge: null,
      multiTfAgreement: false, failedVwapReclaim: false,
      bbWidth: null, bbPercentB: null, bbSqueeze: null, bbSqueezeIntensity: null,
      atrPct: null, atrRatio: null,
      volDeltaBuyRatio: null, volDeltaAccel: null,
      emaDistPct: null, emaCrossSignal: null,
      stochK: null, stochKD: null,
      marketYesPrice: null, marketPriceMomentum: null,
      orderbookImbalance: null, spreadPct: null,
      momentum5CandleSlope: null, volatilityChangeRatio: null, priceConsistency: null,
      fundingRate: null,
    });
    for (let i = 0; i < 79; i++) {
      expect(Number.isFinite(featureBuf[i])).toBe(true);
    }
  });

  it('RSI defaults to 50/100 = 0.5 when null', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ rsi: null }));
    expect(featureBuf[FI.rsi_norm]).toBeCloseTo(0.5, 4);
  });

  it('minutesLeft defaults to 7.5/15 = 0.5 when null', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ minutesLeft: null }));
    expect(featureBuf[FI.minutes_left_norm]).toBeCloseTo(0.5, 4);
  });

  it('stochK defaults to 0.5 when null', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ stochK: null }));
    expect(featureBuf[FI.stoch_k_norm]).toBeCloseTo(0.5, 4);
  });
});

// ────────────────────────────────────────────
// MACD field names (v8a bug regression)
// ────────────────────────────────────────────

describe('MACD field names', () => {
  it('reads macd.hist (NOT macd.histogram)', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ macd: { hist: 0.123, line: 0.456 } }));
    expect(featureBuf[FI.macd_hist]).toBeCloseTo(0.123, 4);
  });

  it('reads macd.line (NOT macd.macd)', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ macd: { hist: 0.123, line: 0.456 } }));
    expect(featureBuf[FI.macd_line]).toBeCloseTo(0.456, 4);
  });

  it('macd null produces 0 for hist and line', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ macd: null }));
    expect(featureBuf[FI.macd_hist]).toBe(0);
    expect(featureBuf[FI.macd_line]).toBe(0);
  });

  it('macd with OLD field names (histogram/macd) does NOT work', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ macd: { histogram: 0.999, macd: 0.888 } }));
    // These should be 0 because the extractor reads .hist/.line, not .histogram/.macd
    expect(featureBuf[FI.macd_hist]).toBe(0);
    expect(featureBuf[FI.macd_line]).toBe(0);
  });
});

// ────────────────────────────────────────────
// Division-by-zero guards
// ────────────────────────────────────────────

describe('division-by-zero guards', () => {
  it('volumeAvg=0 → volRatio=1 (not Infinity)', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ volumeAvg: 0, volumeRecent: 100 }));
    expect(featureBuf[FI.vol_ratio_norm]).toBeCloseTo(1 / 5, 4); // volRatio=1, capped/5
  });

  it('atrPct near 0 → atrSafe clamped to 0.01 (engineered feature)', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ atrPct: 0 }));
    // featureBuf[66] = delta_1m_atr_adj = delta1m / atrSafe
    // With atrPct=0 → atrSafe=0.01 via max(atrPct, 0.01)
    expect(Number.isFinite(featureBuf[66])).toBe(true);
  });

  it('priceToBeat null → ptbDistPct=0', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ priceToBeat: null }));
    expect(featureBuf[FI.ptb_dist_pct]).toBe(0);
  });

  it('price=0 → delta1m/delta3m features are 0', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ price: 0, delta1m: 50, delta3m: 100 }));
    expect(featureBuf[FI.delta_1m_pct]).toBe(0);
    expect(featureBuf[FI.delta_3m_pct]).toBe(0);
  });
});

// ────────────────────────────────────────────
// Regime one-hot encoding
// ────────────────────────────────────────────

describe('regime one-hot', () => {
  it('trending → [1,0,0]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regime: 'trending' }));
    expect(featureBuf[FI.regime_trending]).toBe(1);
    expect(featureBuf[FI.regime_mean_reverting]).toBe(0);
    expect(featureBuf[FI.regime_moderate]).toBe(0);
  });

  it('mean_reverting → [0,1,0]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regime: 'mean_reverting' }));
    expect(featureBuf[FI.regime_trending]).toBe(0);
    expect(featureBuf[FI.regime_mean_reverting]).toBe(1);
    expect(featureBuf[FI.regime_moderate]).toBe(0);
  });

  it('choppy maps to moderate slot', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regime: 'choppy' }));
    expect(featureBuf[FI.regime_moderate]).toBe(1);
    expect(featureBuf[FI.regime_trending]).toBe(0);
  });

  it('moderate → moderate slot', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regime: 'moderate' }));
    expect(featureBuf[FI.regime_moderate]).toBe(1);
  });

  it('unknown regime → all zeros', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regime: 'weird' }));
    expect(featureBuf[FI.regime_trending]).toBe(0);
    expect(featureBuf[FI.regime_mean_reverting]).toBe(0);
    expect(featureBuf[FI.regime_moderate]).toBe(0);
  });
});

// ────────────────────────────────────────────
// Session one-hot encoding
// ────────────────────────────────────────────

describe('session one-hot', () => {
  const sessionTests = [
    ['Asia', FI.session_asia],
    ['Europe', FI.session_europe],
    ['US', FI.session_us],
    ['EU/US Overlap', FI.session_overlap],
    ['Off-hours', FI.session_offhours],
  ];
  const allSessionIndices = [FI.session_asia, FI.session_europe, FI.session_us, FI.session_overlap, FI.session_offhours];

  for (const [name, idx] of sessionTests) {
    it(`${name} → index ${idx} = 1, others = 0`, () => {
      extractLiveFeaturesInPlace(makeDefaultInput({ session: name }));
      expect(featureBuf[idx]).toBe(1);
      for (const otherIdx of allSessionIndices) {
        if (otherIdx !== idx) expect(featureBuf[otherIdx]).toBe(0);
      }
    });
  }

  it('null session → all zeros', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ session: null }));
    for (const idx of allSessionIndices) {
      expect(featureBuf[idx]).toBe(0);
    }
  });
});

// ────────────────────────────────────────────
// Engineered features
// ────────────────────────────────────────────

describe('engineered features', () => {
  it('rsi_regime_interaction = rsi * regimeConf', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ rsi: 70, regimeConfidence: 0.8 }));
    const rsiNorm = 70 / 100;
    const regConf = 0.8;
    expect(featureBuf[57]).toBeCloseTo(rsiNorm * regConf, 4);
  });

  it('delta_1m_capped clips to [-0.003, 0.003]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ delta1m: 1000, price: 100000 }));
    // delta_1m_pct = 1000/100000 = 0.01, capped to 0.003
    expect(featureBuf[54]).toBeCloseTo(0.003, 4);
  });

  it('ha_delta_agree = 1 when signs match', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ heikenColor: 'green', heikenCount: 3, delta1m: 50 }));
    expect(featureBuf[65]).toBe(1);
  });

  it('ha_delta_agree = 0 when signs differ', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ heikenColor: 'red', heikenCount: 3, delta1m: 50 }));
    expect(featureBuf[65]).toBe(0);
  });

  it('multi_indicator_agree is in [0, 1]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    expect(featureBuf[74]).toBeGreaterThanOrEqual(0);
    expect(featureBuf[74]).toBeLessThanOrEqual(1);
  });
});

// ────────────────────────────────────────────
// Index boundaries
// ────────────────────────────────────────────

describe('index boundaries', () => {
  it('feature[0] (ptb_dist_pct) populated', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    expect(Number.isFinite(featureBuf[0])).toBe(true);
  });

  it('feature[78] (imbalance_x_vol_delta) populated', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    expect(Number.isFinite(featureBuf[78])).toBe(true);
  });

  it('feature[53] (funding_rate_change) = 0 live', () => {
    extractLiveFeaturesInPlace(makeDefaultInput());
    expect(featureBuf[53]).toBe(0);
  });

  it('funding_rate_norm clamps to [-1, 1]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ fundingRate: { ratePct: 0.5 } }));
    expect(featureBuf[52]).toBe(1); // 0.5/0.1 = 5, clamped to 1
  });
});

// ────────────────────────────────────────────
// Normalization bounds
// ────────────────────────────────────────────

describe('normalization bounds', () => {
  it('ruleProbUp clamped to [0, 1]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ ruleProbUp: 1.5 }));
    expect(featureBuf[FI.rule_prob_up]).toBe(1);

    extractLiveFeaturesInPlace(makeDefaultInput({ ruleProbUp: -0.5 }));
    expect(featureBuf[FI.rule_prob_up]).toBe(0);
  });

  it('bestEdge clamped to [0, 0.5]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ bestEdge: 2 }));
    expect(featureBuf[FI.best_edge]).toBe(0.5);
  });

  it('regimeConfidence clamped to [0, 1]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ regimeConfidence: 1.5 }));
    expect(featureBuf[FI.regime_confidence]).toBe(1);
  });

  it('marketYesPrice clamped to [0.01, 0.99]', () => {
    extractLiveFeaturesInPlace(makeDefaultInput({ marketYesPrice: 0 }));
    expect(featureBuf[FI.market_yes_price]).toBe(0.01);
  });
});

// ────────────────────────────────────────────
// featureMap index constants
// ────────────────────────────────────────────

describe('featureMap FI constants', () => {
  it('has correct indices for base features', () => {
    expect(FI.ptb_dist_pct).toBe(0);
    expect(FI.rsi_norm).toBe(1);
    expect(FI.macd_hist).toBe(3);
    expect(FI.macd_line).toBe(4);
    expect(FI.funding_rate_norm).toBe(52);
    expect(FI.funding_rate_change).toBe(53);
  });
});
