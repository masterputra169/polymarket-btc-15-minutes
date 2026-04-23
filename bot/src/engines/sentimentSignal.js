/**
 * Sentiment Signal — free API aggregator for market sentiment features.
 *
 * Sources:
 * 1. Crypto Fear & Greed Index (alternative.me) — 0-100 scale
 * 2. BTC Dominance (CoinGecko /global) — % of total crypto market cap
 *
 * Output: composite bias signal for trade filters and sizing adjustment.
 * Cache: configurable (default 5 min), never blocks bot loop.
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Sentiment');

const FNG_URL = 'https://api.alternative.me/fng/?limit=1&format=json';
const COINGECKO_GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';

let _cache = null;       // { fng, btcDom, composite, fetchedAt }
let _fetching = false;
let _stats = { fetches: 0, errors: 0, lastFetchMs: 0 };

/**
 * Fetch sentiment data (cached, non-blocking).
 * Returns cached result if within TTL. Returns null on first call before data is ready.
 */
export async function fetchSentiment() {
  if (_fetching) return _cache;

  const now = Date.now();
  const ttl = BOT_CONFIG.ai?.sentimentCacheMs ?? 300_000;
  if (_cache && (now - _cache.fetchedAt) < ttl) return _cache;

  _fetching = true;
  try {
    const [fng, btcDom] = await Promise.allSettled([
      fetchFearGreed(),
      fetchBtcDominance(),
    ]);

    const fngVal = fng.status === 'fulfilled' ? fng.value : (_cache?.fng ?? null);
    const btcDomVal = btcDom.status === 'fulfilled' ? btcDom.value : (_cache?.btcDom ?? null);

    // Composite sentiment bias: -1 (extreme fear) to +1 (extreme greed)
    const composite = computeComposite(fngVal, btcDomVal);

    _cache = {
      fng: fngVal,
      btcDom: btcDomVal,
      composite,
      classification: classifySentiment(fngVal),
      fetchedAt: now,
    };

    _stats.fetches++;
    _stats.lastFetchMs = now;

    log.debug(`Sentiment: FnG=${fngVal ?? '?'} BtcDom=${btcDomVal?.toFixed(1) ?? '?'}% composite=${composite?.toFixed(2) ?? '?'}`);

    return _cache;
  } catch (err) {
    _stats.errors++;
    log.debug(`Sentiment fetch error: ${err.message}`);
    return _cache;
  } finally {
    _fetching = false;
  }
}

/**
 * Get cached sentiment (synchronous, for use in hot loop).
 * Returns null if never fetched.
 */
export function getSentiment() {
  return _cache;
}

/**
 * Get sentiment stats for dashboard.
 */
export function getSentimentStats() {
  return {
    enabled: BOT_CONFIG.ai?.sentimentEnabled !== false,
    ..._stats,
    current: _cache ? {
      fng: _cache.fng,
      btcDom: _cache.btcDom,
      composite: _cache.composite,
      classification: _cache.classification,
      ageMs: Date.now() - _cache.fetchedAt,
    } : null,
  };
}

// ─────────────── Fetchers ───────────────

async function fetchFearGreed() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(FNG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`FnG HTTP ${res.status}`);
    const data = await res.json();
    const value = parseInt(data?.data?.[0]?.value, 10);
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    return value;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name !== 'AbortError') log.debug(`FnG error: ${err.message}`);
    throw err;
  }
}

async function fetchBtcDominance() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(COINGECKO_GLOBAL_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    const dom = data?.data?.market_cap_percentage?.btc;
    if (!Number.isFinite(dom) || dom < 0 || dom > 100) return null;
    return Math.round(dom * 100) / 100;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name !== 'AbortError') log.debug(`CoinGecko error: ${err.message}`);
    throw err;
  }
}

// ─────────────── Computation ───────────────

/**
 * Compute composite sentiment: -1 (extreme fear) to +1 (extreme greed).
 * FnG is primary signal, BTC dominance is modifier.
 */
function computeComposite(fng, btcDom) {
  if (fng == null) return null;

  // Normalize FnG: 0-100 → -1 to +1 (50 = neutral)
  let composite = (fng - 50) / 50;

  // BTC dominance modifier:
  // High BTC dom (>55%) during fear = flight to quality (slightly less bearish)
  // Low BTC dom (<45%) during greed = alt season (more speculative/risky)
  if (btcDom != null) {
    if (btcDom > 55 && composite < 0) {
      composite *= 0.85; // dampen fear when BTC dom is high
    } else if (btcDom < 45 && composite > 0) {
      composite *= 1.10; // amplify greed during alt season
    }
  }

  return Math.max(-1, Math.min(1, Math.round(composite * 100) / 100));
}

function classifySentiment(fng) {
  if (fng == null) return 'unknown';
  if (fng <= 20) return 'extreme_fear';
  if (fng <= 40) return 'fear';
  if (fng <= 60) return 'neutral';
  if (fng <= 80) return 'greed';
  return 'extreme_greed';
}

/**
 * Check if sentiment is extreme enough to warrant a trade filter.
 * Returns { block: boolean, reason: string } or null if no extreme detected.
 */
export function checkExtremeSentiment() {
  if (!_cache || _cache.fng == null) return null;

  // Extreme fear (<15) or extreme greed (>85) can be contrarian signals
  // But for safety, we block during EXTREME conditions when our edge is uncertain
  if (_cache.fng <= 5) {
    return { block: true, reason: `Extreme fear (FnG=${_cache.fng}) — panic selling, unpredictable` };
  }
  if (_cache.fng >= 95) {
    return { block: true, reason: `Extreme greed (FnG=${_cache.fng}) — euphoria, correction risk` };
  }

  return null;
}
