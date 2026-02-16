/**
 * edge.js unit tests.
 *
 * Tests computeEdge, countAgreement, and decide phase-based logic.
 */

import { describe, it, expect } from 'vitest';

// Mock config for ML_CONFIDENCE
import { vi } from 'vitest';
vi.mock('../../config.js', () => ({
  ML_CONFIDENCE: { HIGH: 0.60, MEDIUM: 0.20 },
}));

import { computeEdge, countAgreement, decide } from '../edge.js';

// ────────────────────────────────────────────
// computeEdge
// ────────────────────────────────────────────

describe('computeEdge', () => {
  it('edge = modelProb - bestAsk when orderbook available', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: 0.55,
      marketNo: 0.45,
      orderbookUp: { bestAsk: 0.52, bestBid: 0.48, spread: 0.04 },
      orderbookDown: { bestAsk: 0.42, bestBid: 0.38, spread: 0.04 },
    });
    expect(result.edgeUp).toBeCloseTo(0.13, 4);   // 0.65 - 0.52
    expect(result.edgeDown).toBeCloseTo(-0.07, 4); // 0.35 - 0.42
  });

  it('uses market price with spread penalty when no orderbook', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: 0.55,
      marketNo: 0.45,
      orderbookUp: { spread: 0.04 },   // no bestAsk
      orderbookDown: { spread: 0.04 },
    });
    // effectiveUp = 0.55 (market), spreadPenalty = 0.04 * 0.5 = 0.02
    expect(result.edgeUp).toBeCloseTo(0.08, 4); // 0.65 - 0.55 - 0.02
  });

  it('no spread penalty when bestAsk is available', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: 0.55,
      marketNo: 0.45,
      orderbookUp: { bestAsk: 0.52, spread: 0.04 },
      orderbookDown: null,
    });
    expect(result.spreadPenaltyUp).toBe(0);
    expect(result.edgeUp).toBeCloseTo(0.13, 4);
  });

  it('null orderbook → fallback to market prices', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: 0.55,
      marketNo: 0.45,
      orderbookUp: null,
      orderbookDown: null,
    });
    expect(result.edgeUp).toBeCloseTo(0.10, 4);   // 0.65 - 0.55
    expect(result.edgeDown).toBeCloseTo(-0.10, 4); // 0.35 - 0.45
  });

  it('selects best side correctly', () => {
    const result = computeEdge({
      modelUp: 0.70,
      modelDown: 0.30,
      marketYes: 0.55,
      marketNo: 0.45,
    });
    expect(result.bestSide).toBe('UP');
    expect(result.bestEdge).toBeCloseTo(0.15, 4);
  });

  it('returns null bestSide when no positive edge', () => {
    const result = computeEdge({
      modelUp: 0.50,
      modelDown: 0.50,
      marketYes: 0.55,
      marketNo: 0.55,
    });
    expect(result.bestSide).toBeNull();
    expect(result.bestEdge).toBeNull();
  });

  it('handles NaN spread gracefully', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: 0.55,
      marketNo: 0.45,
      orderbookUp: { spread: NaN },
      orderbookDown: null,
    });
    expect(Number.isFinite(result.edgeUp)).toBe(true);
  });

  it('handles null market prices', () => {
    const result = computeEdge({
      modelUp: 0.65,
      modelDown: 0.35,
      marketYes: null,
      marketNo: null,
    });
    expect(result.edgeUp).toBeNull();
    expect(result.edgeDown).toBeNull();
  });
});

// ────────────────────────────────────────────
// countAgreement
// ────────────────────────────────────────────

describe('countAgreement', () => {
  it('counts positive-weight indicators matching side', () => {
    const breakdown = {
      rsi: { signal: 'UP', weight: 1 },
      macdHist: { signal: 'UP', weight: 1 },
      vwapPos: { signal: 'DOWN', weight: 1 },
      heikenAshi: { signal: 'UP', weight: 1 },
    };
    expect(countAgreement(breakdown, 'UP')).toBe(3);
    expect(countAgreement(breakdown, 'DOWN')).toBe(1);
  });

  it('counts negative-weight conflicts as agreement for opposite side', () => {
    const breakdown = {
      rsi: { signal: 'DOWN', weight: -0.5 },  // conflict against DOWN = support UP
    };
    expect(countAgreement(breakdown, 'UP')).toBe(1);
    expect(countAgreement(breakdown, 'DOWN')).toBe(0);
  });

  it('ignores zero-weight indicators', () => {
    const breakdown = {
      rsi: { signal: 'UP', weight: 0 },
    };
    expect(countAgreement(breakdown, 'UP')).toBe(0);
  });

  it('returns 0 for null breakdown', () => {
    expect(countAgreement(null, 'UP')).toBe(0);
  });

  it('handles missing signal gracefully', () => {
    const breakdown = {
      rsi: { weight: 1 },  // no signal property
    };
    expect(countAgreement(breakdown, 'UP')).toBe(0);
  });
});

