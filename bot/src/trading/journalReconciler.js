/**
 * Verified trade journal — on-chain reconciliation via CLOB getTrades().
 *
 * Every 30 minutes, fetches real trade history from the Polymarket CLOB API,
 * groups by market, fetches market info + winner from CLOB /markets/ endpoint,
 * computes verified P&L, and cross-references with local state.json.
 *
 * Output: bot/data/verified_journal.jsonl (append-only)
 */

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG, CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getTradeHistory, isClientReady, getProxyAddress } from './clobClient.js';
import { adjustBankrollForReconciliation } from './positionTracker.js';
import { invalidateSync, setReconcileCooldown } from '../engines/usdcSync.js';
import { notify } from '../monitoring/notifier.js';

const log = createLogger('Reconciler');

let intervalId = null;
let lastProcessedTime = 0; // Unix ms — only fetch trades after this
let lastReconcileMs = 0;   // debounce for reconcileNow()

const MONTHS = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

/**
 * Determine ET→UTC offset (5 for EST, 4 for EDT).
 * DST: 2nd Sunday of March → 1st Sunday of November.
 */
function etOffsetHours(year, month0, day) {
  if (month0 < 2 || month0 > 10) return 5; // Jan, Feb, Dec → EST
  if (month0 > 2 && month0 < 10) return 4; // Apr–Oct → EDT
  if (month0 === 2) { // March
    const dow1 = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSun = dow1 === 0 ? 8 : 15 - dow1;
    return day >= secondSun ? 4 : 5;
  }
  // November
  const dow1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSun = dow1 === 0 ? 1 : 8 - dow1;
  return day < firstSun ? 4 : 5;
}

/**
 * Parse market start time from the CLOB question string.
 * e.g. "Bitcoin Up or Down - February 14, 9:15PM-9:30PM ET" → unix seconds (UTC)
 */
function parseQuestionToSlugTs(question) {
  if (!question) return null;
  const m = question.match(/- (\w+) (\d+), (\d+):(\d+)(AM|PM)-/);
  if (!m) return null;
  const [, monthStr, dayStr, hourStr, minStr, ampm] = m;
  const month0 = MONTHS[monthStr];
  if (month0 === undefined) return null;

  let hour = parseInt(hourStr);
  const min = parseInt(minStr);
  const day = parseInt(dayStr);

  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  // M16: Handle year-crossing — if parsed month is far ahead of current month, use previous year
  const currentMonth = new Date().getMonth();
  const currentYear = new Date().getFullYear();
  const year = (month0 - currentMonth > 6) ? currentYear - 1 : currentYear;
  const offset = etOffsetHours(year, month0, day);
  const utcMs = Date.UTC(year, month0, day, hour + offset, min, 0);
  return Math.floor(utcMs / 1000);
}

/**
 * Resolve token side (Up/Down) from asset_id using CLOB market tokens array.
 * CLOB market.tokens: [{ token_id, outcome, price, winner }]
 */
