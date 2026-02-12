import { CONFIG } from '../config.js';

/**
 * Chainlink BTC/USD price via Polygon HTTP RPC (browser-compatible).
 * FIX: Increased cache duration, reduced timeout, better throttling.
 */

const RPC_TIMEOUT_MS = 3000;

// ABI function selectors
const DECIMALS_SELECTOR = '0x313ce567';
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c';

let cachedDecimals = null;
let cachedResult = { price: null, updatedAt: null, source: 'chainlink_rpc' };
let cachedFetchedAtMs = 0;
let fetchInProgress = false; // ═══ FIX: prevent concurrent fetches ═══

function getMinFetchInterval() {
  return CONFIG.chainlink?.rpcCacheMs ?? 30_000; // default 30s cache
}

function getRpcUrls() {
  return CONFIG.chainlink?.polygonRpcUrls ?? [];
}

function getAggregator() {
  return CONFIG.chainlink?.btcUsdAggregator ?? '';
}

async function jsonRpcCall(rpcUrl, to, data) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`rpc_http_${res.status}`);

    const json = await res.json();
    if (json.error) throw new Error(`rpc_error_${json.error.code}`);

    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeUint8(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return parseInt(clean, 16);
}

function decodeLatestRoundData(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 320) return null;

  const answerHex = clean.slice(64, 128);
  const updatedAtHex = clean.slice(192, 256);

  let answer = BigInt('0x' + answerHex);
  const TWO_255 = 1n << 255n;
  const TWO_256 = 1n << 256n;
  if (answer >= TWO_255) answer = answer - TWO_256;

  const updatedAt = Number(BigInt('0x' + updatedAtHex));

  return { answer: Number(answer), updatedAt };
}

export async function fetchChainlinkBtcUsd() {
  const rpcs = getRpcUrls();
  const aggregator = getAggregator();

  if (!rpcs.length || !aggregator) {
    return { price: null, updatedAt: null, source: 'chainlink_rpc_no_config' };
  }

  const now = Date.now();
  const minInterval = getMinFetchInterval();

  // ═══ FIX: Return cached if still fresh ═══
  if (cachedFetchedAtMs && now - cachedFetchedAtMs < minInterval && cachedResult.price !== null) {
    return cachedResult;
  }

  // ═══ FIX: Prevent concurrent fetches ═══
  if (fetchInProgress) {
    return cachedResult;
  }

  fetchInProgress = true;
  const lockTimer = setTimeout(() => { fetchInProgress = false; }, 10_000);

  try {
    // Only try first RPC (we reduced to 1 in config)
    const rpc = rpcs[0];

    try {
      if (cachedDecimals === null) {
        const decResult = await jsonRpcCall(rpc, aggregator, DECIMALS_SELECTOR);
        cachedDecimals = decodeUint8(decResult);
      }

      const roundResult = await jsonRpcCall(rpc, aggregator, LATEST_ROUND_DATA_SELECTOR);
      const decoded = decodeLatestRoundData(roundResult);

      if (!decoded) {
        cachedDecimals = null;
        return cachedResult;
      }

      const scale = 10 ** cachedDecimals;
      const price = decoded.answer / scale;

      cachedResult = {
        price,
        updatedAt: decoded.updatedAt * 1000,
        source: 'chainlink_rpc',
      };
      cachedFetchedAtMs = now;
      return cachedResult;
    } catch {
      cachedDecimals = null;
      return cachedResult;
    }
  } finally {
    clearTimeout(lockTimer);
    fetchInProgress = false;
  }
}