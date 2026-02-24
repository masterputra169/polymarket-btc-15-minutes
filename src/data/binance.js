/**
 * Binance API data fetching.
 * Fetches klines (candlestick data) and last price for BTCUSDT.
 */

import { CONFIG } from '../config.js';

/**
 * Fetch klines (candlestick data) from Binance.
 * @param {Object} opts
 * @param {string} opts.interval - candle interval ('1m', '5m', etc.)
 * @param {number} opts.limit - number of candles
 * @returns {Array} candles [{openTime, open, high, low, close, volume, closeTime}, ...]
 */
export async function fetchKlines({ interval = '1m', limit = 240 } = {}) {
  const url = `${CONFIG.binanceBaseUrl}/api/v3/klines?symbol=${CONFIG.symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const raw = await res.json();
  const now = Date.now();

  // Fix P3: Exclude the current incomplete (forming) candle.
  // Binance always returns the live candle as the last element with closeTime in the future.
  // Including it in indicator calculations is look-ahead bias — close price is not final.
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    takerBuyVolume: parseFloat(k[9]),
  })).filter((k) => k.closeTime < now && !isNaN(k.close) && !isNaN(k.open));
}

/**
 * Fetch last price from Binance.
 * @returns {number} last price
 */
export async function fetchLastPrice() {
  const url = `${CONFIG.binanceBaseUrl}/api/v3/ticker/price?symbol=${CONFIG.symbol}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}