function resolveTokenSide(assetId, tokens) {
  if (!Array.isArray(tokens) || !assetId) return null;
  const token = tokens.find(t => t.token_id === assetId);
  return token?.outcome ? token.outcome.toUpperCase() : null;
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
    const outcome = winnerToken?.outcome ? winnerToken.outcome.toUpperCase() : null;

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
 * Looks for ENTER, then the next SETTLE/CUT_LOSS/PARTIAL_CUT/UNWIND for that position.
 */
function findLocalTrade(localTrades, marketSlug) {
  if (!marketSlug) return null;
  const enterIdx = localTrades.findIndex(t => t.type === 'ENTER' && t.marketSlug === marketSlug);
  if (enterIdx === -1) return null;

  const enter = localTrades[enterIdx];
  // Find the next exit event after this ENTER (before the next ENTER)
  let settle = null;
  for (let i = enterIdx + 1; i < localTrades.length; i++) {
    const t = localTrades[i];
    if (t.type === 'ENTER') break; // Next position — stop searching
    if (['SETTLE', 'CUT_LOSS', 'PARTIAL_CUT', 'UNWIND'].includes(t.type)) {
      settle = t;
      break;
    }
  }

  return {
    enter,
    settle,
    localCost: enter.cost ?? 0,
    localPnl: settle?.pnl ?? null,
  };
}

/**
 * Derive btc-updown-15m slug from the CLOB market question string.
 * Primary: parse "February 14, 9:15PM-9:30PM ET" → UTC unix seconds.
 * Fallback: accepting_order_timestamp (inaccurate, ~24h before market start).
 */
function deriveSlugFromMarket(market, localTrades) {
  if (!market) return null;

  // Primary: parse question string for exact market start time
  const parsedTs = parseQuestionToSlugTs(market.question);
  if (parsedTs) {
    // Try exact match first, then ±900s candidates for edge cases
    for (const candidate of [parsedTs, parsedTs - 900, parsedTs + 900]) {
      const slug = `btc-updown-15m-${candidate}`;
      if (localTrades.find(t => t.marketSlug === slug)) return slug;
    }
    // No local match — use the parsed value (still correct for journal)
    return `btc-updown-15m-${parsedTs}`;
  }

  // Fallback: accepting_order_timestamp (known to be ~24h off)
  const acceptTs = market.accepting_order_timestamp;
  if (acceptTs) {
    const ms = new Date(acceptTs).getTime();
    if (Number.isFinite(ms)) {
      const sec = Math.round(ms / 1000);
      const rounded = Math.round(sec / 900) * 900;
      for (const candidate of [rounded, rounded - 900, rounded + 900]) {
        const slug = `btc-updown-15m-${candidate}`;
        if (localTrades.find(t => t.marketSlug === slug)) return slug;
      }
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
  const intervalMs = BOT_CONFIG.reconcileIntervalMs || 30 * 60 * 1000;
  // First run (no journal history): look back 48h to catch all trades
  const lookbackMs = lastProcessedTime ? 0 : 48 * 60 * 60 * 1000;
  // M17: 5-min overlap buffer on subsequent runs to catch in-flight trades
  const afterMs = lastProcessedTime
    ? lastProcessedTime - 5 * 60 * 1000
    : now - lookbackMs;

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

  // Filter trades to only include our wallet's trades.
  // CLOB getTrades() returns all market trades, not just the authenticated wallet's.
  //
  // Trade ownership identification:
  //   - maker_address: hex wallet address of the maker (CHECKSUM-CASED, e.g. 0x2F8b...)
  //     → matches our proxy address for ALL our trades (we're always maker on Polymarket CTF)
  //   - owner: API key UUID (e.g. "87428c86-40e..."), NOT a wallet address
  //     → matches our API key ID for our trades
  //
  // IMPORTANT: maker_address uses EIP-55 checksum casing (mixed case), so comparison
  // MUST be case-insensitive. The old code compared case-sensitively → 0 matches.
  const proxyAddr = (getProxyAddress() || '').toLowerCase();
  const apiKeyId = process.env.POLYMARKET_API_KEY || '';
  if (proxyAddr || apiKeyId) {
    const before = trades.length;
    trades = trades.filter(t => {
      const maker = (t.maker_address || '').toLowerCase();
      const taker = (t.taker_address || '').toLowerCase();
      const owner = t.owner || '';
      // Include trades where we are MAKER (LIMIT fills), TAKER (FOK fills), or owner (API-attributed).
      return maker === proxyAddr || taker === proxyAddr || owner === apiKeyId;
    });
    if (trades.length < before) {
      log.info(`Wallet filter: ${before} → ${trades.length} trades (excluded ${before - trades.length} foreign trades)`);
    }
  }

  // Group trades by market (conditionId)
  const byMarket = new Map();
  for (const trade of trades) {
    const market = trade.market;
    if (!market) continue;
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push(trade);
  }

  log.info(`Grouped into ${byMarket.size} market(s)`);

  // BUG FIX (Apr 2026): the time-windowed getTradeHistory() only returns trades
  // WITHIN the lookback window. If a BUY happened before the window and a SELL
  // within the window, buildVerifiedEntry() saw only the SELL → totalCost=0,
  // totalProceeds>0, netPnl>0 → incorrectly classified as WIN. (Root cause of
  // 77.9% reported WR vs 59.8% real on-chain.)
  //
  // Fix: for each market that had activity in this window, refetch the COMPLETE
  // per-market trade history. getTradeHistory supports market-filter.
  const proxyAddrLower = (getProxyAddress() || '').toLowerCase();
  const apiKeyIdLocal = process.env.POLYMARKET_API_KEY || '';
  const isOurs = (t) => {
    const maker = (t.maker_address || '').toLowerCase();
    const taker = (t.taker_address || '').toLowerCase();
    const owner = t.owner || '';
    return maker === proxyAddrLower || taker === proxyAddrLower || owner === apiKeyIdLocal;
  };
  for (const [conditionId, existing] of byMarket) {
    try {
      const full = await getTradeHistory({ market: conditionId });
      if (Array.isArray(full) && full.length > 0) {
        const ours = full.filter(isOurs);
        // Dedup by trade id (window trades + full fetch may overlap)
        const merged = new Map();
        for (const t of [...existing, ...ours]) {
          if (t.id) merged.set(t.id, t);
        }
        const mergedArr = [...merged.values()];
        if (mergedArr.length > existing.length) {
          log.debug(`Market ${conditionId.slice(0, 10)}: window had ${existing.length} trades, full history has ${mergedArr.length} (added ${mergedArr.length - existing.length} pre-window trades)`);
        }
        byMarket.set(conditionId, mergedArr);
      }
    } catch (err) {
      // Fall back to window-only trades for this market if refetch fails
      log.debug(`Per-market refetch failed for ${conditionId.slice(0, 10)}: ${err.message}`);
    }
  }

  const localTrades = loadLocalTrades();
  // L: Dedup — load existing conditionIds to prevent duplicate entries from overlap buffer
  // Only skip RESOLVED entries; unresolved ones should be re-checked for outcome updates
  const processedIds = new Set();
  const unresolvedIds = new Set();
  try {
    if (existsSync(BOT_CONFIG.verifiedJournalFile)) {
      const lines = readFileSync(BOT_CONFIG.verifiedJournalFile, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.conditionId) {
            if (e.resolved) {
              processedIds.add(e.conditionId);
            } else {
              unresolvedIds.add(e.conditionId);
            }
          }
        } catch { /* malformed line — skip */ }
      }
    }
  } catch (err) {
    log.debug(`Could not load existing verified journal: ${err.message}`);
  }

  let totalPnl = 0;
  let marketCount = 0;
  let tradeCount = 0;

  // Block USDC syncs during reconciliation — on-chain USDC doesn't reflect
  // reconciler P&L corrections and would overwrite them (race condition fix).
  // 120s cooldown: covers reconcile duration + margin for async USDC fetch callbacks.
  setReconcileCooldown(120_000);

  // Collect updated entries for unresolved markets that are now resolved
  const updatedEntries = [];

  for (const [conditionId, marketTrades] of byMarket) {
    if (processedIds.has(conditionId)) continue; // Skip already-resolved markets

    const isRecheck = unresolvedIds.has(conditionId);
    try {
      const entry = await buildVerifiedEntry(conditionId, marketTrades, localTrades);
      if (!entry) continue;

      if (isRecheck && !entry.resolved) continue; // Still unresolved — skip re-write

      if (isRecheck && entry.resolved) {
        // Was unresolved, now resolved — mark for replacement
        updatedEntries.push(entry);
        log.info(`Updated unresolved → resolved: ${conditionId.slice(0, 16)}... outcome=${entry.outcome} pnl=${entry.netPnl}`);
        // RC5 Fix: auto-correct bankroll when reconciler finds discrepancy
        if (entry.localMatch && entry.discrepancy !== null && Math.abs(entry.discrepancy) > 0.10) {
          adjustBankrollForReconciliation({ delta: entry.discrepancy, reason: `reconciler_delayed_resolution`, slug: entry.marketSlug });
        }
        // RC4 Fix: kirim Telegram — ini adalah kasus desync utama (trade ada di Polymarket tapi bot tidak kirim notif)
        if (entry.netPnl !== null) {
          const pnlStr = entry.netPnl >= 0 ? `+$${entry.netPnl.toFixed(2)}` : `-$${Math.abs(entry.netPnl).toFixed(2)}`;
          const emoji = entry.netPnl >= 0 ? '✅' : '❌';
          const discMsg = entry.discrepancy !== null && Math.abs(entry.discrepancy) > 0.10
            ? `\n⚠️ Selisih P&amp;L: local=$${entry.localPnl?.toFixed(2) ?? '?'} vs verified=${pnlStr} (diff=$${entry.discrepancy.toFixed(2)})`
            : '';
          notify('info', `${emoji} <b>Reconciled (delayed)</b>: ${entry.outcome ?? '?'} | P&amp;L: <b>${pnlStr}</b>\n📊 ${entry.marketSlug?.slice(-30) ?? conditionId.slice(0, 16)}${discMsg}\n<i>Notif ini terlambat karena bot restart atau oracle delay</i>`, { key: `reconcile:${conditionId}` }).catch(e => log.debug(`Notify reconcile: ${e.message}`));
        }
      } else {
        // New entry — append
        const dir = dirname(BOT_CONFIG.verifiedJournalFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(BOT_CONFIG.verifiedJournalFile, JSON.stringify(entry) + '\n');
        // RC5 Fix: auto-correct bankroll when reconciler finds discrepancy on new entry
        if (entry.resolved && entry.localMatch && entry.discrepancy !== null && Math.abs(entry.discrepancy) > 0.10) {
          adjustBankrollForReconciliation({ delta: entry.discrepancy, reason: `reconciler_discrepancy`, slug: entry.marketSlug });
          // RC4 Fix: kirim Telegram
          const pnlStr = entry.netPnl >= 0 ? `+$${entry.netPnl.toFixed(2)}` : `-$${Math.abs(entry.netPnl).toFixed(2)}`;
          notify('warn', `⚠️ <b>P&amp;L Discrepancy</b>!\nLocal: $${entry.localPnl?.toFixed(2) ?? '?'} vs Verified: ${pnlStr}\nSelisih: $${entry.discrepancy.toFixed(2)} | ${entry.marketSlug?.slice(-30) ?? ''}`, { key: `discrepancy:${conditionId}` }).catch(e => log.debug(`Notify discrepancy: ${e.message}`));
        }
      }

      totalPnl += entry.netPnl ?? 0;
      marketCount++;
      tradeCount += marketTrades.length;
    } catch (err) {
      log.warn(`Failed to process market ${conditionId.slice(0, 16)}...: ${err.message}`);
    }
  }

  // Replace unresolved entries that are now resolved (in-place update)
  if (updatedEntries.length > 0) {
    try {
      const updatedMap = new Map(updatedEntries.map(e => [e.conditionId, e]));
      const existingLines = readFileSync(BOT_CONFIG.verifiedJournalFile, 'utf-8').trim().split('\n').filter(Boolean);
      const newLines = existingLines.map(line => {
        try {
          const e = JSON.parse(line);
          if (e.conditionId && updatedMap.has(e.conditionId)) {
            return JSON.stringify(updatedMap.get(e.conditionId));
          }
        } catch { /* keep original */ }
        return line;
      });
      writeFileSync(BOT_CONFIG.verifiedJournalFile, newLines.join('\n') + '\n');
      log.info(`Replaced ${updatedEntries.length} unresolved entries with resolved data`);
    } catch (err) {
      log.warn(`Failed to update unresolved entries: ${err.message}`);
    }
  }

  lastProcessedTime = now;
  lastReconcileMs = now;

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
    // H5: Compute NET payout per token side (buys - sells, handles partial exits + arb)
    const netBuysBySide = {};
    for (const t of tradeRecords) {
      if (t.tokenSide) {
        if (t.side === 'BUY') {
          netBuysBySide[t.tokenSide] = (netBuysBySide[t.tokenSide] || 0) + t.size;
        } else if (t.side === 'SELL') {
          netBuysBySide[t.tokenSide] = (netBuysBySide[t.tokenSide] || 0) - t.size;
        }
      }
    }
    const netWinningShares = Math.max(0, netBuysBySide[outcome] || 0);
    totalPayout = netWinningShares; // Only net remaining winning shares pay out $1/share
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
 * Trigger an immediate reconciliation (debounced: skip if last reconcile < 30s ago).
 * Used after price_fallback settlement to correct bankroll ASAP.
 */
export async function reconcileNow() {
  if (Date.now() - lastReconcileMs < 30_000) return;
  lastReconcileMs = Date.now();
  try { await reconcile(); } catch (e) { log.warn(`Manual reconcile failed: ${e.message}`); }
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
