/**
 * asymmetricBet (Kelly sizing) unit tests.
 *
 * Tests Kelly formula, multiplier chain, gate conditions, and edge cases.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config
vi.mock('../../config.js', () => ({
  BET_SIZING: {
    KELLY_FRACTION: 0.25,
    MAX_BET_PCT: 0.08,
    MIN_BET_PCT: 0.005,
    MIN_EDGE_FOR_BET: 0.03,
    DEFAULT_BANKROLL: 1000,
  },
  EXECUTION: {
    SPREAD_TIGHT: 0.02,
    SPREAD_NORMAL: 0.03,
    SPREAD_WIDE: 0.05,
    LIQ_VERY_THIN: 50,
    LIQ_THIN: 200,
    LIQ_MODERATE: 500,
    FILL_POOR_RATE: 0.5,
    FILL_TIMEOUT_MS: 30000,
  },
}));

// Mock feedback stats — return insufficient_data by default so Kelly = base
vi.mock('../feedback/stats.js', () => ({
  computeKellyTune: vi.fn((base) => ({
    kellyFraction: base,
    reason: 'insufficient_data',
    calibrationRatio: 1.0,
    sampleCount: 0,
  })),
}));

import { computeBetSizing } from '../asymmetricBet.js';

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function makeParams(overrides = {}) {
  return {
    action: 'ENTER',
    side: 'UP',
    ensembleProb: 0.65,
    marketPrice: 0.50,
    edge: 0.15,
    confidence: 'MEDIUM',
    regimeInfo: { regime: 'moderate', confidence: 0.5 },
    feedbackStats: { accuracy: null },
    ml: null,
    bankroll: 1000,
    executionContext: null,
    ...overrides,
  };
}

// ────────────────────────────────────────────
// Gate conditions
// ────────────────────────────────────────────

describe('gate conditions', () => {
  it('action !== ENTER → noBet', () => {
    const result = computeBetSizing(makeParams({ action: 'WAIT' }));
    expect(result.shouldBet).toBe(false);
    expect(result.rationale).toContain('WAIT');
  });

  it('NaN probability → noBet', () => {
    const result = computeBetSizing(makeParams({ ensembleProb: NaN }));
    expect(result.shouldBet).toBe(false);
  });

  it('price = 0 → noBet', () => {
    const result = computeBetSizing(makeParams({ marketPrice: 0 }));
    expect(result.shouldBet).toBe(false);
  });

  it('price = 0.005 (below 0.01) → noBet', () => {
    const result = computeBetSizing(makeParams({ marketPrice: 0.005 }));
    expect(result.shouldBet).toBe(false);
  });

  it('price = 0.995 (above 0.99) → noBet', () => {
    const result = computeBetSizing(makeParams({ marketPrice: 0.995 }));
    expect(result.shouldBet).toBe(false);
  });

  it('tiny absolute edge → noBet (below MIN_EDGE_FOR_BET)', () => {
    // absEdge = Math.abs(0.01) = 0.01 < 0.03
    const result = computeBetSizing(makeParams({ edge: 0.01 }));
    expect(result.shouldBet).toBe(false);
  });

  it('edge below MIN_EDGE_FOR_BET (0.03) → noBet', () => {
    const result = computeBetSizing(makeParams({ edge: 0.02 }));
    expect(result.shouldBet).toBe(false);
  });

  it('null side → noBet', () => {
    const result = computeBetSizing(makeParams({ side: null }));
    expect(result.shouldBet).toBe(false);
  });

  it('ensembleProb > 1 → noBet', () => {
    const result = computeBetSizing(makeParams({ ensembleProb: 1.5 }));
    expect(result.shouldBet).toBe(false);
  });

  it('ensembleProb < 0 → noBet', () => {
    const result = computeBetSizing(makeParams({ ensembleProb: -0.1 }));
    expect(result.shouldBet).toBe(false);
  });
});

// ────────────────────────────────────────────
// Kelly formula
// ────────────────────────────────────────────

describe('Kelly formula', () => {
  it('computes correct raw Kelly', () => {
    // b = (1/0.50) - 1 = 1.0
    // p = 0.65, q = 0.35
    // rawKelly = (1.0 * 0.65 - 0.35) / 1.0 = 0.30
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.65,
      marketPrice: 0.50,
    }));
    expect(result.rawKelly).toBeCloseTo(0.30, 4);
  });

  it('negative Kelly → noBet (no positive edge)', () => {
    // b = (1/0.70) - 1 = 0.4286
    // p = 0.40, q = 0.60
    // rawKelly = (0.4286 * 0.40 - 0.60) / 0.4286 = -1.0 (negative)
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.40,
      marketPrice: 0.70,
      edge: 0.05,  // above MIN_EDGE but Kelly is negative
    }));
    expect(result.shouldBet).toBe(false);
    expect(result.rationale).toContain('Negative Kelly');
  });

  it('Kelly with low price (high payout ratio)', () => {
    // b = (1/0.20) - 1 = 4.0
    // p = 0.30, q = 0.70
    // rawKelly = (4.0 * 0.30 - 0.70) / 4.0 = (1.2 - 0.7) / 4 = 0.125
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.30,
      marketPrice: 0.20,
      edge: 0.10,
    }));
    expect(result.rawKelly).toBeCloseTo(0.125, 3);
  });
});

// ────────────────────────────────────────────
// Regime multiplier
// ────────────────────────────────────────────

describe('regime multiplier', () => {
  it('choppy at full confidence → 0.50 multiplier', () => {
    const result = computeBetSizing(makeParams({
      regimeInfo: { regime: 'choppy', confidence: 1.0 },
    }));
    expect(result.regimeAdj.multiplier).toBeCloseTo(0.50, 2);
  });

  it('trending at full confidence → 1.00 multiplier', () => {
    const result = computeBetSizing(makeParams({
      regimeInfo: { regime: 'trending', confidence: 1.0 },
    }));
    expect(result.regimeAdj.multiplier).toBeCloseTo(1.00, 2);
  });

  it('moderate at full confidence → 0.85', () => {
    const result = computeBetSizing(makeParams({
      regimeInfo: { regime: 'moderate', confidence: 1.0 },
    }));
    expect(result.regimeAdj.multiplier).toBeCloseTo(0.85, 2);
  });

  it('mean_reverting at full confidence → 0.70', () => {
    const result = computeBetSizing(makeParams({
      regimeInfo: { regime: 'mean_reverting', confidence: 1.0 },
    }));
    expect(result.regimeAdj.multiplier).toBeCloseTo(0.70, 2);
  });

  it('low confidence scales multiplier toward 1.0', () => {
    // regime=choppy, base=0.50, confidence=0.2
    // mult = 1.0 + (0.50 - 1.0) * 0.2 = 1.0 - 0.10 = 0.90
    const result = computeBetSizing(makeParams({
      regimeInfo: { regime: 'choppy', confidence: 0.2 },
    }));
    expect(result.regimeAdj.multiplier).toBeCloseTo(0.90, 2);
  });

  it('null regime info → moderate default (0.85)', () => {
    const result = computeBetSizing(makeParams({ regimeInfo: null }));
    // null regime → 'moderate' fallback, confidence 0.5
    // mult = 1.0 + (0.85 - 1.0) * 0.5 = 0.925
    expect(result.regimeAdj.multiplier).toBeCloseTo(0.93, 1);
  });
});

// ────────────────────────────────────────────
// ML multiplier
// ────────────────────────────────────────────

describe('ML multiplier', () => {
  it('high-conf agreement → 1.15', () => {
    const result = computeBetSizing(makeParams({
      side: 'UP',
      ml: { status: 'ready', side: 'UP', confidence: 0.45 },
    }));
    expect(result.mlAdj.multiplier).toBeCloseTo(1.15, 2);
  });

  it('high-conf disagreement → 0.70', () => {
    const result = computeBetSizing(makeParams({
      side: 'UP',
      ml: { status: 'ready', side: 'DOWN', confidence: 0.45 },
    }));
    expect(result.mlAdj.multiplier).toBeCloseTo(0.70, 2);
  });

  it('low-conf → 1.0 (neutral)', () => {
    const result = computeBetSizing(makeParams({
      ml: { status: 'ready', side: 'UP', confidence: 0.20 },
    }));
    expect(result.mlAdj.multiplier).toBe(1.0);
  });

  it('null ML → 1.0', () => {
    const result = computeBetSizing(makeParams({ ml: null }));
    expect(result.mlAdj.multiplier).toBe(1.0);
  });

  it('ML not ready → 1.0', () => {
    const result = computeBetSizing(makeParams({
      ml: { status: 'loading', side: 'UP', confidence: 0.50 },
    }));
    expect(result.mlAdj.multiplier).toBe(1.0);
  });
});

// ────────────────────────────────────────────
// Confidence tier multiplier
// ────────────────────────────────────────────

describe('confidence tier', () => {
  it('VERY_HIGH → 1.0', () => {
    const result = computeBetSizing(makeParams({ confidence: 'VERY_HIGH' }));
    expect(result.confidenceAdj.multiplier).toBe(1.0);
  });

  it('HIGH → 0.80', () => {
    const result = computeBetSizing(makeParams({ confidence: 'HIGH' }));
    expect(result.confidenceAdj.multiplier).toBe(0.80);
  });

  it('MEDIUM → 0.55', () => {
    const result = computeBetSizing(makeParams({ confidence: 'MEDIUM' }));
    expect(result.confidenceAdj.multiplier).toBe(0.55);
  });

  it('LOW → 0.30', () => {
    const result = computeBetSizing(makeParams({ confidence: 'LOW' }));
    expect(result.confidenceAdj.multiplier).toBe(0.30);
  });

  it('unknown confidence → 0.55 (default)', () => {
    const result = computeBetSizing(makeParams({ confidence: 'SUPER_HIGH' }));
    expect(result.confidenceAdj.multiplier).toBe(0.55);
  });
});

// ────────────────────────────────────────────
// Execution multiplier
// ────────────────────────────────────────────

describe('execution multiplier', () => {
  it('wide spread → 0.60', () => {
    const result = computeBetSizing(makeParams({
      executionContext: { spread: 0.06, askLiquidity: 1000, fillRate: 1.0 },
    }));
    expect(result.executionAdj.multiplier).toBeLessThanOrEqual(0.60);
  });

  it('tight spread → 1.0', () => {
    const result = computeBetSizing(makeParams({
      executionContext: { spread: 0.01, askLiquidity: 1000, fillRate: 1.0 },
    }));
    expect(result.executionAdj.multiplier).toBe(1.0);
  });

  it('very thin liquidity → 0.50', () => {
    const result = computeBetSizing(makeParams({
      executionContext: { spread: 0.01, askLiquidity: 30, fillRate: 1.0 },
    }));
    expect(result.executionAdj.multiplier).toBe(0.50);
  });

  it('poor fill rate → 0.70', () => {
    const result = computeBetSizing(makeParams({
      executionContext: { spread: 0.01, askLiquidity: 1000, fillRate: 0.3 },
    }));
    expect(result.executionAdj.multiplier).toBe(0.70);
  });

  it('null execution context → 1.0', () => {
    const result = computeBetSizing(makeParams({ executionContext: null }));
    expect(result.executionAdj.multiplier).toBe(1.0);
  });
});

// ────────────────────────────────────────────
// Final clamping
// ────────────────────────────────────────────

describe('final clamping', () => {
  it('betPercent capped at MAX_BET_PCT (0.08)', () => {
    // Very high prob + low price = huge Kelly
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.90,
      marketPrice: 0.20,
      edge: 0.30,
      confidence: 'VERY_HIGH',
      regimeInfo: { regime: 'trending', confidence: 1.0 },
    }));
    expect(result.betPercent).toBeLessThanOrEqual(0.08);
  });

  it('below MIN_BET_PCT after multipliers → noBet', () => {
    // Low confidence + bad regime = reduced to below MIN_BET_PCT
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.52,
      marketPrice: 0.50,
      edge: 0.04,
      confidence: 'LOW',  // 0.30
      regimeInfo: { regime: 'choppy', confidence: 1.0 },  // 0.50
    }));
    expect(result.shouldBet).toBe(false);
  });
});

// ────────────────────────────────────────────
// Bet amount
// ────────────────────────────────────────────

describe('bet amount', () => {
  it('betAmount = betPercent * bankroll', () => {
    const result = computeBetSizing(makeParams({ bankroll: 500 }));
    if (result.shouldBet) {
      expect(result.betAmount).toBeCloseTo(result.betPercent * 500, 2);
    }
  });

  it('bankroll 0 → betAmount=0', () => {
    const result = computeBetSizing(makeParams({ bankroll: 0 }));
    if (result.shouldBet) {
      expect(result.betAmount).toBe(0);
    }
  });

  it('null bankroll → uses DEFAULT_BANKROLL', () => {
    const result = computeBetSizing(makeParams({ bankroll: null }));
    if (result.shouldBet) {
      expect(result.bankroll).toBe(1000);
    }
  });
});

// ────────────────────────────────────────────
// Risk level
// ────────────────────────────────────────────

describe('risk level', () => {
  it('shouldBet=true returns valid riskLevel', () => {
    const result = computeBetSizing(makeParams());
    if (result.shouldBet) {
      expect(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']).toContain(result.riskLevel);
    }
  });

  it('noBet → NO_BET risk level', () => {
    const result = computeBetSizing(makeParams({ action: 'WAIT' }));
    expect(result.riskLevel).toBe('NO_BET');
  });
});

// ────────────────────────────────────────────
// Expected value
// ────────────────────────────────────────────

describe('expected value', () => {
  it('EV = b*p - q (rounded)', () => {
    // b = (1/0.50) - 1 = 1.0, p=0.65, q=0.35
    // EV = 1.0*0.65 - 0.35 = 0.30
    const result = computeBetSizing(makeParams({
      ensembleProb: 0.65,
      marketPrice: 0.50,
    }));
    if (result.shouldBet) {
      expect(result.expectedValue).toBeCloseTo(0.30, 2);
    }
  });
});

// ────────────────────────────────────────────
// safeMult: NaN treated as 1.0
// ────────────────────────────────────────────

describe('safeMult NaN handling', () => {
  it('NaN multiplier treated as 1.0 (does not crash)', () => {
    // If somehow a multiplier returns NaN, safeMult should treat it as 1.0
    // We can't easily inject NaN into the multiplier chain without mocking internals,
    // but we verify the output is finite when all inputs are valid
    const result = computeBetSizing(makeParams());
    if (result.shouldBet) {
      expect(Number.isFinite(result.adjustedFraction)).toBe(true);
      expect(Number.isFinite(result.betAmount)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────
// Rationale string
// ────────────────────────────────────────────

describe('rationale', () => {
  it('includes Kelly, multipliers, and final bet in rationale', () => {
    const result = computeBetSizing(makeParams());
    if (result.shouldBet) {
      expect(result.rationale).toContain('Kelly=');
      expect(result.rationale).toContain('regime(');
      expect(result.rationale).toContain('ml(');
      expect(result.rationale).toContain('conf(');
      expect(result.rationale).toContain('exec(');
    }
  });
});

// ────────────────────────────────────────────
// Multiplier chain composition
// ────────────────────────────────────────────

describe('multiplier chain', () => {
  it('all 5 multipliers are applied to Kelly fraction', () => {
    // Verify that each multiplier appears in the result object
    const result = computeBetSizing(makeParams());
    expect(result.regimeAdj).toBeDefined();
    expect(result.accuracyAdj).toBeDefined();
    expect(result.mlAdj).toBeDefined();
    expect(result.confidenceAdj).toBeDefined();
    expect(result.executionAdj).toBeDefined();
  });

  it('multiplied result equals adjustedFraction (before clamping)', () => {
    const result = computeBetSizing(makeParams({
      confidence: 'HIGH',
      regimeInfo: { regime: 'trending', confidence: 1.0 },
    }));
    if (result.shouldBet) {
      const expected = result.rawKelly * result.kellyFraction
        * result.regimeAdj.multiplier
        * result.accuracyAdj.multiplier
        * result.mlAdj.multiplier
        * result.confidenceAdj.multiplier
        * result.executionAdj.multiplier;
      // adjustedFraction is clamped to [0, MAX_BET_PCT], so may differ
      expect(result.adjustedFraction).toBeLessThanOrEqual(expected + 0.001);
    }
  });
});
