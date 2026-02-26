#!/usr/bin/env node
/**
 * Convert scraped Polymarket BTC 15m data → polymarket_lookup.json
 *
 * Input:
 *   polymarket_btc15m_data/01_btc15m_master.csv  (12,550 markets)
 *   polymarket_btc15m_data/price_history.csv       (836K price records)
 *
 * Output:
 *   polymarket_lookup_v13.json
 */

import fs from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const DATA_DIR = './polymarket_btc15m_data';
const MASTER_CSV = `${DATA_DIR}/01_btc15m_master.csv`;
const PRICE_CSV = `${DATA_DIR}/price_history.csv`;
const OUTPUT = './polymarket_lookup_v13.json';

// ── CSV parser that handles quoted fields with commas ──
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── Step 1: Read master CSV ──
console.log('📖 Reading master CSV...');
const masterRaw = fs.readFileSync(MASTER_CSV, 'utf-8');
const masterLines = masterRaw.trim().split('\n');
const masterHeader = parseCSVLine(masterLines[0]);

const colIdx = {};
masterHeader.forEach((h, i) => { colIdx[h] = i; });
console.log(`   Columns: ${masterHeader.join(', ')}`);

const lookup = {};
const conditionToSlugTs = {};

for (let i = 1; i < masterLines.length; i++) {
  const cols = parseCSVLine(masterLines[i]);
  const slugTs = cols[colIdx['slug_timestamp']];
  const resolvedLabel = parseInt(cols[colIdx['resolved_label']]);
  const spread = parseFloat(cols[colIdx['spread']]) || 0;
  const liquidity = parseFloat(cols[colIdx['liquidity']]) || 0;
  const volume = parseFloat(cols[colIdx['volume_num']] ?? cols[colIdx['volume']]) || 0;
  const conditionId = cols[colIdx['condition_id']];

  if (!slugTs || isNaN(resolvedLabel)) continue;

  lookup[slugTs] = {
    label: resolvedLabel,
    spread,
    liquidity,
    volume,
    prices: [],
  };

  conditionToSlugTs[conditionId] = slugTs;
}

console.log(`✅ Master: ${Object.keys(lookup).length} markets loaded`);

// ── Step 2: Read price history (streaming — 836K rows) ──
console.log('📖 Reading price history (streaming)...');

let priceCount = 0;
let matchedCount = 0;
let skippedDown = 0;
let noMatch = 0;

const rl = createInterface({
  input: createReadStream(PRICE_CSV),
  crlfDelay: Infinity,
});

let priceHeader = null;
const pColIdx = {};

for await (const line of rl) {
  if (!priceHeader) {
    priceHeader = parseCSVLine(line);
    priceHeader.forEach((h, i) => { pColIdx[h] = i; });
    console.log(`   Price columns: ${priceHeader.join(', ')}`);
    continue;
  }

  priceCount++;
  if (priceCount % 100000 === 0) {
    process.stdout.write(`\r  ${priceCount} price records (${matchedCount} matched, ${skippedDown} down-side, ${noMatch} no-match)...`);
  }

  const cols = parseCSVLine(line);
  const tokenSide = cols[pColIdx['token_side']];

  // Only use UP token prices
  if (tokenSide !== 'up') {
    skippedDown++;
    continue;
  }

  const conditionId = cols[pColIdx['condition_id']];
  const slugTs = conditionToSlugTs[conditionId];
  if (!slugTs || !lookup[slugTs]) {
    noMatch++;
    continue;
  }

  const timestampUnix = parseInt(cols[pColIdx['timestamp_unix']]);
  const price = parseFloat(cols[pColIdx['price']]);

  if (isNaN(timestampUnix) || isNaN(price)) continue;

  // Convert to seconds-into-market
  const marketStartSec = parseInt(slugTs);
  const secsIntoMarket = timestampUnix - marketStartSec;

  // Keep prices within market window with buffer
  if (secsIntoMarket < -60 || secsIntoMarket > 960) continue;

  lookup[slugTs].prices.push([secsIntoMarket, price]);
  matchedCount++;
}

console.log(`\n✅ Prices: ${priceCount} total, ${matchedCount} matched UP, ${skippedDown} down-side, ${noMatch} no-match`);

// ── Step 3: Sort prices ──
console.log('🔧 Sorting prices per market...');
let marketsWithPrices = 0;
let totalPricePoints = 0;

for (const key of Object.keys(lookup)) {
  const m = lookup[key];
  if (m.prices.length > 0) {
    m.prices.sort((a, b) => a[0] - b[0]);
    marketsWithPrices++;
    totalPricePoints += m.prices.length;
  }
}

const avgPts = marketsWithPrices > 0 ? (totalPricePoints / marketsWithPrices).toFixed(1) : 0;
console.log(`✅ ${marketsWithPrices}/${Object.keys(lookup).length} markets have price data (avg ${avgPts} points/market)`);

// ── Step 4: Write output ──
console.log(`💾 Writing ${OUTPUT}...`);
fs.writeFileSync(OUTPUT, JSON.stringify(lookup));
const sizeMB = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1);
console.log(`✅ Saved ${OUTPUT} (${sizeMB} MB, ${Object.keys(lookup).length} markets)`);

// ── Stats ──
const labels = Object.values(lookup);
const ups = labels.filter(m => m.label === 1).length;
const downs = labels.filter(m => m.label === 0).length;
const withPrices = labels.filter(m => m.prices.length > 0).length;
const withSpread = labels.filter(m => m.spread > 0).length;

const sortedKeys = Object.keys(lookup).sort((a, b) => parseInt(a) - parseInt(b));
const firstTs = new Date(parseInt(sortedKeys[0]) * 1000).toISOString();
const lastTs = new Date(parseInt(sortedKeys[sortedKeys.length - 1]) * 1000).toISOString();

console.log(`\n📊 Summary:`);
console.log(`   Markets: ${labels.length} (UP: ${ups}, DOWN: ${downs})`);
console.log(`   With prices: ${withPrices} (${(withPrices/labels.length*100).toFixed(1)}%)`);
console.log(`   With spread: ${withSpread} (${(withSpread/labels.length*100).toFixed(1)}%)`);
console.log(`   Date range: ${firstTs} → ${lastTs}`);
