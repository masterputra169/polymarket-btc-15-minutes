/**
 * Live Polymarket data logger — writes directly to CSV file.
 * Runs in the bot (Node.js), so can write to filesystem.
 *
 * Appends one row every 30s to backtest/ml_training/live_polymarket_data.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.resolve(__dirname, '../../backtest/ml_training/live_polymarket_data.csv');
const LOG_INTERVAL_MS = 5_000;

let lastLogMs = 0;
let headerWritten = false;

const HEADER = [
  'timestamp', 'btcPrice', 'priceToBeat', 'marketSlug',
  'marketUp', 'marketDown', 'marketPriceMomentum',
  'orderbookImbalance', 'spreadPct',
  'rsi', 'rsiSlope', 'macdHist', 'macdLine',
  'vwapNow', 'vwapSlope', 'haColor', 'haCount',
  'delta1m', 'delta3m', 'volumeRecent', 'volumeAvg',
  'regime', 'regimeConfidence', 'timeLeftMin',
  'bbWidth', 'bbPercentB', 'bbSqueeze', 'bbSqueezeIntensity',
  'atrPct', 'atrRatio',
  'volDeltaBuyRatio', 'volDeltaAccel',
  'emaDistPct', 'emaCrossSignal',
  'stochK', 'stochKD',
  'vwapCrossCount', 'multiTfAgreement', 'failedVwapReclaim',
  'fundingRate',
  'momentum5CandleSlope', 'volatilityChangeRatio', 'priceConsistency',
  'ruleEdge',
  'ensembleUp', 'mlProbUp', 'mlConfidence',
].join(',');

function ensureHeader() {
  if (headerWritten) return;
  try {
    if (!fs.existsSync(CSV_PATH)) {
      fs.writeFileSync(CSV_PATH, HEADER + '\n');
    } else {
      // Check if file is empty
      const stat = fs.statSync(CSV_PATH);
      if (stat.size === 0) {
        fs.writeFileSync(CSV_PATH, HEADER + '\n');
      }
    }
    headerWritten = true;
  } catch { /* first write will add header */ }
}

/**
 * Check if it's time to log (caller skips object creation if false).
 */
export function shouldLog() {
  return Date.now() - lastLogMs >= LOG_INTERVAL_MS;
}

/**
 * Log a snapshot row to CSV. Call only when shouldLog() is true.
 */
export function logSnapshot(d) {
  lastLogMs = Date.now();
  ensureHeader();

  const v = (x) => x ?? '';
  const row = [
    Date.now(),
    v(d.btcPrice),
    v(d.priceToBeat),
    v(d.marketSlug),
    v(d.marketUp),
    v(d.marketDown),
    d.marketPriceMomentum ?? 0,
    v(d.orderbookImbalance),
    v(d.spreadPct),
    v(d.rsi),
    v(d.rsiSlope),
    v(d.macdHist),
    v(d.macdLine),
    v(d.vwapNow),
    v(d.vwapSlope),
    v(d.haColor),
    d.haCount ?? 0,
    d.delta1m ?? 0,
    d.delta3m ?? 0,
    d.volumeRecent ?? 0,
    d.volumeAvg ?? 0,
    v(d.regime),
    d.regimeConfidence ?? 0.5,
    v(d.timeLeftMin),
    v(d.bbWidth),
    v(d.bbPercentB),
    d.bbSqueeze ? 1 : 0,
    d.bbSqueezeIntensity ?? 0,
    v(d.atrPct),
    v(d.atrRatio),
    v(d.volDeltaBuyRatio),
    v(d.volDeltaAccel),
    v(d.emaDistPct),
    d.emaCrossSignal ?? 0,
    v(d.stochK),
    v(d.stochKD),
    d.vwapCrossCount ?? 0,
    d.multiTfAgreement ? 1 : 0,
    d.failedVwapReclaim ? 1 : 0,
    v(d.fundingRate),
    d.momentum5CandleSlope ?? 0,
    d.volatilityChangeRatio ?? 1,
    d.priceConsistency ?? 0.5,
    v(d.ruleEdge),
    v(d.ensembleUp),
    v(d.mlProbUp),
    v(d.mlConfidence),
  ].join(',');

  try {
    fs.appendFileSync(CSV_PATH, row + '\n');
  } catch { /* don't break bot loop */ }
}
