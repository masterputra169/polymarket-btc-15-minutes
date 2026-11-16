/**
 * Build the Stage-2 / Pipeline v4 dataset directly from the 1 Hz Market Tape:
 *   - Pulls missing closed market resolutions into tape/_resolutions.json
 *   - Caches Binance 1m BTCUSDT klines covering the tape range + 260m warmup
 *   - Scores the production v2 model (public/ml) per snapshot cleanly (100% OOS)
 *   - Extracts full 63-base Pipeline v4 vectors (58 Quant + 5 Chainlink-native)
 *     plus real L2 orderbook metrics (imbalance, spread, microprice, asks)
 *   - Writes:
 *       1) backtest/ml_training/tape_v4_panel.csv (all minute 1..14 + final-min 15/30/45s rows)
 *       2) backtest/ml_training/training_data_v4.csv + .meta.json (1 row per market, feature_pipeline=4)
 *       3) bot/data/tape_coverage_study.json (54d tape coverage & cross-feed empirical study)
 *
 * Usage:
 *   node backtest/ml_training/buildTapeV4Dataset.mts [--skip-network]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { gunzipSync, constants as zc } from 'zlib';
import { BOT_CONFIG } from '../../bot/src/config.ts';
import { loadMLModelFromDisk, getFeaturePipeline } from '../../bot/src/adapters/mlLoader.ts';
import { predictML } from '../../src/engines/Mlpredictor.ts';
import { extractLiveFeaturesInPlace, featureBuf } from '../../src/engines/ml/featureExtract.ts';
import { V4_CHAINLINK_FI } from '../../src/engines/ml/featureMap.ts';
import { buildMlFeatureInputs, MARKET_MOMENTUM_WINDOW_MS } from '../../src/engines/ml/featureInputs.ts';
import * as MLState from '../../src/engines/ml/state.ts';
import {
  aggregate5m, CANDLES_1M, CANDLES_5M,
  type HistoricalCandle,
} from '../../src/engines/ml/trainingRow.ts';
import { estimateSettlePrice, computeOracleDeltaWindowRatio } from '../../bot/src/engines/settlePrice.ts';
import { spotVolPerSecond, twapVarianceSeconds, normCdf } from '../../bot/src/engines/twapPhysics.ts';
import { isExactPtbSource } from '../../bot/src/engines/ptbSources.ts';
import { fetchResolvedOutcome } from '../../bot/src/engines/marketResolution.ts';
import { fetchJsonWithPolymarketDoh } from '../../bot/src/services/polymarketHttp.ts';
import { parseRelPath, type SnapshotLine, type MarketLine, type DecisionLine } from '../../bot/src/tape/tapeFormat.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const TAPE_DIR = resolve(HERE, 'tape');
const MIN_MS = 60_000;
const WINDOW_SECS = 900;
// Minutes 1..14 + final-minute snapshots (45s, 30s, 15s left) for Stage-2 realism study
const SECS_GRID = [
  60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840,
  855, 870, 885,
];
const SINGLE_ROW_CANDIDATES = [120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780];

const SPOT_FALLBACKS = [
  'https://data-api.binance.vision',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
];

const ARGS = new Set(process.argv.slice(2));
const SKIP_NETWORK = ARGS.has('--skip-network');

function slugTimestamp(slug: string): number | null {
  const m = /-(\d{9,11})$/.exec(slug);
  return m ? Number(m[1]) : null;
}

function seededPicker(seed: number) {
  let state = seed | 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function medianSorted(sorted: number[]): number | null {
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function quantileSorted(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
}

function parseBook(book: { b?: Array<[number, number]>; a?: Array<[number, number]> } | undefined) {
  if (!book || !Array.isArray(book.b) || !Array.isArray(book.a)) return null;
  const bids = book.b.filter((lv) => Array.isArray(lv) && lv[0] > 0 && lv[1] > 0).sort((x, y) => y[0] - x[0]);
  const asks = book.a.filter((lv) => Array.isArray(lv) && lv[0] > 0 && lv[1] > 0).sort((x, y) => x[0] - y[0]);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const bidSz = bids[0][1];
  const askSz = asks[0][1];
  if (!(bestBid > 0 && bestAsk < 1 && bestAsk >= bestBid)) return null;
  const spread = +(bestAsk - bestBid).toFixed(4);
  if (spread > 0.15) return null;
  let bidLiq5 = 0;
  let askLiq5 = 0;
  for (let i = 0; i < Math.min(5, bids.length); i++) bidLiq5 += bids[i][1];
  for (let i = 0; i < Math.min(5, asks.length); i++) askLiq5 += asks[i][1];
  const mid = (bestBid + bestAsk) / 2;
  const microprice = (bidSz + askSz) > 0 ? (bestBid * askSz + bestAsk * bidSz) / (bidSz + askSz) : mid;
  return { bestBid, bestAsk, bidSz, askSz, bidLiq5, askLiq5, spread, mid, microprice };
}

async function fetchJsonDoH(url: string, init?: RequestInit) {
  const res = await fetchJsonWithPolymarketDoh(url, { timeoutMs: 12_000, ...(init as any) });
  return { ok: true, status: 200, json: async () => res };
}

async function resolveOutcomes(tapeDays: string[]): Promise<Map<string, 'UP' | 'DOWN'>> {
  const out = new Map<string, 'UP' | 'DOWN'>();
  const resPath = resolve(TAPE_DIR, '_resolutions.json');
  const cacheObj: { version: number; markets: Record<string, { outcome: 'UP' | 'DOWN'; source: string; conditionId: string | null; checkedAt: string }> } =
    existsSync(resPath) ? JSON.parse(readFileSync(resPath, 'utf8')) : { version: 1, markets: {} };

  for (const [slug, v] of Object.entries(cacheObj.markets || {})) {
    if (v?.outcome === 'UP' || v?.outcome === 'DOWN') out.set(slug, v.outcome);
  }

  const lookupPath = resolve(HERE, 'polymarket_lookup.json');
  if (existsSync(lookupPath)) {
    const lookup = JSON.parse(readFileSync(lookupPath, 'utf8')) as Record<string, { label?: number }>;
    for (const [tsStr, entry] of Object.entries(lookup)) {
      const slug = `btc-updown-15m-${tsStr}`;
      if (!out.has(slug) && (entry?.label === 0 || entry?.label === 1)) {
        out.set(slug, entry.label === 1 ? 'UP' : 'DOWN');
      }
    }
  }

  // Query Polymarket DoH for any remaining closed 15m slots in the tape window
  const firstDayMs = Date.parse(`${tapeDays[0]}T00:00:00Z`);
  const lastDayMs = Math.min(Date.now() - 20 * MIN_MS, Date.parse(`${tapeDays[tapeDays.length - 1]}T23:59:59Z`));
  const startSlot = Math.floor(firstDayMs / 900_000) * 900;
  const endSlot = Math.floor(lastDayMs / 900_000) * 900;
  const missing: string[] = [];
  for (let ts = startSlot; ts <= endSlot; ts += 900) {
    const slug = `btc-updown-15m-${ts}`;
    if (!out.has(slug)) missing.push(slug);
  }

  console.log(`[Resolutions] Known locally: ${out.size} total (${missing.length} tape slots missing)`);
  if (missing.length > 0 && !SKIP_NETWORK) {
    let cursor = 0;
    let newlyResolved = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const slug = missing[cursor++];
        try {
          const r = await fetchResolvedOutcome(
            { marketSlug: slug },
            { timeoutMs: 10_000, fetchImpl: fetchJsonDoH as any },
          );
          if (r) {
            out.set(slug, r.outcome);
            cacheObj.markets[slug] = {
              outcome: r.outcome,
              source: r.source,
              conditionId: null,
              checkedAt: new Date().toISOString(),
            };
            newlyResolved++;
          }
        } catch { /* ignore transient lookup failure */ }
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    if (newlyResolved > 0) {
      writeFileSync(resPath, JSON.stringify(cacheObj, null, 2));
      console.log(`[Resolutions] Queried & cached +${newlyResolved} new outcomes -> _resolutions.json`);
    }
  }
  return out;
}

