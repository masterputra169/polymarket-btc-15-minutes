/**
 * ═══ Backtest Runner v2 ═══
 *
 * Simulates the full prediction pipeline against historical BTC data.
 * Tests every 15-minute window and tracks accuracy.
 *
 * Usage:
 *   1. First fetch data: node backtest/fetchData.mts 7
 *   2. Then run backtest: node backtest/runBacktest.mts backtest/data/btc_7d_2026-02-06.json
 *
 * What it does:
 *   - Splits 1m candles into 15-minute windows
 *   - For each window, simulates prediction at multiple timepoints (12min, 8min, 5min, 3min left)
 *   - Computes all indicators (VWAP, RSI, MACD, HA, momentum, regime, orderbook proxy, multi-TF)
 *   - Runs scoreDirection + applyTimeAwareness + edge calculation
 *   - Compares prediction vs actual outcome (did price end above/below open?)
 *   - Tracks accuracy by phase, session, regime, signal strength
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══ Import engines (relative to project root) ═══
import { computeSessionVwap, computeVwapSeries } from '../src/indicators/vwap.ts';
import { computeRsi, computeRsiSeries, slopeLast } from '../src/indicators/rsi.ts';
import { computeMacd } from '../src/indicators/macd.ts';
import { computeHeikenAshi, countConsecutive } from '../src/indicators/heikenAshi.ts';
import { detectRegime } from '../src/engines/regime.ts';
import { scoreDirection, applyTimeAwareness } from '../src/engines/probability.ts';
import { computeEdge, decide } from '../src/engines/edge.ts';
import { getVolatilityProfile } from '../src/engines/volatility.ts';
import { computeMultiTfConfirmation } from '../src/engines/multitf.ts';
// Note: feedback.ts uses localStorage (browser-only), skip in backtest

type CountStats = { total: number; correct: number };
type BacktestPrediction = Record<string, any> & {
  correct: boolean;
  confidence: number;
  session: string;
  regime: string;
  rec: string;
  recConfidence?: string;
  multiTf: boolean;
};
type BacktestResults = {
  total: number;
  correct: number;
  byPhase: Record<string, CountStats>;
  bySession: Record<string, CountStats>;
  byRegime: Record<string, CountStats>;
  byConfidence: Record<string, CountStats>;
  byRecAction: Record<string, CountStats>;
  byRecConfidence: Record<string, CountStats>;
  byMultiTf: Record<string, CountStats>;
  enterSignals: CountStats;
  predictions: BacktestPrediction[];
};

// ═══ Config (mirror from src/config.ts) ═══
const CONFIG = {
  vwapLookbackCandles: 60,
  rsiPeriod: 8,
  macdFast: 6,
  macdSlow: 13,
  macdSignal: 5,
  candleWindowMinutes: 15,
};

// ═══ Helper: group 1m candles into 15-min windows ═══
function groupIntoWindows(candles1m, windowMinutes = 15) {
  const windows = [];
  const msPerWindow = windowMinutes * 60 * 1000;

  // Find first aligned boundary
  const firstTime = candles1m[0].openTime;
  const startBoundary = Math.ceil(firstTime / msPerWindow) * msPerWindow;

  let i = 0;
  while (i < candles1m.length) {
    // Find window start
    const windowStart = Math.floor(candles1m[i].openTime / msPerWindow) * msPerWindow;
    const windowEnd = windowStart + msPerWindow;

    const windowCandles = [];
    while (i < candles1m.length && candles1m[i].openTime < windowEnd) {
      windowCandles.push(candles1m[i]);
      i++;
    }

    if (windowCandles.length >= 10) { // Need at least 10 candles
      windows.push({
        startTime: windowStart,
        endTime: windowEnd,
        candles: windowCandles,
        openPrice: windowCandles[0].open,
        closePrice: windowCandles[windowCandles.length - 1].close,
        highPrice: Math.max(...windowCandles.map(c => c.high)),
        lowPrice: Math.min(...windowCandles.map(c => c.low)),
      });
    }
  }

  return windows;
}

// ═══ Get lookback candles (candles before this window for indicator warmup) ═══
function getLookbackCandles(allCandles, windowStartTime, lookbackCount = 60) {
  const idx = allCandles.findIndex(c => c.openTime >= windowStartTime);
  if (idx < lookbackCount) return allCandles.slice(0, idx);
  return allCandles.slice(idx - lookbackCount, idx);
}

// ═══ Get 5m candles for a time window ═══
function get5mCandlesFor(candles5m, beforeTime, count = 12) {
  const idx = candles5m.findIndex(c => c.openTime >= beforeTime);
  const endIdx = idx >= 0 ? idx : candles5m.length;
  const startIdx = Math.max(0, endIdx - count);
  return candles5m.slice(startIdx, endIdx);
}

// ═══ Session from UTC hour ═══
function getSession(timestamp) {
  const h = new Date(timestamp).getUTCHours();
  if (h >= 13 && h < 16) return 'EU/US Overlap';
  if (h >= 13 && h < 22) return 'US';
  if (h >= 8 && h < 16) return 'Europe';
  if (h >= 0 && h < 8) return 'Asia';
  return 'Off-hours';
}

// ═══ Simulate prediction at a specific point within a window ═══
function simulatePrediction(allCandles1m, candles5m, window, minutesLeft) {
  // Determine how many candles into the window we are
  const candlesUsed = window.candles.length - minutesLeft;
  if (candlesUsed < 3) return null; // Not enough data

  // Candles available at this point
  const lookback = getLookbackCandles(allCandles1m, window.startTime, CONFIG.vwapLookbackCandles);
  const windowSoFar = window.candles.slice(0, candlesUsed);
  const availableCandles = [...lookback, ...windowSoFar];

  const closes = availableCandles.map(c => c.close);
  const volumes = availableCandles.map(c => c.volume);
  const price = closes[closes.length - 1];

  // Price to Beat = opening price of the window (simulated)
  const priceToBeat = window.openPrice;

  // ═══ Compute indicators ═══
  // VWAP — use computeVwapSeries to match useMarketData.ts approach
  const vwapSeries = computeVwapSeries(availableCandles, CONFIG.vwapLookbackCandles);
  const vwapNow = vwapSeries.length > 0 ? vwapSeries[vwapSeries.length - 1] : null;
  const vwapSlope = vwapSeries.length >= 5 ? slopeLast(vwapSeries, 5) : null;

  // RSI
  const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
  const rsiSeries = computeRsiSeries(closes, CONFIG.rsiPeriod);
  const rsiSlope = rsiSeries.length >= 3 ? slopeLast(rsiSeries, 3) : null;

  // MACD
  const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);

  // Heiken Ashi
  const ha = computeHeikenAshi(availableCandles);
  const consec = countConsecutive(ha);

  // Deltas
  const close1mAgo = closes.length >= 2 ? closes[closes.length - 2] : null;
  const close3mAgo = closes.length >= 4 ? closes[closes.length - 4] : null;
  const delta1m = price && close1mAgo ? price - close1mAgo : null;
  const delta3m = price && close3mAgo ? price - close3mAgo : null;

  // VWAP crossing/distance for regime
  const vwapDist = vwapNow ? (price - vwapNow) / vwapNow : null;
  const closesShort = closes.slice(-20);
  const vwapSeriesShort = vwapSeries.slice(-20);
  let vwapCrossCount = 0;
  for (let j = 1; j < Math.min(closesShort.length, vwapSeriesShort.length); j++) {
    const prev = closesShort[j - 1] - vwapSeriesShort[j - 1];
    const curr = closesShort[j] - vwapSeriesShort[j];
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) vwapCrossCount++;
  }

  // Failed VWAP reclaim detection
  let failedVwapReclaim = false;
  if (vwapNow && closesShort.length >= 5) {
    const wasBelow = closesShort.slice(-5, -2).some(c => c < vwapNow);
    const wentAbove = closesShort.slice(-3, -1).some(c => c > vwapNow);
    const nowBelow = price < vwapNow;
    if (wasBelow && wentAbove && nowBelow) failedVwapReclaim = true;
  }

  // Volume
  const volumeRecent = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volumeAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);

  // Regime detection — needs price + vwap (not vwapDist)
  const regimeInfo = detectRegime({
    price,
    vwap: vwapNow,
    vwapSlope,
    vwapCrossCount,
    volumeRecent,
    volumeAvg,
  });

  // Volatility profile (time-based)
  const predictionTime = new Date(window.startTime + (candlesUsed * 60_000));
  const volProfile = getVolatilityProfile(predictionTime);

  // Multi-TF
  const available5m = get5mCandlesFor(candles5m, window.startTime + candlesUsed * 60_000);
  const closes5m = available5m.map(c => c.close);
  const delta5m = closes5m.length >= 2 ? closes5m[closes5m.length - 1] - closes5m[closes5m.length - 2] : null;
  const ha5m = computeHeikenAshi(available5m);
  const consec5m = countConsecutive(ha5m);
  const rsi5m = computeRsi(closes5m, 8);

  const multiTfConfirm = computeMultiTfConfirmation({
    delta1m,
    delta3m,
    delta5m,
    ha1mColor: consec.color,
    ha5mColor: consec5m.color,
    rsi1m: rsiNow,
    rsi5m,
  });

  // ═══ Score ═══
  const scored = scoreDirection({
    price,
    priceToBeat,
    vwap: vwapNow,
    vwapSlope,
    rsi: rsiNow,
    rsiSlope,
    macd,
    heikenColor: consec.color,
    heikenCount: consec.count,
    failedVwapReclaim,
    delta1m,
    delta3m,
    regime: regimeInfo,
    orderbookSignal: null,  // No orderbook in backtest
    volProfile,
    multiTfConfirm,
    feedbackStats: null,    // No feedback in backtest
  });

  // Time awareness
  const timeAware = applyTimeAwareness(
    scored.rawUp,
    minutesLeft,
    CONFIG.candleWindowMinutes,
  );

  // Simulate market price (50/50 if no edge)
  const simulatedMarketUp = 0.50;
  const simulatedMarketDown = 0.50;

  const edge = computeEdge({
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    marketYes: simulatedMarketUp,
    marketNo: simulatedMarketDown,
  });

  const rec = decide({
    remainingMinutes: minutesLeft,
    edgeUp: edge.edgeUp,
    edgeDown: edge.edgeDown,
    modelUp: timeAware.adjustedUp,
    modelDown: timeAware.adjustedDown,
    breakdown: scored.breakdown,
    multiTfConfirmed: multiTfConfirm?.agreement ?? false,
  });

  // Actual result
  const actualUp = window.closePrice >= window.openPrice;
  const predictedUp = timeAware.adjustedUp > 0.5;
  const correct = predictedUp === actualUp;

  return {
    minutesLeft,
    price,
    priceToBeat,
    distancePct: ((price - priceToBeat) / priceToBeat * 100).toFixed(4),
    rawUp: scored.rawUp,
    adjustedUp: timeAware.adjustedUp,
    timeDecay: timeAware.timeDecay,
    predictedSide: predictedUp ? 'UP' : 'DOWN',
    actualSide: actualUp ? 'UP' : 'DOWN',
    correct,
    confidence: Math.abs(timeAware.adjustedUp - 0.5) * 2, // 0-1 scale
    regime: regimeInfo.regime,
    session: getSession(window.startTime),
    rec: rec.action,
    recSide: rec.side,
    recConfidence: rec.confidence, // NEW: VERY_HIGH/HIGH/MEDIUM/LOW from edge.ts v2
    recPhase: rec.phase,
    recReason: rec.reason,
    edgeUp: edge.edgeUp,
    edgeDown: edge.edgeDown,
    multiTf: multiTfConfirm.agreement,
    breakdown: scored.breakdown,
  };
}

// ═══ MAIN ═══
async function main() {
  const dataFile = process.argv[2];
  if (!dataFile) {
    console.error('Usage: node backtest/runBacktest.mts <data-file.json>');
    console.error('Example: node backtest/runBacktest.mts backtest/data/btc_7d_2026-02-06.json');
    process.exit(1);
  }

  console.log(`\n═══ Backtest Runner v2 ═══\n`);
  console.log(`Loading: ${dataFile}`);

  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const candles1m = raw.data1m;
  const candles5m = raw.data5m;

  console.log(`  1m candles: ${candles1m.length}`);
  console.log(`  5m candles: ${candles5m.length}`);
  console.log(`  Period: ${raw.startTime} → ${raw.endTime}\n`);

  // Group into 15-min windows
  const windows = groupIntoWindows(candles1m, 15);
  console.log(`  15-min windows: ${windows.length}\n`);

  // Simulation timepoints (minutes left in window)
  const checkPoints = [12, 8, 5, 3, 1];

  // Results storage
  const results: BacktestResults = {
    total: 0,
    correct: 0,
    byPhase: {},      // { '12min': { total, correct }, ... }
    bySession: {},     // { 'Asia': { total, correct }, ... }
    byRegime: {},      // { 'trending': { total, correct }, ... }
    byConfidence: {    // Bucketed by confidence
      low: { total: 0, correct: 0 },     // < 0.2
      medium: { total: 0, correct: 0 },  // 0.2-0.5
      high: { total: 0, correct: 0 },    // > 0.5
    },
    byRecAction: {},   // { 'ENTER': { total, correct }, 'WAIT': { ... } }
    byRecConfidence: {}, // { 'VERY_HIGH': { total, correct }, ... }
    byMultiTf: {        // MultiTF confirmed or not
      confirmed: { total: 0, correct: 0 },
      unconfirmed: { total: 0, correct: 0 },
    },
    enterSignals: { total: 0, correct: 0 }, // Only when rec = ENTER
    predictions: [],   // All individual predictions
  };

  // Run simulation
  console.log('Running simulation...');
  let processed = 0;

  for (const window of windows) {
    for (const minLeft of checkPoints) {
      if (minLeft >= window.candles.length) continue;

      const pred = simulatePrediction(candles1m, candles5m, window, minLeft);
      if (!pred) continue;

      results.total++;
      if (pred.correct) results.correct++;

      // By phase
      const phaseKey = `${minLeft}min`;
      if (!results.byPhase[phaseKey]) results.byPhase[phaseKey] = { total: 0, correct: 0 };
      results.byPhase[phaseKey].total++;
      if (pred.correct) results.byPhase[phaseKey].correct++;

      // By session
      if (!results.bySession[pred.session]) results.bySession[pred.session] = { total: 0, correct: 0 };
      results.bySession[pred.session].total++;
      if (pred.correct) results.bySession[pred.session].correct++;

      // By regime
      if (!results.byRegime[pred.regime]) results.byRegime[pred.regime] = { total: 0, correct: 0 };
      results.byRegime[pred.regime].total++;
      if (pred.correct) results.byRegime[pred.regime].correct++;

      // By confidence
      const confBucket = pred.confidence < 0.2 ? 'low' : pred.confidence < 0.5 ? 'medium' : 'high';
      results.byConfidence[confBucket].total++;
      if (pred.correct) results.byConfidence[confBucket].correct++;

      // By rec action
      if (!results.byRecAction[pred.rec]) results.byRecAction[pred.rec] = { total: 0, correct: 0 };
      results.byRecAction[pred.rec].total++;
      if (pred.correct) results.byRecAction[pred.rec].correct++;

      // ENTER signals only
      if (pred.rec === 'ENTER') {
        results.enterSignals.total++;
        if (pred.correct) results.enterSignals.correct++;
      }

      // By recConfidence level (VERY_HIGH/HIGH/MEDIUM/LOW/NONE)
      const rcKey = pred.recConfidence || 'NONE';
      if (!results.byRecConfidence[rcKey]) results.byRecConfidence[rcKey] = { total: 0, correct: 0 };
      results.byRecConfidence[rcKey].total++;
      if (pred.correct) results.byRecConfidence[rcKey].correct++;

      // By multiTF confirmation
      const mtfKey = pred.multiTf ? 'confirmed' : 'unconfirmed';
      results.byMultiTf[mtfKey].total++;
      if (pred.correct) results.byMultiTf[mtfKey].correct++;

      results.predictions.push(pred);
    }

    processed++;
    if (processed % 50 === 0) {
      process.stdout.write(`\r  Processed ${processed}/${windows.length} windows...`);
    }
  }

  console.log(`\r  Processed ${processed}/${windows.length} windows.    \n`);

  // ═══ PRINT RESULTS ═══
  const pct = (c, t) => t > 0 ? `${(c / t * 100).toFixed(1)}%` : 'N/A';

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║              BACKTEST RESULTS                       ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Overall: ${results.correct}/${results.total} = ${pct(results.correct, results.total)} accuracy`);
  console.log(`║  ENTER signals: ${results.enterSignals.correct}/${results.enterSignals.total} = ${pct(results.enterSignals.correct, results.enterSignals.total)} accuracy`);
  console.log('╠══════════════════════════════════════════════════════╣');

  console.log('║  BY TIME LEFT (Phase):');
  for (const [phase, data] of Object.entries(results.byPhase).sort()) {
    console.log(`║    ${phase.padEnd(8)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY SESSION:');
  for (const [session, data] of Object.entries(results.bySession).sort()) {
    console.log(`║    ${session.padEnd(16)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY REGIME:');
  for (const [regime, data] of Object.entries(results.byRegime).sort()) {
    console.log(`║    ${regime.padEnd(16)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY CONFIDENCE:');
  for (const [level, data] of Object.entries(results.byConfidence)) {
    console.log(`║    ${level.padEnd(8)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY DECISION:');
  for (const [action, data] of Object.entries(results.byRecAction).sort()) {
    console.log(`║    ${action.padEnd(8)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY ENTER QUALITY (edge.ts confidence):');
  const rcOrder = ['VERY_HIGH', 'HIGH', 'MEDIUM', 'LOW', 'NONE'];
  for (const level of rcOrder) {
    const data = results.byRecConfidence[level];
    if (data) console.log(`║    ${level.padEnd(12)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╠──────────────────────────────────────────────────────╣');
  console.log('║  BY MULTI-TIMEFRAME:');
  for (const [key, data] of Object.entries(results.byMultiTf)) {
    console.log(`║    ${key.padEnd(14)}: ${data.correct}/${data.total} = ${pct(data.correct, data.total)}`);
  }

  console.log('╚══════════════════════════════════════════════════════╝');

  // ═══ KEY INSIGHT: What's the accuracy when model is confident? ═══
  const highConfPreds = results.predictions.filter(p => p.confidence > 0.3);
  const highConfCorrect = highConfPreds.filter(p => p.correct).length;
  console.log(`\n🎯 HIGH CONFIDENCE (>60%/40% prob):`);
  console.log(`   ${highConfCorrect}/${highConfPreds.length} = ${pct(highConfCorrect, highConfPreds.length)}`);

  const enterPreds = results.predictions.filter(p => p.rec === 'ENTER');
  const enterCorrect = enterPreds.filter(p => p.correct).length;
  console.log(`\n🎯 ENTER SIGNALS ONLY (what matters for trading):`);
  console.log(`   ${enterCorrect}/${enterPreds.length} = ${pct(enterCorrect, enterPreds.length)}`);

  // ENTER + MultiTF confirmed
  const enterMtf = enterPreds.filter(p => p.multiTf);
  const enterMtfCorrect = enterMtf.filter(p => p.correct).length;
  console.log(`\n🎯 ENTER + MultiTF Confirmed:`);
  console.log(`   ${enterMtfCorrect}/${enterMtf.length} = ${pct(enterMtfCorrect, enterMtf.length)}`);

  // ENTER + HIGH/VERY_HIGH quality
  const enterHQ = enterPreds.filter(p => p.recConfidence === 'HIGH' || p.recConfidence === 'VERY_HIGH');
  const enterHQCorrect = enterHQ.filter(p => p.correct).length;
  console.log(`\n🎯 ENTER + HIGH/VERY_HIGH quality:`);
  console.log(`   ${enterHQCorrect}/${enterHQ.length} = ${pct(enterHQCorrect, enterHQ.length)}`);

  // ULTRA: ENTER + MultiTF + HIGH/VERY_HIGH
  const ultraPreds = enterPreds.filter(p => p.multiTf && (p.recConfidence === 'HIGH' || p.recConfidence === 'VERY_HIGH'));
  const ultraCorrect = ultraPreds.filter(p => p.correct).length;
  console.log(`\n🏆 ULTRA QUALITY (ENTER + MultiTF + HIGH/VERY_HIGH):`);
  console.log(`   ${ultraCorrect}/${ultraPreds.length} = ${pct(ultraCorrect, ultraPreds.length)}`);

  // ═══ Calibration check ═══
  console.log(`\n📊 CALIBRATION CHECK:`);
  const buckets = [
    { label: '50-55%', min: 0.50, max: 0.55 },
    { label: '55-60%', min: 0.55, max: 0.60 },
    { label: '60-65%', min: 0.60, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-80%', min: 0.70, max: 0.80 },
    { label: '80%+  ', min: 0.80, max: 1.00 },
  ];
  for (const b of buckets) {
    const inBucket = results.predictions.filter(p => {
      const modelProb = Math.max(p.adjustedUp, 1 - p.adjustedUp);
      return modelProb >= b.min && modelProb < b.max;
    });
    const bucketCorrect = inBucket.filter(p => p.correct).length;
    const bar = '█'.repeat(Math.round((bucketCorrect / Math.max(1, inBucket.length)) * 20));
    console.log(`   ${b.label}: ${String(bucketCorrect).padStart(4)}/${String(inBucket.length).padStart(4)} = ${pct(bucketCorrect, inBucket.length).padStart(6)} ${bar}`);
  }

  // ═══ Save detailed results ═══
  const outFile = path.join(__dirname, 'data', `results_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    summary: {
      total: results.total,
      correct: results.correct,
      accuracy: results.correct / results.total,
      enterTotal: results.enterSignals.total,
      enterCorrect: results.enterSignals.correct,
      enterAccuracy: results.enterSignals.total > 0 ? results.enterSignals.correct / results.enterSignals.total : null,
    },
    byPhase: results.byPhase,
    bySession: results.bySession,
    byRegime: results.byRegime,
    byConfidence: results.byConfidence,
    byRecAction: results.byRecAction,
    byRecConfidence: results.byRecConfidence,
    byMultiTf: results.byMultiTf,
    // Don't save all predictions to keep file small
    samplePredictions: results.predictions.slice(0, 50),
  }, null, 2));

  console.log(`\n💾 Detailed results saved to: ${outFile}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
