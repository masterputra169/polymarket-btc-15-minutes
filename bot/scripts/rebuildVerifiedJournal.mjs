#!/usr/bin/env node
/**
 * Rebuild verified_journal.jsonl from full CLOB history.
 *
 * BACKGROUND (why this exists):
 * -----------------------------
 * `journalReconciler.js` was buggy: it ran with a 48h initial lookback, then
 * incremental lookbacks afterwards. For each reconcile run, it grouped the
 * window's trades by conditionId and called buildVerifiedEntry() with ONLY
 * the window's trades for that market. If a BUY happened before the window
 * and a SELL within the window, the entry had cost=0, proceeds>0, netPnl>0
 * and was INCORRECTLY classified as WIN (proceeds alone → "win").
 *
 * Result: verified_journal.jsonl had 58 out of 95 "wins" that were actually
 * cut-loss SELLs of losing positions. Reported WR 77.9% vs on-chain 59.8%.
 *
 * Also, reconciler's 48h lookback missed 6+ months of history → only 127 of
 * 854 on-chain resolved markets were in the journal (14.9% coverage).
 *
 * THIS SCRIPT:
 * ------------
 * 1. Fetches trade history in paginated windows (30 days back, chunked)
 * 2. Filters to wallet's trades
 * 3. Groups by conditionId
 * 4. For each conditionId, refetches per-market history via
 *    getTradeHistory({ market: conditionId }) to ensure COMPLETE trade list
 *    (catches BUYs that happened before the initial window)
 * 5. Builds verified entry with correct position-level P&L
 * 6. Writes to verified_journal.v2.jsonl (safe — doesn't touch original)
 *
 * USAGE:
 *   node bot/scripts/rebuildVerifiedJournal.mjs [--days 180]
 *                                               [--output verified_journal.v2.jsonl]
 *                                               [--dry-run]
 *                                               [--limit 0]     (max markets to process)
 *
 * SAFETY:
 *   - Does NOT modify verified_journal.jsonl in place (writes new file)
 *   - Respects rate limits (CLOB allows ~5-10 req/s comfortably)
 *   - Reconciler can keep running during execution
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load env BEFORE module imports (same pattern as bot/index.js)
import { config as dotenvConfig } from 'dotenv';
const __file = fileURLToPath(import.meta.url);
const __dir = dirname(__file);
dotenvConfig({ path: resolve(__dir, '..', '.env') });

// Polyfills (matches bot/index.js)
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
}

const { BOT_CONFIG } = await import('../src/config.js');
const { initClobClient, getTradeHistory, getProxyAddress, isClientReady } = await import('../src/trading/clobClient.js');

// ══════════════════════════════════════════════════════════════════
// CLI args
// ══════════════════════════════════════════════════════════════════

const ARGS = (() => {
  const a = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.replace(/^--/, '');
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; }
    else a[key] = true;
  }
  return a;
})();

const DAYS = parseInt(ARGS.days || '180');
const OUTPUT_FILE = ARGS.output || resolve(BOT_CONFIG.dataDir, 'verified_journal.v2.jsonl');
const DRY_RUN = 'dry-run' in ARGS;
const LIMIT = parseInt(ARGS.limit || '0');
const CHUNK_DAYS = 7;  // Fetch in 7-day windows (CLOB getTrades pagination)

const CLOB_BASE = 'https://clob.polymarket.com';

console.log('═══════════════════════════════════════════════════════════');
console.log('  Rebuild Verified Journal (full position-level PnL)');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Lookback:  ${DAYS} days`);
console.log(`Chunk:     ${CHUNK_DAYS} days`);
console.log(`Output:    ${OUTPUT_FILE}`);
console.log(`Mode:      ${DRY_RUN ? 'DRY RUN (no write)' : 'WRITE'}`);
console.log(`Limit:     ${LIMIT || 'all markets'}`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Init CLOB client (requires POLYMARKET_* env vars)
// ══════════════════════════════════════════════════════════════════

try {
  await initClobClient();
} catch (err) {
  console.error(`Failed to init CLOB client: ${err.message}`);
  console.error('Check bot/.env has POLYMARKET_PRIVATE_KEY + API credentials.');
  process.exit(1);
}
if (!isClientReady()) {
  console.error('CLOB client not ready after init — aborting.');
  process.exit(1);
}

const proxyAddr = (getProxyAddress() || '').toLowerCase();
const apiKeyId = process.env.POLYMARKET_API_KEY || '';
if (!proxyAddr && !apiKeyId) {
  console.error('No proxy address or API key detected — cannot filter own trades.');
  process.exit(1);
}
console.log(`Wallet:    ${proxyAddr}`);
console.log(`API key:   ${apiKeyId.slice(0, 8)}...`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'rebuild-journal/1.0' } });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function isOurTrade(t) {
  const maker = (t.maker_address || '').toLowerCase();
  const taker = (t.taker_address || '').toLowerCase();
  const owner = t.owner || '';
  // Include trades where we are MAKER (LIMIT fills), TAKER (FOK fills), or owner (API-attributed).
  return maker === proxyAddr || taker === proxyAddr || owner === apiKeyId;
}

function resolveTokenSide(assetId, tokens) {
  if (!tokens || !assetId) return null;
  const match = tokens.find(t => String(t.token_id) === String(assetId));
  return match ? match.outcome : null;
}

// Cache for market info (reduces duplicate API calls)
const marketCache = new Map();

async function fetchMarketInfo(conditionId) {
  if (marketCache.has(conditionId)) return marketCache.get(conditionId);
  const url = `${CLOB_BASE}/markets/${conditionId}`;
  const data = await httpGet(url);
  if (!data) {
    const result = { market: null, outcome: null, resolved: false };
    marketCache.set(conditionId, result);
    return result;
  }
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];
  const closed = data.closed === true;
  let winner = null;
  if (closed) {
    const winToken = tokens.find(t => t.winner === true);
    if (winToken) winner = winToken.outcome;
  }
  const result = { market: data, outcome: winner, resolved: closed && winner !== null };
  marketCache.set(conditionId, result);
  return result;
}

function deriveSlugFromQuestion(question, marketTime) {
  // Best-effort slug derivation — format: btc-updown-15m-<unix-sec>
  if (!marketTime) return null;
  return `btc-updown-15m-${Math.floor(marketTime / 1000)}`;
}

// ══════════════════════════════════════════════════════════════════
// Phase 1: Fetch all trades in date range (wallet-filtered)
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 1: Fetching trade history ===');
const nowMs = Date.now();
const startMs = nowMs - DAYS * 86400_000;
const startSec = Math.floor(startMs / 1000);
const nowSec = Math.floor(nowMs / 1000);

const allTrades = [];
const seenTradeIds = new Set();
let chunkStart = startSec;
const CHUNK_SEC = CHUNK_DAYS * 86400;

while (chunkStart < nowSec) {
  const chunkEnd = Math.min(chunkStart + CHUNK_SEC, nowSec);
  const chunkDate = new Date(chunkStart * 1000).toISOString().slice(0, 10);
  process.stdout.write(`\r  ${chunkDate}: fetching... ${allTrades.length} total`);

  try {
    // Fetch trades in this window (note: CLOB paginates; we may need to loop
    // within a chunk if it returns >500 results).
    const trades = await getTradeHistory({ after: chunkStart, before: chunkEnd });
    if (Array.isArray(trades)) {
      const ours = trades.filter(isOurTrade);
      for (const t of ours) {
        if (t.id && !seenTradeIds.has(t.id)) {
          seenTradeIds.add(t.id);
          allTrades.push(t);
        }
      }
    }
  } catch (err) {
    process.stdout.write('\n');
    console.warn(`  [${chunkDate}] fetch error: ${err.message} — continuing`);
  }

  chunkStart = chunkEnd;
  await sleep(200); // rate-limit courtesy
}
process.stdout.write('\n');
console.log(`  Collected ${allTrades.length} wallet trades across ${DAYS} days`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 2: Group by conditionId + per-market deep refetch
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 2: Grouping by conditionId + deep refetch ===');
const byMarket = new Map();
for (const t of allTrades) {
  const cid = t.market;
  if (!cid) continue;
  if (!byMarket.has(cid)) byMarket.set(cid, []);
  byMarket.get(cid).push(t);
}
const targetMarkets = LIMIT > 0 ? [...byMarket.keys()].slice(0, LIMIT) : [...byMarket.keys()];
console.log(`  ${byMarket.size} unique markets (processing ${targetMarkets.length})`);
console.log('');

// For each conditionId, fetch complete per-market history (catches trades
// before our lookback window).
const marketTradeMap = new Map();
let refetched = 0;
let refetchErrors = 0;
const t2 = Date.now();

for (const cid of targetMarkets) {
  try {
    const perMarket = await getTradeHistory({ market: cid });
    if (Array.isArray(perMarket)) {
      const ours = perMarket.filter(isOurTrade);
      // Merge with what we already collected (dedup by id)
      const merged = new Map();
      for (const t of [...(byMarket.get(cid) || []), ...ours]) {
        if (t.id) merged.set(t.id, t);
      }
      marketTradeMap.set(cid, [...merged.values()]);
      refetched++;
    }
  } catch (err) {
    refetchErrors++;
    // Fall back to what we collected in phase 1
    marketTradeMap.set(cid, byMarket.get(cid) || []);
  }
  if (refetched % 20 === 0) {
    const rate = refetched / Math.max(1, (Date.now() - t2) / 1000);
    const eta = (targetMarkets.length - refetched) / Math.max(0.1, rate);
    process.stdout.write(`\r  ${refetched}/${targetMarkets.length} | ${rate.toFixed(1)}/s | ETA ${Math.round(eta)}s | errors ${refetchErrors}`);
  }
  await sleep(150);
}
process.stdout.write('\n');
console.log(`  Deep refetch done: ${refetched} markets, ${refetchErrors} errors`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 3: Build verified entries
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 3: Building verified entries ===');
const entries = [];
let wins = 0, losses = 0, unresolved = 0;
let totalPnl = 0;

for (const [conditionId, trades] of marketTradeMap) {
  const { market, outcome, resolved } = await fetchMarketInfo(conditionId);
  await sleep(50);

  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  const question = market?.question ?? null;
  const marketTime = (() => {
    // Try to extract from endDateIso / endDate
    const iso = market?.end_date_iso || market?.endDateIso || market?.game_start_time;
    if (iso) {
      const ts = typeof iso === 'number' ? iso : new Date(iso).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  })();
  const slug = deriveSlugFromQuestion(question, marketTime);

  // Build trade records
  const tradeRecords = trades.map(t => {
    const price = parseFloat(t.price) || 0;
    const size = parseFloat(t.size) || 0;
    const isBuy = t.side === 'BUY';
    return {
      tradeId: t.id,
      side: t.side,
      tokenSide: resolveTokenSide(t.asset_id, tokens),
      price, size,
      cost: isBuy ? Math.round(price * size * 100) / 100 : 0,
      proceeds: !isBuy ? Math.round(price * size * 100) / 100 : 0,
      feeBps: parseFloat(t.fee_rate_bps) || 0,
      matchTime: t.match_time,
      txHash: t.transaction_hash ?? null,
      status: t.status ?? null,
    };
  });

  // Aggregates
  const totalCost = tradeRecords.reduce((s, t) => s + t.cost, 0);
  const totalProceeds = tradeRecords.reduce((s, t) => s + t.proceeds, 0);

  // NET shares by token side (handles partial exits + both-side trades)
  const netSharesBySide = {};
  for (const t of tradeRecords) {
    if (!t.tokenSide) continue;
    const delta = t.side === 'BUY' ? t.size : -t.size;
    netSharesBySide[t.tokenSide] = (netSharesBySide[t.tokenSide] || 0) + delta;
  }

  // Payout: for each winning token side, remaining net shares pay $1/share
  let totalPayout = 0;
  if (resolved && outcome && netSharesBySide[outcome]) {
    totalPayout = Math.max(0, netSharesBySide[outcome]);
  }

  const netPnl = resolved
    ? Math.round((totalPayout + totalProceeds - totalCost) * 100) / 100
    : null;

  // Classification (GENUINE position-level, not per-entry proceeds check)
  let isWin = null;
  if (resolved) {
    isWin = netPnl > 0.01;
    if (isWin) wins++;
    else losses++;
    totalPnl += netPnl;
  } else {
    unresolved++;
  }

  entries.push({
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
    netSharesBySide,
    netPnl,
    isWin,
    _rebuiltAt: Date.now(),
  });

  if ((wins + losses) % 50 === 0 && (wins + losses) > 0) {
    process.stdout.write(`\r  ${wins}W / ${losses}L | ${unresolved} unresolved | PnL $${totalPnl.toFixed(2)}    `);
  }
}
process.stdout.write('\n');
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 4: Write + report
// ══════════════════════════════════════════════════════════════════

const totalResolved = wins + losses;
const wr = totalResolved > 0 ? (wins / totalResolved) * 100 : 0;

console.log('═══════════════════════════════════════════════════════════');
console.log('  Rebuild Complete');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Markets processed:  ${marketTradeMap.size}`);
console.log(`  Resolved:           ${totalResolved} (${wins}W / ${losses}L)`);
console.log(`  Unresolved:         ${unresolved}`);
console.log(`  Win rate:           ${wr.toFixed(1)}%`);
console.log(`  Total P&L:          $${totalPnl.toFixed(2)}`);
console.log(`  Reference (on-chain polymarketscan): 59.8%`);
console.log('');

if (!DRY_RUN) {
  const dir = dirname(OUTPUT_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = entries.map(e => JSON.stringify(e)).join('\n');
  writeFileSync(OUTPUT_FILE, payload + '\n');
  console.log(`  ✅ Wrote ${entries.length} entries to ${OUTPUT_FILE}`);
} else {
  console.log('  (DRY RUN — no file written)');
}
console.log('═══════════════════════════════════════════════════════════');
process.exit(0);
