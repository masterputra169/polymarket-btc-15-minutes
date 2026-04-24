#!/usr/bin/env node
/**
 * ═══ Generate Training Data for XGBoost v13 (54 Features) ═══
 *
 * Fetches historical Binance BTCUSDT klines and computes the same
 * 54 base features used in live prediction (Mlpredictor.js).
 * (44 original + 5 simulated Polymarket + 3 lag features + 2 funding rate)
 * SM features REMOVED in v13: empirically hurt accuracy (v9 77.9% > v9a 74.4% with SM).
 *
 * Output: training_data.csv with 54 feature columns + label column
 *
 * Usage:
 *   node generateTrainingData.mjs [--days 30] [--interval 1m] [--output training_data.csv]
 *
 * Requirements:
 *   - Node.js 18+
 *   - Internet connection (Binance API)
 */

import fs from 'fs';

// ═══ CONFIG ═══
const ARGS = parseArgs();
const DAYS = ARGS.days || 540;
const CANDLE_INTERVAL = '1m';
const OUTPUT_FILE = ARGS.output || 'training_data.csv';
const PREDICTION_WINDOW = 15; // minutes ahead for label
const LIMIT_PER_REQUEST = 1000;
const MIN_MOVE_PCT = ARGS['min-move'] != null ? parseFloat(ARGS['min-move']) : 0.0008; // 0.08% min move — filters noise while keeping ~55k samples
const POLYMARKET_LOOKUP_PATH = ARGS['polymarket-lookup'] || './polymarket_lookup.json';

// Proxy support for regions where Binance is blocked (e.g., Indonesia)
// Usage: --proxy http://localhost:3001  (your local proxy)
//   or:  --proxy https://your-proxy.vercel.app
const PROXY_URL = ARGS.proxy || process.env.BINANCE_PROXY || '';

// If proxy provided, route everything through it
// Otherwise use fallback host lists (try multiple until one works)
const BINANCE_API = PROXY_URL || 'https://data-api.binance.vision';
const BINANCE_FAPI = PROXY_URL || 'https://fapi.binance.com';

// Fallback hosts for when primary is blocked
const SPOT_FALLBACKS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];
const FAPI_FALLBACKS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
  'https://fapi4.binance.com',
];

// Cache working hosts to avoid retrying failed ones
let workingSpotHost = PROXY_URL || null;
let workingFapiHost = PROXY_URL || null;

// Minimum candles needed before we can compute features
const MIN_LOOKBACK = 240; // 4 hours warmup for all indicators

// ═══ Seeded PRNG for reproducible training data ═══
// Using mulberry32 — fast 32-bit seeded PRNG (deterministic)
let _prngState = 42;
function seedRng(s) { _prngState = s | 0; }
function seededRandom() {
  _prngState |= 0; _prngState = _prngState + 0x6D2B79F5 | 0;
  let t = Math.imul(_prngState ^ _prngState >>> 15, 1 | _prngState);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ═══ HELPERS for Polymarket feature simulation ═══
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ═══ Polymarket lookup (real data when available) ═══
let polyLookup = null; // { "slug_ts": { label, spread, liquidity, volume, prices: [[secs,price],...] } }

function loadPolymarketLookup(path) {
  try {
    if (!fs.existsSync(path)) {
      console.log(`⚠️  Polymarket lookup not found at ${path} — using simulation fallback`);
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    const count = Object.keys(raw).length;
    console.log(`✅ Polymarket lookup loaded: ${count.toLocaleString()} markets from ${path}`);
    return raw;
  } catch (err) {
    console.log(`⚠️  Failed to load Polymarket lookup: ${err.message} — using simulation fallback`);
    return null;
  }
}


/**
 * Linear interpolation of UP token price at a given seconds-into-market.
 * Uses binary search over sorted [[secs, price], ...] array.
 * Returns null if no price data available.
 */
function interpolatePrice(prices, targetSecs) {
  if (!prices || prices.length === 0) return null;

  // Before first observation: use first price
  if (targetSecs <= prices[0][0]) return prices[0][1];

  // After last observation: use last price
  if (targetSecs >= prices[prices.length - 1][0]) return prices[prices.length - 1][1];

  // Binary search for bracket
  let lo = 0, hi = prices.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid][0] <= targetSecs) lo = mid;
    else hi = mid;
  }

  const [t0, p0] = prices[lo];
  const [t1, p1] = prices[hi];
  if (t1 === t0) return p0;

  // Linear interpolation
  const frac = (targetSecs - t0) / (t1 - t0);
  return p0 + frac * (p1 - p0);
}

function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const raw = process.argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.replace('--', '');
    // Flags without value
    if (key === 'tune') { args[key] = true; continue; }
    if (key === 'deploy') { args[key] = true; continue; }
    // Key-value pairs
    if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
      args[key] = process.argv[i + 1];
      i++;
    }
  }
  if (args.days) args.days = parseInt(args.days);
  if (args['min-move']) args['min-move'] = parseFloat(args['min-move']);
  return args;
}

// ═══ BINANCE FETCH (with retry + multi-host fallback) ═══
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) {
        if (resp.status === 429) {
          console.log(`\n  Rate limited, waiting 10s... (attempt ${attempt}/${retries})`);
          await sleep(10000);
          continue;
        }
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`\n  Fetch failed (attempt ${attempt}/${retries}): ${err.message}. Retrying in 3s...`);
      await sleep(3000);
    }
  }
}

/**
 * Fetch with automatic host fallback.
 * Tries cached working host first, then falls back through host list.
 */
async function fetchWithFallback(path, fallbackHosts, hostType) {
  // If proxy, just use proxy URL directly
  if (PROXY_URL) {
    return await fetchWithRetry(`${PROXY_URL}${path}`);
  }

  // Try cached working host first
  const cached = hostType === 'spot' ? workingSpotHost : workingFapiHost;
  if (cached) {
    try {
      const result = await fetchWithRetry(`${cached}${path}`, 2);
      return result;
    } catch {
      // Cached host failed, clear it
      if (hostType === 'spot') workingSpotHost = null;
      else workingFapiHost = null;
    }
  }

  // Try each fallback host
  for (const host of fallbackHosts) {
    if (host === cached) continue; // already tried
    try {
      const result = await fetchWithRetry(`${host}${path}`, 1);
      // Cache this working host
      if (hostType === 'spot') workingSpotHost = host;
      else workingFapiHost = host;
      console.log(`\n  Connected to ${host}`);
      return result;
    } catch {
      // Try next host
    }
  }

  throw new Error(`All ${hostType} API hosts failed for ${path}`);
}

