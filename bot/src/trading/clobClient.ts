/**
 * Polymarket CLOB client wrapper — CLOB V2 (`@polymarket/clob-client-v2`).
 * Handles wallet setup, API credential derivation, and order placement.
 *
 * V1-signed orders (EIP-712 domain version "1", `@polymarket/clob-client`)
 * have been rejected in production since the 2026-04-28 V2 cutover
 * (docs.polymarket.com/v2-migration). Configuration and the reasons behind it:
 * clobV2Config.ts. Operator checklist: docs/CLOB_V2_MIGRATION.md.
 *
 * Live only. The dry-run path never calls initClobClient(), so every order
 * function here throws 'CLOB client not initialized' before doing anything else.
 */

import { ethers } from 'ethers';
import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client-v2';
import type { ApiKeyCreds } from '@polymarket/clob-client-v2';
import { createLogger } from '../logger.ts';
import { CONFIG } from '../config.ts';
import {
  V2_CONTRACTS,
  buildClobClientOptions,
  createClobSigner,
  resolveSignatureType,
  signatureTypeName,
  skipSettlementWait,
} from './clobV2Config.ts';
import { checkGtdExpiration, getOrderConstraints, prepareOrder } from './orderConstraints.ts';
import type { OrderKind, OrderSide, PreparedOrder } from './orderConstraints.ts';
import { describeApprovals, evaluateV2Readiness, readWalletState } from './v2Readiness.ts';
import { polygonRpcUrl } from './polygonRpc.ts';

const log = createLogger('CLOB');

type TradeHistoryOptions = {
  market?: string;
  assetId?: string;
  after?: number;
  before?: number;
};

type OrderParams = { tokenId: string; price: number; size: number };
type LimitOrderParams = OrderParams & { expiration: number; postOnly?: boolean };

/** Order placement timeout. The settlement-hash wait is disabled (skipSettlementWait), so this bounds the POST. */
const ORDER_TIMEOUT_MS = 15_000;

let client: ClobClient | null = null;
let walletAddress: string | null = null;
/** CLOB order version read at init (GET /version); null when the read failed. */
let orderVersion: number | null = null;

/** Race a promise against a timer that is cleared either way. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function requireClient(): ClobClient {
  if (!client) throw new Error('CLOB client not initialized');
  return client;
}

/**
 * Tick-round and size-check an order against the constraints last seen for
 * its token (defaults 5 shares / 0.01). Throws, with a log line, when the
 * order cannot be placed as asked — it is never upsized.
 */
function prepareOrThrow(action: string, side: OrderSide, kind: OrderKind, { tokenId, price, size }: OrderParams) {
  const prepared: PreparedOrder = prepareOrder({ side, kind, price, size, constraints: getOrderConstraints(tokenId) });
  if (prepared.ok === false) {
    log.warn(`${action} rejected before signing: ${prepared.reason} | token=${String(tokenId).slice(0, 12)}...`);
    throw new Error(`${action} rejected: ${prepared.reason}`);
  }
  return prepared;
}

function orderOptions(prepared: { tickSize: string | null }) {
  // The SDK checks this against the market's own tick and refuses a finer one.
  return prepared.tickSize ? { tickSize: prepared.tickSize as '0.01' } : undefined;
}

/**
 * Defense-in-depth response check.
 * CLOB SDK with throwOnError: true natively throws on HTTP errors and { error: "..." } responses,
 * so the manual error check is redundant. We still guard `success: false` because matching-engine
 * rejections may come back as HTTP 200 with { success: false, errorMsg } and the SDK won't throw.
 */
