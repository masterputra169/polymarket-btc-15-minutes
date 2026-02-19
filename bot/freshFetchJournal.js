/**
 * FRESH FETCH — Rebuild verified_journal.jsonl from CLOB trade history.
 *
 * Fetches ALL trades from the Polymarket CLOB API for the authenticated wallet,
 * groups by market, resolves outcomes, computes verified P&L, and writes a
 * clean verified_journal.jsonl.
 *
 * Usage:
 *   node bot/freshFetchJournal.js                   # Full rebuild
 *   node bot/freshFetchJournal.js --days 7           # Last 7 days only
 *   node bot/freshFetchJournal.js --dry-run           # Preview without writing
 *
 * Requires .env with POLYMARKET_PRIVATE_KEY, API_KEY, API_SECRET, API_PASSPHRASE
 */

import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import dotenv from 'dotenv';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: resolve(__dirname, '.env') });
const JOURNAL_PATH = resolve(__dirname, 'data', 'verified_journal.jsonl');
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 30;
const dryRun = args.includes('--dry-run');

function log(msg) { console.log(`[${new Date().toISOString().slice(11,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CLOB Client Setup ────────────────────────────────────────────────────

function createClient() {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk || pk === '0x...') {
    console.error('ERROR: POLYMARKET_PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  const wallet = new ethers.Wallet(pk);
  if (!wallet._signTypedData && wallet.signTypedData) {
    wallet._signTypedData = wallet.signTypedData.bind(wallet);
  }

  const apiKey = process.env.POLYMARKET_API_KEY;
  const apiSecret = process.env.POLYMARKET_API_SECRET;
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    console.error('ERROR: API credentials not set in .env');
    process.exit(1);
  }

  const sigType = proxyAddress ? 2 : 0;
  const funder = proxyAddress || undefined;

  const client = new ClobClient(
    CLOB_HOST, CHAIN_ID, wallet,
    { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
    sigType, funder,
  );

  log(`Wallet: ${wallet.address}${proxyAddress ? ` (proxy: ${proxyAddress})` : ''}`);
  return client;
}

// ─── Fetch All Trades (paginated) ──────────────────────────────────────────

async function fetchAllTrades(client, afterMs) {
  const allTrades = [];
  const afterSec = String(Math.floor(afterMs / 1000));

  log(`Fetching trades since ${new Date(afterMs).toISOString()}...`);

  // CLOB API may paginate — fetch in time windows
  let cursor = afterSec;
  let page = 0;
  const MAX_PAGES = 100;

  while (page < MAX_PAGES) {
    page++;
    try {
      const params = { after: cursor };
      const result = await Promise.race([
        client.getTrades(params),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);

      if (!result || !Array.isArray(result) || result.length === 0) {
        break;
      }

      allTrades.push(...result);
      log(`  Page ${page}: ${result.length} trades (total: ${allTrades.length})`);

      // Move cursor to latest trade time + 1
      const maxTime = Math.max(...result.map(t => parseInt(t.match_time || '0')));
      if (maxTime <= parseInt(cursor)) break; // No progress
      cursor = String(maxTime + 1);

      await sleep(300);
    } catch (err) {
      log(`  Page ${page} error: ${err.message}`);
      break;
    }
  }

  log(`Total trades fetched: ${allTrades.length}`);
  return allTrades;
}

// ─── Market Info Fetcher ───────────────────────────────────────────────────

const MONTHS = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function etOffsetHours(year, month0, day) {
  if (month0 < 2 || month0 > 10) return 5;
  if (month0 > 2 && month0 < 10) return 4;
  if (month0 === 2) {
    const dow1 = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const secondSun = dow1 === 0 ? 8 : 15 - dow1;
    return day >= secondSun ? 4 : 5;
  }
  const dow1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSun = dow1 === 0 ? 1 : 8 - dow1;
  return day < firstSun ? 4 : 5;
}

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
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth();
  const year = (month0 - currentMonth > 6) ? currentYear - 1 : currentYear;
  const offset = etOffsetHours(year, month0, day);
  const utcMs = Date.UTC(year, month0, day, hour + offset, min, 0);
  return Math.floor(utcMs / 1000);
}

async function fetchMarketInfo(conditionId) {
  try {
    const res = await fetch(`${CLOB_HOST}/markets/${conditionId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { market: null, outcome: null, resolved: false };
    const market = await res.json();
    if (!market?.condition_id) return { market: null, outcome: null, resolved: false };

    if (!market.closed) return { market, outcome: null, resolved: false };

    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    const winnerToken = tokens.find(t => t.winner === true);
    const outcome = winnerToken?.outcome?.toUpperCase() ?? null;

    return { market, outcome, resolved: !!outcome };
  } catch {
    return { market: null, outcome: null, resolved: false };
  }
}

function resolveTokenSide(assetId, tokens) {
  if (!Array.isArray(tokens) || !assetId) return null;
  const token = tokens.find(t => t.token_id === assetId);
  return token?.outcome?.toUpperCase() ?? null;
}

// ─── Build Journal Entry ───────────────────────────────────────────────────

async function buildEntry(conditionId, trades) {
  const { market, outcome, resolved } = await fetchMarketInfo(conditionId);
  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const question = market?.question ?? null;

  const parsedTs = parseQuestionToSlugTs(question);
  const slug = parsedTs ? `btc-updown-15m-${parsedTs}` : null;
  const marketTime = parsedTs ? parsedTs * 1000 : null;

  const tradeRecords = trades.map(t => {
    const price = parseFloat(t.price) || 0;
    const size = parseFloat(t.size) || 0;
    const feeBps = parseFloat(t.fee_rate_bps) || 0;
    const isBuy = t.side === 'BUY';
    return {
      tradeId: t.id,
      side: t.side,
      tokenSide: resolveTokenSide(t.asset_id, tokens),
      price, size,
      cost: Math.round((isBuy ? price * size : 0) * 100) / 100,
      proceeds: Math.round((!isBuy ? price * size : 0) * 100) / 100,
      feeBps,
      matchTime: t.match_time,
      txHash: t.transaction_hash ?? null,
      traderSide: t.trader_side ?? null,
      status: t.status ?? null,
    };
  });

  const totalCost = tradeRecords.reduce((s, t) => s + t.cost, 0);
  const totalProceeds = tradeRecords.reduce((s, t) => s + t.proceeds, 0);
  const netBuySize = tradeRecords.filter(t => t.side === 'BUY').reduce((s, t) => s + t.size, 0);
  const netSellSize = tradeRecords.filter(t => t.side === 'SELL').reduce((s, t) => s + t.size, 0);
  const netPosition = netBuySize - netSellSize;

  let totalPayout = 0;
  let netPnl = null;

  if (resolved && netPosition > 0) {
    const netBuysBySide = {};
    for (const t of tradeRecords) {
      if (t.tokenSide) {
        const delta = t.side === 'BUY' ? t.size : -t.size;
        netBuysBySide[t.tokenSide] = (netBuysBySide[t.tokenSide] || 0) + delta;
      }
    }
    const netWinningShares = Math.max(0, netBuysBySide[outcome] || 0);
    totalPayout = netWinningShares;
    netPnl = Math.round((totalPayout + totalProceeds - totalCost) * 100) / 100;
  } else if (netPosition <= 0 && totalProceeds > 0) {
    netPnl = Math.round((totalProceeds - totalCost) * 100) / 100;
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
    _fetchedAt: Date.now(),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   FRESH FETCH — Rebuild Verified Trade Journal        ║
╠═══════════════════════════════════════════════════════╣
║   Days: ${String(daysArg).padEnd(4)}  Dry-run: ${dryRun ? 'YES' : 'NO '}                        ║
╚═══════════════════════════════════════════════════════╝
`);

  const client = createClient();
  const afterMs = Date.now() - daysArg * 24 * 60 * 60 * 1000;

  // Step 1: Fetch all trades
  const allTrades = await fetchAllTrades(client, afterMs);
  if (allTrades.length === 0) {
    log('No trades found. Exiting.');
    return;
  }

  // Step 2: Filter to BTC 15m markets only
  const btcMarkets = new Set();
  const byMarket = new Map();
  for (const t of allTrades) {
    const market = t.market;
    if (!market) continue;
    if (!byMarket.has(market)) byMarket.set(market, []);
    byMarket.get(market).push(t);
  }

  log(`\nGrouped into ${byMarket.size} markets. Resolving each...`);

  // Step 3: Build entries
  const entries = [];
  let idx = 0;
  let resolved = 0;
  let unresolved = 0;
  let totalPnl = 0;
  let skippedNonBtc = 0;

  for (const [conditionId, trades] of byMarket) {
    idx++;
    try {
      const entry = await buildEntry(conditionId, trades);

      // Filter: only BTC 15m markets
      if (entry.question && !entry.question.includes('Bitcoin Up or Down')) {
        skippedNonBtc++;
        continue;
      }
      if (!entry.question && !entry.marketSlug) {
        skippedNonBtc++;
        continue;
      }

      entries.push(entry);

      if (entry.resolved) {
        resolved++;
        totalPnl += entry.netPnl ?? 0;
      } else {
        unresolved++;
      }

      if (idx % 10 === 0) {
        log(`  ${idx}/${byMarket.size} markets processed (${entries.length} BTC 15m)...`);
      }

      await sleep(200); // Rate limit for market info fetch
    } catch (err) {
      log(`  ERROR on ${conditionId.slice(0, 16)}: ${err.message}`);
    }
  }

  // Sort by marketTime
  entries.sort((a, b) => (a.marketTime || 0) - (b.marketTime || 0));

  // Step 4: Write
  log(`\n═══ RESULTS ═══`);
  log(`Total BTC 15m markets: ${entries.length}`);
  log(`Resolved: ${resolved}, Unresolved: ${unresolved}`);
  log(`Skipped non-BTC: ${skippedNonBtc}`);
  log(`Total P&L (resolved): ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDC`);

  if (dryRun) {
    log(`\n[DRY-RUN] Would write ${entries.length} entries to ${JOURNAL_PATH}`);
    log('Last 10 entries:');
    entries.slice(-10).forEach(e => {
      const q = (e.question || '').slice(25, 55);
      const out = e.resolved ? e.outcome : 'PENDING';
      const pnl = e.netPnl !== null ? e.netPnl.toFixed(2) : 'n/a';
      log(`  ${q} | ${out} | pnl ${pnl} | cost ${e.totalCost.toFixed(2)} | ${e.trades.length}f`);
    });
    return;
  }

  // Backup existing
  if (existsSync(JOURNAL_PATH)) {
    const backupPath = JOURNAL_PATH.replace('.jsonl', `.backup_${Date.now()}.jsonl`);
    const existing = readFileSync(JOURNAL_PATH, 'utf-8');
    writeFileSync(backupPath, existing);
    log(`Backed up existing journal to ${backupPath}`);
  }

  // Write new journal
  const dir = dirname(JOURNAL_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(JOURNAL_PATH, content);
  log(`Wrote ${entries.length} entries to ${JOURNAL_PATH}`);

  // Summary table
  const wins = entries.filter(e => e.netPnl > 0);
  const losses = entries.filter(e => e.netPnl !== null && e.netPnl <= 0);
  const totalCost = entries.filter(e => e.resolved).reduce((s, e) => s + e.totalCost, 0);

  console.log(`
╔═══════════════════════════════════════════════════════╗
║             JOURNAL REBUILD COMPLETE                  ║
╠═══════════════════════════════════════════════════════╣
║  Markets:    ${String(entries.length).padStart(5)} (${String(resolved).padStart(3)} resolved, ${String(unresolved).padStart(3)} pending)    ║
║  Wins:       ${String(wins.length).padStart(5)}                                      ║
║  Losses:     ${String(losses.length).padStart(5)}                                      ║
║  Win Rate:   ${resolved > 0 ? (wins.length / resolved * 100).toFixed(1).padStart(5) : '  N/A'}%                                    ║
║  Net P&L:  ${(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2).padStart(7)} USDC                             ║
║  ROI:      ${totalCost > 0 ? ((totalPnl / totalCost * 100).toFixed(2) + '%').padStart(7) : '    N/A'}                                  ║
╚═══════════════════════════════════════════════════════╝
`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
