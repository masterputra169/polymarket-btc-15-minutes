/**
 * Shared Adaptive Monte Carlo Simulation Engine (Pure ES Module).
 *
 * Zero external dependencies — imported identically by Node.js build scripts
 * (`scripts/build-study-site.mjs`) and the browser portal (`study-site/app.js`).
 */

export const MC_DEFAULT_PATHS = 10000;
export const MC_HORIZONS = [100, 250, 500, 1000, 2000, 5000, 10000];
export const MC_FAN_STEPS = [
  0, 25, 50, 75, 100, 150, 200, 250, 350, 500, 750,
  1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000,
];

/** Deterministic non-zero 32-bit signed PRNG seed from bot state & scenario salt. */
export function makeSeed(nTrades = 0, bankroll = 100, salt = 0) {
  let h = 2166136261 >>> 0;
  const nums = [
    Math.round(Number(nTrades) || 0),
    Math.round((Number(bankroll) || 0) * 100),
    Math.round(Number(salt) || 0),
  ];
  for (const n of nums) {
    h ^= n & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= (n >>> 16) & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const signed = (h ^ 0x9e3779b9) | 0;
  return signed === 0 ? 2463534242 | 0 : signed;
}

/** Marsaglia-Tsang Gamma sampler (handles shape < 1 cleanly). */
export function sampleGamma(shape, nextFloat) {
  if (!(shape > 0)) return 0;
  if (shape < 1) {
    let u = nextFloat();
    if (u <= 1e-12) u = 1e-12;
    return sampleGamma(shape + 1, nextFloat) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let u1 = nextFloat();
    let u2 = nextFloat();
    if (u1 <= 1e-12) u1 = 1e-12;
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const v = 1 + c * z;
    if (v <= 0) continue;
    const v3 = v * v * v;
    let u = nextFloat();
    if (u <= 1e-12) u = 1e-12;
    if (u < 1 - 0.0331 * z * z * z * z) return d * v3;
    if (Math.log(u) < 0.5 * z * z + d * (1 - v3 + Math.log(v3))) return d * v3;
  }
}

/** Sample Beta(alpha, beta) via ratio of two independent Gamma draws. */
export function sampleBeta(alpha, beta, nextFloat) {
  const gx = sampleGamma(alpha, nextFloat);
  const gy = sampleGamma(beta, nextFloat);
  const sum = gx + gy;
  return sum > 0 ? gx / sum : 0.5;
}

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function normalizePool(rawPool) {
  const out = [];
  if (!Array.isArray(rawPool)) return out;
  for (const item of rawPool) {
    if (Array.isArray(item)) {
      const pnl = Number(item[0]);
      if (!Number.isFinite(pnl)) continue;
      const costRaw = Number(item[1]);
      const priceRaw = Number(item[2]);
      const won = item[3] != null ? Boolean(item[3]) : pnl > 0;
      const isMaker = item[4] != null ? Boolean(item[4]) : false;
      out.push({
        pnl,
        cost: Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 3.15,
        price: Number.isFinite(priceRaw) && priceRaw > 0 && priceRaw < 1 ? priceRaw : 0.62,
        won,
        isMaker,
      });
    } else if (item && typeof item === 'object') {
      const pnl = Number(item.pnl);
      if (!Number.isFinite(pnl)) continue;
      const costRaw = Number(item.cost);
      const priceRaw = Number(item.price ?? item.tokenPrice);
      const outcome = item.outcome;
      const won = typeof item.won === 'boolean'
        ? item.won
        : outcome === 'WIN'
          ? true
          : outcome === 'LOSS'
            ? false
            : pnl > 0;
      out.push({
        pnl,
        cost: Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 3.15,
        price: Number.isFinite(priceRaw) && priceRaw > 0 && priceRaw < 1 ? priceRaw : 0.62,
        won,
        isMaker: Boolean(item.isMaker),
      });
    }
  }
  return out;
}

/**
 * Compute adaptive empirical + Bayesian posterior statistics from settled trades.
 */
export function computeAdaptiveStats(trades) {
  const valid = (Array.isArray(trades) ? trades : []).filter(
    (t) => t && typeof t.pnl === 'number' && Number.isFinite(t.pnl),
  );
  const nTrades = valid.length;
  const priorAlpha = 12; // 60.0% conservative pseudo-20-trade Beta prior
  const priorBeta = 8;

  if (nTrades === 0) {
    return {
      nTrades: 0,
      wins: 0,
      losses: 0,
      empiricalWrPct: null,
      wrCiLoPct: null,
      wrCiHiPct: null,
      priorAlpha,
      priorBeta,
      bayesianAlpha: priorAlpha,
      bayesianBeta: priorBeta,
      bayesianWrPct: 60.0,
      avgCostUsd: 3.15,
      avgWinUsd: 1.85,
      avgLossUsd: 3.15,
      avgEntryCents: 62.0,
      evPerTradeUsd: 0,
      evRoiPct: 0,
      fullKellyPct: 0,
      halfKellyPct: 0,
      makerSharePct: null,
      tradesPerDay: null,
    };
  }

  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLossAbs = 0;
  let sumPnl = 0;
  let sumCost = 0;
  let costCount = 0;
  let sumPrice = 0;
  let priceCount = 0;
  let makerKnown = 0;
  let makerYes = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const t of valid) {
    const won = t.outcome === 'WIN' || (t.outcome !== 'LOSS' && t.pnl > 0);
    if (won) {
      wins++;
      sumWin += Math.max(0, t.pnl);
    } else {
      losses++;
      sumLossAbs += Math.abs(Math.min(0, t.pnl));
    }
    sumPnl += t.pnl;
    const c = Number(t.cost);
    if (Number.isFinite(c) && c > 0) {
      sumCost += c;
      costCount++;
    }
    const px = Number(t.tokenPrice ?? t.price);
    if (Number.isFinite(px) && px > 0 && px < 1) {
      sumPrice += px;
      priceCount++;
    }
    if (typeof t.isMaker === 'boolean') {
      makerKnown++;
      if (t.isMaker) makerYes++;
    }
    const ts = Number(t.exitedAt ?? t.enteredAt ?? t.ts);
    if (Number.isFinite(ts) && ts > 0) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
  }

  const pEmp = wins / nTrades;
  const empiricalWrPct = r2(pEmp * 100);

  // Wilson score 95% confidence interval
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / nTrades;
  const center = pEmp + z2 / (2 * nTrades);
  const half = z * Math.sqrt((pEmp * (1 - pEmp) + z2 / (4 * nTrades)) / nTrades);
  const wrCiLoPct = r2(clamp((center - half) / denom, 0, 1) * 100);
  const wrCiHiPct = r2(clamp((center + half) / denom, 0, 1) * 100);

  const bayesianAlpha = wins + priorAlpha;
  const bayesianBeta = losses + priorBeta;
  const bayesianWrPct = r2((bayesianAlpha / (bayesianAlpha + bayesianBeta)) * 100);

  const avgCostUsd = r2(costCount > 0 ? sumCost / costCount : 3.15);
  const avgEntryProb = priceCount > 0 ? sumPrice / priceCount : 0.62;
  const avgEntryCents = r2(avgEntryProb * 100);
  const avgWinUsd = r2(wins > 0 ? sumWin / wins : avgCostUsd * (1 - avgEntryProb) / avgEntryProb);
  const avgLossUsd = r2(losses > 0 ? sumLossAbs / losses : avgCostUsd);
  const evPerTradeUsd = +(sumPnl / nTrades).toFixed(4);
  const evRoiPct = avgCostUsd > 0 ? r2((evPerTradeUsd / avgCostUsd) * 100) : 0;

  const winLossRatio = avgLossUsd > 0 ? avgWinUsd / avgLossUsd : 0;
  const rawKelly = winLossRatio > 0 ? pEmp - (1 - pEmp) / winLossRatio : 0;
  const fullKellyPct = r2(clamp(rawKelly * 100, 0, 100));
  const halfKellyPct = r2(fullKellyPct * 0.5);

  const makerSharePct = makerKnown > 0 ? r2((makerYes / makerKnown) * 100) : null;
  const spanMs = maxTs > minTs ? maxTs - minTs : 0;
  const tradesPerDay = nTrades >= 2 && spanMs >= 3_600_000
    ? r2(nTrades / (spanMs / 86_400_000))
    : null;

  return {
    nTrades,
    wins,
    losses,
    empiricalWrPct,
    wrCiLoPct,
    wrCiHiPct,
    priorAlpha,
    priorBeta,
    bayesianAlpha,
    bayesianBeta,
    bayesianWrPct,
    avgCostUsd,
    avgWinUsd,
    avgLossUsd,
    avgEntryCents,
    evPerTradeUsd,
    evRoiPct,
    fullKellyPct,
    halfKellyPct,
    makerSharePct,
    tradesPerDay,
  };
}

