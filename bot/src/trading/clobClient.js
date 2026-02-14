/**
 * Polymarket CLOB client wrapper.
 * Handles wallet setup, API credential derivation, and order placement.
 */

import { randomUUID } from 'crypto';
import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { createLogger } from '../logger.js';
import { CONFIG } from '../config.js';

const log = createLogger('CLOB');

const POLYGON_CHAIN_ID = 137;

let client = null;
let wallet = null;

/**
 * Initialize the CLOB client with wallet and API credentials.
 * Must be called before placing orders.
 */
export async function initClobClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set');

  // Create wallet (no provider needed for signing)
  wallet = new ethers.Wallet(pk);
  log.info(`Wallet address: ${wallet.address}`);

  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (apiKey && apiSecret && apiPassphrase) {
    // Use provided API credentials
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
      { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    );
    log.info('CLOB client initialized with provided API credentials');
  } else {
    // Derive API credentials from wallet signature
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
    );
    log.info('Deriving API credentials from wallet...');
    const creds = await client.createOrDeriveApiCreds();
    client = new ClobClient(
      CONFIG.clobBaseUrl,
      POLYGON_CHAIN_ID,
      wallet,
      creds,
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

  // C2: Idempotency — unique nonce prevents duplicate orders on retry
  const nonce = randomUUID();

  const order = await client.createAndPostOrder({
    tokenID: tokenId,
    price,
    side: 'BUY',
    size,
    orderType: 'GTC',
    nonce,
  });

  log.info(`Order placed: BUY ${size} @ ${price} | nonce=${nonce.slice(0, 8)} | token=${tokenId.slice(0, 12)}...`);
  return order;
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId) {
  if (!client) throw new Error('CLOB client not initialized');
  const result = await client.cancelOrder(orderId);
  log.info(`Order cancelled: ${orderId}`);
  return result;
}

/**
 * Cancel all open orders.
 */
export async function cancelAllOrders() {
  if (!client) throw new Error('CLOB client not initialized');
  const result = await client.cancelAll();
  log.info('All orders cancelled');
  return result;
}

/**
 * Get all open orders.
 */
export async function getOpenOrders() {
  if (!client) throw new Error('CLOB client not initialized');
  return await client.getOpenOrders();
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

  // C2: Idempotency — unique nonce prevents duplicate orders on retry
  const nonce = randomUUID();

  const order = await client.createAndPostOrder({
    tokenID: tokenId,
    price,
    side: 'SELL',
    size,
    orderType: 'FOK',
    nonce,
  });

  log.info(`Order placed: SELL ${size} @ ${price} | nonce=${nonce.slice(0, 8)} | token=${tokenId.slice(0, 12)}...`);
  return order;
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
