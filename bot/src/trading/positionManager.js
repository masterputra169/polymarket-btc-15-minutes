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

const CACHE_TTL_MS = 60_000; // Cache positions for 60s
const DATA_API = 'https://data-api.polymarket.com';

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
 * Close a position by placing a FOK sell order.
 */
export async function closePosition(tokenId, size, price) {
  if (BOT_CONFIG.dryRun) {
    log.info(`[DRY RUN] Would SELL ${size} @ ${price} | token=${tokenId.slice(0, 12)}...`);
    return { dryRun: true };
  }
  return await placeSellOrder({ tokenId, price, size });
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