function summarizeArray(arr, startBankroll, nPaths) {
  const sorted = Float64Array.from(arr);
  sorted.sort();
  const q = (pct) => sorted[Math.min(nPaths - 1, Math.max(0, Math.floor((pct / 100) * (nPaths - 1))))];

  let sum = 0;
  let cntProfit = 0;
  let cntDouble = 0;
  let cntFiveX = 0;
  let cntRuinHalf = 0;
  let cntBankrupt = 0;
  for (let i = 0; i < nPaths; i++) {
    const v = sorted[i];
    sum += v;
    if (v > startBankroll + 1e-9) cntProfit++;
    if (v >= startBankroll * 2) cntDouble++;
    if (v >= startBankroll * 5) cntFiveX++;
    if (v <= startBankroll * 0.5) cntRuinHalf++;
    if (v <= Math.min(2.5, startBankroll * 0.1)) cntBankrupt++;
  }

  const minV = sorted[0];
  const maxV = sorted[nPaths - 1];
  const lo = minV;
  const hi = maxV - minV < 1e-6 ? minV + 1 : maxV;
  const nBins = 22;
  const step = (hi - lo) / nBins;
  const finalHistCounts = new Array(nBins).fill(0);
  const finalHistEdges = new Array(nBins + 1);
  for (let b = 0; b <= nBins; b++) finalHistEdges[b] = r2(lo + b * step);

  for (let i = 0; i < nPaths; i++) {
    let bin = Math.floor((sorted[i] - lo) / step);
    if (bin < 0) bin = 0;
    else if (bin >= nBins) bin = nBins - 1;
    finalHistCounts[bin]++;
  }

  const p50 = r2(q(50));
  const mean = r2(sum / nPaths);
  const base = startBankroll > 0 ? startBankroll : 1;
  const tailCount = Math.max(1, Math.ceil(0.05 * nPaths));
  let tailSum = 0;
  for (let i = 0; i < tailCount; i++) tailSum += sorted[i];
  const cvar95Final = r2(tailSum / tailCount);

  return {
    p5: r2(q(5)),
    cvar95Final,
    p10: r2(q(10)),
    p25: r2(q(25)),
    p50,
    p75: r2(q(75)),
    p90: r2(q(90)),
    p95: r2(q(95)),
    mean,
    min: r2(minV),
    max: r2(maxV),
    medianReturnPct: r2(((p50 - startBankroll) / base) * 100),
    meanReturnPct: r2(((mean - startBankroll) / base) * 100),
    probProfitPct: r2((cntProfit / nPaths) * 100),
    probDoublePct: r2((cntDouble / nPaths) * 100),
    probFiveXPct: r2((cntFiveX / nPaths) * 100),
    probRuinHalfPct: r2((cntRuinHalf / nPaths) * 100),
    probBankruptPct: r2((cntBankrupt / nPaths) * 100),
    finalHist: { counts: finalHistCounts, edges: finalHistEdges },
  };
}

