/**
 * Verified trade journal — on-chain reconciliation via CLOB getTrades().
 *
 * Every 30 minutes, fetches real trade history from the Polymarket CLOB API,
 * groups by market, fetches outcomes from Gamma API, computes verified P&L,
 * and cross-references with local state.json for discrepancy detection.
 *
 * Output: bot/data/verified_journal.jsonl (append-only)
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG, CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getTradeHistory, isClientReady } from './clobClient.js';

const log = createLogger('Reconciler');

let intervalId = null;
let lastProcessedTime = 0; // Unix ms — only fetch trades after this

/**
 * Extract market start time (unix seconds) from a BTC 15-min slug.
 * e.g. "btc-updown-15m-1771108200" → 1771108200000 (ms)
 */
function parseMarketTimeFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const match = slug.match(/(\d{10,})$/);
  return match ? parseInt(match[1], 10) * 1000 : null;
}

/**
 * Determine token side (UP or DOWN) from a trade's asset_id.
 * Requires the market object with clobTokenIds + outcomes arrays.
 */
function resolveTokenSide(assetId, market) {
  if (!market || !assetId) return null;
  const outcomes = parseJsonField(market.outcomes);
  const tokenIds = parseJsonField(market.clobTokenIds);
  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) return null;
  const idx = tokenIds.indexOf(assetId);
  if (idx < 0) return null;
  const label = String(outcomes[idx]).toUpperCase();
  return label === 'UP' || label === 'DOWN' ? label : null;
}

/**
 * Parse a JSON string field that may already be an array.
 */
function parseJsonField(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); }
    catch { return null; }
  }
  return null;
}

/**
 * Fetch market outcome from Gamma API.
 * Returns { outcome, resolved, market } or { outcome: null, resolved: false } on failure.
 */