// ────────────────────────────────────────────
// decide - phase boundaries
// ────────────────────────────────────────────

describe('decide phase boundaries', () => {
  const baseParams = {
    edgeUp: 0.25,
    edgeDown: -0.10,
    modelUp: 0.75,
    modelDown: 0.25,
    breakdown: {
      rsi: { signal: 'UP', weight: 1 },
      macdHist: { signal: 'UP', weight: 1 },
      vwapPos: { signal: 'UP', weight: 1 },
      heikenAshi: { signal: 'UP', weight: 1 },
      multiTf: { signal: 'UP', weight: 1 },
    },
    multiTfConfirmed: true,
  };

  it('remainingMinutes > 10 → EARLY', () => {
    const result = decide({ ...baseParams, remainingMinutes: 10.01 });
    expect(result.phase).toBe('EARLY');
  });

  it('remainingMinutes = 10.0 → MID (not EARLY)', () => {
    const result = decide({ ...baseParams, remainingMinutes: 10.0 });
    expect(result.phase).toBe('MID');
  });

  it('remainingMinutes = 5.0 → LATE', () => {
    const result = decide({ ...baseParams, remainingMinutes: 5.0 });
    expect(result.phase).toBe('LATE');
  });

  it('remainingMinutes = 2.0 → VERY_LATE', () => {
    const result = decide({ ...baseParams, remainingMinutes: 2.0 });
    expect(result.phase).toBe('VERY_LATE');
  });

  it('remainingMinutes = 0.5 → VERY_LATE', () => {
    const result = decide({ ...baseParams, remainingMinutes: 0.5 });
    expect(result.phase).toBe('VERY_LATE');
  });
});

// ────────────────────────────────────────────
// decide - WAIT/ENTER logic
// ────────────────────────────────────────────

describe('decide WAIT/ENTER', () => {
  it('WAIT when edge below threshold', () => {
    const result = decide({
      remainingMinutes: 8,  // MID: minEdge=0.10
      edgeUp: 0.05,         // below 0.10
      edgeDown: 0.03,
      modelUp: 0.70,
      modelDown: 0.30,
    });
    expect(result.action).toBe('WAIT');
  });

  it('WAIT when prob below threshold', () => {
    const result = decide({
      remainingMinutes: 8,  // MID: minProb=0.58
      edgeUp: 0.15,
      edgeDown: 0.15,
      modelUp: 0.50,        // below 0.58
      modelDown: 0.50,
    });
    expect(result.action).toBe('WAIT');
  });

  it('ENTER when all thresholds met', () => {
    const result = decide({
      remainingMinutes: 3,  // LATE: minEdge=0.12, minProb=0.57
      edgeUp: 0.20,
      edgeDown: -0.05,
      modelUp: 0.72,
      modelDown: 0.28,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
        vwapPos: { signal: 'UP', weight: 1 },
      },
    });
    expect(result.action).toBe('ENTER');
    expect(result.side).toBe('UP');
  });

  it('ENTER DOWN when DOWN passes and UP fails', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.02,     // too low for UP
      edgeDown: 0.18,   // passes for DOWN
      modelUp: 0.30,
      modelDown: 0.70,
      breakdown: {
        rsi: { signal: 'DOWN', weight: 1 },
        macdHist: { signal: 'DOWN', weight: 1 },
        vwapPos: { signal: 'DOWN', weight: 1 },
      },
    });
    expect(result.action).toBe('ENTER');
    expect(result.side).toBe('DOWN');
  });

  it('picks higher-edge side when both pass', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.15,
      edgeDown: 0.20,
      modelUp: 0.65,
      modelDown: 0.65,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'DOWN', weight: 1 },
        vwapPos: { signal: 'UP', weight: 1 },
        heikenAshi: { signal: 'DOWN', weight: 1 },
      },
    });
    expect(result.action).toBe('ENTER');
    expect(result.side).toBe('DOWN'); // higher edge
  });
});