function summarizeDrawdowns(ddArr, nPaths) {
  const sorted = Float64Array.from(ddArr);
  sorted.sort();
  const q = (pct) => sorted[Math.min(nPaths - 1, Math.max(0, Math.floor((pct / 100) * (nPaths - 1))))];

  let cntOver25 = 0;
  let cntOver50 = 0;
  const nBins = 20;
  const ddHistCounts = new Array(nBins).fill(0);
  const ddHistEdges = new Array(nBins + 1);
  for (let b = 0; b <= nBins; b++) ddHistEdges[b] = b * 5;

  for (let i = 0; i < nPaths; i++) {
    const ddPct = sorted[i] * 100;
    if (ddPct >= 25) cntOver25++;
    if (ddPct >= 50) cntOver50++;
    let bin = Math.floor(ddPct / 5);
    if (bin < 0) bin = 0;
    else if (bin >= nBins) bin = nBins - 1;
    ddHistCounts[bin]++;
  }

  const tailStart = Math.max(0, Math.min(nPaths - 1, Math.floor(0.95 * nPaths)));
  let tailDdSum = 0;
  for (let i = tailStart; i < nPaths; i++) tailDdSum += sorted[i];
  const cvar95MaxDdPct = r2((tailDdSum / Math.max(1, nPaths - tailStart)) * 100);

  return {
    medianMaxDdPct: r2(q(50) * 100),
    p95MaxDdPct: r2(q(95) * 100),
    cvar95MaxDdPct,
    p99MaxDdPct: r2(q(99) * 100),
    probDdOver25Pct: r2((cntOver25 / nPaths) * 100),
    probDdOver50Pct: r2((cntOver50 / nPaths) * 100),
    ddHist: { counts: ddHistCounts, edges: ddHistEdges },
  };
}

