/**
 * Position Manager — Fetches real on-chain positions from Polymarket Data API.
 * Provides close/sell operations and JSON persistence.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import { BOT_CONFIG } from '../config.js';
import { placeSellOrder, getWalletAddress } from './clobClient.js';

const log = createLogger('Positions');

const CACHE_TTL_MS = 15_000; // Cache positions for 15s
const DATA_API = 'https://data-api.polymarket.com';

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const POLYGON_RPC = 'https://polygon-rpc.com';

let cachedPositions = [];
let lastFetchMs = 0;
let pollTimer = null;

/**
 * Fetch positions from Polymarket Data API.
 * @param {string} walletAddress - Wallet address to query
 * @returns {Array} Parsed position objects
 */
export async function fetchPositions(walletAddress) {
  if (!walletAddress) return [];

  const url = `${DATA_API}/positions?user=${walletAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Positions API ${res.status}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) return [];

  return raw.map(p => ({
    conditionId: p.conditionId ?? p.condition_id ?? '',
    tokenId: p.tokenId ?? p.token_id ?? '',
    size: Number(p.size) || 0,
    avgPrice: Number(p.avgPrice ?? p.avg_price) || 0,
    currentPrice: Number(p.curPrice ?? p.current_price ?? p.price) || 0,
    pnl: Number(p.pnl) || 0,
    market: p.title ?? p.market ?? '',
    side: p.outcome ?? p.side ?? '',
    asset: p.asset ?? '',
  })).filter(p => p.size > 0);
}

/**
 * Query actual on-chain CTF token balance for the proxy wallet.
 * Returns balance in decimal (e.g. 7.883), or null on error.
 */
async function queryOnChainTokenBalance(tokenId) {
  try {
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || getWalletAddress();
    if (!proxyAddress) return null;

    // ERC1155 balanceOf(address, uint256)
    const addr = '000000000000000000000000' + proxyAddress.slice(2).toLowerCase();
    const id = BigInt(tokenId).toString(16).padStart(64, '0');
    const data = '0x00fdd58e' + addr + id;

    const res = await fetch(POLYGON_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: CTF_ADDRESS, data }, 'latest'], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json();
    if (!json.result) return null;
    return Number(BigInt(json.result)) / 1e6;
  } catch (err) {
    log.warn(`On-chain balance query failed: ${err.message}`);
    return null;
  }
}

/**
 * Close a position by placing a FOK sell order.
 * If sell fails due to balance mismatch (recorded size > actual on-chain tokens),
 * retries with the actual on-chain balance.
 */
export async function closePosition(tokenId, size, price) {
  if (BOT_CONFIG.dryRun) {
    log.info(`[DRY RUN] Would SELL ${size} @ ${price} | token=${tokenId.slice(0, 12)}...`);
    return { dryRun: true };
  }
  try {
    return await placeSellOrder({ tokenId, price, size });
  } catch (err) {
    if (err.message.includes('not enough balance')) {
      // Recorded size likely exceeds actual on-chain balance (exchange fees/rounding)
      const actualBalance = await queryOnChainTokenBalance(tokenId);
      if (actualBalance != null && actualBalance > 0 && actualBalance < size) {
        // Floor to 6 decimal precision (CTF token precision)
        const correctedSize = Math.floor(actualBalance * 1e6) / 1e6;
        log.warn(`Balance mismatch: recorded ${size}, on-chain ${actualBalance.toFixed(6)} — retrying sell with ${correctedSize}`);
        return await placeSellOrder({ tokenId, price, size: correctedSize });
      }
    }
    throw err;
  }
}

/**
 * Get cached positions + last update timestamp.
 */
export function getPositionsSummary() {
  return {
    list: cachedPositions,
    lastUpdate: lastFetchMs || null,
  };
}

/**
 * Get positions merged with bot's local position tracking.
 * Returns API positions augmented with the bot's local position
 * (which is available instantly, before the API catches up).
 */
export function getMergedPositions(localPosition) {
  const merged = [...cachedPositions];

  if (localPosition && !localPosition.settled && localPosition.size > 0) {
    const matchIdx = merged.findIndex(p => p.tokenId === localPosition.tokenId);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], botTracked: true, botSide: localPosition.side };
    } else {
      merged.push({
        conditionId: '',
        tokenId: localPosition.tokenId,
        size: localPosition.size,
        avgPrice: localPosition.price,
        currentPrice: localPosition.price,
        pnl: 0,
        market: localPosition.marketSlug ?? '',
        side: localPosition.side,
        asset: '',
        botTracked: true,
        botSide: localPosition.side,
        enteredAt: localPosition.enteredAt,
        fillConfirmed: localPosition.fillConfirmed ?? false,
      });
    }
  }

  return {
    list: merged,
    lastUpdate: lastFetchMs || Date.now(),
    botPosition: localPosition && !localPosition.settled ? {
      side: localPosition.side,
      size: localPosition.size,
      price: localPosition.price,
      cost: localPosition.cost,
      marketSlug: localPosition.marketSlug,
      enteredAt: localPosition.enteredAt,
      fillConfirmed: localPosition.fillConfirmed ?? false,
      settled: localPosition.settled,
    } : null,
  };
}

/**
 * Poll positions — fetch + cache + persist to disk.
 */
export async function pollPositions() {
  const now = Date.now();
  if (now - lastFetchMs < CACHE_TTL_MS) return;

  const addr = getWalletAddress();
  if (!addr) return;

  try {
    cachedPositions = await fetchPositions(addr);
    lastFetchMs = now;
    savePositions();
    log.debug(`Fetched ${cachedPositions.length} positions`);
  } catch (err) {
    log.warn(`Position fetch failed: ${err.message}`);
    lastFetchMs = now; // Prevent retry storm
  }
}

/**
 * Start periodic position polling.
 */
export function startPolling(intervalMs = BOT_CONFIG.positionPollIntervalMs ?? 60_000) {
  if (pollTimer) return;
  pollPositions(); // Initial fetch
  pollTimer = setInterval(pollPositions, intervalMs);
  log.info(`Position polling started (every ${intervalMs / 1000}s)`);
}

/**
 * Stop position polling.
 */
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Save positions snapshot to disk.
 */
function savePositions() {
  try {
    const filePath = BOT_CONFIG.positionsFile;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      lastUpdate: lastFetchMs,
      positions: cachedPositions,
    }, null, 2));
  } catch (err) {
    log.warn(`Failed to save positions: ${err.message}`);
  }
}

/**
 * Load positions from disk (on startup).
 */
export function loadPositions() {
  try {
    const raw = readFileSync(BOT_CONFIG.positionsFile, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.positions)) {
      cachedPositions = data.positions;
      lastFetchMs = data.lastUpdate || 0;
      log.info(`Loaded ${cachedPositions.length} positions from disk`);
    }
  } catch {
    // No saved positions — fine
  }
}