function validateOrderResponse(result, action) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${action}: empty response from CLOB API`);
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
 * Initialize the CLOB V2 client with wallet and API credentials.
 * Must be called before placing orders. Live only.
 */
export async function initClobClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set');

  // viem wallet client: signs locally, never sends anything by itself.
  const signer = createClobSigner(pk);
  walletAddress = signer.account.address;
  log.info(`Wallet address: ${walletAddress}`);

  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || undefined;

  // A proxy address means the funds sit in a Polymarket smart wallet (a Gnosis
  // Safe by default): the EOA signs, the proxy is maker/funder.
  const signatureType = resolveSignatureType(proxyAddress, process.env.POLYMARKET_SIGNATURE_TYPE);
  if (proxyAddress) {
    log.info(`Proxy wallet: ${proxyAddress} (signatureType=${signatureTypeName(signatureType)})`);
  } else {
    log.info(`No proxy address set — using ${signatureTypeName(signatureType)} signing`);
  }

  const build = (creds?: ApiKeyCreds) => new ClobClient(buildClobClientOptions({
    host: CONFIG.clobBaseUrl,
    signer,
    creds,
    signatureType,
    funderAddress: proxyAddress,
  }));

  let next: ClobClient;
  if (apiKey && apiSecret && apiPassphrase) {
    // L1/L2 auth is unchanged in V2: existing API keys keep working.
    next = build({ key: apiKey, secret: apiSecret, passphrase: apiPassphrase });
    log.info('CLOB V2 client initialized with provided API credentials');
  } else {
    const bootstrap = build();
    log.info('Deriving API credentials from wallet...');
    const creds = await bootstrap.createOrDeriveApiKey();
    next = build(creds);
    log.info('CLOB V2 client initialized with derived API credentials');
  }

  if (!skipSettlementWait(next)) {
    throw new Error(
      'clob-client-v2 no longer exposes resolveTransactionsHashes: postOrder may wait up to 30s for settlement ' +
      'hashes, longer than the order timeout. Review clobV2Config.ts skipSettlementWait before trading live.',
    );
  }

  // The order version decides which exchange the SDK signs for (2 = CTF Exchange V2).
  try {
    orderVersion = await withTimeout(next.getVersion(), 10_000, 'CLOB /version timeout (10s)');
    log.info(`CLOB order version ${orderVersion} | CTF Exchange V2 ${V2_CONTRACTS.exchange} | collateral pUSD ${V2_CONTRACTS.collateral}`);
  } catch (err) {
    orderVersion = null;
    log.warn(`CLOB order version lookup failed: ${err.message}`);
  }

  client = next;

  // Refresh the CLOB's cached pUSD balance/allowance for the funder. This is a
  // sync, not an approval: it sends no transaction. The approvals themselves
  // are checked by verifyClobV2Readiness().
  await updateCollateralApproval();

  return client;
}

/**
 * Live-startup gate: the funder wallet holds pUSD and has approved CTF Exchange
 * V2 for pUSD and for its outcome tokens. Reads chain state only — it sends no
 * transaction and does not wrap USDC.e. Throws with every problem found.
 *
 * RPC: POLYGON_RPC_URL, else the first of CONFIG.chainlink.polygonRpcUrls.
 */
export async function verifyClobV2Readiness(): Promise<void> {
  requireClient();
  const funder = getProxyAddress();
  if (!funder) throw new Error('no funder address (POLYMARKET_PROXY_ADDRESS or wallet)');

  const rpcUrl = process.env.POLYGON_RPC_URL || CONFIG.chainlink?.polygonRpcUrls?.[0];
  if (!rpcUrl) throw new Error('no Polygon RPC configured (POLYGON_RPC_URL)');
  const provider = new ethers.JsonRpcProvider(rpcUrl, new ethers.Network('matic', 137), { staticNetwork: true, batchMaxCount: 1 });

  log.info(`CLOB V2 readiness: reading pUSD balance and approvals for ${funder} (view calls only, no transaction)`);
  let state;
  try {
    state = await withTimeout(readWalletState(provider, funder, orderVersion), 15_000, 'Polygon RPC timeout (15s)');
  } catch (err) {
    throw new Error(`could not read the wallet's pUSD balance / approvals from Polygon: ${err.message}`);
  } finally {
    provider.destroy();
  }

  for (const line of describeApprovals(state)) log.info(`CLOB V2 readiness: ${line}`);
  const verdict = evaluateV2Readiness(state);
  for (const note of verdict.notes) log.warn(`CLOB V2 readiness: ${note}`);
  if (!verdict.ok) {
    for (const problem of verdict.problems) log.error(`CLOB V2 readiness: ${problem}`);
    throw new Error(`${verdict.problems.length} problem(s) — see the lines above and docs/CLOB_V2_MIGRATION.md`);
  }
  log.info('CLOB V2 readiness: OK — pUSD funded, CTF Exchange V2 approved for pUSD and outcome tokens');
}

