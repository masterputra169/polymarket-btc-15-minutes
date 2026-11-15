import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeVolumeDelta } from '../../../../src/indicators/volumedelta.ts';
import { twapPhysics, normCdf } from '../twapPhysics.ts';
import { getDeribitIvSnapshot, setDeribitIvForTest } from '../../adapters/deribitIv.ts';
import {
  recordBinanceTickForTest,
  clearBinanceTicksForTest,
  getRecentPriceWindow,
} from '../../streams/binanceWs.ts';
import { computeLeadLagImpulse } from '../signalComputation.ts';

const END = 1_790_400_000_000;
const ORIGINAL_ENV = { ...process.env };

function makeCandles(ratios: number[]) {
  return ratios.map((r) => ({
    volume: 100,
    takerBuyVolume: Math.round(r * 100),
  }));
}

describe('Upgrade 1: 300s & 60s Binance Taker Buy Ratio (Bwijn R4)', () => {
  test('computes buyRatio300s, buyRatio60s, r4Bullish and r4Bearish accurately', () => {
    const bull = makeCandles([
      0.40, 0.40, 0.40, 0.40, 0.40, // older 5 candles (10m..6m ago)
      0.75, 0.78, 0.80, 0.76, 0.86, // last 5 candles (300s avg = 0.79, 60s = 0.86)
    ]);
    const rBull = computeVolumeDelta(bull, 10)!;
    expect(rBull.buyRatio).toBeCloseTo(0.595, 3);
    expect(rBull.buyRatio300s).toBeCloseTo(0.79, 4);
    expect(rBull.buyRatio60s).toBeCloseTo(0.86, 4);
    expect(rBull.r4Bullish).toBe(true);
    expect(rBull.r4Bearish).toBe(false);

    const bear = makeCandles([
      0.60, 0.60, 0.60, 0.60, 0.60,
      0.20, 0.22, 0.25, 0.21, 0.17, // last 5 avg = 0.21, 60s = 0.17
    ]);
    const rBear = computeVolumeDelta(bear, 10)!;
    expect(rBear.buyRatio300s).toBeCloseTo(0.21, 4);
    expect(rBear.buyRatio60s).toBeCloseTo(0.17, 4);
    expect(rBear.r4Bullish).toBe(false);
    expect(rBear.r4Bearish).toBe(true);
  });
});

describe('Upgrade 2: Deribit BTC DVOL Adapter & Blended TWAP Physics', () => {
  afterEach(() => {
    setDeribitIvForTest(null, null);
  });

  test('converts annualized DVOL (%) into $/sec sigma and blends into pIv without changing p', () => {
    const now = END - 100_000;
    setDeribitIvForTest(60, now - 5_000); // 60% annualized IV, 5s old
    const snap = getDeribitIvSnapshot(84_000, now);
    expect(snap.source).toBe('deribit_dvol');
    expect(snap.dvolPct).toBe(60);
    const expectedSigmaIv = (84_000 * 0.60) / Math.sqrt(365.25 * 86_400);
    expect(snap.sigmaPerSec).toBeCloseTo(expectedSigmaIv, 6);

    // Alternating +-2 USD moves => realized sigma = $2/s
    const ticks = Array.from({ length: 121 }, (_, i) => ({
      ts: now - 130_000 + i * 1000,
      value: 84_000 + (i % 2 ? 2 : 0),
    }));
    const phys = twapPhysics({
      settle: 84_020,
      settle30sAgo: 84_010,
      ptb: 84_000,
      spotTicks: ticks,
      nowMs: now,
      endMs: END,
      ivSigmaPerSec: snap.sigmaPerSec,
      dvolPct: snap.dvolPct,
    })!;

    // Realized physics p & z stay identical to baseline
    const expectedSd = 2 * Math.sqrt(60.5);
    expect(phys.z).toBeCloseTo(20 / expectedSd, 9);
    expect(phys.p).toBeCloseTo(normCdf(phys.z), 12);

    // Blended IV physics uses 0.5 * sigma_realized + 0.5 * sigma_iv
    const sigmaBlend = 0.5 * 2 + 0.5 * snap.sigmaPerSec!;
    const expectedPIv = normCdf(20 / (sigmaBlend * Math.sqrt(60.5)));
    expect(phys.dvolPct).toBe(60);
    expect(phys.sigmaIv).toBeCloseTo(snap.sigmaPerSec!, 6);
    expect(phys.pIv).toBeCloseTo(expectedPIv, 9);
  });

  test('returns source none when DVOL snapshot is stale (>5m)', () => {
    const now = END;
    setDeribitIvForTest(55, now - 301_000);
    const snap = getDeribitIvSnapshot(84_000, now);
    expect(snap.source).toBe('none');
    expect(snap.dvolPct).toBeNull();
    expect(snap.sigmaPerSec).toBeNull();
  });
});

