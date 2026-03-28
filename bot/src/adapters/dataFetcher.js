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
  // Set BEFORE fetch attempt so cooldown applies even on failure (prevents retry storm)
  chainlinkFetchedAt = now;

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
    // overwriting good cache (chainlinkFetchedAt already set above for cooldown)
    if (Number.isFinite(price) && price > 0) {
      cachedChainlink = { price, updatedAt, source: 'chainlink_rpc' };
    }
    return cachedChainlink;
  } catch (err) {
    // Network error — return stale cache (chainlinkFetchedAt already set for cooldown)
    log.debug(`Chainlink RPC error: ${err.message}`);
    return cachedChainlink;
  }
}

/**
 * Fetch Chainlink BTC/USD price at a specific timestamp by searching rounds.
 * Used for accurate PTB — Polymarket resolves via Chainlink, not Binance.
 *
 * @param {number} targetSec - Unix timestamp in SECONDS for the desired price
 * @returns {Promise<{price: number, updatedAt: number, diff: number}|null>}
 */
const GET_ROUND_DATA_SELECTOR = '0x9a6fc8f5'; // getRoundData(uint80)
export async function fetchChainlinkAtTimestamp(targetSec) {
  const aggregator = CONFIG.chainlink?.btcUsdAggregator ?? '';
  if (!aggregator || !targetSec) return null;

  // Build RPC list: configured HTTP RPCs + HTTPS versions of WSS URLs
  const rpcs = [
    ...(CONFIG.chainlink?.polygonRpcUrls ?? []),
    ...(CONFIG.chainlink?.polygonWssUrls ?? []).map(u => u.replace('wss://', 'https://')),
  ];
  if (!rpcs.length) return null;
  const rpc = rpcs.find(u => !u.includes('polygon-rpc.com')) || rpcs[0]; // prefer working RPC
  const decimals = cachedDecimals ?? 8;

  try {
    // 1. Get latest round
    const latRes = await fetch(rpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: aggregator, data: LATEST_ROUND_DATA_SELECTOR }, 'latest'] }),
      signal: AbortSignal.timeout(5000),
    });
    const latHex = (await latRes.json()).result?.slice(2);
    if (!latHex || latHex.length < 320) return null;

    const latRoundId = BigInt('0x' + latHex.slice(0, 64));
    const latUpdatedAt = Number(BigInt('0x' + latHex.slice(192, 256)));
    if (latUpdatedAt <= 0) return null;

    // 2. Estimate target round (Polygon Chainlink ~27-34s per round)
    const secAgo = latUpdatedAt - targetSec;
    const estRoundsBack = Math.round(secAgo / 30);
    const targetRound = latRoundId - BigInt(estRoundsBack);

    // 3. Check ±7 rounds around estimate in parallel (~7min window at ~30s/round)
    const offsets = [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];
    const roundFetches = offsets.map(async (off) => {
      const rid = targetRound + BigInt(off);
      const padded = rid.toString(16).padStart(64, '0');
      const r = await fetch(rpc, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_call',
          params: [{ to: aggregator, data: GET_ROUND_DATA_SELECTOR + padded }, 'latest'] }),
        signal: AbortSignal.timeout(5000),
      });
      const hex = (await r.json()).result?.slice(2);
      if (!hex || hex.length < 320) return null;
      let answer = BigInt('0x' + hex.slice(64, 128));
      if (answer >= (1n << 255n)) answer -= (1n << 256n);
      const updatedAt = Number(BigInt('0x' + hex.slice(192, 256)));
      return { price: Number(answer) / (10 ** decimals), updatedAt, diff: updatedAt - targetSec };
    });

    const results = (await Promise.all(roundFetches)).filter(Boolean);
    if (!results.length) return null;

    // 4. Pick the round closest to targetSec (absolute time difference)
    results.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
    const best = results[0];

    if (best && best.price > 0) {
      log.info(`Chainlink PTB: $${best.price.toFixed(2)} (${best.diff}s from target)`);
      return best;
    }
    return null;
  } catch (err) {
    log.debug(`Chainlink round query error: ${err.message}`);
    return null;
  }
}