async function fetchKlinesBatch(startTime, endTime) {
  const path = `/api/v3/klines?symbol=BTCUSDT&interval=${CANDLE_INTERVAL}&startTime=${startTime}&endTime=${endTime}&limit=${LIMIT_PER_REQUEST}`;
  const data = await fetchWithFallback(path, SPOT_FALLBACKS, 'spot');

  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    takerBuyVolume: parseFloat(k[9]),
  }));
}

async function fetchAllKlines(days) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const allCandles = [];

  console.log(`📡 Fetching ${days} days of 1m BTCUSDT klines...`);
  let cursor = startMs;

  while (cursor < endMs) {
    const batch = await fetchKlinesBatch(cursor, endMs);
    if (batch.length === 0) break;

    allCandles.push(...batch);
    cursor = batch[batch.length - 1].openTime + 60000;

    process.stdout.write(`\r  ${allCandles.length} candles fetched...`);

    // Rate limit: Binance allows 1200 req/min
    await sleep(100);
  }

  console.log(`\n✅ Total: ${allCandles.length} candles (${(allCandles.length / 1440).toFixed(1)} days)`);
  return allCandles;
}

// Also fetch 5m klines for multi-TF features
async function fetchAllKlines5m(days) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;
  const allCandles = [];

  console.log(`📡 Fetching ${days} days of 5m klines...`);
  let cursor = startMs;

  while (cursor < endMs) {
    const path = `/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT_PER_REQUEST}`;
    let data;
    try { data = await fetchWithFallback(path, SPOT_FALLBACKS, 'spot'); } catch { break; }
    if (data.length === 0) break;

    const batch = data.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    allCandles.push(...batch);
    cursor = batch[batch.length - 1].openTime + 5 * 60000;

    process.stdout.write(`\r  ${allCandles.length} candles (5m)...`);
    await sleep(100);
  }

  console.log(`\n✅ Total 5m: ${allCandles.length} candles`);
  return allCandles;
}

// Fetch historical funding rates
// Strategy 1: FAPI endpoint (may be blocked in Indonesia)
// Strategy 2: Binance Vision public CSV data (static files, not blocked)
async function fetchFundingRates(days) {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  // Try Strategy 1: FAPI API
  console.log(`📡 Fetching funding rates...`);
  console.log(`   Strategy 1: FAPI endpoints...`);
  let allRates = await fetchFundingRatesAPI(startMs, endMs);

  if (allRates.length > 0) {
    console.log(`✅ Funding rates: ${allRates.length} entries (from API)`);
    return allRates;
  }

  // Strategy 2: Binance Vision public data archive
  console.log(`   Strategy 1 failed (fapi blocked). Trying Strategy 2: Binance Vision CSV...`);
  allRates = await fetchFundingRatesVision(startMs, endMs);

  if (allRates.length > 0) {
    console.log(`✅ Funding rates: ${allRates.length} entries (from Binance Vision)`);
    return allRates;
  }

  // Strategy 3: Bybit API (not blocked in Indonesia)
  console.log(`   Strategy 2 failed. Trying Strategy 3: Bybit API...`);
  allRates = await fetchFundingRatesBybit(startMs, endMs);

  if (allRates.length > 0) {
    console.log(`✅ Funding rates: ${allRates.length} entries (from Bybit)`);
    return allRates;
  }

  console.log(`⚠️  Funding rates: 0 entries (all sources failed)`);
  return allRates;
}

// Strategy 1: Direct FAPI endpoint
async function fetchFundingRatesAPI(startMs, endMs) {
  const allRates = [];
  let cursor = startMs;

  while (cursor < endMs) {
    try {
      const path = `/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      const data = await fetchWithFallback(path, FAPI_FALLBACKS, 'fapi');
      if (data.length === 0) break;

      for (const entry of data) {
        allRates.push({
          time: entry.fundingTime,
          rate: parseFloat(entry.fundingRate),
        });
      }
      cursor = data[data.length - 1].fundingTime + 1;
      await sleep(100);
    } catch { break; }
  }

  return allRates;
}

// Strategy 2: Binance Vision public data archive
// Downloads monthly CSV files from https://data.binance.vision/
// These are STATIC files on CDN — NOT blocked by ISP
async function fetchFundingRatesVision(startMs, endMs) {
  const allRates = [];
  const startDate = new Date(startMs);
  const endDate = new Date(endMs);

  // Build list of months we need
  const months = [];
  const cursor = new Date(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1);
  while (cursor <= endDate) {
    const yyyy = cursor.getUTCFullYear();
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${yyyy}-${mm}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  console.log(`   Downloading ${months.length} months of funding rate data...`);

  for (const month of months) {
    try {
      // Binance Vision CSV URL
      const csvUrl = `https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-${month}.csv`;

      const text = await fetchUrlText(csvUrl, 15000);
      if (!text) continue;

      const lines = text.trim().split('\n');
      // Skip header if present
      const startIdx = lines[0].includes('symbol') || lines[0].includes('calc_time') ? 1 : 0;

      let monthCount = 0;
      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 3) continue;

        let time, rate;

        // Format varies by Binance:
        // Old: symbol, fundingRate, fundingRateTimestamp
        // New: calc_time, symbol, fundingIntervalHours, lastFundingRate, markPrice
        if (parts[0] === 'BTCUSDT' || parts[1] === 'BTCUSDT') {
          if (parts[0] === 'BTCUSDT') {
            // [symbol, fundingRate, timestamp]
            rate = parseFloat(parts[1]);
            time = parseInt(parts[2]);
          } else {
            // [calc_time, symbol, hours, rate, ...]
            time = parseInt(parts[0]);
            rate = parseFloat(parts[3]);
          }
        } else {
          // Fallback: first col = time, last numeric = rate
          time = parseInt(parts[0]);
          for (let j = parts.length - 1; j >= 1; j--) {
            const v = parseFloat(parts[j]);
            if (!isNaN(v) && Math.abs(v) < 1) { rate = v; break; }
          }
        }

        if (isNaN(time) || isNaN(rate)) continue;
        if (time < startMs || time > endMs) continue;

        allRates.push({ time, rate });
        monthCount++;
      }

      if (monthCount > 0) {
        process.stdout.write(`\r   ${month}: ${monthCount} entries (total: ${allRates.length})`);
      }
      await sleep(200);
    } catch { continue; }
  }

  if (allRates.length > 0) console.log('');

  // Sort by time
  allRates.sort((a, b) => a.time - b.time);
  return allRates;
}

// Strategy 3: Bybit API (not geo-blocked like Binance FAPI)
// Bybit funding rate history: max 200 per request, paginate with startTime/endTime
async function fetchFundingRatesBybit(startMs, endMs) {
  const allRates = [];
  let cursor = startMs;

  while (cursor < endMs) {
    try {
      const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200&startTime=${cursor}&endTime=${endMs}`;
      const data = await fetchWithRetry(url, 3);
      const list = data?.result?.list;
      if (!list || list.length === 0) break;

      for (const entry of list) {
        const time = parseInt(entry.fundingRateTimestamp);
        const rate = parseFloat(entry.fundingRate);
        if (!isNaN(time) && !isNaN(rate)) {
          allRates.push({ time, rate });
        }
      }

      // Bybit returns newest first, so find the oldest timestamp for pagination
      const timestamps = list.map(e => parseInt(e.fundingRateTimestamp)).filter(t => !isNaN(t));
      const oldest = Math.min(...timestamps);
      const newest = Math.max(...timestamps);

      // Move cursor past the newest entry we received
      if (newest <= cursor) break; // no progress
      cursor = newest + 1;

      process.stdout.write(`\r   Bybit: ${allRates.length} entries...`);
      await sleep(200); // rate limit
    } catch (err) {
      console.log(`\n   Bybit fetch error: ${err.message}`);
      break;
    }
  }

  if (allRates.length > 0) console.log('');

  // Sort by time ascending
  allRates.sort((a, b) => a.time - b.time);
  return allRates;
}

