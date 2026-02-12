import { CONFIG } from '../config.js';
import { toNumber } from '../utils.js';

export async function fetchLiveEventsBySeriesId({ seriesId, limit = 20 }) {
  const url = `${CONFIG.gammaBaseUrl}/events?series_id=${seriesId}&active=true&closed=false&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma events error: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export function flattenEventMarkets(events) {
  const out = [];
  for (const e of Array.isArray(events) ? events : []) {
    const markets = Array.isArray(e.markets) ? e.markets : [];
    for (const m of markets) out.push(m);
  }
  return out;
}

function safeTimeMs(x) {
  if (!x) return null;
  const t = new Date(x).getTime();
  return Number.isFinite(t) ? t : null;
}

export function pickLatestLiveMarket(markets, nowMs = Date.now()) {
  if (!Array.isArray(markets) || markets.length === 0) return null;

  const enriched = markets
    .map((m) => ({
      m,
      endMs: safeTimeMs(m.endDate),
      startMs: safeTimeMs(m.eventStartTime ?? m.startTime ?? m.startDate),
    }))
    .filter((x) => x.endMs !== null);

  const live = enriched
    .filter((x) => {
      const started = x.startMs === null ? true : x.startMs <= nowMs;
      return started && nowMs < x.endMs;
    })
    .sort((a, b) => a.endMs - b.endMs);

  if (live.length) return live[0].m;

  const upcoming = enriched.filter((x) => nowMs < x.endMs).sort((a, b) => a.endMs - b.endMs);
  return upcoming.length ? upcoming[0].m : null;
}

export async function fetchClobPrice({ tokenId, side }) {
  const url = `${CONFIG.clobBaseUrl}/price?token_id=${tokenId}&side=${side}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB price error: ${res.status}`);
  const data = await res.json();
  return toNumber(data.price);
}

export async function fetchOrderBook({ tokenId }) {
  const url = `${CONFIG.clobBaseUrl}/book?token_id=${tokenId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB book error: ${res.status}`);
  return await res.json();
}

export function summarizeOrderBook(book, depthLevels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids.length
    ? bids.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.max(best, p);
      }, null)
    : null;

  const bestAsk = asks.length
    ? asks.reduce((best, lvl) => {
        const p = toNumber(lvl.price);
        if (p === null) return best;
        if (best === null) return p;
        return Math.min(best, p);
      }, null)
    : null;

  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const bidLiquidity = bids.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);
  const askLiquidity = asks.slice(0, depthLevels).reduce((acc, x) => acc + (toNumber(x.size) ?? 0), 0);

  return { bestBid, bestAsk, spread, bidLiquidity, askLiquidity };
}

/**
 * ═══ FIX: Added `skipClob` option ═══
 * When CLOB WebSocket is connected, we skip REST calls for prices & orderbooks.
 * This eliminates 4 HTTP requests per poll cycle (2 prices + 2 orderbooks).
 */
export async function fetchPolymarketSnapshot({ skipClob = false } = {}) {
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
    for (let i = 0; i < outcomes.length; i += 1) {
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

    // ═══ FIX: Skip CLOB REST calls when WebSocket provides prices ═══
    if (skipClob) {
      return {
        ok: true,
        market,
        tokens: { upTokenId, downTokenId },
        prices: { up: gammaYes, down: gammaNo },  // Use Gamma prices as fallback
        orderbook: {
          up: { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null },
          down: { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null },
        },
      };
    }

    let upBuy = null;
    let downBuy = null;
    let upBookSummary = { bestBid: null, bestAsk: null, spread: null, bidLiquidity: null, askLiquidity: null };
    let downBookSummary = { ...upBookSummary };

    if (upTokenId && downTokenId) {
      try {
        // Fetch full orderbooks — compute midpoint from bid/ask (matches WS calculation)
        // This also saves 2 HTTP requests vs separate /price calls
        const [upBook, downBook] = await Promise.all([
          fetchOrderBook({ tokenId: upTokenId }),
          fetchOrderBook({ tokenId: downTokenId }),
        ]);
        upBookSummary = summarizeOrderBook(upBook);
        downBookSummary = summarizeOrderBook(downBook);

        // Midpoint price (consistent with WS midpoint)
        if (upBookSummary.bestBid !== null && upBookSummary.bestAsk !== null)
          upBuy = (upBookSummary.bestBid + upBookSummary.bestAsk) / 2;
        if (downBookSummary.bestBid !== null && downBookSummary.bestAsk !== null)
          downBuy = (downBookSummary.bestBid + downBookSummary.bestAsk) / 2;
      } catch {
        upBuy = gammaYes;
        downBuy = gammaNo;
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