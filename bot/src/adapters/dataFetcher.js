/**
 * Data fetching for Node.js bot.
 * Reimplements HTTP fetchers with direct API URLs (no Vite proxy).
 * Reuses pure helper functions from shared polymarket.js module.
 */

import { CONFIG } from '../config.js';
import { toNumber } from '../../../src/utils.js';
import {
  flattenEventMarkets,
  pickLatestLiveMarket,
  summarizeOrderBook,
} from '../../../src/data/polymarket.js';
import { createLogger } from '../logger.js';

const log = createLogger('Data');

// Re-export helpers for use in loop.js
export { flattenEventMarkets, pickLatestLiveMarket, summarizeOrderBook };

/**
 * Fetch klines (candlestick data) from Binance.
 */
export async function fetchKlines({ interval = '1m', limit = 240 } = {}) {
  const url = `${CONFIG.binanceBaseUrl}/api/v3/klines?symbol=${CONFIG.symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
  const raw = await res.json();

  return raw.map((k) => ({
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

/**
 * Fetch last BTC price from Binance.
 */
export async function fetchLastPrice() {
  const url = `${CONFIG.binanceBaseUrl}/api/v3/ticker/price?symbol=${CONFIG.symbol}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

/**
 * Fetch live events from Polymarket Gamma API.
 */
async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = `${CONFIG.gammaBaseUrl}/events?series_id=${seriesId}&active=true&closed=false&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Gamma events error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch CLOB orderbook for a token.
 */
async function fetchOrderBook({ tokenId }) {
  const url = `${CONFIG.clobBaseUrl}/book?token_id=${tokenId}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`CLOB book error: ${res.status}`);
  return await res.json();
}

/**
 * Fetch full Polymarket snapshot (market discovery + orderbook).
 * Bot always fetches REST (no WebSocket).
 */