// Simple URL text fetch helper (for static files like Binance Vision CSVs)
async function fetchUrlText(url, timeout = 15000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 BTC-ML-Trainer' },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.text();
  } catch { return null; }
}

// (sleep defined above)

// ═══ INDICATOR COMPUTATIONS (mirror live code exactly) ═══

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] - closes[i - 1];
    if (c >= 0) avgGain += c; else avgLoss += Math.abs(c);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (c >= 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? Math.abs(c) : 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function computeRSISeries(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const result = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const c = closes[i] - closes[i - 1];
    if (c >= 0) avgGain += c; else avgLoss += Math.abs(c);
  }
  avgGain /= period; avgLoss /= period;
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const c = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (c >= 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? Math.abs(c) : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return result;
}

function slopeLast(series, n) {
  if (series.length < n) return null;
  return (series[series.length - 1] - series[series.length - n]) / n;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaCalc = (data, p) => {
    const k = 2 / (p + 1);
    let v = data.slice(0, p).reduce((a, b) => a + b, 0) / p;
    const r = [v];
    for (let i = p; i < data.length; i++) { v = data[i] * k + v * (1 - k); r.push(v); }
    return r;
  };
  const emaF = emaCalc(closes, fast);
  const emaS = emaCalc(closes, slow);
  const diff = slow - fast;
  const macdLine = [];
  for (let i = 0; i < emaS.length; i++) macdLine.push(emaF[i + diff] - emaS[i]);
  if (macdLine.length < signal) return null;
  const sigLine = emaCalc(macdLine, signal);
  const idx = macdLine.length - 1;
  const sIdx = sigLine.length - 1;
  const hist = macdLine[idx] - sigLine[sIdx];
  const prevHist = idx > 0 && sIdx > 0 ? macdLine[idx - 1] - sigLine[sIdx - 1] : null;
  return { macd: macdLine[idx], signal: sigLine[sIdx], hist, histDelta: prevHist !== null ? hist - prevHist : null };
}

function computeVWAP(candles, lookback) {
  const start = Math.max(0, candles.length - lookback);
  let cumPV = 0, cumV = 0;
  const series = [];
  for (let i = start; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPV += tp * candles[i].volume;
    cumV += candles[i].volume;
    series.push(cumV > 0 ? cumPV / cumV : candles[i].close);
  }
  return series;
}

function computeHeikenAshi(candles) {
  if (candles.length < 2) return [];
  const ha = [];
  let prevC = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
  let prevO = candles[0].open;
  for (let i = 0; i < candles.length; i++) {
    const c = (candles[i].open + candles[i].high + candles[i].low + candles[i].close) / 4;
    const o = (prevO + prevC) / 2;
    ha.push({ open: o, close: c, color: c >= o ? 'green' : 'red' });
    prevO = o; prevC = c;
  }
  return ha;
}

function countConsecutive(ha) {
  if (ha.length === 0) return { color: null, count: 0 };
  const last = ha[ha.length - 1].color;
  let count = 0;
  for (let i = ha.length - 1; i >= 0 && ha[i].color === last; i--) count++;
  return { color: last, count };
}

function countVwapCrosses(closes, vwapSeries, lookback) {
  // vwapSeries is shorter than closes (e.g., 60 vs 240).
  // Both arrays are aligned at their ENDS (last element = current candle).
  if (vwapSeries.length < lookback) return 0;
  const offset = closes.length - vwapSeries.length; // index offset to align ends
  let crosses = 0;
  for (let i = vwapSeries.length - lookback + 1; i < vwapSeries.length; i++) {
    const prev = closes[i + offset - 1] - vwapSeries[i - 1];
    const cur = closes[i + offset] - vwapSeries[i];
    if (prev !== 0 && ((prev > 0 && cur < 0) || (prev < 0 && cur > 0))) crosses++;
  }
  return crosses;
}

function computeBollingerBands(closes, period = 20, stdMult = 2) {
  if (closes.length < period) return null;
  const len = closes.length;
  let sum = 0;
  for (let i = len - period; i < len; i++) sum += closes[i];
  const middle = sum / period;
  let sqSum = 0;
  for (let i = len - period; i < len; i++) { const d = closes[i] - middle; sqSum += d * d; }
  const std = Math.sqrt(sqSum / period);
  const upper = middle + stdMult * std;
  const lower = middle - stdMult * std;
  const width = middle !== 0 ? (upper - lower) / middle : 0;
  const range = upper - lower;
  const percentB = range !== 0 ? (closes[len - 1] - lower) / range : 0.5;

  // Squeeze
  const squeezeLookback = Math.min(50, len - period);
  let squeeze = false, squeezeIntensity = 0;
  if (squeezeLookback >= 10) {
    const widths = [];
    for (let offset = 0; offset < squeezeLookback; offset++) {
      const end = len - offset;
      const start = end - period;
      if (start < 0) break;
      let s = 0;
      for (let i = start; i < end; i++) s += closes[i];
      const m = s / period;
      let sq = 0;
      for (let i = start; i < end; i++) { const d2 = closes[i] - m; sq += d2 * d2; }
      const sd = Math.sqrt(sq / period);
      widths.push(m !== 0 ? (2 * stdMult * sd) / m : 0);
    }
    let avgW = 0;
    for (let i = 0; i < widths.length; i++) avgW += widths[i];
    avgW /= widths.length;
    squeeze = width < avgW * 0.75;
    squeezeIntensity = avgW > 0 ? Math.max(0, Math.min(1, 1 - width / avgW)) : 0;
  }
  return { width, percentB, squeeze, squeezeIntensity };
}

function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const len = candles.length;
  const trs = [];
  for (let i = 1; i < len; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    ));
  }
  if (trs.length < period) return null;
  const trLen = trs.length;
  let atr = 0;
  for (let i = trLen - period; i < trLen; i++) atr += trs[i];
  atr /= period;
  const price = candles[len - 1].close;
  const atrPct = price > 0 ? (atr / price) * 100 : 0;
  const longP = Math.min(period * 2, trLen);
  let longAtr = 0;
  for (let i = trLen - longP; i < trLen; i++) longAtr += trs[i];
  longAtr /= longP;
  const atrRatio = longAtr > 0 ? atr / longAtr : 1;
  return { atr, atrPct, atrRatio, expanding: atrRatio > 1.1 };
}

