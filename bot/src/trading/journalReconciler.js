/**
 * Verified trade journal — on-chain reconciliation via CLOB getTrades().
 *
 * Every 30 minutes, fetches real trade history from the Polymarket CLOB API,
 * groups by market, fetches market info + winner from CLOB /markets/ endpoint,
 * computes verified P&L, and cross-references with local state.json.
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
 * Extract market time from the CLOB market question string.
 * e.g. "Bitcoin Up or Down - February 14, 9:15PM-9:30PM ET" → parse start time
 * Falls back to matching a slug-style unix timestamp if present.
 */
function parseMarketTimeFromQuestion(question) {
  // Not easily parseable to exact unix ts from question text alone
  return null;
}

/**
 * Resolve token side (Up/Down) from asset_id using CLOB market tokens array.
 * CLOB market.tokens: [{ token_id, outcome, price, winner }]
 */
function resolveTokenSide(assetId, tokens) {
  if (!Array.isArray(tokens) || !assetId) return null;
  const token = tokens.find(t => t.token_id === assetId);
  return token ? token.outcome.toUpperCase() : null;
}

/**
 * Fetch market info from CLOB API /markets/<conditionId>.
 * Returns { market, outcome, resolved } with winner determined from tokens[].winner.
 */
async function fetchMarketInfo(conditionId) {
  try {
    const url = `${CONFIG.clobBaseUrl}/markets/${conditionId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      log.warn(`CLOB market API ${res.status} for ${conditionId.slice(0, 16)}...`);
      return { market: null, outcome: null, resolved: false };
    }
    const market = await res.json();
    if (!market || !market.condition_id) {
      return { market: null, outcome: null, resolved: false };
    }

    const closed = market.closed === true;
    if (!closed) return { market, outcome: null, resolved: false };

    // Determine winner from tokens[].winner field
    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    const winnerToken = tokens.find(t => t.winner === true);
    const outcome = winnerToken ? winnerToken.outcome.toUpperCase() : null;

    return { market, outcome, resolved: !!outcome };
  } catch (err) {
    log.warn(`CLOB market fetch failed for ${conditionId.slice(0, 16)}...: ${err.message}`);
    return { market: null, outcome: null, resolved: false };
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
 */
function findLocalTrade(localTrades, marketSlug) {
  if (!marketSlug) return null;
  const enter = localTrades.find(t => t.type === 'ENTER' && t.marketSlug === marketSlug);
  if (!enter) return null;

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
 * Try to derive a btc-updown-15m slug from the CLOB market question.
 * e.g. "Bitcoin Up or Down - February 14, 9:15PM-9:30PM ET"
 * We match against local trades by the accepting_order_timestamp or end time.
 */
function deriveSlugFromMarket(market, localTrades) {
  if (!market) return null;

  // Try accepting_order_timestamp → convert to unix seconds for slug
  const acceptTs = market.accepting_order_timestamp;
  if (acceptTs) {
    const ms = new Date(acceptTs).getTime();
    if (Number.isFinite(ms)) {
      // BTC 15-min markets: slug timestamp = market start (accepting_order_timestamp)
      // Try rounding to nearest 15-min boundary (900s)
      const sec = Math.round(ms / 1000);
      const rounded = Math.round(sec / 900) * 900;
      // Check a few candidates around this time
      for (const candidate of [rounded, rounded - 900, rounded + 900, sec]) {
        const slug = `btc-updown-15m-${candidate}`;
        const match = localTrades.find(t => t.marketSlug === slug);
        if (match) return slug;
      }
      // No local match — use the rounded value as best guess
      return `btc-updown-15m-${rounded}`;
    }
  }
  return null;
}

/**
 * Main reconciliation cycle.
 */
async function reconcile() {
  if (!isClientReady()) {
    log.debug('CLOB client not ready — skipping reconcile');
    return;
  }

  const now = Date.now();
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

  const localTrades = loadLocalTrades();
  let totalPnl = 0;
  let marketCount = 0;
  let tradeCount = 0;

  for (const [conditionId, marketTrades] of byMarket) {
    try {
      const entry = await buildVerifiedEntry(conditionId, marketTrades, localTrades);
      if (!entry) continue;

      const dir = dirname(BOT_CONFIG.verifiedJournalFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(BOT_CONFIG.verifiedJournalFile, JSON.stringify(entry) + '\n');

      totalPnl += entry.netPnl ?? 0;
      marketCount++;
      tradeCount += marketTrades.length;
    } catch (err) {
      log.warn(`Failed to process market ${conditionId.slice(0, 16)}...: ${err.message}`);
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
  // Fetch market info from CLOB API (has tokens + winner)
  const { market, outcome, resolved } = await fetchMarketInfo(conditionId);

  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const question = market?.question ?? null;
  const slug = deriveSlugFromMarket(market, localTrades);
  const marketTime = slug?.match(/(\d{10,})$/) ? parseInt(slug.match(/(\d{10,})$/)[1]) * 1000 : null;

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
      tokenSide: resolveTokenSide(t.asset_id, tokens),
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

  // Aggregates
  const totalCost = tradeRecords.reduce((s, t) => s + t.cost, 0);
  const totalProceeds = tradeRecords.reduce((s, t) => s + t.proceeds, 0);
  const netBuySize = tradeRecords.filter(t => t.side === 'BUY').reduce((s, t) => s + t.size, 0);
  const netSellSize = tradeRecords.filter(t => t.side === 'SELL').reduce((s, t) => s + t.size, 0);
  const netPosition = netBuySize - netSellSize;

  // Compute P&L
  let totalPayout = 0;
  let netPnl = 0;

  if (resolved && netPosition > 0) {
    const primarySide = tradeRecords.find(t => t.side === 'BUY')?.tokenSide;
    const won = primarySide === outcome;
    totalPayout = won ? netPosition : 0;
    netPnl = Math.round((totalPayout + totalProceeds - totalCost) * 100) / 100;
  } else if (netPosition <= 0 && totalProceeds > 0) {
    netPnl = Math.round((totalProceeds - totalCost) * 100) / 100;
  } else if (!resolved) {
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
    question,
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
 * Start the reconciliation interval.
 */
export function startReconciler() {
  loadLastProcessedTime();

  reconcile().catch(err => log.warn(`Initial reconcile failed: ${err.message}`));

  const ms = BOT_CONFIG.reconcileIntervalMs || 30 * 60 * 1000;
  intervalId = setInterval(() => {
    reconcile().catch(err => log.warn(`Reconcile cycle failed: ${err.message}`));
  }, ms);

  log.info(`Reconciler started (every ${Math.round(ms / 60000)} min)`);
}

/**
 * Stop the reconciliation interval.
 */
export function stopReconciler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Reconciler stopped');
  }
}