export async function fetchPolymarketSnapshot() {
  try {
    const events = await fetchLiveEventsBySeriesId({
      seriesId: CONFIG.polymarket.seriesId,
      limit: 25,
    });
    const markets = flattenEventMarkets(events);
    const market = pickLatestLiveMarket(markets);

    if (!market) return { ok: false, reason: 'market_not_found' };

    const outcomes = Array.isArray(market.outcomes)
      ? market.outcomes
      : typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : [];
    const outcomePrices = Array.isArray(market.outcomePrices)
      ? market.outcomePrices
      : typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : [];
    const clobTokenIds = Array.isArray(market.clobTokenIds)
      ? market.clobTokenIds
      : typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : [];

    let upTokenId = null;
    let downTokenId = null;
    for (let i = 0; i < outcomes.length; i++) {
      const label = String(outcomes[i]);
      const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
      if (!tokenId) continue;
      if (label.toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()) upTokenId = tokenId;
      if (label.toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()) downTokenId = tokenId;
    }

    const upIndex = outcomes.findIndex(
      (x) => String(x).toLowerCase() === CONFIG.polymarket.upOutcomeLabel.toLowerCase()
    );
    const downIndex = outcomes.findIndex(
      (x) => String(x).toLowerCase() === CONFIG.polymarket.downOutcomeLabel.toLowerCase()
    );

    const gammaYes = upIndex >= 0 ? Number(outcomePrices[upIndex]) : null;
    const gammaNo = downIndex >= 0 ? Number(outcomePrices[downIndex]) : null;

    // Bot always fetches orderbook via REST (no WebSocket)
    let upBuy = null;
    let downBuy = null;
    let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
    let downBookSummary = { ...upBookSummary };

    if (upTokenId && downTokenId) {
      try {
        const [upBook, downBook] = await Promise.all([
          fetchOrderBook({ tokenId: upTokenId }),
          fetchOrderBook({ tokenId: downTokenId }),
        ]);
        upBookSummary = summarizeOrderBook(upBook);
        downBookSummary = summarizeOrderBook(downBook);

        if (upBookSummary.bestBid !== null && upBookSummary.bestAsk !== null)
          upBuy = (upBookSummary.bestBid + upBookSummary.bestAsk) / 2;
        if (downBookSummary.bestBid !== null && downBookSummary.bestAsk !== null)
          downBuy = (downBookSummary.bestBid + downBookSummary.bestAsk) / 2;
      } catch (err) {
        log.warn?.(`Orderbook fetch failed: ${err.message} — using Gamma prices`);
        upBuy = gammaYes;
        downBuy = gammaNo;
        // Mark orderbook as unavailable so arb engine doesn't see null spread as 0
        upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null, error: true };
        downBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null, error: true };
      }
    }

    return {
      ok: true,
      market,
      tokens: { upTokenId, downTokenId },
      prices: { up: upBuy ?? gammaYes, down: downBuy ?? gammaNo },
      orderbook: { up: upBookSummary, down: downBookSummary },
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * Chainlink BTC/USD price via Polygon RPC.
 * Simplified version for Node.js (single RPC endpoint).
 */
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';
const DECIMALS_SELECTOR = '0x313ce567';
let cachedDecimals = null;
let cachedDecimalsTs = 0;
const DECIMALS_TTL = 24 * 3600_000; // 24 hours
let cachedChainlink = { price: null, updatedAt: null, source: 'chainlink_rpc' };
let chainlinkFetchedAt = 0;

export async function fetchChainlinkBtcUsd() {
  const rpcs = CONFIG.chainlink?.polygonRpcUrls ?? [];
  const aggregator = CONFIG.chainlink?.btcUsdAggregator ?? '';

  if (!rpcs.length || !aggregator) {
    return { price: null, updatedAt: null, source: 'chainlink_rpc_no_config' };
  }

  const now = Date.now();
  if (chainlinkFetchedAt && now - chainlinkFetchedAt < 30_000) {
    return cachedChainlink;
  }

  try {
    const rpc = rpcs[0];

    // L1: Re-fetch decimals if cache is null or expired (24h TTL)
    if (cachedDecimals === null || (now - cachedDecimalsTs >= DECIMALS_TTL)) {
      const decRes = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_call',
          params: [{ to: aggregator, data: DECIMALS_SELECTOR }, 'latest'],
        }),
        signal: AbortSignal.timeout(3000),
      });
      const decJson = await decRes.json();
      const parsed = parseInt(decJson.result, 16);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 32) {
        return cachedChainlink; // invalid decimals — abort
      }
      cachedDecimals = parsed;
      cachedDecimalsTs = now;
    }

    const roundRes = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_call',
        params: [{ to: aggregator, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'],
      }),
      signal: AbortSignal.timeout(3000),
    });
    const roundJson = await roundRes.json();
    const hex = roundJson.result?.startsWith('0x') ? roundJson.result.slice(2) : roundJson.result;
    if (!hex || hex.length < 320) return cachedChainlink;

    const answerHex = hex.slice(64, 128);
    let answer = BigInt('0x' + answerHex);
    if (answer >= (1n << 255n)) answer = answer - (1n << 256n);

    const price = Number(answer) / (10 ** cachedDecimals);
    const updatedAtHex = hex.slice(192, 256);
    const updatedAt = Number(BigInt('0x' + updatedAtHex)) * 1000;

    // W8: Only cache valid prices — prevents null/invalid responses from
    // overwriting good cache and blocking retries for 30s
    if (Number.isFinite(price) && price > 0) {
      cachedChainlink = { price, updatedAt, source: 'chainlink_rpc' };
      chainlinkFetchedAt = now;
    }
    return cachedChainlink;
  } catch (err) {
    // Network error — return stale cache, don't update timestamp so retry happens next poll
    log.debug(`Chainlink RPC error: ${err.message}`);
    return cachedChainlink;
  }
}

/**
 * Funding rate — returns null (all sources blocked in user's network).
 */
export async function fetchFundingRate() {
  return null;
}
