/**
 * Pure logic of backtest/ml_training/decisionTrailStudy.mts (the module lives
 * next to the study; vitest only collects bot/ and src/, hence this location).
 */
import { describe, it, expect } from 'vitest';
import {
  categorizeReason, scoreLine, soleGate, passesWithRelaxed, passesAtMlThreshold, passesMlRule, ML_RULE_CANDIDATES,
  firstPerMarket, entryPrice, breakevenWinRate, winPnlPerDollar, pnlPerDollar,
  simulateTrade, summarizeTrades, wilsonInterval, marketEndMs, stageMix,
  type TrailLine, type GateId,
} from '../../backtest/ml_training/decisionTrailCore.mts';
import { breakevenWinRate as botBreakevenWinRate } from '../src/trading/breakevenMargin.ts';
import { applyTradeFilters } from '../src/safety/tradeFilters.ts';

function line(over: Partial<TrailLine> = {}): TrailLine {
  return {
    t: 1_000, m: 'btc-updown-15m-1790305200', a: 'E', sd: 'U', mc: 0.5,
    pu: 0.6, pd: 0.4, st: 'filtered', fr: [], ...over,
  };
}

describe('categorizeReason', () => {
  const cases: Array<[string, GateId]> = [
    ['ML conf 44% < 65%', 'ml_conf'],
    ['ML conf 37% < 45% [edge 26%≥15%→relaxed]', 'ml_conf'],
    ['ML conf 50% < 70% [tilt]', 'ml_conf'],
    ['Too early: 14.8min left > 12min (wait for price discovery)', 'too_early'],
    ['Too close: 1.8min < 2min', 'too_late'],
    ['BTC too close to PTB: 0.005% < 0.020% (coin flip)', 'btc_dist'],
    ['Edge ceiling: 26% > 25% (high edge = poor WR in journal)', 'edge_ceiling'],
    ['Trending+EARLY blocked: 14.8m left > 10m (data: 7/9 EARLY losses)', 'trending_early'],
    ['Trending+low price blocked: 56c < 60c (market says 50/50, not trending)', 'trending_price'],
    ['Trending+low ML blocked: 40% < 55% (aligned trend, ML unsure)', 'trending_ml'],
    ['Entry price 81c > 75c hard cap (need 81% WR) [ultra ML active] [dry-run cap]', 'entry_ceiling'],
    ['Entry price 66c > 63c ceiling (ML 40% < 85%)', 'entry_soft_ceiling'],
    ['Entry price 45c < 50c floor', 'entry_floor'],
    ['ML dead zone: conf 77% in 75-80% band, edge 5.0% < 10% required', 'dead_zone'],
    ['LATE phase ML gate: conf 60% < 80% (4.2min left)', 'late_ml'],
    ['LATE phase ML gate: conf 50% < 55% (3.0min left) [edge 20%≥15%→relaxed]', 'late_ml'],
    ['Market 50c near 50/50 (47-53c)', 'near_5050'],
    ['Extreme price 90c outside 15-85c range', 'extreme_price'],
    ['Loss cooldown: 120s remaining', 'cooldown'],
    ['Max 1 trade(s) per market reached', 'max_trades'],
    ['Re-entry blocked: edge 5.0% < 12% (anti-revenge gate)', 'max_trades'],
    ['Wide spread: 9.0% > 8% max', 'spread'],
    ['Spread 5.0% w/ thin edge 3.0% < 8%', 'spread'],
    ['Spread widening: 4.0% > 2× baseline 1.5% (informed flow)', 'spread_widening'],
    ['VPIN 80% opposing: flow=SELL vs signal=UP (informed flow)', 'vpin'],
    ['Counter-trend: BTC dropped $250 in 1m vs UP signal', 'counter_trend'],
    ['Asia session: ML conf 60% < 80% minimum', 'time_gate'],
    ['Asia session: ML 60% < 75% required', 'time_gate'],
    ['Blackout hour: 17:00 ET (historically unprofitable)', 'time_gate'],
    ['Weekend + low ML conf 50% < 65%', 'time_gate'],
    ['Europe session blocked (BLOCKED_SESSIONS)', 'session_block'],
    ["PTB source 'chainlink_round' not exact — entry BLOCKED (Lapis0 safety: Polymarket gamma removed 2026-05-16; need exact sch…", 'ptb_source'],
    ['Sentiment: extreme fear', 'sentiment'],
    ['Macro: CPI in 5 min', 'macro'],
    ['LLM regime: bearish vs UP', 'llm'],
    ['ML degraded: 40% acc (last 20) < 45%', 'ml_degraded'],
  ];
  it.each(cases)('%s → %s', (reason, gate) => {
    expect(categorizeReason(reason)).toBe(gate);
  });

  it('sends unknown or non-string reasons to other', () => {
    expect(categorizeReason('Something new: 42')).toBe('other');
    expect(categorizeReason('')).toBe('other');
    expect(categorizeReason(null)).toBe('other');
    expect(categorizeReason(7)).toBe('other');
  });

  it('recognises every reason applyTradeFilters() emits for a spread of inputs', () => {
    const base = {
      mlConfidence: 0.3, mlAvailable: true, marketPrice: 0.5, atrRatio: 0.0001, timeLeftMin: 14,
      marketSlug: 'btc-updown-15m-cat-test', consecutiveLosses: 0, session: 'Asia', btcPrice: 80000,
      priceToBeat: 80000, tiltMlConfMin: null, bestEdge: 0.3, delta1m: -500, signalSide: 'UP',
      regime: 'trending', etHour: 3, spread: 0.2, mlAccuracy: 0.3, buyRatio: 0.05, ptbSource: 'chainlink_round',
    };
    const inputs = [
      base,
      { ...base, mlConfidence: 0.77, marketPrice: 0.9, timeLeftMin: 3, bestEdge: 0.05, spread: 0.05 },
      { ...base, mlConfidence: 0.6, marketPrice: 0.66, timeLeftMin: 1, bestEdge: 0.02, regime: 'moderate' },
      { ...base, mlConfidence: 0.5, marketPrice: 0.4, timeLeftMin: 8, bestEdge: 0.01, regime: 'moderate' },
    ];
    const seen: string[] = [];
    for (const input of inputs) {
      const { reasons } = applyTradeFilters(input);
      for (const r of reasons) {
        seen.push(r);
        expect(categorizeReason(r), r).not.toBe('other');
      }
    }
    expect(seen.length).toBeGreaterThan(10);
  });
});

