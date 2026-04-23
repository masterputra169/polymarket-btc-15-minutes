/**
 * Chainlink Data Streams adapter — direct source for BTC/USD price snapshots.
 *
 * Polymarket resolves 15-min BTC markets using Chainlink Data Streams (off-chain,
 * ms-precision, signed reports). This adapter queries the same source used by
 * Polymarket resolution, giving EXACT PTB match once activated.
 *
 * ACTIVATION: Set CHAINLINK_DS_API_KEY and CHAINLINK_DS_USER_SECRET in bot/.env.
 * Without credentials, adapter is dormant and returns null (pipeline falls back
 * to existing sources: polymarket_page → chainlink_round → oracle).
 *
 * API key: apply via Chainlink Labs / Polymarket sponsored 15m markets program.
 */

import { createLogger } from '../logger.js';

const log = createLogger('DataStreams');

// BTC/USD V3 crypto stream on mainnet (18 decimals).
// Feed ID from Chainlink Data Streams crypto catalog.
const DEFAULT_BTC_FEED_ID = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';

const MAINNET_ENDPOINT = 'https://api.dataengine.chain.link';
const MAINNET_WS_ENDPOINT = 'wss://ws.dataengine.chain.link';
const TESTNET_ENDPOINT = 'https://api.testnet-dataengine.chain.link';
const TESTNET_WS_ENDPOINT = 'wss://ws.testnet-dataengine.chain.link';

// Module state
let client = null;
let stream = null;
let latestReport = null; // { price, validFromTimestamp, observationsTimestamp, receivedAt }
let connectAttempted = false;
let connectFailedAt = 0;
const RECONNECT_COOLDOWN_MS = 60_000;

function getFeedId() {
  return process.env.CHAINLINK_DS_BTC_FEED_ID || DEFAULT_BTC_FEED_ID;
}

function getEndpoints() {
  const useTestnet = process.env.CHAINLINK_DS_TESTNET === 'true';
  return {
    endpoint: useTestnet ? TESTNET_ENDPOINT : MAINNET_ENDPOINT,
    wsEndpoint: useTestnet ? TESTNET_WS_ENDPOINT : MAINNET_WS_ENDPOINT,
  };
}

/**
 * Check if adapter has credentials configured.
 * Returns false when env vars are missing — adapter stays dormant.
 */
export function isDataStreamsConfigured() {
  return Boolean(process.env.CHAINLINK_DS_API_KEY && process.env.CHAINLINK_DS_USER_SECRET);
}

/**
 * Decode V3 crypto report price (18 decimals BigInt → number).
 */
function decodeV3Price(decoded) {
  if (!decoded || typeof decoded.price === 'undefined') return null;
  const priceBigInt = typeof decoded.price === 'bigint' ? decoded.price : BigInt(decoded.price);
  return Number(priceBigInt) / 1e18;
}

/**
 * Lazy-initialize the SDK client and open a WS stream for BTC/USD.
 * Returns true if connected, false if dormant/failed.
 */
export async function initDataStreams() {
  if (!isDataStreamsConfigured()) {
    if (!connectAttempted) {
      log.info('Data Streams dormant (CHAINLINK_DS_API_KEY / CHAINLINK_DS_USER_SECRET not set)');
      connectAttempted = true;
    }
    return false;
  }

  if (stream) return true;

  const now = Date.now();
  if (now - connectFailedAt < RECONNECT_COOLDOWN_MS) return false;

  try {
    const sdk = await import('@chainlink/data-streams-sdk');
    const { createClient, decodeReport, LogLevel } = sdk;
    const endpoints = getEndpoints();

    client = createClient({
      apiKey: process.env.CHAINLINK_DS_API_KEY,
      userSecret: process.env.CHAINLINK_DS_USER_SECRET,
      endpoint: endpoints.endpoint,
      wsEndpoint: endpoints.wsEndpoint,
      logging: { logger: { info: () => {}, warn: log.warn.bind(log), error: log.error.bind(log), debug: () => {} }, logLevel: LogLevel.WARN },
    });

    const feedId = getFeedId();
    stream = client.createStream([feedId]);

    stream.on('report', (report) => {
      try {
        const decoded = decodeReport(report.fullReport, report.feedID);
        const price = decodeV3Price(decoded);
        if (price && price > 0 && Number.isFinite(price)) {
          latestReport = {
            price,
            validFromTimestamp: report.validFromTimestamp,
            observationsTimestamp: report.observationsTimestamp,
            receivedAt: Date.now(),
          };
        }
      } catch (err) {
        log.debug(`Report decode failed: ${err.message}`);
      }
    });

    stream.on('error', (err) => {
      log.warn(`Data Streams error: ${err.message || err}`);
    });

    stream.on('disconnected', () => {
      log.warn('Data Streams WS disconnected');
    });

    await stream.connect();
    log.info(`Data Streams connected (feed ${feedId.slice(0, 10)}...)`);
    connectFailedAt = 0;
    return true;
  } catch (err) {
    log.error(`Data Streams init failed: ${err.message}`);
    connectFailedAt = Date.now();
    client = null;
    stream = null;
    return false;
  }
}