/**
 * Place a fill-or-kill buy on Polymarket CLOB.
 * The price is the maximum per share; it is rounded down to the market tick.
 * An order under the market's minimum size is refused, never upsized.
 * @param {Object} params
 * @param {string} params.tokenId - The outcome token ID to buy
 * @param {number} params.price - Limit price (0-1)
 * @param {number} params.size - Number of shares (dollar amount / price)
 * @returns {Promise<Object>} Order result from CLOB
 */
export async function placeBuyOrder({ tokenId, price, size }: OrderParams) {
  const c = requireClient();
  const order = prepareOrThrow('BUY', 'BUY', 'market', { tokenId, price, size });

  // FOK (Fill-or-Kill): entire order fills immediately or is cancelled.
  // GTC was unsafe — partial fills leave remainder open + loop.js records full size.
  // A market BUY's amount is the dollars to spend (shares × price); the taker fee
  // is charged on top at match. orderType is the 3rd positional arg.
  // H13: timeout prevents bot from hanging indefinitely on slow CLOB API.
  // Loosely typed on purpose: callers read makingAmount / takingAmount as before.
  const result: any = await withTimeout(
    c.createAndPostMarketOrder(
      { tokenID: tokenId, price: order.price, amount: order.buyAmountUsd, side: Side.BUY, orderType: OrderType.FOK },
      orderOptions(order),
      OrderType.FOK,
    ),
    ORDER_TIMEOUT_MS,
    'createAndPostMarketOrder BUY timeout (15s)',
  );

  validateOrderResponse(result, 'BUY');

  const orderId = extractOrderId(result);
  log.info(`Order placed: BUY ${order.size} @ ${order.price} | orderId=${orderId ?? 'unknown'} | token=${tokenId.slice(0, 12)}...`);
  log.debug(`BUY response: ${JSON.stringify(result)}`);
  return { ...result, orderId };
}

/**
 * Place a GTD (Good-Til-Date) limit buy order on Polymarket CLOB.
 * Unlike FOK, this order stays on the book until filled or expiration.
 * @param {Object} params
 * @param {string} params.tokenId - The outcome token ID to buy
 * @param {number} params.price - Limit price (0-1), rounded down to the market tick
 * @param {number} params.size - Number of shares (refused under the market minimum)
 * @param {number} params.expiration - Unix timestamp (seconds) when order auto-cancels
 * @param {boolean} [params.postOnly=false] - Rest only: the CLOB rejects the order instead of letting it take
 * @returns {Promise<Object>} Order result from CLOB
 */
export async function placeLimitBuyOrder({ tokenId, price, size, expiration, postOnly = false }: LimitOrderParams) {
  const c = requireClient();
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiration <= nowSec) throw new Error(`GTD expiration ${expiration} already past`);
  const expiryProblem = checkGtdExpiration(expiration, nowSec);
  if (expiryProblem) {
    log.warn(`LIMIT_BUY rejected before signing: ${expiryProblem} | token=${String(tokenId).slice(0, 12)}...`);
    throw new Error(`LIMIT_BUY rejected: ${expiryProblem}`);
  }
  const order = prepareOrThrow('LIMIT_BUY', 'BUY', 'limit', { tokenId, price, size });

  // postOnly is the 4th positional arg (V2); it is not supported for FOK/FAK.
  // Loosely typed on purpose: callers read makingAmount / takingAmount as before.
  const result: any = await withTimeout(
    c.createAndPostOrder(
      { tokenID: tokenId, price: order.price, side: Side.BUY, size: order.size, expiration },
      orderOptions(order),
      OrderType.GTD,
      postOnly,
    ),
    ORDER_TIMEOUT_MS,
    'GTD BUY timeout (15s)',
  );

  validateOrderResponse(result, 'LIMIT_BUY');
  const orderId = extractOrderId(result);
  log.info(`LIMIT order: GTD BUY ${order.size}@${order.price}${postOnly ? ' postOnly' : ''} exp=${new Date(expiration * 1000).toISOString()} | id=${orderId}`);
  return { ...result, orderId };
}

