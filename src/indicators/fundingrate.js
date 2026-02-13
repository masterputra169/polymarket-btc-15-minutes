/**
 * Funding Rate — Crypto Sentiment Indicator
 *
 * Binance perpetual futures funding rate:
 * - Positive funding = longs pay shorts → market is over-leveraged long → potential SHORT
 * - Negative funding = shorts pay longs → market is over-leveraged short → potential LONG
 * - Near zero = balanced, no strong sentiment signal
 *
 * Rate updates every 8 hours on Binance. For 15-min prediction:
 * - Not directly actionable for timing, but provides context
 * - Extreme funding (>0.05% or <-0.05%) = crowded trade → contrarian signal
 *
 * v2: Multi-host fallback for regions where fapi.binance.com is blocked
 */

// Use Vite proxy to avoid CORS — /fapi-api proxied to https://fapi.binance.com
const FAPI_HOSTS = [
  '/fapi-api',
];

const CACHE_TTL_MS = 5 * 60_000; // Cache 5 minutes (rate changes every 8h)
const FETCH_TIMEOUT_MS = 3_000;  // 3s timeout (was 8s — too slow when blocked)

let cachedFunding = null;
let lastFetchMs = 0;
let workingHost = null; // Remember which host works
let binanceBackoffUntil = 0; // Timestamp-based backoff (not counter)
const BINANCE_BACKOFF_MS = 5 * 60_000; // Retry after 5 minutes

/**
 * Fetch with timeout helper
 */
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Try fetching from multiple hosts with fallback
 */
async function fetchFapiWithFallback(path) {
  // Skip Binance if recently failed, but retry after backoff period
  if (binanceBackoffUntil > 0 && Date.now() < binanceBackoffUntil) {
    return null;
  }

  // Try working host first
  const hosts = workingHost
    ? [workingHost, ...FAPI_HOSTS.filter(h => h !== workingHost)]
    : FAPI_HOSTS;

  for (const host of hosts) {
    try {
      const resp = await fetchWithTimeout(`${host}${path}`);
      if (resp.ok) {
        workingHost = host;
        binanceBackoffUntil = 0; // reset on success
        return await resp.json();
      }
    } catch {
      continue;
    }
  }

  // All Binance hosts failed — backoff and retry after 5 minutes
  binanceBackoffUntil = Date.now() + BINANCE_BACKOFF_MS;
  console.warn('[FundingRate] All Binance FAPI hosts unreachable, will retry later');
  return null;
}

/**
 * Fetch funding rate from Bybit as fallback
 * @returns {{ rate, ratePct, extreme, sentiment, nextFundingTime } | null}
 */
async function fetchBybitFundingRate() {
  try {
    const resp = await fetchWithTimeout(
      '/bybit-api/v5/market/tickers?category=linear&symbol=BTCUSDT'
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const ticker = data?.result?.list?.[0];
    if (!ticker || ticker.fundingRate == null) return null;

    const rate = parseFloat(ticker.fundingRate);
    const ratePct = rate * 100;
    const extreme = Math.abs(ratePct) > 0.05;
    let sentiment = 'NEUTRAL';
    if (ratePct > 0.03) sentiment = 'BEARISH';
    else if (ratePct < -0.03) sentiment = 'BULLISH';

    const nextFundingTime = ticker.nextFundingTime
      ? parseInt(ticker.nextFundingTime) : null;

    return { rate, ratePct, extreme, sentiment, nextFundingTime, fetchedAt: Date.now(), source: 'bybit' };
  } catch {
    return null;
  }
}

/**
 * Internal: actually perform the funding rate fetch from Binance/Bybit.
 * Updates cachedFunding on success.
 */
async function doFetch() {
  try {
    const data = await fetchFapiWithFallback('/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1');
    if (data && Array.isArray(data) && data.length > 0) {
      const entry = data[0];
      const rate = parseFloat(entry.fundingRate);
      const ratePct = rate * 100;

      // Also fetch next funding time from premium index
      let nextFundingTime = null;
      try {
        const prem = await fetchFapiWithFallback('/fapi/v1/premiumIndex?symbol=BTCUSDT');
        if (prem) {
          nextFundingTime = prem.nextFundingTime || null;
        }
      } catch { /* silent */ }

      // Sentiment analysis (CONTRARIAN)
      const extreme = Math.abs(ratePct) > 0.05;
      let sentiment = 'NEUTRAL';
      if (ratePct > 0.03) sentiment = 'BEARISH';   // Longs crowded → contrarian SHORT
      else if (ratePct < -0.03) sentiment = 'BULLISH'; // Shorts crowded → contrarian LONG

      cachedFunding = {
        rate,
        ratePct,
        extreme,
        sentiment,
        nextFundingTime,
        fetchedAt: Date.now(),
      };

      return cachedFunding;
    }

    // Binance FAPI failed — try Bybit as fallback
    const bybitResult = await fetchBybitFundingRate();
    if (bybitResult) {
      cachedFunding = bybitResult;
      return cachedFunding;
    }

    return cachedFunding;
  } catch (err) {
    console.warn('[FundingRate] All hosts failed:', err.message);
    return cachedFunding;
  }
}

let firstCallDone = false;

/**
 * Fetch current funding rate from Binance Futures.
 * First call is non-blocking (fire-and-forget) to avoid 3-6s timeout on initial load.
 * @returns {{ rate, ratePct, extreme, sentiment, nextFundingTime } | null}
 */
export async function fetchFundingRate() {
  const now = Date.now();

  // Return cached if fresh (also respect cooldown when all hosts failed)
  if (now - lastFetchMs < CACHE_TTL_MS) {
    return cachedFunding;
  }

  // Always update timestamp to prevent retry-storm when all hosts are blocked
  lastFetchMs = now;

  // First call: fire-and-forget to avoid blocking initial render
  if (!firstCallDone) {
    firstCallDone = true;
    doFetch(); // no await — result cached for next poll
    return null;
  }

  return doFetch();
}

/**
 * Get cached funding rate without fetching.
 * @returns {Object|null}
 */
export function getCachedFundingRate() {
  return cachedFunding;
}