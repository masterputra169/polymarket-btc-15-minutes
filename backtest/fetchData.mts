/**
 * ═══ Backtest Data Fetcher v2 ═══
 * 
 * Fetches historical BTC 1m candles from Binance public API.
 * Tries multiple endpoints in case one is blocked.
 * 
 * Usage: node backtest/fetchData.mts [days]
 * Example: node backtest/fetchData.mts 7    → fetch last 7 days
 *          node backtest/fetchData.mts 30   → fetch last 30 days
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const SYMBOL = 'BTCUSDT';

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  ...unknown[],
];

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

// Multiple endpoints — tries in order until one works
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

/**
 * HTTPS GET with timeout — works on all Node.js versions.
 */
function httpsGet<T = unknown>(url, timeoutMs = 15000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === 451 || res.statusCode === 403) {
        reject(new Error(`HTTP ${res.statusCode} — endpoint blocked in your region`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

/**
 * Try multiple Binance endpoints until one works.
 */
let workingEndpoint = null;

async function binanceGet<T = unknown>(apiPath): Promise<T> {
  // If we already found a working endpoint, use it
  if (workingEndpoint) {
    return httpsGet<T>(`${workingEndpoint}${apiPath}`);
  }

  // Try each endpoint
  const errors = [];
  for (const base of BINANCE_ENDPOINTS) {
    try {
      process.stdout.write(`  Trying ${base}... `);
      const result = await httpsGet<T>(`${base}${apiPath}`);
      workingEndpoint = base;
      console.log('✅ Works!');
      return result;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      errors.push(`${base}: ${err.message}`);
    }
  }

  // All failed
  console.error('\n❌ All Binance endpoints failed!');
  console.error('💡 Solutions:');
  console.error('   1. Try using a VPN');
  console.error('   2. Check your internet connection');
  console.error('   3. Binance might be temporarily down');
  throw new Error('All endpoints failed');
}

/**
 * Fetch klines from Binance with pagination (max 1000 per request).
 */
async function fetchKlinesBatch(interval, startTime, endTime, limit = 1000): Promise<Candle[]> {
  const apiPath = `/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
  const raw = await binanceGet<BinanceKline[]>(apiPath);

  return raw.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

/**
 * Fetch ALL candles for a date range with automatic pagination.
 */
async function fetchAllKlines(interval, startTime, endTime) {
  const allCandles = [];
  let cursor = startTime;
  let batch = 0;
  const totalMs = endTime - startTime;
  const startedAt = Date.now();

  while (cursor < endTime) {
    batch++;
    const candles = await fetchKlinesBatch(interval, cursor, endTime);
    if (candles.length === 0) break;

    allCandles.push(...candles);
    cursor = candles[candles.length - 1].closeTime + 1;

    // Progress with ETA
    const progress = (cursor - startTime) / totalMs * 100;
    const progressPct = progress.toFixed(1);
    const elapsed = (Date.now() - startedAt) / 1000;
    const estimatedTotal = elapsed / (progress / 100);
    const etaSeconds = Math.max(0, estimatedTotal - elapsed);
    const etaMin = Math.floor(etaSeconds / 60);
    const etaSec = Math.floor(etaSeconds % 60);

    process.stdout.write(
      `\r  Batch ${batch}: ${allCandles.length} candles (${progressPct}%) ETA: ${etaMin}m${etaSec}s   `
    );

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n  Total: ${allCandles.length} candles`);
  return allCandles;
}

async function main() {
  const days = parseInt(process.argv[2] || '7', 10);
  console.log(`\n═══ Fetching ${days} days of BTC data ═══\n`);

  // Create data directory
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  // Test connection first
  console.log('🔍 Finding working Binance endpoint...');
  try {
    await binanceGet(`/api/v3/ticker/price?symbol=${SYMBOL}`);
  } catch (err) {
    process.exit(1);
  }

  // Fetch 1m candles
  console.log(`\n📊 Fetching 1m candles (${days} days ≈ ${days * 1440} candles)...`);
  const candles1m = await fetchAllKlines('1m', startTime, endTime);

  // Fetch 5m candles (for multi-TF)
  console.log(`\n📊 Fetching 5m candles (${days} days ≈ ${days * 288} candles)...`);
  const candles5m = await fetchAllKlines('5m', startTime, endTime);

  // Save to file
  const filename = `btc_${days}d_${new Date().toISOString().slice(0, 10)}.json`;
  const filepath = path.join(DATA_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify({
    symbol: SYMBOL,
    days,
    startTime: new Date(startTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
    fetchedAt: new Date().toISOString(),
    candles1m: candles1m.length,
    candles5m: candles5m.length,
    data1m: candles1m,
    data5m: candles5m,
  })); // compact JSON (no indentation) — saves ~40% space for large files

  console.log(`\n✅ Saved to: ${filepath}`);
  console.log(`   1m candles: ${candles1m.length}`);
  console.log(`   5m candles: ${candles5m.length}`);
  console.log(`   File size: ${(fs.statSync(filepath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\n🚀 Next step: node backtest/runBacktest.mts ${filepath}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