/**
 * Look up an order by ID among open orders.
 * Returns the order object if found, null if not found (likely filled or expired).
 * @param {string} orderId - Order ID to look up
 * @returns {Promise<Object|null>}
 */
export async function getOrderById(orderId) {
  if (!client) throw new Error('CLOB client not initialized');
  try {
    const openOrders = await getOpenOrders();
    return openOrders.find(o => (o.id ?? o.orderID ?? o.order_id) === orderId) ?? null;
  } catch (err) {
    log.debug(`getOrderById failed: ${err.message}`);
    return null;
  }
}

/**
 * Get the definitive status of an order by ID via /data/order/{id}.
 * More reliable than getOpenOrders() for fill detection — reflects matching engine state.
 * Returns the order object with status field, or null if not found/error.
 * @param {string} orderId
 * @returns {Promise<Object|null>} order with status: 'LIVE'|'MATCHED'|'CANCELLED'|'DELAYED' etc.
 */
export async function getOrderStatus(orderId) {
  if (!client) return null;
  try {
    const result: any = await withTimeout(client.getOrder(orderId), 5_000, 'getOrderStatus timeout (5s)');
    if (result?.error) {
      log.debug(`getOrderStatus(${orderId}): ${result.error}`);
      return null;
    }
    return result ?? null;
  } catch (err) {
    log.debug(`getOrderStatus failed: ${err.message}`);
    return null;
  }
}

/**
 * Cancel an open order.
 */