/**
 * Run a 10,000-trial (configurable) Monte Carlo simulation across multi-trade horizons.
 */
export function runMonteCarloScenario(config) {
  const pool = normalizePool(config?.tradePool);
  if (pool.length === 0) {
    throw new Error('runMonteCarloScenario requires at least 1 settled trade in tradePool');
  }

  const mode = config.mode || 'bootstrap';
  const startBankroll = Math.max(1, Number(config.startBankroll) || 100);
  const nPaths = Math.max(10, Math.min(50000, Math.round(Number(config.nPaths) || MC_DEFAULT_PATHS)));
  const horizons = [...new Set((config.horizons || MC_HORIZONS).map((h) => Math.max(1, Math.round(h))))].sort((a, b) => a - b);
  const fanSteps = [...new Set([0, ...(config.fanSteps || MC_FAN_STEPS).map((s) => Math.max(0, Math.round(s))), ...horizons])].sort((a, b) => a - b);

  // Build union checkpoints covering every fan step and every horizon
  const checkpoints = [...new Set([...fanSteps.filter((s) => s > 0), ...horizons])].sort((a, b) => a - b);
  const fanIdxOfCheckpoint = checkpoints.map((c) => fanSteps.indexOf(c));
  const horizonSet = new Set(horizons);

  const nSamples = pool.length;
  let wins = 0;
  let sumCost = 0;
  let sumPrice = 0;
  const winPnlList = [];
  const lossPnlList = [];

  const allPnl = new Float64Array(nSamples);
  const allRet = new Float64Array(nSamples);

  for (let i = 0; i < nSamples; i++) {
    const t = pool[i];
    allPnl[i] = t.pnl;
    allRet[i] = Math.max(-1, t.cost > 0 ? t.pnl / t.cost : t.pnl / 3.15);
    sumCost += t.cost;
    sumPrice += t.price;
    if (t.won) {
      wins++;
      winPnlList.push(Math.max(0.01, t.pnl));
    } else {
      lossPnlList.push(-Math.max(0.01, Math.abs(t.pnl)));
    }
  }

  const avgCost = sumCost / nSamples;
  const avgPrice = sumPrice / nSamples;
  if (winPnlList.length === 0) winPnlList.push(r2(avgCost * (1 - avgPrice) / avgPrice));
  if (lossPnlList.length === 0) lossPnlList.push(-r2(avgCost));

  const extraCost = Number(config.extraCostUsd) || 0;
  const winArr = new Float64Array(winPnlList.map((v) => v - extraCost));
  const lossArr = new Float64Array(lossPnlList.map((v) => v - extraCost));
  const nWinArr = winArr.length;
  const nLossArr = lossArr.length;

  const bayesianAlpha = Number(config.bayesianAlpha) || (wins + 12);
  const bayesianBeta = Number(config.bayesianBeta) || (nSamples - wins + 8);
  const riskPct = clamp(Number(config.riskPct) || 0.03, 0.002, 0.25);
  const minBetUsd = clamp(Number(config.minBetUsd) || 3.0, 0.25, 100);
  const maxBetUsd = Math.max(minBetUsd, Number(config.maxBetUsd) || 250);
  const empWr = wins / nSamples;
  const wrShiftPp = Number(config.wrShiftPp) || 0;
  const pStress = clamp(empWr + wrShiftPp / 100, 0.05, 0.99);
  const pStressThresh = Math.floor(pStress * 4294967296);

  const stopFloor = startBankroll >= minBetUsd ? Math.min(minBetUsd * 0.9, avgCost * 0.65) : 0.5;
  const compStopFloor = minBetUsd;

  const stepVals = fanSteps.map(() => new Float64Array(nPaths));
  const horizonVals = {};
  const horizonDds = {};
  for (const h of horizons) {
    horizonVals[h] = new Float64Array(nPaths);
    horizonDds[h] = new Float64Array(nPaths);
  }

  const samplePathCount = 6;
  const sampleStepStride = Math.max(1, Math.floor(nPaths / samplePathCount));
  const samplePaths = Array.from({ length: samplePathCount }, () => new Array(fanSteps.length).fill(r2(startBankroll)));

  let x = (Number(config.seed) || makeSeed(nSamples, startBankroll, 7)) | 0;
  if (x === 0) x = 2463534242 | 0;

  const nextFloat = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) + 0.5) / 4294967296;
  };

  const modeCode = mode === 'bayesian' ? 1 : mode === 'compounding' ? 2 : mode === 'stress' ? 3 : 0;

  for (let p = 0; p < nPaths; p++) {
    let b = startBankroll;
    let peak = startBankroll;
    let maxDd = 0;
    let ddThresh = startBankroll;
    let pThresh = pStressThresh;

    if (modeCode === 1) {
      const pDraw = clamp(sampleBeta(bayesianAlpha, bayesianBeta, nextFloat), 0.05, 0.99);
      pThresh = Math.floor(pDraw * 4294967296);
    }

    stepVals[0][p] = b;
    const isSample = p % sampleStepStride === 0 && (p / sampleStepStride) < samplePathCount;
    const sampleIdx = isSample ? (p / sampleStepStride) | 0 : -1;

    let prevStep = 0;
    for (let ci = 0; ci < checkpoints.length; ci++) {
      const target = checkpoints[ci];
      const count = target - prevStep;

      if (modeCode === 0) {
        // Empirical fixed-size bootstrap with replacement
        for (let k = 0; k < count; k++) {
          if (b < stopFloor) { b = 0; break; }
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          b += allPnl[((x & 0xFFFF) * nSamples) >>> 16];
          if (b <= 0) {
            b = 0;
            maxDd = 1;
            ddThresh = 0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * (1 - maxDd);
          } else if (b < ddThresh) {
            maxDd = (peak - b) / peak;
            ddThresh = b;
          }
        }
      } else if (modeCode === 1 || modeCode === 3) {
        // Hierarchical Bayesian Beta-Binomial (mode 1) or Stress shifted WR (mode 3)
        for (let k = 0; k < count; k++) {
          if (b < stopFloor) { b = 0; break; }
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          const isWin = (x >>> 0) < pThresh;
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          if (isWin) {
            b += winArr[((x & 0xFFFF) * nWinArr) >>> 16];
          } else {
            b += lossArr[((x & 0xFFFF) * nLossArr) >>> 16];
          }
          if (b <= 0) {
            b = 0;
            maxDd = 1;
            ddThresh = 0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * (1 - maxDd);
          } else if (b < ddThresh) {
            maxDd = (peak - b) / peak;
            ddThresh = b;
          }
        }
      } else {
        // Adaptive fractional-Kelly compounding (% of bankroll, floor minBetUsd, cap maxBetUsd)
        for (let k = 0; k < count; k++) {
          if (b < compStopFloor) { b = 0; break; }
          let bet = b * riskPct;
          if (bet < minBetUsd) bet = minBetUsd;
          else if (bet > maxBetUsd) bet = maxBetUsd;
          if (bet > b) bet = b;
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
          b += bet * allRet[((x & 0xFFFF) * nSamples) >>> 16];
          if (b <= 0) {
            b = 0;
            maxDd = 1;
            ddThresh = 0;
            break;
          }
          if (b > peak) {
            peak = b;
            ddThresh = peak * (1 - maxDd);
          } else if (b < ddThresh) {
            maxDd = (peak - b) / peak;
            ddThresh = b;
          }
        }
      }

      const fIdx = fanIdxOfCheckpoint[ci];
      if (fIdx >= 0) {
        stepVals[fIdx][p] = b;
        if (sampleIdx >= 0) samplePaths[sampleIdx][fIdx] = r2(b);
      }
      if (horizonSet.has(target)) {
        horizonVals[target][p] = b;
        horizonDds[target][p] = maxDd;
      }
      prevStep = target;
    }
  }

  // Compute percentile envelope across fanSteps
  const fan = { p5: [], p10: [], p25: [], p50: [], p75: [], p90: [], p95: [] };
  for (let si = 0; si < fanSteps.length; si++) {
    const col = Float64Array.from(stepVals[si]);
    col.sort();
    const pick = (pct) => r2(col[Math.min(nPaths - 1, Math.max(0, Math.floor((pct / 100) * (nPaths - 1))))]);
    fan.p5.push(pick(5));
    fan.p10.push(pick(10));
    fan.p25.push(pick(25));
    fan.p50.push(pick(50));
    fan.p75.push(pick(75));
    fan.p90.push(pick(90));
    fan.p95.push(pick(95));
  }

  const horizonsOut = {};
  for (const h of horizons) {
    const valSummary = summarizeArray(horizonVals[h], startBankroll, nPaths);
    const ddSummary = summarizeDrawdowns(horizonDds[h], nPaths);
    horizonsOut[h] = { ...valSummary, ...ddSummary };
  }

  const maxH = horizons[horizons.length - 1];
  const winRateSummary = mode === 'bayesian'
    ? r2((bayesianAlpha / (bayesianAlpha + bayesianBeta)) * 100)
    : mode === 'stress'
      ? r2(pStress * 100)
      : r2(empWr * 100);

  return {
    id: config.id || `custom_${mode}`,
    label: config.label || mode,
    description: config.description || '',
    mode,
    startBankroll: r2(startBankroll),
    nPaths,
    sampleTrades: nSamples,
    assumedWrPct: winRateSummary,
    riskPct: mode === 'compounding' ? r2(riskPct * 100) : null,
    maxBetUsd: mode === 'compounding' ? r2(maxBetUsd) : null,
    fanSteps,
    fan,
    samplePaths,
    horizons: horizonsOut,
    summaryMaxH: maxH,
  };
}