/**
 * Get the latest streamed BTC/USD price from the WS buffer.
 * Returns null if dormant, disconnected, or buffer stale (>30s old).
 *
 * @returns {{ price: number, observationsTimestamp: number, age: number } | null}
 */
export function getLatestStreamPrice() {
  if (!latestReport) return null;
  const age = Date.now() - latestReport.receivedAt;
  if (age > 30_000) return null; // stale buffer
  return {
    price: latestReport.price,
    observationsTimestamp: latestReport.observationsTimestamp,
    age,
  };
}

/**
 * Fetch the EXACT report at a specific timestamp via REST API.
 * This is the highest-accuracy PTB path: Polymarket uses the same source.
 *
 * @param {number} targetSec - Unix timestamp in seconds (e.g. eventStartTime)
 * @returns {Promise<{ price: number, observationsTimestamp: number, source: 'data_streams' } | null>}
 */
export async function fetchDataStreamsReportAt(targetSec) {
  if (!isDataStreamsConfigured()) return null;
  if (!Number.isFinite(targetSec) || targetSec <= 0) return null;

  // Lazy init client (REST works without stream)
  if (!client) {
    try {
      const sdk = await import('@chainlink/data-streams-sdk');
      const { createClient, LogLevel } = sdk;
      const endpoints = getEndpoints();
      client = createClient({
        apiKey: process.env.CHAINLINK_DS_API_KEY,
        userSecret: process.env.CHAINLINK_DS_USER_SECRET,
        endpoint: endpoints.endpoint,
        wsEndpoint: endpoints.wsEndpoint,
        logging: { logger: { info: () => {}, warn: () => {}, error: log.error.bind(log), debug: () => {} }, logLevel: LogLevel.ERROR },
      });
    } catch (err) {
      log.error(`Data Streams REST init failed: ${err.message}`);
      return null;
    }
  }

  try {
    const sdk = await import('@chainlink/data-streams-sdk');
    const { decodeReport } = sdk;
    const feedId = getFeedId();
    const report = await client.getReportByTimestamp(feedId, targetSec);
    if (!report?.fullReport) return null;

    const decoded = decodeReport(report.fullReport, report.feedID);
    const price = decodeV3Price(decoded);
    if (!price || price <= 0 || !Number.isFinite(price)) return null;

    log.info(`Data Streams PTB: $${price.toFixed(2)} @ ts=${report.observationsTimestamp} (target=${targetSec}, diff=${report.observationsTimestamp - targetSec}s)`);
    return {
      price,
      observationsTimestamp: report.observationsTimestamp,
      source: 'data_streams',
    };
  } catch (err) {
    log.warn(`Data Streams getReportByTimestamp failed: ${err.message}`);
    return null;
  }
}

/**
 * Graceful shutdown — close WS stream.
 */
export async function shutdownDataStreams() {
  if (stream) {
    try {
      await stream.disconnect();
    } catch { /* ignore */ }
    stream = null;
  }
  client = null;
  latestReport = null;
}