describe('sole blocker', () => {
  it('is the gate when every reason belongs to one category', () => {
    expect(soleGate(scoreLine(line({ fr: ['ML conf 44% < 65%'] })))).toBe('ml_conf');
    expect(soleGate(scoreLine(line({ fr: ['Wide spread: 9.0% > 8% max', 'Spread 5.0% w/ thin edge 3.0% < 8%'] })))).toBe('spread');
  });

  it('is null with two gates, no reasons, a WAIT, or filters that never ran', () => {
    expect(soleGate(scoreLine(line({ fr: ['ML conf 44% < 65%', 'Too early: 14.8min left > 12min (x)'] })))).toBeNull();
    expect(soleGate(scoreLine(line({ st: 'passed', fr: [] })))).toBeNull();
    expect(soleGate(scoreLine(line({ a: 'W', st: 'wait', fr: undefined })))).toBeNull();
    expect(soleGate(scoreLine(line({ st: 'unstable', fr: undefined })))).toBeNull();
    expect(soleGate(scoreLine(line({ st: 'pre', fr: undefined })))).toBeNull();
  });

  it('relaxing a gate passes exactly the lines it blocked alone', () => {
    const relaxed = new Set<GateId>(['ml_conf']);
    expect(passesWithRelaxed(scoreLine(line({ fr: ['ML conf 44% < 65%'] })), relaxed)).toBe(true);
    expect(passesWithRelaxed(scoreLine(line({ fr: ['ML conf 44% < 65%', 'Market 50c near 50/50 (47-53c)'] })), relaxed)).toBe(false);
    expect(passesWithRelaxed(scoreLine(line({ st: 'passed', fr: [] })), new Set())).toBe(true);
    expect(passesWithRelaxed(scoreLine(line({ st: 'entered', fr: [] })), new Set())).toBe(true);
    expect(passesWithRelaxed(scoreLine(line({ st: 'filtered', fr: ['ML conf 44% < 65%'] })), new Set())).toBe(false);
    expect(passesWithRelaxed(scoreLine(line({ a: 'W', st: 'wait', fr: undefined })), relaxed)).toBe(false);
  });
});