/**
 * Fetch exact PTB from Polymarket website's server-rendered data.
 * Polymarket embeds eventMetadata.priceToBeat in __NEXT_DATA__ for closed markets.
 * The PTB of market N+1 = finalPrice of market N (Chainlink Data Streams snapshot).
 *
 * @param {string} slug - Event slug (e.g. "btc-updown-15m-1774686600")
 * @returns {Promise<{priceToBeat: number, source: string}|null>}
 */
let ptbCache = { slug: null, value: null, fetchedAt: 0 };

export async function fetchPolymarketPtb(slug) {
  if (!slug) return null;

  // Cache: don't re-fetch for the same slug within 60s
  if (ptbCache.slug === slug && ptbCache.value && Date.now() - ptbCache.fetchedAt < 60_000) {
    return ptbCache.value;
  }

  try {
    const res = await fetch(`https://polymarket.com/event/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!scriptMatch) return null;

    const nextData = JSON.parse(scriptMatch[1]);

    // Navigate to dehydratedState queries and find the events array
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries ?? [];
    let allEvents = null;
    for (const q of queries) {
      const data = q.state?.data;
      if (data?.events && Array.isArray(data.events)) {
        allEvents = data.events;
        break;
      }
    }
    if (!allEvents) return null;

    // Strategy 1: Active event may have its own eventMetadata.priceToBeat
    const activeEvent = allEvents.find(e => e.slug === slug);
    if (activeEvent?.eventMetadata?.priceToBeat) {
      const ptb = Number(activeEvent.eventMetadata.priceToBeat);
      if (Number.isFinite(ptb) && ptb > 10000) {
        const result = { priceToBeat: ptb, source: 'polymarket_page' };
        ptbCache = { slug, value: result, fetchedAt: Date.now() };
        log.info(`PTB from Polymarket page: $${ptb.toFixed(2)} (active event)`);
        return result;
      }
    }

    // Strategy 2: Previous market's finalPrice = current market's PTB
    // Compute previous slug: current timestamp - 900 (15 min)
    const tsMatch = slug.match(/(\d+)$/);
    if (tsMatch) {
      const prevTs = Number(tsMatch[1]) - 900;
      const prevSlug = `btc-updown-15m-${prevTs}`;
      const prevEvent = allEvents.find(e => e.slug === prevSlug);
      if (prevEvent?.eventMetadata?.finalPrice) {
        const ptb = Number(prevEvent.eventMetadata.finalPrice);
        if (Number.isFinite(ptb) && ptb > 10000) {
          const result = { priceToBeat: ptb, source: 'polymarket_page_prev' };
          ptbCache = { slug, value: result, fetchedAt: Date.now() };
          log.info(`PTB from previous finalPrice: $${ptb.toFixed(2)} (${prevSlug})`);
          return result;
        }
      }
    }

    // Strategy 3: If previous market's finalPrice not available yet,
    // try its priceToBeat as a rough estimate (off by one settlement delta, typically <$50).
    // Only accept from the immediately previous market — never use older markets.
    if (tsMatch) {
      const prevTs = Number(tsMatch[1]) - 900;
      const prevSlug = `btc-updown-15m-${prevTs}`;
      const prevEvent = allEvents.find(e => e.slug === prevSlug);
      if (prevEvent?.eventMetadata?.priceToBeat) {
        const ptb = Number(prevEvent.eventMetadata.priceToBeat);
        if (Number.isFinite(ptb) && ptb > 10000) {
          // Mark as low-priority — scheduled_ws/chainlink_round should override this
          const result = { priceToBeat: ptb, source: 'polymarket_page_approx' };
          ptbCache = { slug, value: result, fetchedAt: Date.now() };
          log.info(`PTB approx from prev priceToBeat: $${ptb.toFixed(2)} (${prevSlug})`);
          return result;
        }
      }
    }

    return null;
  } catch (err) {
    log.debug(`Polymarket PTB scrape failed: ${err.message}`);
    return null;
  }
}

/**
 * Funding rate — returns null (all sources blocked in user's network).
 */
export async function fetchFundingRate() {
  return null;
}