describe('Upgrade 3: 3-Second Binance Lead-Lag Impulse Detector', () => {
  beforeEach(() => clearBinanceTicksForTest());
  afterEach(() => clearBinanceTicksForTest());

  test('triggers active impulse on sharp 3s BTC move before CLOB reprices', () => {
    const t0 = 1_790_000_000_000;
    recordBinanceTickForTest(80_000, t0 - 2_500);
    recordBinanceTickForTest(80_035, t0); // +0.04375% in 2.5s
    const win = getRecentPriceWindow(3_000, t0);
    expect(win.tickCount).toBe(2);
    expect(win.deltaUsd).toBe(35);
    expect(win.deltaPct).toBeCloseTo((35 / 80_000) * 100, 6);

    const impulseLagging = computeLeadLagImpulse({
      binance3s: win,
      marketMomentum: 0.005, // Polymarket still flat
      clobQuietMs: 1200,
    });
    expect(impulseLagging.active).toBe(true);
    expect(impulseLagging.direction).toBe('UP');

    // Already repriced -> not stale / not active
    const impulseRepriced = computeLeadLagImpulse({
      binance3s: win,
      marketMomentum: 0.03,
      clobQuietMs: 100,
    });
    expect(impulseRepriced.active).toBe(false);
    expect(impulseRepriced.direction).toBe('UP');
  });

  test('triggers DOWN impulse cleanly and ignores sub-threshold noise', () => {
    const t0 = 1_790_000_000_000;
    recordBinanceTickForTest(80_000, t0 - 2_000);
    recordBinanceTickForTest(79_960, t0); // -0.05%
    const down = computeLeadLagImpulse({
      binance3s: getRecentPriceWindow(3_000, t0),
      marketMomentum: 0.0,
    });
    expect(down.active).toBe(true);
    expect(down.direction).toBe('DOWN');

    clearBinanceTicksForTest();
    recordBinanceTickForTest(80_000, t0 - 1_000);
    recordBinanceTickForTest(80_008, t0); // +0.01% (< 0.035%)
    const quiet = computeLeadLagImpulse({
      binance3s: getRecentPriceWindow(3_000, t0),
      marketMomentum: 0.0,
    });
    expect(quiet.active).toBe(false);
    expect(quiet.direction).toBeNull();
  });
});

describe('Gates 20d & 20e in applyTradeFilters', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  test('blocks opposing 300s taker flow (20d) and opposing 3s lead-lag impulse (20e) when enabled', async () => {
    vi.resetModules();
    process.env.TIME_GATES_ENABLED = 'false';
    process.env.FILTER_MAX_OPPOSING_TAKER_300S = '0.22';
    process.env.FILTER_BLOCK_OPPOSING_LEAD_LAG = '1';
    const { setLogLevel } = await import('../../logger.ts');
    setLogLevel('error');
    const { applyTradeFilters } = await import('../../safety/tradeFilters.ts');

    const base = {
      mlConfidence: 0.72,
      mlAvailable: true,
      mlSide: 'UP',
      marketPrice: 0.54,
      atrRatio: 1.0,
      timeLeftMin: 8,
      marketSlug: 'btc-updown-15m-test',
      consecutiveLosses: 0,
      session: 'US',
      btcPrice: 80_100,
      priceToBeat: 80_000,
      tiltMlConfMin: null,
      bestEdge: 0.14,
      delta1m: 15,
      signalSide: 'UP',
      regime: 'moderate',
      etHour: 11,
      spread: 0.01,
      mlAccuracy: 0.75,
      buyRatio: 0.55,
      ptbSource: 'chainlink_twap',
      pathEfficiency: 0.5,
      peakGapRatio: 0.9,
      orderbookImbalance: 0.2,
    };

    // Aligned flow & impulse passes cleanly
    const aligned = applyTradeFilters({ ...base, buyRatio300s: 0.76, leadLagDirection: 'UP' });
    expect(aligned.pass).toBe(true);
    expect(aligned.reasons).toEqual([]);

    // Opposing 300s taker flow (buyRatio300s = 0.20 => 0.5 - 0.20 = 0.30 > 0.22) blocks UP
    const badTaker = applyTradeFilters({ ...base, buyRatio300s: 0.20, leadLagDirection: null });
    expect(badTaker.pass).toBe(false);
    expect(badTaker.reasons.some((r: string) => r.includes('Opposing 300s taker flow'))).toBe(true);

    // Opposing 3s lead-lag impulse (Binance spiking DOWN vs signal UP) blocks UP
    const badLag = applyTradeFilters({ ...base, buyRatio300s: 0.55, leadLagDirection: 'DOWN' });
    expect(badLag.pass).toBe(false);
    expect(badLag.reasons.some((r: string) => r.includes('Opposing 3s BTC lead-lag impulse'))).toBe(true);
  });
});