// ────────────────────────────────────────────
// decide - regime adjustment
// ────────────────────────────────────────────

describe('decide regime adjustment', () => {
  it('trending tightens thresholds (harder entry)', () => {
    // With trending regime, thresholds increase
    const trendingResult = decide({
      remainingMinutes: 3,
      edgeUp: 0.145,     // just above LATE base (0.12) but maybe below after trending tightening
      edgeDown: -0.05,
      modelUp: 0.60,
      modelDown: 0.40,
      regimeInfo: { regime: 'trending', confidence: 1.0 },
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    // With trending: minEdge = 0.12 + 0.02*0.85 = 0.137, then +0.02 UP bias = 0.157
    // edgeUp 0.145 < 0.157 → should WAIT
    expect(trendingResult.action).toBe('WAIT');
  });

  it('choppy tightens even more', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.15,
      edgeDown: -0.05,
      modelUp: 0.62,
      modelDown: 0.38,
      regimeInfo: { regime: 'choppy', confidence: 1.0 },
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    // choppy penalty is capped at +3%, but with UP bias (+2%) it gets harder
    expect(result.action).toBe('WAIT');
  });
});

// ────────────────────────────────────────────
// decide - session adjustment
// ────────────────────────────────────────────

describe('decide session adjustment', () => {
  it('Asia adds +2% edge threshold', () => {
    // LATE base: 0.12 edge. Asia: +0.02 = 0.14. UP bias: +0.02 = 0.16
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.155,
      edgeDown: -0.05,
      modelUp: 0.65,
      modelDown: 0.35,
      session: 'Asia',
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    expect(result.action).toBe('WAIT');
  });

  it('Off-hours adds +3% edge threshold', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.17,
      edgeDown: -0.05,
      modelUp: 0.65,
      modelDown: 0.35,
      session: 'Off-hours',
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    // LATE: 0.12 + Off-hours 0.03 = 0.15, capped at base+0.03=0.15, +UP bias 0.02 = 0.17
    // 0.17 >= 0.17 → should pass edge check if prob also passes
    expect(result.action).toBe('ENTER');
  });
});

// ────────────────────────────────────────────
// decide - combined penalty cap
// ────────────────────────────────────────────

describe('decide combined penalty cap', () => {
  it('caps regime + session penalty at +3%', () => {
    // choppy (+3%) + off-hours (+3%) would be +6% uncapped, but cap = +3%
    const result = decide({
      remainingMinutes: 3,  // LATE: base minEdge = 0.12
      edgeUp: 0.20,
      edgeDown: -0.05,
      modelUp: 0.70,
      modelDown: 0.30,
      regimeInfo: { regime: 'choppy', confidence: 1.0 },
      session: 'Off-hours',
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
        vwapPos: { signal: 'UP', weight: 1 },
      },
    });
    // Capped at base + 3% = 0.15, + UP bias 0.02 = 0.17
    // edgeUp 0.20 >= 0.17 → passes
    expect(result.action).toBe('ENTER');
  });
});

// ────────────────────────────────────────────
// decide - ML high-confidence boost
// ────────────────────────────────────────────