describe('ML-threshold sweep predicate', () => {
  it('replaces the ml_conf gate with mc >= T and keeps every other gate', () => {
    const onlyMl = scoreLine(line({ mc: 0.5, fr: ['ML conf 50% < 65%'] }));
    expect(passesAtMlThreshold(onlyMl, 0.45)).toBe(true);
    expect(passesAtMlThreshold(onlyMl, 0.5)).toBe(true);
    expect(passesAtMlThreshold(onlyMl, 0.55)).toBe(false);

    const passedLowMc = scoreLine(line({ st: 'passed', mc: 0.6, fr: [] }));
    expect(passesAtMlThreshold(passedLowMc, 0.55)).toBe(true);
    expect(passesAtMlThreshold(passedLowMc, 0.65)).toBe(false);

    const mlAndEarly = scoreLine(line({ mc: 0.9, fr: ['ML conf 90% < 95%', 'Too early: 13.0min left > 12min (x)'] }));
    expect(passesAtMlThreshold(mlAndEarly, 0.3)).toBe(false);

    const deadZone = scoreLine(line({ mc: 0.77, fr: ['ML dead zone: conf 77% in 75-80% band, edge 5.0% < 10% required'] }));
    expect(passesAtMlThreshold(deadZone, 0.3)).toBe(false);

    expect(passesAtMlThreshold(scoreLine(line({ st: 'passed', mc: null, fr: [] })), 0.65)).toBe(true);
  });
});

describe('one trade per market', () => {
  it('takes the earliest qualifying line of each market, in time order even when input is not', () => {
    const A = 'btc-updown-15m-1790305200';
    const B = 'btc-updown-15m-1790306100';
    const lines = [
      line({ m: A, t: 5_000, st: 'filtered', fr: ['ML conf 60% < 65%'], pu: 0.62 }),
      line({ m: A, t: 3_000, st: 'filtered', fr: ['Too early: 13.0min left > 12min (x)'] }),
      line({ m: A, t: 4_000, st: 'filtered', fr: ['ML conf 55% < 65%'], pu: 0.58 }),
      line({ m: B, t: 2_000, a: 'W', st: 'wait', fr: undefined }),
      line({ m: B, t: 6_000, st: 'passed', fr: [], sd: 'D', pd: 0.55 }),
      line({ m: B, t: 7_000, st: 'entered', fr: [], sd: 'D', pd: 0.56 }),
      line({ m: null, t: 1_000, st: 'passed', fr: [] }),
    ].map(scoreLine);

    const relaxedMl = firstPerMarket(lines, (s) => passesWithRelaxed(s, new Set<GateId>(['ml_conf'])));
    expect([...relaxedMl.keys()].sort()).toEqual([A, B]);
    expect(relaxedMl.get(A)!.line.t).toBe(4_000);
    expect(relaxedMl.get(B)!.line.t).toBe(6_000);

    const actual = firstPerMarket(lines, (s) => s.line.st === 'entered');
    expect([...actual.keys()]).toEqual([B]);
    expect(actual.get(B)!.line.t).toBe(7_000);

    const baseline = firstPerMarket(lines, (s) => passesWithRelaxed(s, new Set()));
    expect([...baseline.keys()]).toEqual([B]);
  });
});

