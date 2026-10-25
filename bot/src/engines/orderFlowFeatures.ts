/**
 * Order-flow features — record-only P0.
 *
 * Pure(ish) module fed from the existing CLOB book and trade prints. It never
 * changes a trade decision. Values are intended for future model research and
 * are exposed in the JEV log / status snapshot.
 */
export type OrderFlowBook = {
  bestBid: number | null;
  bestAsk: number | null;
  spread?: number | null;
  bidLiquidity?: number;
  askLiquidity?: number;
  bidSize?: number;
  askSize?: number;
};
export type OrderFlowTrade = {
  t: number;
  token: 'up' | 'down';
  side: 'BUY' | 'SELL' | null;
  price: number;
  size: number;
};
export type OrderFlowFeatures = {
  ok: boolean;
  sampleCount: number;
  updatedAt: number;
  spread: number | null;
  mid: number | null;
  microprice: number | null;
  micropriceEdgePct: number | null;
  ofi: number;
  depthImbalance: number;
  topImbalance: number;
  tradeImbalance: number;
  vpin: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
};

const TRADE_WINDOW_MS = 5 * 60_000;
const MAX_TRADE_SAMPLES = 500;
const VPIN_BUCKETS = 10;

let _slug: string | null = null;
let _prevUp: OrderFlowBook | null = null;
let _sampleCount = 0;
let _updatedAt = 0;
let _spread: number | null = null;
let _mid: number | null = null;
let _microprice: number | null = null;
let _micropriceEdgePct: number | null = null;
let _ofi = 0;
let _depthImbalance = 0;
let _topImbalance = 0;
let _tradeImbalance = 0;
let _vpin = 0;
let _buyVolume = 0;
let _sellVolume = 0;
let _tradeCount = 0;

function finite(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function clamp(n: number): number { return Math.max(-1, Math.min(1, n)); }
function norm(n: number, den: number): number { return den > 0 ? clamp(n / den) : 0; }
function imbalance(a: number, b: number): number { const s = a + b; return s > 0 ? clamp((a - b) / s) : 0; }

export function resetOrderFlow(): void {
  _slug = null;
  _prevUp = null;
  _sampleCount = 0;
  _updatedAt = 0;
  _spread = null;
  _mid = null;
  _microprice = null;
  _micropriceEdgePct = null;
  _ofi = 0;
  _depthImbalance = 0;
  _topImbalance = 0;
  _tradeImbalance = 0;
  _vpin = 0;
  _buyVolume = 0;
  _sellVolume = 0;
  _tradeCount = 0;
}

export function recordOrderFlowBook(up: OrderFlowBook | null, down: OrderFlowBook | null, slug: string | null, now = Date.now()): void {
  if (slug !== _slug) {
    resetOrderFlow();
    _slug = slug;
  }
  const bid = up ? finite(up.bestBid) : null;
  const ask = up ? finite(up.bestAsk) : null;
  if (bid == null || ask == null || ask <= bid) return;
  const bidSize = Math.max(0, finite(up?.bidSize) ?? 0);
  const askSize = Math.max(0, finite(up?.askSize) ?? 0);
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const micro = bidSize + askSize > 0 ? (ask * bidSize + bid * askSize) / (bidSize + askSize) : mid;
  const prevBidSize = Math.max(0, finite(_prevUp?.bidSize) ?? 0);
  const prevAskSize = Math.max(0, finite(_prevUp?.askSize) ?? 0);
  const bidDelta = bidSize - prevBidSize;
  const askDelta = askSize - prevAskSize;
  // Best-level order-flow imbalance; normalize by current displayed size.
  _ofi = norm(bidDelta - askDelta, bidSize + askSize + Math.abs(bidDelta) + Math.abs(askDelta));
  _spread = spread;
  _mid = mid;
  _microprice = micro;
  _micropriceEdgePct = mid > 0 ? ((micro - mid) / mid) * 100 : null;
  _topImbalance = imbalance(bidSize, askSize);
  const bidDepth = Math.max(0, finite(up?.bidLiquidity) ?? 0);
  const askDepth = Math.max(0, finite(up?.askLiquidity) ?? 0);
  _depthImbalance = imbalance(bidDepth, askDepth);
  _prevUp = { bestBid: bid, bestAsk: ask, bidSize, askSize, bidLiquidity: bidDepth, askLiquidity: askDepth, spread };
  _sampleCount++;
  _updatedAt = now;
}

export function recordOrderFlowTrades(trades: OrderFlowTrade[], slug: string | null, now = Date.now()): void {
  if (slug !== _slug) {
    resetOrderFlow();
    _slug = slug;
  }
  const cutoff = now - TRADE_WINDOW_MS;
  const recent = trades.filter((t) => t && Number.isFinite(t.t) && t.t >= cutoff).slice(-MAX_TRADE_SAMPLES);
  let buy = 0;
  let sell = 0;
  let count = 0;
  for (const t of recent) {
    const size = Math.max(0, Number(t.size) || 0);
    if (size <= 0 || !t.side) continue;
    count++;
    // A buy of UP or a sell of DOWN is bullish pressure; the reverse is bearish.
    if ((t.token === 'up' && t.side === 'BUY') || (t.token === 'down' && t.side === 'SELL')) buy += size;
    else if ((t.token === 'up' && t.side === 'SELL') || (t.token === 'down' && t.side === 'BUY')) sell += size;
  }
  _buyVolume = buy;
  _sellVolume = sell;
  _tradeCount = count;
  _tradeImbalance = imbalance(buy, sell);
  // Volume-bucketed VPIN proxy: average absolute bucket imbalance over N buckets.
  const total = buy + sell;
  if (total <= 0) { _vpin = 0; return; }
  const target = total / VPIN_BUCKETS;
  let bucketBuy = 0;
  let bucketSell = 0;
  let vpinSum = 0;
  let buckets = 0;
  for (const t of recent) {
    const size = Math.max(0, Number(t.size) || 0);
    if (size <= 0 || !t.side) continue;
    const bullish = (t.token === 'up' && t.side === 'BUY') || (t.token === 'down' && t.side === 'SELL');
    let remaining = size;
    while (remaining > 0) {
      const take = Math.min(remaining, Math.max(0, target - bucketBuy - bucketSell));
      if (take <= 0) break;
      if (bullish) bucketBuy += take; else bucketSell += take;
      remaining -= take;
      const filled = bucketBuy + bucketSell;
      if (filled >= target - 1e-9) {
        vpinSum += Math.abs(bucketBuy - bucketSell) / Math.max(1e-9, filled);
        buckets++;
        bucketBuy = 0;
        bucketSell = 0;
        if (buckets >= VPIN_BUCKETS) break;
      }
    }
    if (buckets >= VPIN_BUCKETS) break;
  }
  if (buckets > 0) _vpin = Math.max(0, Math.min(1, vpinSum / buckets));
}

export function getOrderFlowFeatures(): OrderFlowFeatures {
  return {
    ok: _sampleCount > 0,
    sampleCount: _sampleCount,
    updatedAt: _updatedAt,
    spread: _spread,
    mid: _mid,
    microprice: _microprice,
    micropriceEdgePct: _micropriceEdgePct,
    ofi: _ofi,
    depthImbalance: _depthImbalance,
    topImbalance: _topImbalance,
    tradeImbalance: _tradeImbalance,
    vpin: _vpin,
    tradeCount: _tradeCount,
    buyVolume: _buyVolume,
    sellVolume: _sellVolume,
  };
}