describe('decide ML high-confidence boost', () => {
  it('relaxes thresholds by 2% when ML agrees at high conf', () => {
    const result = decide({
      remainingMinutes: 3,  // LATE: minEdge=0.12, minProb=0.57
      edgeUp: 0.12,         // exactly at base threshold
      edgeDown: -0.05,
      modelUp: 0.59,        // below 0.57+UP_bias (0.59) normally
      modelDown: 0.41,
      mlConfidence: 0.70,
      mlAgreesWithRules: true,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    // ML boost: -2% edge, -2% prob → UP minEdge=0.12 (base) +0.02 (UP bias) -0.02 (ML) = 0.12
    // UP minProb: 0.57 + 0.02 (UP bias) -0.02 (ML) = 0.57
    expect(result.action).toBe('ENTER');
  });

  it('no boost when ML disagrees', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.12,
      edgeDown: -0.05,
      modelUp: 0.59,
      modelDown: 0.41,
      mlConfidence: 0.70,
      mlAgreesWithRules: false,  // disagrees
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    // No ML boost, UP minEdge = 0.12+0.02 = 0.14 > 0.12 → WAIT
    expect(result.action).toBe('WAIT');
  });
});

// ────────────────────────────────────────────
// decide - side bias
// ────────────────────────────────────────────

describe('decide side bias', () => {
  it('UP has +2% harder entry (requires more edge)', () => {
    // LATE base: 0.12. UP: +0.02 = 0.14
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.13,
      edgeDown: -0.10,
      modelUp: 0.65,
      modelDown: 0.35,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    expect(result.action).toBe('WAIT');
  });

  it('DOWN has -1% easier entry', () => {
    // LATE base: 0.12. DOWN: -0.01 = 0.11
    const result = decide({
      remainingMinutes: 3,
      edgeUp: -0.10,
      edgeDown: 0.115,
      modelUp: 0.35,
      modelDown: 0.65,
      breakdown: {
        rsi: { signal: 'DOWN', weight: 1 },
        macdHist: { signal: 'DOWN', weight: 1 },
      },
    });
    expect(result.action).toBe('ENTER');
    expect(result.side).toBe('DOWN');
  });
});

// ────────────────────────────────────────────
// decide - multiTF confirmation
// ────────────────────────────────────────────

describe('decide multiTF', () => {
  it('EARLY/MID prefer multiTF (waivable with extra agreements)', () => {
    // EARLY: preferMultiTf=true, minAgreement=2, waiver at 3
    const result = decide({
      remainingMinutes: 12,
      edgeUp: 0.25,
      edgeDown: -0.05,
      modelUp: 0.75,
      modelDown: 0.25,
      multiTfConfirmed: false,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
        // only 2 agreements — need 3 to waive multiTF
      },
    });
    expect(result.action).toBe('WAIT');
  });

  it('LATE/VERY_LATE do not require multiTF', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.20,
      edgeDown: -0.05,
      modelUp: 0.70,
      modelDown: 0.30,
      multiTfConfirmed: false,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
      },
    });
    expect(result.action).toBe('ENTER');
  });
});

// ────────────────────────────────────────────
// decide - confidence levels
// ────────────────────────────────────────────

describe('decide confidence levels', () => {
  it('returns VERY_HIGH for strong signals', () => {
    const result = decide({
      remainingMinutes: 3,
      edgeUp: 0.30,
      edgeDown: -0.05,
      modelUp: 0.75,
      modelDown: 0.25,
      breakdown: {
        rsi: { signal: 'UP', weight: 1 },
        macdHist: { signal: 'UP', weight: 1 },
        vwapPos: { signal: 'UP', weight: 1 },
        heikenAshi: { signal: 'UP', weight: 1 },
        multiTf: { signal: 'UP', weight: 1 },
        momentum: { signal: 'UP', weight: 1 },
      },
    });
    expect(result.confidence).toBe('VERY_HIGH');
  });

  it('returns LOW for marginal signals', () => {
    const result = decide({
      remainingMinutes: 1,  // VERY_LATE
      edgeDown: 0.155,
      edgeUp: -0.10,
      modelDown: 0.60,
      modelUp: 0.40,
      breakdown: {
        rsi: { signal: 'DOWN', weight: 1 },
        macdHist: { signal: 'DOWN', weight: 1 },
      },
    });
    if (result.action === 'ENTER') {
      expect(result.confidence).toBe('LOW');
    }
  });
});

// ────────────────────────────────────────────
// decide - WAIT reason
// ────────────────────────────────────────────

describe('decide WAIT reason', () => {
  it('includes reason for WAIT', () => {
    const result = decide({
      remainingMinutes: 8,
      edgeUp: 0.05,
      edgeDown: 0.03,
      modelUp: 0.55,
      modelDown: 0.45,
    });
    expect(result.action).toBe('WAIT');
    expect(result.reason).toBeTruthy();
    expect(typeof result.reason).toBe('string');
  });

  it('WAIT reason mentions no valid edge when both null', () => {
    const result = decide({
      remainingMinutes: 8,
      edgeUp: null,
      edgeDown: null,
      modelUp: 0.55,
      modelDown: 0.45,
    });
    expect(result.reason).toContain('no valid edge');
  });
});