async function fetchMarketOutcome(conditionId) {
  try {
    const url = `${CONFIG.gammaBaseUrl}/markets?condition_id=${conditionId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      log.warn(`Gamma API ${res.status} for condition ${conditionId}`);
      return { outcome: null, resolved: false, market: null };
    }
    const data = await res.json();
    // Gamma returns an array of markets for the condition
    const market = Array.isArray(data) ? data[0] : data;
    if (!market) return { outcome: null, resolved: false, market: null };

    const closed = market.closed === true || market.closed === 'true';
    if (!closed) return { outcome: null, resolved: false, market };

    // Determine winner from outcomePrices
    const outcomes = parseJsonField(market.outcomes);
    const prices = parseJsonField(market.outcomePrices);
    if (!Array.isArray(outcomes) || !Array.isArray(prices)) {
      return { outcome: null, resolved: false, market };
    }

    // Winner has price > 0.8 (binary market resolves to ~1.0 / ~0.0)
    let winner = null;
    for (let i = 0; i < outcomes.length; i++) {
      const p = parseFloat(prices[i]);
      if (Number.isFinite(p) && p > 0.8) {
        winner = String(outcomes[i]).toUpperCase();
        break;
      }
    }

    return { outcome: winner, resolved: !!winner, market };
  } catch (err) {
    log.warn(`Gamma fetch failed for ${conditionId}: ${err.message}`);
    return { outcome: null, resolved: false, market: null };
  }
}

/**
 * Load lastProcessedTime from the last entry in verified_journal.jsonl.
 */
function loadLastProcessedTime() {
  try {
    if (!existsSync(BOT_CONFIG.verifiedJournalFile)) return;
    const content = readFileSync(BOT_CONFIG.verifiedJournalFile, 'utf-8').trim();
    if (!content) return;
    const lines = content.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    if (entry._fetchedAt) {
      lastProcessedTime = entry._fetchedAt;
      log.info(`Resuming from last reconciled time: ${new Date(lastProcessedTime).toISOString()}`);
    }
  } catch {
    // Fresh start — no problem
  }
}

/**
 * Load local trades from state.json for cross-referencing.
 * Returns the trades array from positionTracker state.
 */
function loadLocalTrades() {
  try {
    if (!existsSync(BOT_CONFIG.stateFile)) return [];
    const state = JSON.parse(readFileSync(BOT_CONFIG.stateFile, 'utf-8'));
    return Array.isArray(state.trades) ? state.trades : [];
  } catch {
    return [];
  }
}

/**
 * Find matching local trade entry by marketSlug.
 * Returns the ENTER trade and its corresponding SETTLE/CUT_LOSS if present.
 */
function findLocalTrade(localTrades, marketSlug) {
  const enter = localTrades.find(t => t.type === 'ENTER' && t.marketSlug === marketSlug);
  if (!enter) return null;

  // Find the corresponding settlement (occurs after the enter)
  const enterTs = enter.timestamp;
  const settle = localTrades.find(
    t => (t.type === 'SETTLE' || t.type === 'CUT_LOSS') && t.timestamp > enterTs
  );

  return {
    enter,
    settle: settle ?? null,
    localCost: enter.cost ?? 0,
    localPnl: settle?.pnl ?? null,
  };
}

/**
 * Main reconciliation cycle.
 * Fetches recent trades, groups by market, resolves outcomes, writes to journal.
 */
async function reconcile() {
  if (!isClientReady()) {
    log.debug('CLOB client not ready — skipping reconcile');
    return;
  }

  const now = Date.now();

  // Default: look back 35 minutes (slightly more than interval to avoid gaps)
  const lookbackMs = (BOT_CONFIG.reconcileIntervalMs || 30 * 60 * 1000) + 5 * 60 * 1000;
  const afterMs = lastProcessedTime || (now - lookbackMs);

  log.info(`Reconciling trades since ${new Date(afterMs).toISOString()}...`);

  let trades;
  try {
    trades = await getTradeHistory({ after: afterMs });
  } catch (err) {
    log.warn(`Failed to fetch trade history: ${err.message}`);
    return;
  }

  if (!Array.isArray(trades) || trades.length === 0) {
    log.info('No new trades found');
    lastProcessedTime = now;
    return;
  }

  log.info(`Fetched ${trades.length} trade(s) from CLOB API`);

  // Group trades by market (conditionId)
  const byMarket = new Map();
  for (const trade of trades) {
    const market = trade.market;
    if (!market) continue;
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push(trade);
  }

  log.info(`Grouped into ${byMarket.size} market(s)`);

  // Load local trades for cross-referencing
  const localTrades = loadLocalTrades();
  let totalPnl = 0;
  let marketCount = 0;
  let tradeCount = 0;

  for (const [conditionId, marketTrades] of byMarket) {
    try {
      const entry = await buildVerifiedEntry(conditionId, marketTrades, localTrades);
      if (!entry) continue;

      // Write to JSONL
      const dir = dirname(BOT_CONFIG.verifiedJournalFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(BOT_CONFIG.verifiedJournalFile, JSON.stringify(entry) + '\n');

      totalPnl += entry.netPnl ?? 0;
      marketCount++;
      tradeCount += marketTrades.length;
    } catch (err) {
      log.warn(`Failed to process market ${conditionId}: ${err.message}`);
    }
  }

  lastProcessedTime = now;

  if (marketCount > 0) {
    log.info(
      `Reconciled ${marketCount} market(s), ${tradeCount} trade(s), ` +
      `P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
    );
  }
}

/**
 * Build a verified journal entry for a single market's trades.
 */