/**
 * Build the complete live-adaptive Monte Carlo bundle from settled bot trades.
 */
export function buildMonteCarloBundle(trades, opts = {}) {
  const generatedAt = opts.generatedAt || new Date().toISOString();
  const nPaths = Math.max(10, Math.min(50000, Math.round(Number(opts.nPaths) || MC_DEFAULT_PATHS)));
  const validTrades = (Array.isArray(trades) ? trades : []).filter(
    (t) => t && typeof t.pnl === 'number' && Number.isFinite(t.pnl),
  );

  if (validTrades.length === 0) {
    return {
      available: false,
      reason: 'awaiting_settled_trades',
      generatedAt,
      nPaths,
      horizons: MC_HORIZONS,
      fanSteps: MC_FAN_STEPS,
      stats: computeAdaptiveStats([]),
      scenarios: [],
    };
  }

  const stats = computeAdaptiveStats(validTrades);
  const currentBankroll = Number.isFinite(Number(opts.startBankroll)) && Number(opts.startBankroll) > 0
    ? r2(Number(opts.startBankroll))
    : 100;

  // Compact numeric pool (zero IDs, keys, or secrets) for browser custom 10k re-runs
  const tradePool = validTrades.map((t) => {
    const cost = typeof t.cost === 'number' && Number.isFinite(t.cost) && t.cost > 0 ? t.cost : stats.avgCostUsd;
    const px = typeof t.tokenPrice === 'number' && Number.isFinite(t.tokenPrice) && t.tokenPrice > 0 && t.tokenPrice < 1
      ? t.tokenPrice
      : (stats.avgEntryCents ? stats.avgEntryCents / 100 : 0.62);
    const won = t.outcome === 'WIN' || (t.outcome !== 'LOSS' && t.pnl > 0);
    return [
      +t.pnl.toFixed(4),
      +cost.toFixed(4),
      +px.toFixed(4),
      won ? 1 : 0,
      t.isMaker ? 1 : 0,
    ];
  });

  const recentCount = Math.min(25, tradePool.length);
  const recentPool = tradePool.slice(-recentCount);
  const recentStats = computeAdaptiveStats(validTrades.slice(-recentCount));

  const scenarios = [
    runMonteCarloScenario({
      id: 'live_bayesian_adaptive',
      label: `1. Bayesian Adaptive Posterior (${stats.nTrades} tr · ${stats.bayesianWrPct}% post. WR · Fixed)`,
      description: `Beta(${stats.bayesianAlpha}, ${stats.bayesianBeta}) parameter-uncertain posterior around 60% prior. Prevents over-optimism when live sample (${stats.nTrades} trades) is still growing.`,
      mode: 'bayesian',
      tradePool,
      startBankroll: currentBankroll,
      nPaths,
      bayesianAlpha: stats.bayesianAlpha,
      bayesianBeta: stats.bayesianBeta,
      seed: makeSeed(stats.nTrades, currentBankroll, 101),
    }),
    runMonteCarloScenario({
      id: 'live_bootstrap_fixed',
      label: `2. Live Empirical Bootstrap (${stats.wins}W–${stats.losses}L · ${stats.empiricalWrPct}% WR · Fixed)`,
      description: `Direct i.i.d. resampling from all ${stats.nTrades} settled live PnL outcomes (~$${stats.avgCostUsd}/trade) starting at $${currentBankroll}.`,
      mode: 'bootstrap',
      tradePool,
      startBankroll: currentBankroll,
      nPaths,
      seed: makeSeed(stats.nTrades, currentBankroll, 202),
    }),
    runMonteCarloScenario({
      id: 'live_compounding_kelly',
      label: `3. Adaptive Compounding (3% Bankroll · Min $3 / Cap $250)`,
      description: `Sizes each trade dynamically at 3% of simulated bankroll (quarter-Kelly style) capped at $250/trade using empirical return/cost distribution.`,
      mode: 'compounding',
      tradePool,
      startBankroll: currentBankroll,
      nPaths,
      riskPct: 0.03,
      minBetUsd: 3.0,
      maxBetUsd: 250.0,
      seed: makeSeed(stats.nTrades, currentBankroll, 303),
    }),
    runMonteCarloScenario({
      id: 'live_recent_regime',
      label: `4. Recent Regime Adaptive (Last ${recentCount} tr · ${recentStats.empiricalWrPct}% WR · Fixed)`,
      description: `Weights only the most recent ${recentCount} settled trades (${recentStats.wins}W–${recentStats.losses}L, EV ${recentStats.evPerTradeUsd >= 0 ? '+' : ''}$${recentStats.evPerTradeUsd}/tr) to reflect current market conditions & filters.`,
      mode: 'bootstrap',
      tradePool: recentPool,
      startBankroll: currentBankroll,
      nPaths,
      seed: makeSeed(stats.nTrades, currentBankroll, 404),
    }),
    runMonteCarloScenario({
      id: 'live_stress_test',
      label: `5. Stress Test (-3.0pp WR & -$0.05/tr Slippage · Fixed)`,
      description: `Degrades observed win rate by -3.0pp (to ${(clamp(stats.empiricalWrPct - 3.0, 5, 99)).toFixed(2)}%) and adds $0.05/trade adverse slippage across all trades.`,
      mode: 'stress',
      tradePool,
      startBankroll: currentBankroll,
      nPaths,
      wrShiftPp: -3.0,
      extraCostUsd: 0.05,
      seed: makeSeed(stats.nTrades, currentBankroll, 505),
    }),
  ];

  return {
    available: true,
    generatedAt,
    nPaths,
    defaultScenarioId: 'live_bayesian_adaptive',
    defaultHorizon: 5000,
    currentBankroll,
    horizons: MC_HORIZONS,
    fanSteps: MC_FAN_STEPS,
    stats,
    tradePool,
    scenarios,
  };
}