describe('settlement math', () => {
  it('breakeven at 60c is about 60.43%, from the fee on profit', () => {
    expect(breakevenWinRate(0.6)).toBeCloseTo(0.6043, 3);
    const r = 0.072 * 0.6 * 0.4;
    expect(breakevenWinRate(0.6)).toBeCloseTo(0.6 / ((1 - 0.6) * (1 - r) + 0.6), 12);
  });

  it('agrees with the bot’s own breakeven (solved from computeSettlementPnl)', () => {
    for (const c of [0.3, 0.5, 0.55, 0.6, 0.68, 0.75, 0.9]) {
      expect(breakevenWinRate(c)).toBeCloseTo(botBreakevenWinRate(c)!, 6);
    }
  });

  it('has zero expected P&L per $1 at breakeven', () => {
    for (const c of [0.45, 0.6, 0.8]) {
      const w = breakevenWinRate(c);
      expect(w * pnlPerDollar(c, true) + (1 - w) * pnlPerDollar(c, false)).toBeCloseTo(0, 12);
    }
    expect(winPnlPerDollar(0.5)).toBeCloseTo(1 * (1 - 0.018), 12);
    expect(pnlPerDollar(0.5, false)).toBe(-1);
  });

  it('prices a simulated entry at the side price plus slippage, capped at 99c', () => {
    expect(entryPrice(line({ sd: 'U', pu: 0.595 }))).toBeCloseTo(0.605, 10);
    expect(entryPrice(line({ sd: 'D', pd: 0.43 }))).toBeCloseTo(0.44, 10);
    expect(entryPrice(line({ sd: 'U', pu: 0.985 }))).toBe(0.99);
    expect(entryPrice(line({ sd: null }))).toBeNull();
    expect(entryPrice(line({ sd: 'U', pu: null }))).toBeNull();
    expect(entryPrice(line({ sd: 'U', pu: 0.6 }), 0)).toBe(0.6);
  });

  it('simulates and summarises trades', () => {
    const l = line({ sd: 'D', pd: 0.59 });
    expect(simulateTrade(l, 'DOWN')).toMatchObject({ side: 'DOWN', price: 0.6, won: true });
    expect(simulateTrade(l, 'UP')!.won).toBe(false);
    expect(simulateTrade(l, null)).toBeNull();

    const trades = [
      { slug: 'a', t: 1, side: 'UP' as const, price: 0.6, won: true },
      { slug: 'b', t: 2, side: 'UP' as const, price: 0.6, won: false },
      { slug: 'c', t: 3, side: 'DOWN' as const, price: 0.6, won: true },
    ];
    const s = summarizeTrades(trades);
    expect(s.n).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBeCloseTo(2 / 3, 12);
    expect(s.breakeven).toBeCloseTo(breakevenWinRate(0.6), 12);
    expect(s.roi).toBeCloseTo((2 * winPnlPerDollar(0.6) - 1) / 3, 12);
    expect(s.marginPp).toBeCloseTo((2 / 3 - breakevenWinRate(0.6)) * 100, 10);
    expect(summarizeTrades([]).n).toBe(0);
    expect(summarizeTrades([]).winRate).toBeNull();
  });

  it('gives a Wilson interval that contains the observed rate', () => {
    const [lo, hi] = wilsonInterval(7, 10)!;
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
    expect(lo).toBeCloseTo(0.3968, 3);
    expect(hi).toBeCloseTo(0.8922, 3);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('helpers', () => {
  it('derives a market end from the slug when the tape has none', () => {
    expect(marketEndMs('btc-updown-15m-1790305200')).toBe(1790305200_000 + 900_000);
    expect(marketEndMs('btc-updown-15m-1790305200', 123)).toBe(123);
    expect(marketEndMs('not-a-market')).toBeNull();
  });

  it('counts stages per group', () => {
    const mix = stageMix([
      line({ a: 'W', st: 'wait' }), line({ st: 'filtered' }), line({ st: 'entered' }),
    ], () => 'Asia');
    const asia = mix.get('Asia')!;
    expect(asia.total).toBe(3);
    expect(asia.enter).toBe(2);
    expect(asia.stages).toMatchObject({ wait: 1, filtered: 1, entered: 1, pre: 0 });
  });
});

describe('ML-rule predicate (forward test of candidate gates)', () => {
  const live = ML_RULE_CANDIDATES[0];
  const bypass = ML_RULE_CANDIDATES[1];
  it('the first candidate is the live gate: 0.65, or 0.45 when the side edge is >= 15%', () => {
    expect(live).toMatchObject({ min: 0.65, relaxed: 0.45, bypass: 0.15 });
    const lowConf = (edge: number) => scoreLine({ ...line({ sd: 'U', mc: 0.5, fr: ['ML conf 50% < 65%'] }), eu: edge, ed: -edge } as any);
    expect(passesMlRule(lowConf(0.10), live)).toBe(false);
    expect(passesMlRule(lowConf(0.16), live)).toBe(true);
  });
  it("uses the edge of the line's own side, and still needs every other gate clear", () => {
    const down = scoreLine({ ...line({ sd: 'D', mc: 0.25, fr: ['ML conf 25% < 65%'] }), eu: 0.3, ed: 0.13 } as any);
    expect(passesMlRule(down, bypass)).toBe(true);   // 0.25 >= 0.20 with the DOWN edge 13% >= 12%
    expect(passesMlRule(down, live)).toBe(false);    // 13% < 15%: the floor stays 0.65
    const other = scoreLine({ ...line({ sd: 'D', mc: 0.9, fr: ['Market 50c near 50/50 (47-53c)'] }), eu: 0, ed: 0.2 } as any);
    expect(passesMlRule(other, bypass)).toBe(false);
  });
});
