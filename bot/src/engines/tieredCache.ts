/**
 * Tiered cache management for data fetching intervals.
 *
 * Tier 1 (every poll):  1m klines + BTC price (WS or REST fallback)
 * Tier 2 (every 10s):   5m klines
 * Tier 3 (every 30s):   Polymarket market discovery, Chainlink RPC
 *
 * Extracted from loop.js lines 233-251, 496-506.
 */

// ── Intervals ──
export const MARKET_DISCOVERY_INTERVAL = 30_000;
export const KLINES_5M_INTERVAL = 10_000;
export const CHAINLINK_INTERVAL = 30_000;

// ── Cache state ──
let polySnapshotCache = null;
let polyLastFetchMs = 0;

let klines5mCache = null;
let klines5mLastFetchMs = 0;

let chainlinkCache = { price: null, updatedAt: null, source: 'chainlink_rpc' };
let chainlinkLastFetchMs = 0;

/**
 * Determine which data sources need a fresh fetch.
 * @param {number} now - Current timestamp
 * @param {boolean} marketExpired - Whether market just expired
 * @returns {{ needsFreshPoly: boolean, needsFresh5m: boolean, needsChainlink: boolean }}
 */
export function getRefreshNeeds(now, marketExpired) {
  return {
    needsFreshPoly:
      !polySnapshotCache ||
      now - polyLastFetchMs > MARKET_DISCOVERY_INTERVAL ||
      marketExpired,
    needsFresh5m:
      !klines5mCache ||
      now - klines5mLastFetchMs > KLINES_5M_INTERVAL,
    needsChainlink:
      now - chainlinkLastFetchMs > CHAINLINK_INTERVAL,
  };
}

// ── Cache updaters ──
export function updateKlines5m(data, now) {
  klines5mCache = data;
  klines5mLastFetchMs = now;
}

export function updateChainlink(data, now) {
  chainlinkCache = data;
  chainlinkLastFetchMs = now;
}

export function updatePolySnapshot(data, now) {
  polySnapshotCache = data;
  polyLastFetchMs = now;
}

// ── Cache getters ──
export function getKlines5mCache() { return klines5mCache; }
export function getChainlinkCache() { return chainlinkCache; }
export function getPolySnapshotCache() { return polySnapshotCache; }

/**
 * Reset caches on market change.
 * Note: chainlink cache is NOT reset (independent of market lifecycle).
 */
export function resetCaches() {
  polySnapshotCache = null;
  polyLastFetchMs = 0;
  klines5mCache = null;
  klines5mLastFetchMs = 0;
}