function computeVolumeDelta(candles, recent = 10) {
  if (candles.length < recent) return null;
  const len = candles.length;
  let buyVol = 0, totalVol = 0;
  for (let i = len - recent; i < len; i++) {
    buyVol += candles[i].takerBuyVolume || 0;
    totalVol += candles[i].volume || 0;
  }
  const buyRatio = totalVol > 0 ? buyVol / totalVol : 0.5;

  // Acceleration
  let deltaAccel = 0;
  const accelLookback = 20;
  if (candles.length >= accelLookback) {
    let olderBuy = 0, olderTotal = 0;
    for (let i = len - accelLookback; i < len - recent; i++) {
      olderBuy += candles[i].takerBuyVolume || 0;
      olderTotal += candles[i].volume || 0;
    }
    const olderRatio = olderTotal > 0 ? olderBuy / olderTotal : 0.5;
    deltaAccel = buyRatio - olderRatio;
  }
  return { buyRatio, deltaAccel };
}

function computeEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  const result = new Array(data.length).fill(null);
  result[period - 1] = sum / period;
  for (let i = period; i < data.length; i++) result[i] = data[i] * k + result[i - 1] * (1 - k);
  return result;
}

function computeEmaCrossover(closes) {
  if (closes.length < 23) return null;
  const ema8 = computeEMA(closes, 8);
  const ema21 = computeEMA(closes, 21);
  const len = closes.length;
  const fast = ema8[len - 1], slow = ema21[len - 1];
  const prevFast = ema8[len - 2], prevSlow = ema21[len - 2];
  if (fast === null || slow === null || prevFast === null || prevSlow === null) return null;

  const distancePct = closes[len - 1] > 0 ? ((fast - slow) / closes[len - 1]) * 100 : 0;
  const prevDiff = prevFast - prevSlow, currDiff = fast - slow;
  let cross = 0; // 0=none, 1=bull, -1=bear
  if (prevDiff <= 0 && currDiff > 0) cross = 1;
  else if (prevDiff >= 0 && currDiff < 0) cross = -1;
  return { distancePct, cross };
}

function computeStochRSI(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const minLen = rsiPeriod + stochPeriod + smoothK + smoothD;
  if (closes.length < minLen) return null;

  const rsi = computeRSISeries(closes, rsiPeriod);
  if (rsi.length < stochPeriod + smoothK + smoothD) return null;

  const stochRaw = [];
  for (let i = stochPeriod - 1; i < rsi.length; i++) {
    let mn = Infinity, mx = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsi[j] < mn) mn = rsi[j];
      if (rsi[j] > mx) mx = rsi[j];
    }
    stochRaw.push(mx - mn > 0 ? (rsi[i] - mn) / (mx - mn) : 0.5);
  }
  if (stochRaw.length < smoothK + smoothD) return null;

  const kSeries = [];
  for (let i = smoothK - 1; i < stochRaw.length; i++) {
    let s = 0;
    for (let j = i - smoothK + 1; j <= i; j++) s += stochRaw[j];
    kSeries.push(s / smoothK);
  }
  if (kSeries.length < smoothD + 1) return null;

  const dSeries = [];
  for (let i = smoothD - 1; i < kSeries.length; i++) {
    let s = 0;
    for (let j = i - smoothD + 1; j <= i; j++) s += kSeries[j];
    dSeries.push(s / smoothD);
  }
  if (dSeries.length < 2) return null;

  const k = kSeries[kSeries.length - 1] * 100;
  const d = dSeries[dSeries.length - 1] * 100;
  return { k, d, kd: k - d };
}

// Audit fix C7: Synced with live src/engines/regime.js v3 thresholds.
// CRITICAL: Previous version used raw absSlope ($/candle) vs live normalizedAbsSlope (slope/vwap).
// With BTC at ~$90k, raw slope > 0.05 fired on nearly everything, while live normalized
// threshold 0.00005 is meaningful. Choppy thresholds also differed (3 vs 4 crosses, 0.0015 vs 0.002).
function detectRegime(price, vwap, vwapSlope, vwapCrossCount, volumeRatio) {
  if (!vwap || !price) return { regime: 'moderate', confidence: 0.5 };
  const vwapDist = Math.abs(price - vwap) / vwap;
  // v3 fix: Normalize slope to percentage of VWAP (matches live regime.js exactly)
  const normalizedAbsSlope = vwap > 0 ? Math.abs(vwapSlope || 0) / vwap : 0;

  // Choppy: many crosses + price near VWAP (v3: 4+ crosses, dist < 0.002)
  if ((vwapCrossCount || 0) >= 4 && vwapDist < 0.002) {
    const confidence = 0.3 + Math.min((vwapCrossCount || 0) / 8, 0.4);
    return { regime: 'choppy', confidence };
  }
  // Trending: price far from VWAP + directional slope (v3: normalized slope > 0.00005)
  if (vwapDist > 0.0008 && normalizedAbsSlope > 0.00005) {
    const volBoost = volumeRatio > 1.2 ? 0.10 : 0;
    const confidence = Math.min(0.6 + vwapDist * 200 + volBoost, 0.95);
    return { regime: 'trending', confidence };
  }
  // Trending: very far from VWAP regardless of slope (weaker)
  if (vwapDist > 0.002) {
    const confidence = Math.min(0.50 + vwapDist * 80, 0.75);
    return { regime: 'trending', confidence };
  }
  // Mean reverting: price very close to VWAP, low slope, few crosses (v3: normalized slope < 0.00003)
  if (vwapDist < 0.0005 && normalizedAbsSlope < 0.00003 && (vwapCrossCount == null || vwapCrossCount < 3))
    return { regime: 'mean_reverting', confidence: 0.5 };
  return { regime: 'moderate', confidence: 0.5 };
}