export async function cancelOrder(orderId) {
  if (!client) throw new Error('CLOB client not initialized');
  // CLOB client expects { orderID: string }, NOT a raw string.
  // Passing raw string caused "Invalid order payload" (HTTP 400) on every cancel.
  const result = await client.cancelOrder({ orderID: orderId });
  // L2: Log cancel errors (non-critical — don't throw)
  if (result?.error) {
    log.warn(`Cancel order error: ${result.error} — order may have been filled`);
  } else {
    log.info(`Order cancelled: ${orderId}`);
  }
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
 * Get all open orders. 10s timeout prevents poll stall on slow CLOB.
 */
export async function getOpenOrders() {
  if (!client) throw new Error('CLOB client not initialized');
  const result: any = await withTimeout(client.getOpenOrders(), 10_000, 'getOpenOrders timeout (10s)');
  // CLOB client may return { error: "..." } instead of array
  if (result && !Array.isArray(result)) {
    if (result.error) throw new Error(`getOpenOrders: ${result.error}`);
    return [];
  }
  return result ?? [];
}

/**
 * Place a fill-or-kill sell order on Polymarket CLOB.
 * The price is the minimum per share; it is rounded up to the market tick.
 * An order under the market's minimum size is refused.
 * @param {Object} params
 * @param {string} params.tokenId - The outcome token ID to sell
 * @param {number} params.price - Limit price (0-1)
 * @param {number} params.size - Number of shares to sell
 * @returns {Promise<Object>} Order result from CLOB
 */
export async function placeSellOrder({ tokenId, price, size }: OrderParams) {
  const c = requireClient();
  const order = prepareOrThrow('SELL', 'SELL', 'market', { tokenId, price, size });

  // FOK SELL uses createAndPostMarketOrder: amount = shares to sell (not dollars).
  // orderType is the 3rd positional arg. H13: timeout bounds a slow CLOB API.
  // Loosely typed on purpose: callers read makingAmount / takingAmount as before.
  const result: any = await withTimeout(
    c.createAndPostMarketOrder(
      { tokenID: tokenId, price: order.price, amount: order.size, side: Side.SELL, orderType: OrderType.FOK },
      orderOptions(order),
      OrderType.FOK,
    ),
    ORDER_TIMEOUT_MS,
    'createAndPostMarketOrder SELL timeout (15s)',
  );

  validateOrderResponse(result, 'SELL');

  const orderId = extractOrderId(result);
  log.info(`Order placed: SELL ${order.size} @ ${order.price} | orderId=${orderId ?? 'unknown'} | token=${tokenId.slice(0, 12)}...`);
  log.debug(`SELL response: ${JSON.stringify(result)}`);
  return { ...result, orderId };
}

// ── Bug #37 fix (2026-05-15): include USDC.e in bankroll ──
// CLOB getBalanceAllowance returns pUSD only. Settlement redemptions return
// USDC.e (legacy) which is invisible → ghost-drawdown / wealth under-report.
// Read USDC.e on-chain and ADD to pUSD for a true total-wallet bankroll.
const _USDCE_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const _CHAINSTACK = polygonRpcUrl();
const _POLY_NET = new ethers.Network('matic', 137);
const _ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
let _usdceProvider = null;

async function readUsdceOnChain(proxyAddr) {
  try {
    if (!_usdceProvider) {
      _usdceProvider = new ethers.JsonRpcProvider(_CHAINSTACK, _POLY_NET, { staticNetwork: true, batchMaxCount: 1 });
    }
    const c = new ethers.Contract(_USDCE_ADDR, _ERC20_BAL_ABI, _usdceProvider);
    const raw = await c.balanceOf(proxyAddr);
    const val = Number(raw) / 1e6;
    return (Number.isFinite(val) && val >= 0 && val < 100_000) ? val : 0;
  } catch (e) {
    log.debug(`USDC.e on-chain read failed: ${e.message}`);
    return 0; // unavailable → treat as 0 (next poll retries)
  }
}

/**
 * The allowance a balance-allowance response grants `spender`, as a raw number.
 *
 * V1 answered `{ balance, allowance }`; V2 answers `{ balance, allowances }`,
 * a map keyed by spender address. Reads either shape. Null when the response
 * says nothing about `spender`.
 */
export function readAllowance(result: unknown, spender: string): number | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { allowance?: unknown; allowances?: unknown };
  const parse = (v: unknown): number | null => {
    const n = parseFloat(String(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  if (r.allowances && typeof r.allowances === 'object') {
    const want = spender.toLowerCase();
    for (const [key, value] of Object.entries(r.allowances as Record<string, unknown>)) {
      if (key.toLowerCase() === want) return parse(value);
    }
    return null;
  }
  return r.allowance != null ? parse(r.allowance) : null;
}

/**
 * Fetch real collateral balance + allowance from Polymarket.
 * Uses the CLOB client's getBalanceAllowance(), which reports the funder's
 * pUSD (the V2 collateral, 6 decimals) and its allowance for CTF Exchange V2.
 *
 * @returns {Promise<{ balance: number, allowance: number } | null>}
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
    const result: any = await withTimeout(
      client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      8_000,
      'getUsdcBalance timeout (8s)',
    );
    if (result && result.balance != null) {
      // pUSD has 6 decimals — API returns raw micro-units as a string
      const rawBalance = parseFloat(result.balance);
      const rawAllowance = readAllowance(result, V2_CONTRACTS.exchange);
      // FINTECH: Validate range — must be finite, non-negative, and reasonable.
      // Max 100M micro-units = $100,000. Anything above is likely API garbage.
      const MAX_RAW_BALANCE = 100_000 * 1e6; // $100K in micro-units
      if (!Number.isFinite(rawBalance) || rawBalance < 0 || rawBalance > MAX_RAW_BALANCE) {
        log.warn(`Invalid USDC balance from API: ${result.balance} (raw=${rawBalance}, max=${MAX_RAW_BALANCE}) — rejecting, using stale cache`);
      } else {
        let totalBalance = rawBalance / 1e6;
        // Bug #37 fix: add USDC.e ghost (settlement-returned legacy collateral)
        const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
        if (proxyAddr) {
          const usdceBal = await readUsdceOnChain(proxyAddr);
          if (usdceBal > 0.01) {
            log.debug(`Bankroll incl USDC.e: pUSD $${totalBalance.toFixed(2)} + USDC.e $${usdceBal.toFixed(2)} = $${(totalBalance + usdceBal).toFixed(2)}`);
            totalBalance += usdceBal;
          }
        }
        balanceCache = {
          balance: totalBalance,
          allowance: rawAllowance != null ? rawAllowance / 1e6 : 0,
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
  return walletAddress;
}

export function isClientReady() {
  return client !== null;
}

export function getProxyAddress() {
  return process.env.POLYMARKET_PROXY_ADDRESS || walletAddress || null;
}

/**
 * Fetch actual conditional token (ERC1155) balance AND allowance from CLOB API.
 * More reliable than Polygon RPC (same API, no regional blocks).
 * Returns { balance, allowance } in decimal, or null on error.
 * - balance=0 → phantom position (no tokens received)
 * - allowance=0 → ERC1155 not approved for CTF Exchange V2 (setApprovalForAll missing)
 * - allowance=null → the response did not say (V2 reports allowances per spender)
 *
 * @param {string} tokenId - Outcome token ID
 * @returns {Promise<{balance: number, allowance: number|null}|null>}
 */
export async function getConditionalTokenBalance(tokenId) {
  if (!client) return null;
  try {
    const result: any = await withTimeout(
      client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId }),
      5_000,
      'conditional balance timeout',
    );
    if (result?.balance != null) {
      const rawBal = parseFloat(result.balance);
      if (Number.isFinite(rawBal) && rawBal >= 0) {
        return {
          balance: rawBal / 1e6,
          allowance: readAllowance(result, V2_CONTRACTS.exchange),
        };
      }
    }
  } catch (err) {
    log.debug(`Conditional token balance check failed: ${err.message}`);
  }
  return null;
}

/**
 * Ask the CLOB to re-read the funder's pUSD balance and allowance from chain
 * (GET /balance-allowance/update). It refreshes the CLOB's cache only: it does
 * not approve anything and sends no transaction. Approving pUSD for CTF
 * Exchange V2 is a one-time manual step (docs/CLOB_V2_MIGRATION.md).
 */
export async function updateCollateralApproval() {
  if (!client) return;
  try {
    log.info(`Syncing CLOB allowance cache: COLLATERAL (pUSD ${V2_CONTRACTS.collateral}) for ${getProxyAddress()} — no transaction`);
    await withTimeout(
      client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
      10_000,
      'collateral allowance sync timeout',
    );
    log.info('Collateral (pUSD) allowance cache synced');
  } catch (err) {
    log.warn(`Collateral allowance sync failed (non-fatal): ${err.message}`);
  }
}

/**
 * Ask the CLOB to re-read one outcome token's balance and ERC1155 approval
 * from chain. Cache refresh only — no transaction. Called when a sell fails
 * on balance/allowance; the approval itself is setApprovalForAll(CTF Exchange
 * V2), a one-time manual step.
 *
 * @param {string} tokenId - Outcome token ID
 */
export async function updateConditionalApproval(tokenId) {
  if (!client) return;
  try {
    await withTimeout(
      client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId }),
      10_000,
      'conditional allowance sync timeout',
    );
    log.info(`Conditional token (ERC1155) allowance cache synced for ${tokenId.slice(0, 12)}...`);
  } catch (err) {
    log.warn(`Conditional allowance sync failed (non-fatal): ${err.message}`);
  }
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
export async function getTradeHistory({ market, assetId, after, before }: TradeHistoryOptions = {}) {
  if (!client) return [];
  const params: Record<string, string> = {};
  if (market) params.market = market;
  if (assetId) params.asset_id = assetId;
  // CLOB API requires unix seconds as a string
  if (after != null) params.after = String(after > 1e12 ? Math.floor(after / 1000) : Math.floor(after));
  if (before != null) params.before = String(before > 1e12 ? Math.floor(before / 1000) : Math.floor(before));

  // L3: Add timeout to prevent hanging on slow CLOB API
  const result: any = await withTimeout(client.getTrades(params), 10_000, 'getTrades timeout');
  // getTrades may return an error object instead of throwing
  if (result && !Array.isArray(result)) {
    if (result.error) throw new Error(`CLOB getTrades: ${result.error}`);
    return [];
  }
  return result ?? [];
}
