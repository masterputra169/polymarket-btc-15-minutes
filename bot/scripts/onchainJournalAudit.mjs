#!/usr/bin/env node
/**
 * On-chain trade journal audit via Polymarket data-api.
 *
 * BACKGROUND:
 * ----------
 * The CLOB-based rebuild covers ~85% of trades (attribution via maker/owner).
 * Polymarket's public data-api (https://data-api.polymarket.com) indexes the
 * same on-chain data that powers polymarketscan.org — 100% coverage by design.
 *
 * This script builds a parallel `verified_journal.onchain.jsonl` from:
 *   - /trades?user=X   → all BUY/SELL events for wallet (proxy-level)
 *   - /activity?user=X → REDEEM events (payout from winning positions)
 *
 * Per-market P&L formula (purely from on-chain events):
 *   netPnl = sum(SELL proceeds) + sum(REDEEM payouts) - sum(BUY cost)
 *   isWin  = netPnl > 0.01
 *
 * No CLOB API, no wallet filter, no maker/taker attribution — since data-api
 * already filters by wallet address.
 *
 * USAGE:
 *   node bot/scripts/onchainJournalAudit.mjs [--output verified_journal.onchain.jsonl]
 *                                             [--merge]
 *                                             [--compare]
 *
 * FLAGS:
 *   --output:  target file (default bot/data/verified_journal.onchain.jsonl)
 *   --merge:   after write, also copy to verified_journal.jsonl (BACKUP original first)
 *   --compare: show coverage delta vs current verified_journal.jsonl
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __file = fileURLToPath(import.meta.url);
const __dir = dirname(__file);

// Load env for wallet address
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: resolve(__dir, '..', '.env') });

const WALLET = '0x2f8b9af5a465e2bdd5f9b541c3878bc64659b472'; // bot proxy wallet (hardcoded — public info)
const DATA_API = 'https://data-api.polymarket.com';
const BOT_DATA_DIR = resolve(__dir, '..', 'data');

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

const OUTPUT_FILE = ARGS.output || resolve(BOT_DATA_DIR, 'verified_journal.onchain.jsonl');
const DO_MERGE = 'merge' in ARGS;
const DO_COMPARE = 'compare' in ARGS;

console.log('═══════════════════════════════════════════════════════════');
console.log('  On-chain Trade Journal Audit (Polymarket data-api)');
console.log('═══════════════════════════════════════════════════════════');
console.log(`Wallet:  ${WALLET}`);
console.log(`Output:  ${OUTPUT_FILE}`);
console.log(`Mode:    ${DO_MERGE ? 'MERGE into main journal' : 'WRITE side-by-side'}`);
console.log(`Compare: ${DO_COMPARE ? 'YES (show delta)' : 'no'}`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGet(url, retries = 3) {
  for (let a = 0; a < retries; a++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'onchain-audit/1.0' } });
      clearTimeout(t);
      if (!res.ok) {
        if (res.status === 429) { await sleep(2000 * (a + 1)); continue; }
        return null;
      }
      return await res.json();
    } catch {
      if (a === retries - 1) return null;
      await sleep(1000 * (a + 1));
    }
  }
  return null;
}

/**
 * Paginated fetch. data-api caps at ~1000/call, uses offset pagination.
 */
async function fetchAllPaginated(endpoint, params = {}) {
  const results = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const qs = new URLSearchParams({ ...params, user: WALLET, limit: PAGE_SIZE, offset }).toString();
    const url = `${DATA_API}${endpoint}?${qs}`;
    const page = await httpGet(url);
    if (!Array.isArray(page) || page.length === 0) break;
    results.push(...page);
    process.stdout.write(`\r  ${endpoint}: ${results.length} records fetched...`);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await sleep(200); // rate-limit courtesy
  }
  process.stdout.write('\n');
  return results;
}