function getSessionName(timestamp) {
  const h = new Date(timestamp).getUTCHours();
  if (h >= 13 && h < 16) return 'EU/US Overlap';
  if (h >= 13 && h < 22) return 'US';
  if (h >= 8 && h < 16) return 'Europe';
  if (h >= 0 && h < 8) return 'Asia';
  return 'Off-hours';
}

// ═══ FUNDING RATE LOOKUP ═══
// Binary search for most recent funding rate at or before given timestamp
function lookupFundingRate(fundingRates, timestamp) {
  if (!fundingRates || fundingRates.length === 0) return null;
  let lo = 0, hi = fundingRates.length - 1;
  if (fundingRates[0].time > timestamp) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (fundingRates[mid].time <= timestamp) lo = mid;
    else hi = mid - 1;
  }
  return fundingRates[lo];
}

// ═══ FEATURE EXTRACTION (mirrors Mlpredictor.js exactly) ═══
function extractFeatures(candles, idx, candles5m, fundingRates) {
  // We need at least MIN_LOOKBACK candles before idx
  if (idx < MIN_LOOKBACK) return null;
  // Need PREDICTION_WINDOW candles after for label
  if (idx + PREDICTION_WINDOW >= candles.length) return null;

  // Slice candles up to (including) idx
  const slice = candles.slice(Math.max(0, idx - 239), idx + 1);
  const closes = slice.map(c => c.close);
  const price = candles[idx].close;
  const timestamp = candles[idx].openTime;

  // ═══ Match to Polymarket market ═══
  const candleTimeSec = Math.floor(candles[idx].openTime / 1000);
  const slugTs = Math.floor(candleTimeSec / 900) * 900;
  const polyMarket = polyLookup?.[String(slugTs)] ?? null;

  // Label: real Polymarket resolution or Binance price direction
  let label;
  if (polyMarket) {
    label = polyMarket.label;
    // No min-move filter for Polymarket-labeled rows (definitively resolved)
  } else {
    const futurePrice = candles[idx + PREDICTION_WINDOW].close;
    label = futurePrice > price ? 1 : 0;
    // Label engineering: skip ambiguous samples (simulation only)
    const priceMoveAbs = Math.abs(futurePrice - price) / price;
    if (priceMoveAbs < MIN_MOVE_PCT) return null;
  }

  // Use open price of current candle window as "priceToBeat" (simulate)
  // In live: this comes from Polymarket. For training we simulate with price 15 bars ago
  const priceToBeat = idx >= 15 ? candles[idx - 15].close : price;
  const ptbDistPct = priceToBeat ? (price - priceToBeat) / priceToBeat : 0;

  // RSI — must match config.js rsiPeriod: 8
  const rsi = computeRSI(closes, 8);
  const rsiSeries = computeRSISeries(closes, 8);
  const rsiSlope = slopeLast(rsiSeries, 3);

  // MACD — must match config.js macdFast:6, macdSlow:13, macdSignal:5
  const macd = computeMACD(closes, 6, 13, 5);

  // VWAP — must match config.js vwapLookbackCandles: 60
  const vwapSeries = computeVWAP(slice, Math.min(60, slice.length));
  const vwapNow = vwapSeries[vwapSeries.length - 1];
  const vwapLookback = 5;
  const vwapSlope = vwapSeries.length >= vwapLookback
    ? (vwapNow - vwapSeries[vwapSeries.length - vwapLookback]) / vwapLookback
    : 0;
  const vwapDist = vwapNow ? (price - vwapNow) / vwapNow : 0;

  // Heiken Ashi
  const ha = computeHeikenAshi(slice);
  const consec = countConsecutive(ha);
  const isGreen = consec.color === 'green';
  const haSignedConsec = isGreen ? consec.count : -consec.count;

  // Deltas
  const cLen = closes.length;
  const delta1m = cLen >= 2 ? closes[cLen - 1] - closes[cLen - 2] : 0;
  const delta3m = cLen >= 4 ? closes[cLen - 1] - closes[cLen - 4] : 0;

  // Volume
  let volRecent = 0, volTotal120 = 0;
  for (let i = Math.max(0, cLen - 20); i < cLen; i++) volRecent += slice[i].volume;
  for (let i = Math.max(0, cLen - 120); i < cLen; i++) volTotal120 += slice[i].volume;
  const volAvg = volTotal120 / 6;
  const volRatio = volAvg > 0 ? volRecent / volAvg : 1;

  // VWAP crosses
  const vwapCrossCount = countVwapCrosses(closes, vwapSeries, 20);

  // Failed VWAP reclaim
  const failedVwapReclaim = vwapNow && vwapSeries.length >= 3
    ? closes[cLen - 1] < vwapNow && closes[cLen - 2] > vwapSeries[vwapSeries.length - 2]
    : false;

  // Regime (aligned with live regime.js v2)
  const regimeResult = detectRegime(price, vwapNow, vwapSlope, vwapCrossCount, volRatio);
  const regime = regimeResult.regime;
  const regimeConfidence = regimeResult.confidence;

  // Session
  const session = getSessionName(timestamp);

  // minutesLeft: real remaining time from Polymarket or seeded PRNG fallback
  let minutesLeft;
  if (polyMarket) {
    const secsRemaining = 900 - (candleTimeSec - slugTs);
    minutesLeft = Math.max(1, Math.min(14, Math.floor(secsRemaining / 60)));
  } else {
    minutesLeft = 1 + Math.floor(seededRandom() * 14); // legacy fallback
  }

  // ═══ Bollinger Bands (computed early for rule prob) ═══
  const bb = computeBollingerBands(closes, 20, 2);

  // ═══ EMA Crossover (computed early for rule prob) ═══
  const ema = computeEmaCrossover(closes);

  // ═══ Rule probability simulation (~8-factor scoring, closer to live 21-point system) ═══
  let ruleScore = 0;
  // 1. PTB distance — strongest signal
  ruleScore += ptbDistPct * 3;
  // 2. RSI
  ruleScore += rsi != null ? (rsi > 60 ? 0.04 : rsi < 40 ? -0.04 : (rsi - 50) / 500) : 0;
  // 3. MACD histogram direction
  ruleScore += macd?.hist > 0 ? 0.03 : macd?.hist < 0 ? -0.03 : 0;
  // 4. VWAP position
  ruleScore += vwapDist > 0 ? 0.02 : vwapDist < 0 ? -0.02 : 0;
  // 5. Heiken Ashi
  ruleScore += isGreen ? 0.02 : -0.02;
  // 6. Delta 1m direction
  ruleScore += delta1m > 0 ? 0.02 : delta1m < 0 ? -0.02 : 0;
  // 7. EMA cross
  ruleScore += ema?.cross === 1 ? 0.03 : ema?.cross === -1 ? -0.03 : 0;
  // 8. Bollinger %B
  ruleScore += (bb?.percentB ?? 0.5) > 0.6 ? 0.02 : (bb?.percentB ?? 0.5) < 0.4 ? -0.02 : 0;

  const ruleProbUp = Math.max(0.1, Math.min(0.9, 0.5 + ruleScore));
  const ruleConfidence = Math.abs(ruleProbUp - 0.5) * 2;
  const bestEdge = Math.abs(ruleProbUp - 0.5) * 0.3;

  // Multi-TF
  let multiTfAgreement = false;
  if (candles5m.length > 2) {
    // Find the closest 5m candle to current timestamp
    let ci = candles5m.length - 1;
    while (ci > 0 && candles5m[ci].openTime > timestamp) ci--;
    if (ci >= 2) {
      const d5m = candles5m[ci].close - candles5m[ci - 1].close;
      multiTfAgreement = (delta1m > 0 && d5m > 0) || (delta1m < 0 && d5m < 0);
    }
  }

  // ═══ ATR ═══
  const atr = computeATR(slice, 14);

  // ═══ Volume Delta ═══
  const vd = computeVolumeDelta(slice, 10);

  // ═══ StochRSI ═══
  const stoch = computeStochRSI(closes, 14, 14, 3, 3);

  // ═══ BUILD 54-FEATURE VECTOR (exact same order as Mlpredictor.js) ═══
  // 49 original base + 3 lag features + 2 funding rate (SM removed in v13)
  const features = new Array(54);

  // Numerical (16)
  features[0]  = ptbDistPct;
  features[1]  = (rsi ?? 50) / 100;
  features[2]  = rsiSlope ?? 0;
  features[3]  = macd?.hist ?? 0;
  features[4]  = macd?.macd ?? 0;
  features[5]  = vwapDist;
  features[6]  = vwapSlope;
  features[7]  = haSignedConsec / 15;
  features[8]  = delta1m / price;
  features[9]  = delta3m / price;
  features[10] = Math.min(volRatio, 5) / 5;
  features[11] = minutesLeft / 15;
  features[12] = Math.max(0, Math.min(1, ruleProbUp));
  features[13] = ruleConfidence;
  features[14] = Math.min(vwapCrossCount, 10) / 10;
  features[15] = Math.min(bestEdge, 0.5);

  // Regime (4): trending, confidence, mean_reverting, moderate
  features[16] = regime === 'trending'       ? 1 : 0;
  features[17] = Math.max(0, Math.min(1, regimeConfidence));
  features[18] = regime === 'mean_reverting' ? 1 : 0;
  features[19] = regime === 'moderate' || regime === 'choppy' ? 1 : 0;

  // One-hot: Session (5)
  features[20] = session === 'Asia'           ? 1 : 0;
  features[21] = session === 'Europe'         ? 1 : 0;
  features[22] = session === 'US'             ? 1 : 0;
  features[23] = session === 'EU/US Overlap'  ? 1 : 0;
  features[24] = session === 'Off-hours'      ? 1 : 0;

  // Binary flags (3)
  features[25] = isGreen ? 1 : 0;
  features[26] = multiTfAgreement ? 1 : 0;
  features[27] = failedVwapReclaim ? 1 : 0;

  // Bollinger Bands (3)
  features[28] = bb?.width ?? 0;
  features[29] = bb?.percentB ?? 0.5;
  features[30] = bb?.squeeze ? 1 : 0;

  // ATR (3)
  features[31] = atr ? Math.min(atr.atrPct, 2) / 2 : 0.5;
  features[32] = atr ? Math.min(atr.atrRatio, 3) / 3 : 0.33;
  features[33] = atr?.expanding ? 1 : 0;

  // Volume Delta (2)
  features[34] = vd?.buyRatio ?? 0.5;
  features[35] = vd?.deltaAccel != null ? Math.max(-0.5, Math.min(0.5, vd.deltaAccel)) + 0.5 : 0.5;

  // EMA Crossover (2)
  features[36] = ema?.distancePct != null ? Math.max(-1, Math.min(1, ema.distancePct * 10)) / 2 + 0.5 : 0.5;
  features[37] = ema ? (ema.cross + 1) / 2 : 0.5;

  // StochRSI (2)
  features[38] = stoch ? stoch.k / 100 : 0.5;
  features[39] = stoch ? Math.max(-50, Math.min(50, stoch.kd)) / 100 + 0.5 : 0.5;

  // Volume Acceleration + BB Squeeze Intensity (replaced dead funding rate features)
  features[40] = Math.min(volRatio, 3) / 3; // volume_acceleration: normalized [0,1]
  features[41] = bb?.squeezeIntensity ?? 0;  // bb_squeeze_intensity: [0,1]

  // Time cyclical encoding (2) — captures hour-of-day patterns
  const hourUTC = new Date(timestamp).getUTCHours() + new Date(timestamp).getUTCMinutes() / 60;
  features[42] = Math.sin(hourUTC / 24 * 2 * Math.PI);
  features[43] = Math.cos(hourUTC / 24 * 2 * Math.PI);

  // ═══ Polymarket features (5) — REAL DATA ONLY (no simulation fallback) ═══
  // Audit fix (Apr 2026): feature 44-48 previously used interpolatePrice(polyPrices, secsIntoMarket)
  // which leaks post-hoc outcome info — price at minute 10 of a 15-min window already discounts
  // 10 minutes of resolution. Use price at MARKET OPEN (capped at first 60s) as a stable,
  // pre-resolution crowd signal that is genuinely tradeable at any entry time.
  const polyPrices = polyMarket?.prices;
  if (!polyPrices || polyPrices.length === 0) {
    return null; // drop sample — simulation fallback removed (distribution mismatch hurts real perf)
  }

  // Use price sampled in first 60s of market — represents pre-trade crowd sentiment
  const openUpPrice = interpolatePrice(polyPrices, Math.min(60, polyPrices[0][0]));
  if (openUpPrice === null) {
    return null; // defensive: interpolate somehow failed
  }

  // [44] market_yes_price — UP token price at market open (NOT at observation time)
  features[44] = Math.max(0.01, Math.min(0.99, openUpPrice));

  // [45] market_price_momentum — early discovery: price at +60s vs price at open
  // Captures initial crowd reaction, not mid-window drift (which leaks outcome).
  const priceEarly = interpolatePrice(polyPrices, Math.min(120, polyPrices[polyPrices.length - 1][0]));
  const priceOpen0 = interpolatePrice(polyPrices, 0);
  features[45] = (priceEarly !== null && priceOpen0 !== null)
    ? Math.max(-0.1, Math.min(0.1, priceEarly - priceOpen0))
    : 0;

  // [46] orderbook_imbalance — from open price (signed crowd conviction at entry)
  features[46] = Math.max(-1, Math.min(1, (openUpPrice - 0.5) * 2));

  // [47] spread_pct — real spread from master data
  features[47] = Math.max(0, Math.min(1, polyMarket.spread ?? 0));

  // [48] crowd_model_divergence — |rule prob - open crowd price|
  features[48] = Math.abs(Math.max(0, Math.min(1, ruleProbUp)) - openUpPrice);

  // ═══ Lag features (temporal memory) — [49-51] ═══

  // [49] momentum_5candle_slope — 5-candle price slope, normalized by price
  const slope5 = cLen >= 6 ? (closes[cLen - 1] - closes[cLen - 6]) / (5 * price) : 0;
  features[49] = Math.max(-0.01, Math.min(0.01, slope5));

  // [50] volatility_change_ratio — stddev(returns last 5) / stddev(returns last 20)
  // Captures short-term vol expansion/contraction
  let volChangeRatio = 0.5;
  if (cLen >= 21) {
    const returns5 = [];
    for (let k = cLen - 5; k < cLen; k++) returns5.push((closes[k] - closes[k - 1]) / closes[k - 1]);
    const returns20 = [];
    for (let k = cLen - 20; k < cLen; k++) returns20.push((closes[k] - closes[k - 1]) / closes[k - 1]);
    const stddev = (arr) => {
      const mu = arr.reduce((a, b) => a + b, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
    };
    const std5 = stddev(returns5);
    const std20 = stddev(returns20);
    volChangeRatio = std20 > 1e-10 ? std5 / std20 : 1;
  }
  features[50] = Math.min(volChangeRatio, 3) / 3;

  // [51] price_consistency — fraction of last 10 candles moving in same direction as current delta1m
  let consistency = 0.5;
  if (cLen >= 11 && delta1m !== 0) {
    const dir = delta1m > 0 ? 1 : -1;
    let sameDir = 0;
    for (let k = cLen - 10; k < cLen; k++) {
      const candleDir = closes[k] > closes[k - 1] ? 1 : closes[k] < closes[k - 1] ? -1 : 0;
      if (candleDir === dir) sameDir++;
    }
    consistency = sameDir / 10;
  }
  features[51] = consistency;

  // ═══ Funding rate features (2) — [52-53] ═══
  const fr = lookupFundingRate(fundingRates, timestamp);
  const frRate = fr?.rate ?? 0; // raw rate, e.g., 0.0001
  const frRatePct = frRate * 100; // as percent, e.g., 0.01
  features[52] = Math.max(-1, Math.min(1, frRatePct / 0.1)); // funding_rate_norm

  // funding_rate_change: current rate vs 8h ago (direction of sentiment shift)
  const fr8hAgo = lookupFundingRate(fundingRates, timestamp - 8 * 3600_000);
  const rate8h = fr8hAgo?.rate ?? 0;
  features[53] = Math.max(-1, Math.min(1, (frRate - rate8h) * 1000)); // funding_rate_change

  // SM features REMOVED in v13 — empirically hurt accuracy (v9 77.9% > v9a 74.4%)
  // SM data used as post-ML filter gate only (MetEngine in tradeFilters.js)

  return { features, label, slugTs: polyMarket ? slugTs : null };
}

// ═══ FEATURE NAMES (for CSV header) ═══
const FEATURE_NAMES = [
  'ptb_dist_pct', 'rsi_norm', 'rsi_slope', 'macd_hist', 'macd_line',
  'vwap_dist', 'vwap_slope', 'ha_signed_consec', 'delta_1m_pct', 'delta_3m_pct',
  'vol_ratio_norm', 'minutes_left_norm', 'rule_prob_up', 'rule_confidence',
  'vwap_cross_count_norm', 'best_edge',
  'regime_trending', 'regime_confidence', 'regime_mean_reverting', 'regime_moderate',
  'session_asia', 'session_europe', 'session_us', 'session_overlap', 'session_offhours',
  'ha_is_green', 'multi_tf_agreement', 'failed_vwap_reclaim',
  'bb_width', 'bb_percent_b', 'bb_squeeze',
  'atr_pct_norm', 'atr_ratio_norm', 'atr_expanding',
  'vol_delta_buy_ratio', 'vol_delta_accel',
  'ema_dist_norm', 'ema_cross_signal',
  'stoch_k_norm', 'stoch_kd_norm',
  'volume_acceleration', 'bb_squeeze_intensity',
  'hour_sin', 'hour_cos',
  'market_yes_price', 'market_price_momentum', 'orderbook_imbalance',
  'spread_pct', 'crowd_model_divergence',
  'momentum_5candle_slope', 'volatility_change_ratio', 'price_consistency',
  'funding_rate_norm', 'funding_rate_change',
];

// ═══ MAIN ═══
async function main() {
  console.log(`\n=== Training Data Generator v13 (54 features + real Polymarket, NO smart money) ===`);
  console.log(`Days: ${DAYS} | Window: ${PREDICTION_WINDOW}min | Min-move: ${(MIN_MOVE_PCT*100).toFixed(3)}% | Output: ${OUTPUT_FILE}`);
  if (PROXY_URL) {
    console.log(`API: ${PROXY_URL} (proxy mode)`);
  } else {
    console.log(`Spot API fallbacks: ${SPOT_FALLBACKS.length} hosts`);
    console.log(`Futures API fallbacks: ${FAPI_FALLBACKS.length} hosts`);
  }
  console.log();

  // Load Polymarket lookup (real data for labels, features 44-48, minutesLeft)
  polyLookup = loadPolymarketLookup(POLYMARKET_LOOKUP_PATH);

  // Seed PRNG for reproducible minutesLeft values (used as fallback)
  seedRng(42);

  // Fetch data
  const candles1m = await fetchAllKlines(DAYS);
  const candles5m = await fetchAllKlines5m(DAYS);
  const fundingRates = await fetchFundingRates(DAYS);

  // Generate features
  // Audit fix (Apr 2026): previously step=5 with PREDICTION_WINDOW=15 caused heavy correlation —
  // 3 samples per 15-min market share identical outcome + near-identical open-price features.
  // Now: step=1 candle scan with dedup-to-1 per market slug.
  //
  // V2 fix (Apr 2026): original dedup picked first valid candle per slug (ascending loop
  // order) which pinned ALL non-Polymarket features to market-open time (minutes_left_norm
  // mean=0.93, std=0.004). This created massive train/serve skew — live bot polls across
  // all phases (EARLY/MID/LATE/VERY_LATE) but model saw only t=0 snapshots, causing
  // pathological predictions (0-18% ML conf in v24 deploy).
  //
  // New approach: collect ALL candidates per slug, then pick ONE at random per slug using
  // seeded RNG. Effective sample size = number of unique Polymarket markets, with features
  // sampled across the 15-min window matching live distribution.
  console.log(`\n🔧 Generating features (min-move filter: ${(MIN_MOVE_PCT*100).toFixed(3)}%, random-per-slug dedup)...`);
  const rows = [];
  const candidatesPerSlug = new Map(); // slugTs -> [result, result, ...]
  let filteredCount = 0;
  let dupCount = 0;
  let totalCandidates = 0;

  for (let i = MIN_LOOKBACK; i < candles1m.length - PREDICTION_WINDOW; i += 1) {
    totalCandidates++;
    const result = extractFeatures(candles1m, i, candles5m, fundingRates);
    if (!result) {
      filteredCount++;
      continue;
    }
    // Non-Polymarket samples (simulated labels) pass through directly.
    if (result.slugTs === null) {
      rows.push(result);
      continue;
    }
    // Polymarket samples: collect all candidates per slug for random selection.
    if (!candidatesPerSlug.has(result.slugTs)) {
      candidatesPerSlug.set(result.slugTs, []);
    }
    candidatesPerSlug.get(result.slugTs).push(result);

    if (totalCandidates % 10000 === 0) {
      process.stdout.write(`\r  scanned ${totalCandidates} | collected ${rows.length + candidatesPerSlug.size} | slugs ${candidatesPerSlug.size}`);
    }
  }

  // Pick one candidate per slug at random (seeded RNG for reproducibility).
  for (const [slugTs, list] of candidatesPerSlug) {
    const picked = list[Math.floor(rng() * list.length)];
    rows.push(picked);
    dupCount += list.length - 1;
  }
  console.log(`\n  Collected ${candidatesPerSlug.size} unique slugs | Dropped ${dupCount} non-picked candidates`);

  console.log(`\n✅ Generated ${rows.length} training samples`);
  console.log(`   Filtered ${filteredCount} ambiguous samples (move < ${(MIN_MOVE_PCT*100).toFixed(3)}%, ${(filteredCount/totalCandidates*100).toFixed(1)}% of candidates)`);

  // Stats: count real vs simulated
  const realCount = rows.filter(r => r.slugTs !== null).length;
  const simCount = rows.length - realCount;
  console.log(`   Real Polymarket labels: ${realCount} (${(realCount/rows.length*100).toFixed(1)}%)`);
  console.log(`   Simulated labels: ${simCount} (${(simCount/rows.length*100).toFixed(1)}%)`);

  // Write CSV (slug_timestamp metadata column added after features, before label)
  const header = FEATURE_NAMES.join(',') + ',slug_timestamp,label';
  const csvRows = rows.map(r =>
    r.features.map(f => Number.isFinite(f) ? f.toFixed(8) : '0').join(',') +
    ',' + (r.slugTs ?? '') +
    ',' + r.label
  );

  fs.writeFileSync(OUTPUT_FILE, [header, ...csvRows].join('\n'));
  console.log(`💾 Saved to ${OUTPUT_FILE} (${(fs.statSync(OUTPUT_FILE).size / 1024 / 1024).toFixed(1)} MB)`);

  // Compute and save normalization stats
  const nf = FEATURE_NAMES.length; // 54
  const means = new Array(nf).fill(0);
  const stds = new Array(nf).fill(0);
  const n = rows.length;

  for (const row of rows) {
    for (let j = 0; j < nf; j++) means[j] += row.features[j];
  }
  for (let j = 0; j < nf; j++) means[j] /= n;

  for (const row of rows) {
    for (let j = 0; j < nf; j++) {
      const d = row.features[j] - means[j];
      stds[j] += d * d;
    }
  }
  for (let j = 0; j < nf; j++) stds[j] = Math.sqrt(stds[j] / n);

  // Prevent div-by-zero for binary/constant features
  for (let j = 0; j < nf; j++) {
    if (stds[j] < 1e-8) stds[j] = 1;
  }

  const normStats = { means, stds, featureNames: FEATURE_NAMES, numFeatures: nf };
  fs.writeFileSync('norm_stats.json', JSON.stringify(normStats, null, 2));
  console.log(`💾 Saved norm_stats.json`);

  // Label distribution
  const upCount = rows.filter(r => r.label === 1).length;
  console.log(`\n📊 Label distribution: UP=${upCount} (${(upCount/n*100).toFixed(1)}%) | DOWN=${n-upCount} (${((n-upCount)/n*100).toFixed(1)}%)`);
  console.log(`\n✅ Done! Next step: python trainXGBoost_v3.py --input ${OUTPUT_FILE} --tune`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
