/**
 * Polymarket CLOB client wrapper.
 * Handles wallet setup, API credential derivation, and order placement.
 */

import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { createLogger } from '../logger.js';
import { CONFIG } from '../config.js';

const log = createLogger('CLOB');

const POLYGON_CHAIN_ID = 137;

// SignatureType enum from @polymarket/order-utils
// 0 = EOA (sign with EOA wallet directly — no proxy)
// 1 = POLY_PROXY (for email/Magic wallet logins — Polymarket's internal proxy)
// 2 = POLY_GNOSIS_SAFE (for browser wallets — Gnosis Safe proxy created by Polymarket)
const SIGNATURE_TYPE_EOA = 0;
const SIGNATURE_TYPE_POLY_GNOSIS_SAFE = 2;

let client = null;
let wallet = null;

/**
 * Validate CLOB API response. The @polymarket/clob-client library swallows
 * HTTP errors and returns { error: "..." } instead of throwing. This function
 * detects error responses and throws so callers (loop.js) don't record
 * phantom trades for orders that never went through.
 */
function validateOrderResponse(result, action) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${action}: empty response from CLOB API`);
  }
  if (result.error) {
    const status = result.status ? ` (HTTP ${result.status})` : '';
    const msg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
    throw new Error(`${action}: CLOB API error${status}: ${msg}`);
  }
  if (result.success === false) {
    throw new Error(`${action}: order rejected: ${result.errorMsg || 'unknown reason'}`);
  }
  return result;
}

/**
 * Extract orderId from CLOB API response.
 * The API may return it as orderID, order_id, or id depending on version.
 */
function extractOrderId(result) {
  return result?.orderID ?? result?.order_id ?? result?.id ?? null;
}

/**
 * Initialize the CLOB client with wallet and API credentials.
 * Must be called before placing orders.
 */
export async function initClobClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set');

  // Create wallet (no provider needed for signing)
  wallet = new ethers.Wallet(pk);

  // Ethers v6 compatibility shim: @polymarket/clob-client expects ethers v5's
  // _signTypedData(), but ethers v6 renamed it to signTypedData() (no underscore).
  if (!wallet._signTypedData && wallet.signTypedData) {
    wallet._signTypedData = wallet.signTypedData.bind(wallet);
  }

  log.info(`Wallet address: ${wallet.address}`);

  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  // Determine signature type: if proxy address is set, use POLY_GNOSIS_SAFE (2)
  // Polymarket creates a Gnosis Safe proxy for browser-wallet users.
  // The EOA signs orders, maker/funder is the Safe (where USDC.e lives).
  const sigType = proxyAddress ? SIGNATURE_TYPE_POLY_GNOSIS_SAFE : SIGNATURE_TYPE_EOA;
  const funder = proxyAddress || undefined;

  if (proxyAddress) {
    log.info(`Proxy wallet: ${proxyAddress} (signatureType=POLY_GNOSIS_SAFE)`);
  } else {
    log.info('No proxy address set — using EOA signing');
  }

  if (apiKey && apiSecret && apiPassphrase) {
    // Use provided API credentials
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
      sigType,   // signatureType (5th param)
      funder,    // funderAddress (6th param) — proxy wallet
    );
    log.info('CLOB client initialized with provided API credentials');
  } else {
    // Derive API credentials from wallet signature
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
      undefined,
      sigType,
      funder,
    );
    log.info('Deriving API credentials from wallet...');
    const creds = await client.createOrDeriveApiCreds();
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
      creds,
      sigType,
      funder,
    );
    log.info('CLOB client initialized with derived API credentials');
  }

  return client;
}

/**
 * Place a limit buy order on Polymarket CLOB.
 * @param {Object} params
 * @param {string} params.tokenId - The outcome token ID to buy
 * @param {number} params.price - Limit price (0-1)
 * @param {number} params.size - Number of shares (dollar amount / price)
 * @returns {Object} Order result from CLOB
 */
export async function placeBuyOrder({ tokenId, price, size }) {
  if (!client) throw new Error('CLOB client not initialized');

  // orderType is the 3rd positional arg to createAndPostOrder, NOT inside userOrder
  // FOK (Fill-or-Kill): entire order fills immediately or is cancelled.
  // GTC was unsafe — partial fills leave remainder open + loop.js records full size.
  // H13: 15s timeout prevents bot from hanging indefinitely on slow CLOB API
  const result = await Promise.race([
    client.createAndPostOrder(
      { tokenID: tokenId, price, side: 'BUY', size },
      undefined, // options
      'FOK',     // orderType (3rd param) — fill-or-kill to prevent untracked partial fills
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('createAndPostOrder BUY timeout (15s)')), 15000)),
  ]);

  // Validate — CLOB client swallows HTTP errors, returning { error: "..." }
  validateOrderResponse(result, 'BUY');

  const orderId = extractOrderId(result);
  log.info(`Order placed: BUY ${size} @ ${price} | orderId=${orderId ?? 'unknown'} | token=${tokenId.slice(0, 12)}...`);
  log.debug(`BUY response: ${JSON.stringify(result)}`);
  return { ...result, orderId };
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId) {
  if (!client) throw new Error('CLOB client not initialized');
  const result = await client.cancelOrder(orderId);
  // L2: Log cancel errors (non-critical — don't throw)
  if (result?.error) log.warn(`Cancel order warning: ${result.error}`);
  log.info(`Order cancelled: ${orderId}`);
  return result;
}

/**
 * Cancel all open orders.
 */
export async function cancelAllOrders() {
  if (!client) throw new Error('CLOB client not initialized');
  const result = await client.cancelAll();
  // L2: Log cancel errors (non-critical — don't throw)
  if (result?.error) log.warn(`Cancel all orders warning: ${result.error}`);
  log.info('All orders cancelled');
  return result;
}

/**
 * Get all open orders.
 */
export async function getOpenOrders() {
  if (!client) throw new Error('CLOB client not initialized');
  const result = await client.getOpenOrders();
  // CLOB client may return { error: "..." } instead of array
  if (result && !Array.isArray(result)) {
    if (result.error) throw new Error(`getOpenOrders: ${result.error}`);
    return [];
  }
  return result ?? [];
}

/**
 * Place a fill-or-kill sell order on Polymarket CLOB.
 * @param {Object} params
 * @param {string} params.tokenId - The outcome token ID to sell
 * @param {number} params.price - Limit price (0-1)
 * @param {number} params.size - Number of shares to sell
 * @returns {Object} Order result from CLOB
 */
export async function placeSellOrder({ tokenId, price, size }) {
  if (!client) throw new Error('CLOB client not initialized');

  // orderType is the 3rd positional arg to createAndPostOrder, NOT inside userOrder
  // H13: 15s timeout prevents bot from hanging indefinitely on slow CLOB API
  const result = await Promise.race([
    client.createAndPostOrder(
      { tokenID: tokenId, price, side: 'SELL', size },
      undefined, // options
      'FOK',     // orderType (3rd param) — fill-or-kill for sells
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('createAndPostOrder SELL timeout (15s)')), 15000)),
  ]);

  validateOrderResponse(result, 'SELL');

  const orderId = extractOrderId(result);
  log.info(`Order placed: SELL ${size} @ ${price} | orderId=${orderId ?? 'unknown'} | token=${tokenId.slice(0, 12)}...`);
  log.debug(`SELL response: ${JSON.stringify(result)}`);
  return { ...result, orderId };
}

/**
 * Fetch real USDC balance + allowance from Polymarket.
 * Uses the CLOB client's getBalanceAllowance() which returns the actual
 * on-chain collateral (USDC.e) available for trading.
 *
 * @returns {{ balance: number, allowance: number } | null}
 */
let balanceCache = null;
let balanceLastFetchMs = 0;
const BALANCE_CACHE_TTL = 10_000; // 10s cache

export async function getUsdcBalance() {
  if (!client) return null;

  const now = Date.now();
  if (balanceCache && now - balanceLastFetchMs < BALANCE_CACHE_TTL) {
    return balanceCache;
  }

  try {
    const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    if (result && result.balance != null) {
      // USDC.e has 6 decimals — API returns raw microUSDC string
      const rawBalance = parseFloat(result.balance);
      const rawAllowance = parseFloat(result.allowance ?? '0');
      // FINTECH: Validate range — must be finite, non-negative, and reasonable.
      // Max 100M microUSDC = $100,000. Anything above is likely API garbage.
      const MAX_RAW_BALANCE = 100_000 * 1e6; // $100K in microUSDC
      if (!Number.isFinite(rawBalance) || rawBalance < 0 || rawBalance > MAX_RAW_BALANCE) {
        log.warn(`Invalid USDC balance from API: ${result.balance} (raw=${rawBalance}, max=${MAX_RAW_BALANCE}) — rejecting, using stale cache`);
      } else {
        balanceCache = {
          balance: rawBalance / 1e6,
          allowance: Number.isFinite(rawAllowance) && rawAllowance >= 0 ? rawAllowance / 1e6 : 0,
          fetchedAt: now,
        };
        balanceLastFetchMs = now;
        return balanceCache;
      }
    }
  } catch (err) {
    log.warn(`USDC balance fetch failed: ${err.message}`);
    balanceLastFetchMs = now; // Prevent retry storm
  }
  return balanceCache; // Return stale cache on error
}

/**
 * Get the wallet address used by the CLOB client.
 */
export function getWalletAddress() {
  return wallet?.address ?? null;
}

export function isClientReady() {
  return client !== null;
}

/**
 * Fetch trade history from the CLOB API.
 * Returns real on-chain fill data for the authenticated wallet.
 *
 * CLOB API expects `after`/`before` as unix timestamp strings (seconds).
 * This wrapper accepts either unix-seconds numbers or ms numbers (>1e12)
 * and converts appropriately.
 *
 * @param {Object} [params]
 * @param {string} [params.market] - Filter by market/conditionId
 * @param {string} [params.assetId] - Filter by asset (token) ID
 * @param {number} [params.after] - Unix timestamp (seconds or ms) — only trades after
 * @param {number} [params.before] - Unix timestamp (seconds or ms) — only trades before
 * @returns {Promise<Array>} Array of Trade objects from CLOB
 */
export async function getTradeHistory({ market, assetId, after, before } = {}) {
  if (!client) return [];
  const params = {};
  if (market) params.market = market;
  if (assetId) params.asset_id = assetId;
  // CLOB API requires unix seconds as a string
  if (after != null) params.after = String(after > 1e12 ? Math.floor(after / 1000) : Math.floor(after));
  if (before != null) params.before = String(before > 1e12 ? Math.floor(before / 1000) : Math.floor(before));

  // L3: Add timeout to prevent hanging on slow CLOB API
  const result = await Promise.race([
    client.getTrades(params),
    new Promise((_, reject) => setTimeout(() => reject(new Error('getTrades timeout')), 10000))
  ]);
  // getTrades may return an error object instead of throwing
  if (result && !Array.isArray(result)) {
    if (result.error) throw new Error(`CLOB getTrades: ${result.error}`);
    return [];
  }
  return result ?? [];
}