async function buildVerifiedEntry(conditionId, marketTrades, localTrades) {
  // Fetch market info + outcome from Gamma API
  const { outcome, resolved, market } = await fetchMarketOutcome(conditionId);

  // Try to determine slug from Gamma market data
  const slug = market?.slug ?? null;
  const marketTime = slug ? parseMarketTimeFromSlug(slug) : null;

  // Build trade records
  const tradeRecords = marketTrades.map(t => {
    const price = parseFloat(t.price) || 0;
    const size = parseFloat(t.size) || 0;
    const feeBps = parseFloat(t.fee_rate_bps) || 0;
    const isBuy = t.side === 'BUY';
    const cost = isBuy ? price * size : 0;
    const proceeds = !isBuy ? price * size : 0;

    return {
      tradeId: t.id,
      side: t.side,
      tokenSide: market ? resolveTokenSide(t.asset_id, market) : null,
      price,
      size,
      cost: Math.round(cost * 100) / 100,
      proceeds: Math.round(proceeds * 100) / 100,
      feeBps,
      matchTime: t.match_time,
      txHash: t.transaction_hash ?? null,
      traderSide: t.trader_side ?? null,
      status: t.status ?? null,
    };
  });

  // Aggregate costs and proceeds
  const totalCost = tradeRecords.reduce((s, t) => s + t.cost, 0);
  const totalProceeds = tradeRecords.reduce((s, t) => s + t.proceeds, 0);

  // Net size bought vs sold
  const netBuySize = tradeRecords
    .filter(t => t.side === 'BUY')
    .reduce((s, t) => s + t.size, 0);
  const netSellSize = tradeRecords
    .filter(t => t.side === 'SELL')
    .reduce((s, t) => s + t.size, 0);
  const netPosition = netBuySize - netSellSize;

  // Compute P&L
  let totalPayout = 0;
  let netPnl = 0;

  if (resolved && netPosition > 0) {
    // Position held to settlement
    const primarySide = tradeRecords.find(t => t.side === 'BUY')?.tokenSide;
    const won = primarySide === outcome;
    totalPayout = won ? netPosition : 0; // Binary: $1/share if won
    netPnl = Math.round((totalPayout + totalProceeds - totalCost) * 100) / 100;
  } else if (netPosition <= 0 && totalProceeds > 0) {
    // Fully exited before settlement (cut-loss or early exit)
    netPnl = Math.round((totalProceeds - totalCost) * 100) / 100;
  } else if (!resolved) {
    // Not yet resolved — P&L unknown
    netPnl = null;
  }

  // Cross-reference with local state
  let localMatch = false;
  let localPnl = null;
  let discrepancy = null;

  if (slug) {
    const local = findLocalTrade(localTrades, slug);
    if (local) {
      localMatch = true;
      localPnl = local.localPnl;
      if (netPnl !== null && localPnl !== null) {
        discrepancy = Math.round((netPnl - localPnl) * 100) / 100;
        if (Math.abs(discrepancy) > 0.01) {
          log.warn(`Discrepancy on ${slug}: verified=$${netPnl.toFixed(2)} vs local=$${localPnl.toFixed(2)} (diff=$${discrepancy.toFixed(2)})`);
        }
      }
    }
  }

  return {
    marketSlug: slug,
    conditionId,
    marketTime,
    trades: tradeRecords,
    outcome: outcome ?? null,
    resolved,
    totalCost: Math.round(totalCost * 100) / 100,
    totalProceeds: Math.round(totalProceeds * 100) / 100,
    totalPayout: Math.round(totalPayout * 100) / 100,
    netPosition: Math.round(netPosition * 1e8) / 1e8,
    netPnl,
    localMatch,
    localPnl,
    discrepancy,
    _fetchedAt: Date.now(),
  };
}

/**
 * Start the reconciliation interval. Runs immediately on start, then every 30 min.
 * Only call in live mode (when CLOB client is initialized).
 */
export function startReconciler() {
  loadLastProcessedTime();

  // Run immediately (catch up on missed trades)
  reconcile().catch(err => log.warn(`Initial reconcile failed: ${err.message}`));

  const ms = BOT_CONFIG.reconcileIntervalMs || 30 * 60 * 1000;
  intervalId = setInterval(() => {
    reconcile().catch(err => log.warn(`Reconcile cycle failed: ${err.message}`));
  }, ms);

  log.info(`Reconciler started (every ${Math.round(ms / 60000)} min)`);
}

/**
 * Stop the reconciliation interval (called on shutdown).
 */
export function stopReconciler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Reconciler stopped');
  }
}