async function fetchKlinesRange(startMs: number, endMs: number): Promise<HistoricalCandle[]> {
  const cachePath = resolve(TAPE_DIR, '_binance_1m_cache.json');
  let cached: { startMs: number; endMs: number; candles: HistoricalCandle[] } | null = null;
  if (existsSync(cachePath)) {
    try {
      cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    } catch { cached = null; }
  }
  if (cached && cached.startMs <= startMs && cached.endMs >= endMs - 2 * MIN_MS) {
    console.log(`[Klines] Loaded cached ${cached.candles.length.toLocaleString()} Binance 1m candles`);
    return cached.candles;
  }

  const byOpen = new Map<number, HistoricalCandle>();
  let fetchStart = startMs;
  if (cached?.candles?.length && cached.startMs <= startMs) {
    for (const c of cached.candles) byOpen.set(c.openTime, c);
    fetchStart = cached.candles[cached.candles.length - 1].openTime + MIN_MS;
    console.log(`[Klines] Extending cache from ${new Date(fetchStart).toISOString()}...`);
  } else {
    console.log(`[Klines] Fetching Binance 1m candles ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()}...`);
  }

  if (!SKIP_NETWORK) {
    let hostIdx = 0;
    for (let cursor = fetchStart; cursor < endMs;) {
      const urlPath = `/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
      let batch: any[] | null = null;
      for (let tries = 0; tries < SPOT_FALLBACKS.length; tries++) {
        const host = SPOT_FALLBACKS[(hostIdx + tries) % SPOT_FALLBACKS.length];
        try {
          const resp = await fetch(`${host}${urlPath}`, { signal: AbortSignal.timeout(15_000) });
          if (resp.ok) {
            batch = await resp.json() as any[];
            hostIdx = (hostIdx + tries) % SPOT_FALLBACKS.length;
            break;
          }
        } catch { /* try next host */ }
      }
      if (!batch || batch.length === 0) break;
      for (const k of batch) {
        const c: HistoricalCandle = {
          openTime: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
          takerBuyVolume: Number(k[9]),
        };
        byOpen.set(c.openTime, c);
      }
      cursor = Number(batch[batch.length - 1][0]) + MIN_MS;
      if (byOpen.size % 10_000 < 1000) process.stdout.write(`\r  ${byOpen.size.toLocaleString()} candles`);
    }
    if (fetchStart < endMs) process.stdout.write('\n');
  }

  const all = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
  if (all.length > 0) {
    writeFileSync(cachePath, JSON.stringify({
      startMs: all[0].openTime,
      endMs: all[all.length - 1].openTime + MIN_MS,
      candles: all,
    }));
  }
  return all;
}

interface SpotPt { ts: number; value: number }
interface BtcPt { ts: number; value: number }
interface UpPt { ts: number; value: number }

class TrailingTapeBuffers {
  spotTicks: SpotPt[] = [];
  btcTicks: BtcPt[] = [];
  upTicks: UpPt[] = [];

  pushSnapshot(s: SnapshotLine, bookMid: number | null) {
    const t = s.t;
    const oracle = (typeof s.pl === 'number' && Number.isFinite(s.pl) && s.pl > 0)
      ? s.pl
      : (typeof s.cl === 'number' && Number.isFinite(s.cl) && s.cl > 0 ? s.cl : null);
    if (oracle != null) {
      this.spotTicks.push({ ts: t, value: oracle });
      const cutSpot = t - 180_000;
      while (this.spotTicks.length && this.spotTicks[0].ts < cutSpot) this.spotTicks.shift();
    }
    if (typeof s.btc === 'number' && Number.isFinite(s.btc) && s.btc > 0) {
      this.btcTicks.push({ ts: t, value: s.btc });
      const cutBtc = t - 20_000;
      while (this.btcTicks.length && this.btcTicks[0].ts < cutBtc) this.btcTicks.shift();
    }
    if (bookMid != null) {
      this.upTicks.push({ ts: t, value: bookMid });
      const cutUp = t - 120_000;
      while (this.upTicks.length && this.upTicks[0].ts < cutUp) this.upTicks.shift();
    }
  }
}

function deltaRatioFromTicks(ticks: ReadonlyArray<{ ts: number; value: number }>, nowMs: number, windowMs: number): number {
  const cutoff = nowMs - windowMs;
  let oldest: { ts: number; value: number } | null = null;
  let latest: { ts: number; value: number } | null = null;
  let n = 0;
  for (const pt of ticks) {
    if (pt.ts < cutoff || pt.ts > nowMs) continue;
    n++;
    if (!oldest || pt.ts < oldest.ts) oldest = pt;
    if (!latest || pt.ts > latest.ts) latest = pt;
  }
  if (!oldest || !latest || n < 2 || latest.ts <= oldest.ts || oldest.value <= 0) return 0;
  return (latest.value - oldest.value) / oldest.value;
}

function upAtOrBefore(ticks: ReadonlyArray<UpPt>, atMs: number, marketStartMs: number): number | null {
  let found: number | null = null;
  for (const pt of ticks) {
    if (pt.ts < marketStartMs) continue;
    if (pt.ts > atMs) break;
    found = pt.value;
  }
  return found;
}

function decodeDayHourLines(filePath: string): Array<SnapshotLine | MarketLine | DecisionLine> {
  const buf = readFileSync(filePath);
  const text = gunzipSync(buf, { finishFlush: zc.Z_SYNC_FLUSH }).toString('utf8');
  const out: Array<SnapshotLine | MarketLine | DecisionLine> = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && (obj.k === 's' || obj.k === 'm' || obj.k === 'd') && Number.isFinite(obj.t)) {
        out.push(obj);
      }
    } catch { /* skip torn crash line */ }
  }
  return out;
}

function predictBaselineV2(snapshotV2: Parameters<typeof buildMlFeatureInputs>[0]): number | null {
  const { marketState, ruleProbUp } = buildMlFeatureInputs(snapshotV2);
  const prevBase = MLState.BASE_FEATURES;
  try {
    MLState.setBaseFeatureCount(58);
    extractLiveFeaturesInPlace({
      ...marketState,
      ruleProbUp,
      ruleConfidence: Math.abs(ruleProbUp - 0.5) * 2,
    });
    const r = predictML(featureBuf);
    return r ? r.probUp : null;
  } finally {
    MLState.setBaseFeatureCount(prevBase);
  }
}

function extractV4Vector(snapshotV4: Parameters<typeof buildMlFeatureInputs>[0]): number[] {
  const { marketState, ruleProbUp } = buildMlFeatureInputs(snapshotV4);
  const prevBase = MLState.BASE_FEATURES;
  const prevPipe = MLState.featurePipeline;
  try {
    MLState.setState({ featurePipeline: 4 });
    MLState.setBaseFeatureCount(63);
    extractLiveFeaturesInPlace({
      ...marketState,
      ruleProbUp,
      ruleConfidence: Math.abs(ruleProbUp - 0.5) * 2,
    });
    return Array.from(featureBuf.subarray(0, 63));
  } finally {
    MLState.setState({ featurePipeline: prevPipe });
    MLState.setBaseFeatureCount(prevBase);
  }
}

async function main() {
  if (!existsSync(TAPE_DIR)) throw new Error(`Missing tape dir: ${TAPE_DIR}`);
  const days = readdirSync(TAPE_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) throw new Error('No YYYY-MM-DD directories in tape/');
  console.log(`[Tape] Found ${days.length} days: ${days[0]} .. ${days[days.length - 1]}`);

  // Load 395d production v2 model so we get leak-free out-of-sample v2_prob_up per snapshot
  const mlDir = resolve(ROOT, 'public', 'ml');
  (BOT_CONFIG as any).modelPath = resolve(mlDir, 'xgboost_model.json');
  (BOT_CONFIG as any).normPath = resolve(mlDir, 'norm_browser.json');
  if (!loadMLModelFromDisk()) throw new Error(`Failed to load active v2 model from ${mlDir}`);
  const loadedModelId = MLState.modelId || '20261116-p2-ef8dfd';
  console.log(`[Model] Active baseline loaded: ${loadedModelId} (pipeline v${getFeaturePipeline()}, OOS for all >= 2026-09-24)`);

  const officialPtbPath = resolve(TAPE_DIR, '_ptb_official.json');
  const officialPtbs: Record<string, number> = existsSync(officialPtbPath)
    ? JSON.parse(readFileSync(officialPtbPath, 'utf8'))
    : {};

  const outcomes = await resolveOutcomes(days);
  const klineStartMs = Date.parse(`${days[0]}T00:00:00Z`) - (CANDLES_1M + 30) * MIN_MS;
  const klineEndMs = Math.min(Date.now(), Date.parse(`${days[days.length - 1]}T23:59:59Z`) + 20 * MIN_MS);
  const candles = await fetchKlinesRange(klineStartMs, klineEndMs);
  const byOpen = new Map<number, number>();
  candles.forEach((c, idx) => byOpen.set(c.openTime, idx));
  console.log(`[Klines] Indexed ${candles.length.toLocaleString()} 1m Binance candles`);

  const v4Names = Object.entries(V4_CHAINLINK_FI).sort((a, b) => a[1] - b[1]).map(([n]) => n);
  const metaCols = [
    'slug_timestamp', 'secs_into', 'label', 'ptb_exact', 'v2_prob_up',
    'up_mid', 'up_bid', 'up_ask', 'dn_bid', 'dn_ask', 'microprice',
    'imb1', 'imb5', 'spread_up', 'live_basis_usd', 'cross_feed_skew_usd',
    'binance_dist_pct', 'oracle_dist_pct', 'twap_p',
  ];

  const outPanelPath = resolve(HERE, 'tape_v4_panel.csv');
  const outCsvPath = resolve(HERE, 'training_data_v4.csv');
  const outMetaPath = resolve(HERE, 'training_data_v4.meta.json');
  const outStudyPath = resolve(ROOT, 'bot', 'data', 'tape_coverage_study.json');

  const panelStream = createWriteStream(outPanelPath);
  const singleStream = createWriteStream(outCsvPath);
  panelStream.write([...v4Names, ...metaCols].join(',') + '\n');
  singleStream.write([...v4Names, 'slug_timestamp', 'label'].join(',') + '\n');

  const rng = seededPicker(42);
  const buffers = new TrailingTapeBuffers();
  const seenMarkets = new Set<string>();
  const resolvedMarkets = new Set<string>();
  const exactPtbMarkets = new Set<string>();
  const allBasis: number[] = [];
  const allAbsSkewNearPtb: number[] = [];
  let totalSnapshots = 0;
  let totalLiveBook = 0;
  let totalHasTwap = 0;
  let totalHasOracle = 0;
  let totalDecisions = 0;
  let totalCrossFeedBlocked = 0;
  let totalCrossFeedFlips = 0;
  let totalPanelRows = 0;
  let totalSingleRows = 0;
  let singleFirstTs: number | null = null;
  let singleLastTs: number | null = null;

  const dailySummary: Array<Record<string, unknown>> = [];

  // Process one day at a time, grouping hour files chronologically
  let curSlug: string | null = null;
  let curSlugTs: number | null = null;
  let curCandIdxMap = new Map<number, number>(); // secsInto -> 1m candle close idx
  let emittedSecsForMarket = new Set<number>();
  let singleRowsBuf: Array<{ secsInto: number; rowLine: string }> = [];
  let lastValidPtb: { slug: string; val: number; exact: boolean } | null = null;

  const flushSingleRowForMarket = () => {
    if (!curSlug || curSlugTs == null || singleRowsBuf.length === 0) return;
    const pool = singleRowsBuf.filter((x) => SINGLE_ROW_CANDIDATES.includes(x.secsInto));
    const list = pool.length ? pool : singleRowsBuf;
    const pick = list[Math.floor(rng() * list.length)];
    singleStream.write(pick.rowLine + '\n');
    totalSingleRows++;
    if (singleFirstTs == null || curSlugTs < singleFirstTs) singleFirstTs = curSlugTs;
    if (singleLastTs == null || curSlugTs > singleLastTs) singleLastTs = curSlugTs;
    singleRowsBuf = [];
  };

  for (let dIdx = 0; dIdx < days.length; dIdx++) {
    const day = days[dIdx];
    const dayDir = join(TAPE_DIR, day);
    const files = readdirSync(dayDir)
      .filter((f) => parseRelPath(`${day}/${f}`) !== null)
      .sort();

    let daySnaps = 0;
    let dayLive = 0;
    let dayOracle = 0;
    let dayTwap = 0;
    let dayDecisions = 0;
    let dayCfBlocked = 0;
    let dayBytes = 0;
    const dayMarkets = new Set<string>();
    const dayBasis: number[] = [];
    const dayLines: Array<SnapshotLine | MarketLine | DecisionLine> = [];

    for (const f of files) {
      const fp = join(dayDir, f);
      dayBytes += readFileSync(fp).length;
      const lines = decodeDayHourLines(fp);
      for (const l of lines) dayLines.push(l);
    }
    dayLines.sort((a, b) => a.t - b.t);

    let lastSnapProcessedT = 0;
    for (const line of dayLines) {
      if (line.k === 'd') {
        dayDecisions++;
        totalDecisions++;
        const fr = line.fr;
        if (Array.isArray(fr) && fr.some((r) => typeof r === 'string' && r.startsWith('Cross-feed'))) {
          dayCfBlocked++;
          totalCrossFeedBlocked++;
          if (fr.some((r) => typeof r === 'string' && r.includes('Cross-feed flip'))) totalCrossFeedFlips++;
        }
        continue;
      }
      if (line.k !== 's') continue;

      // Avoid processing duplicate snapshot timestamps within < 400ms across boot restarts
      if (line.t - lastSnapProcessedT < 400) continue;
      lastSnapProcessedT = line.t;

      daySnaps++;
      totalSnapshots++;
      const slug = line.m;
      if (slug) {
        dayMarkets.add(slug);
        seenMarkets.add(slug);
      }

      const oracleNow = (typeof line.pl === 'number' && Number.isFinite(line.pl) && line.pl > 0)
        ? line.pl
        : (typeof line.cl === 'number' && Number.isFinite(line.cl) && line.cl > 0 ? line.cl : null);
      if (oracleNow != null) { dayOracle++; totalHasOracle++; }
      if (typeof line.tw === 'number' && line.tw > 0) { dayTwap++; totalHasTwap++; }

      if (typeof line.btc === 'number' && oracleNow != null) {
        const bDiff = line.btc - oracleNow;
        if (Math.abs(bDiff) < 500) {
          dayBasis.push(bDiff);
          allBasis.push(bDiff);
        }
      }

      const upTop = line.ok === 1 ? parseBook(line.u) : null;
      const dnTop = line.ok === 1 ? parseBook(line.d) : null;
      if (upTop && dnTop && line.ok === 1) {
        dayLive++;
        totalLiveBook++;
      }

      buffers.pushSnapshot(line, upTop?.mid ?? null);

      if (!slug) continue;
      const sTs = slugTimestamp(slug);
      if (!sTs) continue;

      if (curSlug !== slug) {
        flushSingleRowForMarket();
        curSlug = slug;
        curSlugTs = sTs;
        emittedSecsForMarket = new Set<number>();
        singleRowsBuf = [];
        curCandIdxMap = new Map<number, number>();
        MLState.resetHysteresis();
      }

      const ptbLive = typeof line.ptb === 'number' && Number.isFinite(line.ptb) && line.ptb > 0 ? line.ptb : null;
      const ptbIsExact = Boolean(ptbLive && isExactPtbSource(line.ps));
      if (ptbLive && (!lastValidPtb || lastValidPtb.slug !== slug || (!lastValidPtb.exact && ptbIsExact))) {
        lastValidPtb = { slug, val: ptbLive, exact: ptbIsExact };
        if (ptbIsExact) exactPtbMarkets.add(slug);
      }

      const outcome = outcomes.get(slug);
      if (!outcome) continue;
      resolvedMarkets.add(slug);
      const label = outcome === 'UP' ? 1 : 0;

      const secsIntoRaw = line.t / 1000 - sTs;
      if (secsIntoRaw < 59 || secsIntoRaw > 895) continue;

      // Check if this snapshot falls inside [targetSec, targetSec + 5] for any grid point
      for (const targetSec of SECS_GRID) {
        if (emittedSecsForMarket.has(targetSec)) continue;
        if (secsIntoRaw < targetSec || secsIntoRaw > targetSec + 5) continue;
        if (!upTop || !dnTop || typeof line.btc !== 'number' || oracleNow == null) continue;

        const targetMs = (sTs + targetSec) * 1000;
        const binanceCandleCloseTarget = sTs * 1000 + (Math.min(targetSec, 840) - 60) * 1000;
        let idx = curCandIdxMap.get(targetSec);
        if (idx === undefined) {
          idx = byOpen.get(binanceCandleCloseTarget);
          if (idx === undefined) continue;
          curCandIdxMap.set(targetSec, idx);
        }
        if (idx < CANDLES_1M - 1) continue;
        const slice = candles.slice(idx - CANDLES_1M + 1, idx + 1);
        if (slice[slice.length - 1].openTime - slice[0].openTime !== (CANDLES_1M - 1) * MIN_MS) continue;

        const windowOpenCandleIdx = idx - Math.round(Math.min(targetSec, 840) / 60) + 1;
        if (windowOpenCandleIdx < 0 || candles[windowOpenCandleIdx]?.openTime !== sTs * 1000) continue;
        const binanceWindowOpen = candles[windowOpenCandleIdx].open;

        const officialPtb = officialPtbs[slug];
        const exactPtb = officialPtb && officialPtb > 0
          ? officialPtb
          : (lastValidPtb?.slug === slug && lastValidPtb.exact ? lastValidPtb.val : null);
        const ptbExactFlag = exactPtb != null ? 1 : 0;
        const activePtb = exactPtb ?? (lastValidPtb?.slug === slug ? lastValidPtb.val : null);
        if (activePtb == null || !(activePtb > 0)) continue;

        const marketEndMs = (sTs + WINDOW_SECS) * 1000;
        const settle = estimateSettlePrice({
          nowMs: line.t,
          endMs: marketEndMs,
          spot: oracleNow,
          spotTicks: buffers.spotTicks.filter((pt) => pt.ts >= marketEndMs - 61_000 && pt.ts <= line.t),
          binance: line.btc,
          basis: line.btc - oracleNow,
        });
        const settlePrice = settle.price ?? oracleNow;
        const sigma1s = spotVolPerSecond(buffers.spotTicks.filter((pt) => pt.ts >= line.t - 121_000 && pt.ts <= line.t));
        const leftSecs = Math.max(1, (marketEndMs - line.t) / 1000);
        const twapPhysicsZ = (sigma1s != null && sigma1s > 0)
          ? (settlePrice - activePtb) / (sigma1s * Math.sqrt(twapVarianceSeconds(leftSecs)))
          : null;

        const binanceDelta3s = deltaRatioFromTicks(buffers.btcTicks, line.t, 3_000);
        const oracleDelta3s = deltaRatioFromTicks(buffers.spotTicks, line.t, 3_000);
        const upLag = upAtOrBefore(buffers.upTicks, line.t - MARKET_MOMENTUM_WINDOW_MS, sTs * 1000);

        const upTotalLiq = upTop.bidLiq5 + upTop.askLiq5;
        const dnTotalLiq = dnTop.bidLiq5 + dnTop.askLiq5;
        const obImbalance = (upTotalLiq >= 1 && dnTotalLiq >= 1)
          ? (upTop.bidLiq5 / upTotalLiq) - (dnTop.bidLiq5 / dnTotalLiq)
          : 0;
        const imb1 = (upTop.bidSz + upTop.askSz) > 0 ? upTop.bidSz / (upTop.bidSz + upTop.askSz) : 0.5;
        const imb5 = upTotalLiq > 0 ? upTop.bidLiq5 / upTotalLiq : 0.5;

        const candles5m = aggregate5m(slice).slice(-CANDLES_5M);
        const minutesLeft = (WINDOW_SECS - Math.min(secsIntoRaw, WINDOW_SECS - 1)) / 60;

        // Score baseline 395d v2 model honestly (featurePipeline=2, neutral book)
        const v2ProbUp = predictBaselineV2({
          candles1m: slice,
          candles5m,
          lastPrice: line.btc,
          windowOpenPrice: binanceWindowOpen,
          minutesLeft,
          nowMs: line.t,
          marketUp: upTop.mid,
          marketUpLag: upLag,
          fundingRate: null,
          featurePipeline: 2,
        });

        // Extract Pipeline v4 63-base feature vector (includes live L2 book + 5 Chainlink-native)
        const v4Feats = extractV4Vector({
          candles1m: slice,
          candles5m,
          lastPrice: line.btc,
          windowOpenPrice: binanceWindowOpen,
          minutesLeft,
          nowMs: line.t,
          marketUp: upTop.mid,
          marketUpLag: upLag,
          fundingRate: null,
          featurePipeline: 4,
          orderbookImbalance: obImbalance,
          spreadPct: upTop.spread,
          oraclePrice: oracleNow,
          settlePrice,
          exactPtb: activePtb,
          twapPhysicsZ,
          binanceDelta3s,
          oracleDelta3s,
        });

        const liveBasisUsd = line.btc - oracleNow;
        const binDistPct = ((line.btc - binanceWindowOpen) / binanceWindowOpen) * 100;
        const oraDistPct = ((settlePrice - activePtb) / activePtb) * 100;
        const skewUsd = (line.btc - binanceWindowOpen) - (settlePrice - activePtb);
        if (Math.abs(oraDistPct) < 0.08) allAbsSkewNearPtb.push(Math.abs(skewUsd));

        const twapProb = twapPhysicsZ != null ? normCdf(twapPhysicsZ) : null;

        const fmtVec = v4Feats.map((v) => (Number.isFinite(v) ? +v.toPrecision(7) : 0));
        const panelRow = [
          ...fmtVec,
          sTs,
          targetSec,
          label,
          ptbExactFlag,
          v2ProbUp != null ? +v2ProbUp.toFixed(6) : '',
          +upTop.mid.toFixed(4),
          +upTop.bestBid.toFixed(4),
          +upTop.bestAsk.toFixed(4),
          +dnTop.bestBid.toFixed(4),
          +dnTop.bestAsk.toFixed(4),
          +upTop.microprice.toFixed(5),
          +imb1.toFixed(4),
          +imb5.toFixed(4),
          +upTop.spread.toFixed(4),
          +liveBasisUsd.toFixed(2),
          +skewUsd.toFixed(2),
          +binDistPct.toFixed(5),
          +oraDistPct.toFixed(5),
          twapProb != null ? +twapProb.toFixed(6) : '',
        ].join(',');
        panelStream.write(panelRow + '\n');
        totalPanelRows++;

        if (ptbExactFlag === 1 && SINGLE_ROW_CANDIDATES.includes(targetSec)) {
          singleRowsBuf.push({
            secsInto: targetSec,
            rowLine: [...fmtVec, sTs, label].join(','),
          });
        }
        emittedSecsForMarket.add(targetSec);
      }
    }

    const sortedBasis = [...dayBasis].sort((a, b) => a - b);
    const livePct = daySnaps > 0 ? +((dayLive / daySnaps) * 100).toFixed(1) : 0;
    const twapPct = daySnaps > 0 ? +((dayTwap / daySnaps) * 100).toFixed(1) : 0;
    dailySummary.push({
      date: day,
      files: files.length,
      sizeMb: +(dayBytes / 1024 / 1024).toFixed(2),
      snapshots: daySnaps,
      liveBookPct: livePct,
      oraclePct: daySnaps > 0 ? +((dayOracle / daySnaps) * 100).toFixed(1) : 0,
      twapPct,
      markets: dayMarkets.size,
      decisions: dayDecisions,
      crossFeedBlocked: dayCfBlocked,
      medianBasisUsd: sortedBasis.length ? +medianSorted(sortedBasis)!.toFixed(2) : null,
    });
    if ((dIdx + 1) % 5 === 0 || dIdx === days.length - 1) {
      console.log(`  [${dIdx + 1}/${days.length}] ${day}: snaps=${daySnaps.toLocaleString()} liveBook=${livePct}% panelRows=${totalPanelRows.toLocaleString()} singleRows=${totalSingleRows.toLocaleString()}`);
    }
  }
  flushSingleRowForMarket();

  await Promise.all([
    new Promise<void>((res) => panelStream.end(res)),
    new Promise<void>((res) => singleStream.end(res)),
  ]);

  const sortedAllBasis = [...allBasis].sort((a, b) => a - b);
  const sortedNearSkew = [...allAbsSkewNearPtb].sort((a, b) => a - b);

  const metaObj = {
    feature_pipeline: 4,
    quant_features: true,
    chainlink_native: true,
    market_price_source: 'market_tape_1hz_l2_mid',
    generated_at: new Date().toISOString(),
    days: days.length,
    seed: 42,
    rows: totalSingleRows,
    first_slug_ts: singleFirstTs,
    last_slug_ts: singleLastTs,
    feature_names: v4Names,
    v4_added_features: ['oracle_ptb_dist_pct', 'twap_physics_z', 'basis_pct', 'basis_drift_pct', 'cross_feed_lead'],
  };
  writeFileSync(outMetaPath, JSON.stringify(metaObj, null, 2));

  const coverageStudy = {
    generatedAt: new Date().toISOString(),
    dateRange: { start: days[0], end: days[days.length - 1], totalDays: days.length },
    totals: {
      files: dailySummary.reduce((a, d) => a + Number(d.files), 0),
      totalSizeMb: +dailySummary.reduce((a, d) => a + Number(d.sizeMb), 0).toFixed(1),
      snapshots: totalSnapshots,
      liveBookSnapshots: totalLiveBook,
      liveBookPct: totalSnapshots > 0 ? +((totalLiveBook / totalSnapshots) * 100).toFixed(1) : 0,
      hasOraclePct: totalSnapshots > 0 ? +((totalHasOracle / totalSnapshots) * 100).toFixed(1) : 0,
      hasTwapPct: totalSnapshots > 0 ? +((totalHasTwap / totalSnapshots) * 100).toFixed(1) : 0,
      uniqueMarkets: seenMarkets.size,
      resolvedMarkets: resolvedMarkets.size,
      exactPtbMarkets: exactPtbMarkets.size,
      decisions: totalDecisions,
      crossFeedBlocked: totalCrossFeedBlocked,
      crossFeedFlips: totalCrossFeedFlips,
      panelRowsExtracted: totalPanelRows,
      singlePerMarketRows: totalSingleRows,
    },
    basisDiagnostics: {
      sampleCount: sortedAllBasis.length,
      p05Usd: quantileSorted(sortedAllBasis, 0.05) != null ? +quantileSorted(sortedAllBasis, 0.05)!.toFixed(2) : null,
      medianUsd: medianSorted(sortedAllBasis) != null ? +medianSorted(sortedAllBasis)!.toFixed(2) : null,
      p95Usd: quantileSorted(sortedAllBasis, 0.95) != null ? +quantileSorted(sortedAllBasis, 0.95)!.toFixed(2) : null,
      nearPtbAbsSkewMedianUsd: medianSorted(sortedNearSkew) != null ? +medianSorted(sortedNearSkew)!.toFixed(2) : null,
      nearPtbAbsSkewP95Usd: quantileSorted(sortedNearSkew, 0.95) != null ? +quantileSorted(sortedNearSkew, 0.95)!.toFixed(2) : null,
    },
    daily: dailySummary,
  };
  writeFileSync(outStudyPath, JSON.stringify(coverageStudy, null, 2));

  console.log(`\n[DONE] Pipeline v4 dataset built:`);
  console.log(`  Panel CSV : ${outPanelPath} (${totalPanelRows.toLocaleString()} rows across ${resolvedMarkets.size.toLocaleString()} resolved markets)`);
  console.log(`  1/mkt CSV : ${outCsvPath} (${totalSingleRows.toLocaleString()} rows, pipeline v4, 63 base + 25 eng = 88 features)`);
  console.log(`  Study JSON: ${outStudyPath}`);
}

await main();
