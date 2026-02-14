/**
 * Trader Discovery — Scans Polymarket markets, discovers traders, ranks them,
 * and simulates following their trades. JSON persistence for tracked traders.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import { BOT_CONFIG } from '../config.js';

const log = createLogger('Discovery');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const RATE_LIMIT_MS = 500; // Max 2 API calls/sec

let trackedTraders = [];
let discoveredTraders = [];
let lastScanMs = 0;

// Simple rate limiter
let lastApiCallMs = 0;
async function rateLimitedFetch(url, opts = {}) {
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - lastApiCallMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApiCallMs = Date.now();
  return fetch(url, { signal: AbortSignal.timeout(10_000), ...opts });
}

/**
 * Scan active BTC 15m markets from Gamma API.
 * Returns condition IDs for active markets.
 */
export async function scanMarkets() {
  try {
    const res = await rateLimitedFetch(
      `${GAMMA_API}/events?slug=btc-updown-15m&closed=false&limit=10`
    );
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);

    const events = await res.json();
    const conditionIds = [];

    for (const event of (Array.isArray(events) ? events : [])) {
      const markets = event.markets ?? [];
      for (const m of markets) {
        if (m.conditionId || m.condition_id) {
          conditionIds.push(m.conditionId ?? m.condition_id);
        }
      }
    }

    log.info(`Scanned ${conditionIds.length} active market conditions`);
    return conditionIds;
  } catch (err) {
    log.warn(`Market scan failed: ${err.message}`);
    return [];
  }
}

/**
 * Discover traders active in a given market condition.
 * @param {string} conditionId
 * @returns {Array} Unique trader addresses with basic stats
 */
export async function discoverTraders(conditionId) {
  try {
    const res = await rateLimitedFetch(
      `${DATA_API}/activity?market=${conditionId}&limit=100`
    );
    if (!res.ok) throw new Error(`Activity API ${res.status}`);

    const activity = await res.json();
    if (!Array.isArray(activity)) return [];

    // Aggregate by trader address
    const traderMap = new Map();
    for (const a of activity) {
      const addr = a.proxyWallet ?? a.proxy_wallet ?? a.user ?? a.maker ?? '';
      if (!addr) continue;

      if (!traderMap.has(addr)) {
        traderMap.set(addr, { address: addr, trades: 0, volume: 0, sides: [] });
      }
      const t = traderMap.get(addr);
      t.trades++;
      t.volume += Number(a.size ?? a.amount ?? 0) * Number(a.price ?? 0);
      if (a.side) t.sides.push(a.side);
    }

    return Array.from(traderMap.values());
  } catch (err) {
    log.warn(`Discover traders failed for ${conditionId}: ${err.message}`);
    return [];
  }
}

/**
 * Rank traders by composite score: trade count + volume + consistency.
 */