// ══════════════════════════════════════════════════════════════════
// Phase 1: Fetch all trades + activity
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 1: Fetching on-chain data ===');
// PRIMARY: /activity endpoint (paginated, includes TRADE + REDEEM + MAKER_REBATE).
// The /trades endpoint is capped at ~938 records (API bug) and misses ~268 trades.
// /activity is complete and also exposes `usdcSize` = actual USD transacted including fees,
// which is crucial for accurate P&L (price × size ignores fees; usdcSize accounts for them).
const t0 = Date.now();
const activity = await fetchAllPaginated('/activity');
const t1 = Date.now();

const trades = activity.filter(a => a.type === 'TRADE');
const redeems = activity.filter(a => a.type === 'REDEEM');
const rebates = activity.filter(a => a.type === 'MAKER_REBATE');
const otherActivity = activity.filter(a => !['TRADE', 'REDEEM', 'MAKER_REBATE'].includes(a.type));

console.log(`  Total activity: ${activity.length}`);
console.log(`  Trades:         ${trades.length}`);
console.log(`  REDEEMs:        ${redeems.length}`);
console.log(`  MAKER_REBATEs:  ${rebates.length}`);
console.log(`  Other:          ${otherActivity.length} (${[...new Set(otherActivity.map(a => a.type))].join(', ') || 'none'})`);
console.log(`  Duration:       ${((t1 - t0) / 1000).toFixed(1)}s`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 2: Group by conditionId and compute position P&L
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 2: Aggregating by conditionId ===');
const byMarket = new Map();

function getBucket(cid) {
  if (!byMarket.has(cid)) {
    byMarket.set(cid, {
      conditionId: cid,
      trades: [],
      redeems: [],
      rebates: [],
      slug: null,
      title: null,
      marketTime: null,
    });
  }
  return byMarket.get(cid);
}

for (const t of trades) {
  if (!t.conditionId) continue;
  const b = getBucket(t.conditionId);
  b.trades.push(t);
  if (!b.slug && t.slug) b.slug = t.slug;
  if (!b.title && t.title) b.title = t.title;
  // Derive marketTime from slug tail (format: btc-updown-15m-<unix-sec>)
  if (!b.marketTime && t.slug) {
    const m = /(\d{10})$/.exec(t.slug);
    if (m) b.marketTime = parseInt(m[1]) * 1000;
  }
}
for (const r of redeems) {
  if (!r.conditionId) continue;
  const b = getBucket(r.conditionId);
  b.redeems.push(r);
  if (!b.slug && r.slug) b.slug = r.slug;
  if (!b.title && r.title) b.title = r.title;
  if (!b.marketTime && r.slug) {
    const m = /(\d{10})$/.exec(r.slug);
    if (m) b.marketTime = parseInt(m[1]) * 1000;
  }
}
for (const rb of rebates) {
  if (!rb.conditionId) continue;
  const b = getBucket(rb.conditionId);
  b.rebates.push(rb);
}

console.log(`  Unique markets: ${byMarket.size}`);
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 3: Build entries
// ══════════════════════════════════════════════════════════════════

console.log('=== Phase 3: Building verified entries ===');
const entries = [];
let wins = 0, losses = 0, draws = 0, unresolved = 0;
let totalPnl = 0;

for (const [cid, b] of byMarket) {
  // Aggregate per asset (token_id = each side of the binary market).
  // CRITICAL: use `usdcSize` (actual USD transacted, post-fee) rather than price × size.
  //   - BUY usdcSize = cost paid to acquire shares (includes protocol fee)
  //   - SELL usdcSize = proceeds received (after fee deducted)
  //   - REDEEM usdcSize = payout received (1 USDC per winning share)
  // Using price × size would IGNORE fees and systematically overstate P&L.
  const byAsset = new Map();
  for (const t of b.trades) {
    if (!byAsset.has(t.asset)) byAsset.set(t.asset, { buyCost: 0, buySize: 0, sellProceeds: 0, sellSize: 0 });
    const a = byAsset.get(t.asset);
    const size = Number(t.size) || 0;
    // usdcSize is the actual USD amount; fall back to price × size if missing
    const usdcValue = Number(t.usdcSize);
    const notional = Number.isFinite(usdcValue) && usdcValue > 0
      ? usdcValue
      : (Number(t.price) || 0) * size;
    if (t.side === 'BUY') {
      a.buyCost += notional;
      a.buySize += size;
    } else if (t.side === 'SELL') {
      a.sellProceeds += notional;
      a.sellSize += size;
    }
  }

  // Totals across all assets (both sides of market — bot may have held one or both)
  let totalCost = 0, totalProceeds = 0;
  for (const a of byAsset.values()) {
    totalCost += a.buyCost;
    totalProceeds += a.sellProceeds;
  }

  // Redemption payout: sum usdcSize from REDEEM events for this market
  const totalPayout = b.redeems.reduce((s, r) => s + (Number(r.usdcSize) || Number(r.size) || 0), 0);

  // Add any MAKER_REBATE received for this market (increases effective P&L)
  const totalRebate = (b.rebates || []).reduce((s, x) => s + (Number(x.usdcSize) || 0), 0);

  // Position P&L = proceeds + payouts + rebates - cost
  const netPnl = Math.round((totalProceeds + totalPayout + totalRebate - totalCost) * 100) / 100;

  // Resolution: if we have REDEEM event OR market is old enough (>1h after marketTime), resolved
  const resolved = b.redeems.length > 0 || (b.marketTime && Date.now() - b.marketTime > 60 * 60 * 1000);

  // Classify
  let isWin = null;
  if (!resolved) {
    unresolved++;
  } else if (Math.abs(netPnl) < 0.01) {
    draws++;
    isWin = false;
  } else if (netPnl > 0) {
    wins++;
    isWin = true;
  } else {
    losses++;
    isWin = false;
  }

  if (resolved) totalPnl += netPnl;

  entries.push({
    marketSlug: b.slug,
    conditionId: cid,
    question: b.title,
    marketTime: b.marketTime,
    // Trade records in CLOB-compatible format for schema parity with existing journalAnalytics
    trades: b.trades.map(t => {
      // Derive tokenSide from outcomeIndex (0 = Up, 1 = Down for binary BTC markets)
      let tokenSide = null;
      const idx = Number(t.outcomeIndex);
      if (idx === 0) tokenSide = 'Up';
      else if (idx === 1) tokenSide = 'Down';
      const usdc = Number(t.usdcSize);
      const priceSize = (Number(t.price) || 0) * (Number(t.size) || 0);
      const trueNotional = Number.isFinite(usdc) && usdc > 0 ? usdc : priceSize;
      return {
        tradeId: t.transactionHash || null,
        side: t.side,
        tokenSide,
        asset: t.asset,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        cost: t.side === 'BUY' ? Math.round(trueNotional * 100) / 100 : 0,
        proceeds: t.side === 'SELL' ? Math.round(trueNotional * 100) / 100 : 0,
        matchTime: String(t.timestamp),
        txHash: t.transactionHash || null,
      };
    }),
    redeems: b.redeems.map(r => ({
      amount: Number(r.usdcSize) || Number(r.size) || 0,
      asset: r.asset,
      txHash: r.transactionHash || null,
      timestamp: r.timestamp,
    })),
    outcome: (() => {
      // Infer winning outcome from which asset got redeemed
      if (b.redeems.length === 0) return null;
      // If we have redeems, determine tokenSide of redeemed asset
      const redeemedAsset = b.redeems[0]?.asset;
      if (!redeemedAsset) return null;
      const matchingTrade = b.trades.find(t => t.asset === redeemedAsset);
      if (matchingTrade?.outcomeIndex === 0) return 'Up';
      if (matchingTrade?.outcomeIndex === 1) return 'Down';
      return null;
    })(),
    resolved,
    totalCost: Math.round(totalCost * 100) / 100,
    totalProceeds: Math.round(totalProceeds * 100) / 100,
    totalPayout: Math.round(totalPayout * 100) / 100,
    // netPosition field for journalAnalytics compatibility (net long shares)
    netPosition: (() => {
      let netSize = 0;
      for (const a of byAsset.values()) netSize += (a.buySize - a.sellSize);
      return Math.round(netSize * 1e6) / 1e6;
    })(),
    netPnl,
    isWin,
    // _fetchedAt alias for schema compat with existing journalAnalytics.loadVerifiedJournal
    _fetchedAt: Date.now(),
    _source: 'onchain-dataapi',
  });
}
console.log('');

// ══════════════════════════════════════════════════════════════════
// Phase 4: Write + report
// ══════════════════════════════════════════════════════════════════

const totalResolved = wins + losses + draws;
const wr = totalResolved > 0 ? (wins / totalResolved) * 100 : 0;

console.log('═══════════════════════════════════════════════════════════');
console.log('  On-chain Audit Complete');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Markets:      ${byMarket.size}`);
console.log(`  Resolved:     ${totalResolved} (${wins}W / ${losses}L / ${draws}D)`);
console.log(`  Unresolved:   ${unresolved}`);
console.log(`  Win rate:     ${wr.toFixed(1)}%`);
console.log(`  Total P&L:    $${totalPnl.toFixed(2)}`);
console.log(`  Reference:    polymarketscan 59.8% / +$106 all-time`);
console.log('');

// Sort entries by marketTime for stable output
entries.sort((a, b) => (a.marketTime || 0) - (b.marketTime || 0));

const dir = dirname(OUTPUT_FILE);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
writeFileSync(OUTPUT_FILE, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
console.log(`  ✅ Wrote ${entries.length} entries → ${OUTPUT_FILE}`);

// ─── Compare with current journal ───
if (DO_COMPARE) {
  const mainJournal = resolve(BOT_DATA_DIR, 'verified_journal.jsonl');
  if (existsSync(mainJournal)) {
    const mainLines = readFileSync(mainJournal, 'utf-8').trim().split('\n').filter(Boolean);
    const mainCids = new Set();
    for (const line of mainLines) {
      try {
        const e = JSON.parse(line);
        if (e.conditionId) mainCids.add(e.conditionId);
      } catch {}
    }
    const onchainCids = new Set(entries.map(e => e.conditionId));
    const onlyOnChain = [...onchainCids].filter(c => !mainCids.has(c));
    const onlyMain = [...mainCids].filter(c => !onchainCids.has(c));
    console.log('');
    console.log('=== Coverage Comparison ===');
    console.log(`  Current verified_journal.jsonl: ${mainCids.size} markets`);
    console.log(`  On-chain journal:               ${onchainCids.size} markets`);
    console.log(`  Only in on-chain (new):         ${onlyOnChain.length}`);
    console.log(`  Only in main (orphan):          ${onlyMain.length}`);
    console.log(`  Shared:                          ${onchainCids.size - onlyOnChain.length}`);
  }
}

// ─── Merge mode ───
if (DO_MERGE) {
  const mainJournal = resolve(BOT_DATA_DIR, 'verified_journal.jsonl');
  const backup = resolve(BOT_DATA_DIR, 'verified_journal.pre_onchain.bak');
  if (existsSync(mainJournal)) {
    copyFileSync(mainJournal, backup);
    console.log(`  📦 Backed up existing journal → ${backup}`);
  }
  copyFileSync(OUTPUT_FILE, mainJournal);
  console.log(`  🔄 Merged on-chain journal → ${mainJournal}`);
  console.log('  ⚠️  Restart bot (pm2 restart polymarket-bot) to refresh analytics');
}

console.log('═══════════════════════════════════════════════════════════');
process.exit(0);