export function rankTraders(traders) {
  if (!traders.length) return [];

  const maxTrades = Math.max(...traders.map(t => t.trades));
  const maxVolume = Math.max(...traders.map(t => t.volume));

  return traders.map(t => {
    const tradeScore = maxTrades > 0 ? t.trades / maxTrades : 0;
    const volumeScore = maxVolume > 0 ? t.volume / maxVolume : 0;
    const score = tradeScore * 0.4 + volumeScore * 0.6;

    return {
      ...t,
      score: Math.round(score * 100) / 100,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Full scan: discover traders across active markets, rank them.
 */
export async function fullScan() {
  const conditionIds = await scanMarkets();
  if (!conditionIds.length) return [];

  const allTraders = new Map();

  // Scan up to 5 markets to stay within rate limits
  const toScan = conditionIds.slice(0, 5);
  for (const cid of toScan) {
    const traders = await discoverTraders(cid);
    for (const t of traders) {
      if (allTraders.has(t.address)) {
        const existing = allTraders.get(t.address);
        existing.trades += t.trades;
        existing.volume += t.volume;
        existing.sides.push(...t.sides);
      } else {
        allTraders.set(t.address, { ...t });
      }
    }
  }

  discoveredTraders = rankTraders(Array.from(allTraders.values()));
  lastScanMs = Date.now();
  log.info(`Discovered ${discoveredTraders.length} unique traders across ${toScan.length} markets`);
  return discoveredTraders;
}

/**
 * Simulate following a trader's recent trades.
 * Fetches their activity and computes hypothetical P&L.
 */
export async function simulateTrader(address) {
  try {
    const res = await rateLimitedFetch(
      `${DATA_API}/activity?user=${address}&limit=200`
    );
    if (!res.ok) throw new Error(`Activity API ${res.status}`);

    const activity = await res.json();
    if (!Array.isArray(activity) || !activity.length) {
      return { address, totalTrades: 0, winRate: 0, pnl: 0, avgSize: 0 };
    }

    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let totalSize = 0;

    for (const a of activity) {
      const size = Number(a.size ?? a.amount ?? 0);
      const price = Number(a.price ?? 0);
      totalSize += size * price;

      // If outcome is available (resolved market), count win/loss
      if (a.outcome != null) {
        const won = (a.side === 'BUY' && a.outcome === a.asset) ||
                    (a.side === 'SELL' && a.outcome !== a.asset);
        if (won) {
          wins++;
          totalPnl += size * (1 - price);
        } else {
          losses++;
          totalPnl -= size * price;
        }
      }
    }

    const total = wins + losses;
    return {
      address,
      totalTrades: activity.length,
      resolvedTrades: total,
      wins,
      losses,
      winRate: total > 0 ? Math.round((wins / total) * 1000) / 1000 : 0,
      pnl: Math.round(totalPnl * 100) / 100,
      avgSize: activity.length > 0
        ? Math.round((totalSize / activity.length) * 100) / 100
        : 0,
    };
  } catch (err) {
    log.warn(`Simulate trader failed for ${address}: ${err.message}`);
    return { address, totalTrades: 0, winRate: 0, pnl: 0, avgSize: 0, error: err.message };
  }
}

// ── Tracked traders management ──

export function getTrackedTraders() { return trackedTraders; }
export function getDiscoveredTraders() { return discoveredTraders; }
export function getLastScanTime() { return lastScanMs; }

export function addTrackedTrader(address) {
  if (!address || trackedTraders.some(t => t.address === address)) return false;
  const discovered = discoveredTraders.find(t => t.address === address);
  trackedTraders.push({
    address,
    score: discovered?.score ?? 0,
    addedAt: Date.now(),
  });
  if (trackedTraders.length > (BOT_CONFIG.maxTrackedTraders ?? 20)) {
    trackedTraders = trackedTraders.slice(-20);
  }
  saveTrackedTraders();
  log.info(`Tracking trader: ${address.slice(0, 10)}...`);
  return true;
}

export function removeTrackedTrader(address) {
  const before = trackedTraders.length;
  trackedTraders = trackedTraders.filter(t => t.address !== address);
  if (trackedTraders.length < before) {
    saveTrackedTraders();
    log.info(`Untracked trader: ${address.slice(0, 10)}...`);
    return true;
  }
  return false;
}

// ── JSON Persistence ──

function saveTrackedTraders() {
  try {
    const filePath = BOT_CONFIG.trackedTradersFile;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      lastUpdate: Date.now(),
      traders: trackedTraders,
    }, null, 2));
  } catch (err) {
    log.warn(`Failed to save tracked traders: ${err.message}`);
  }
}

export function loadTrackedTraders() {
  try {
    const raw = readFileSync(BOT_CONFIG.trackedTradersFile, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.traders)) {
      trackedTraders = data.traders;
      log.info(`Loaded ${trackedTraders.length} tracked traders from disk`);
    }
  } catch {
    // No saved traders — fine
  }
}
