/**
 * Native C11 Monte Carlo runner wrapper for `scripts/build-study-site.mjs`.
 *
 * Auto-compiles `scripts/study/mc_accel.c` with `gcc -O3 -pthread -lm` when
 * running large path counts (e.g. 1,000,000 paths on Linux VPS), and returns
 * `null` cleanly if no C compiler / binary is available so the caller falls
 * back to the pure-JS engine in `study-site/mc-engine.js`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MC_DEFAULT_PATHS,
  MC_HORIZONS,
  MC_FAN_STEPS,
  computeAdaptiveStats,
  makeSeed,
} from '../../study-site/mc-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, 'mc_accel.c');
const BIN_NAME = process.platform === 'win32' ? 'mc_accel.exe' : '.mc-accel';

const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

function isUpToDate(binPath, srcMtimeMs) {
  try {
    const st = fs.statSync(binPath);
    return st.isFile() && st.size > 0 && st.mtimeMs >= srcMtimeMs;
  } catch {
    return false;
  }
}

export function resolveNativeMcBinary() {
  if (!fs.existsSync(SRC_PATH)) return null;
  const srcMtimeMs = fs.statSync(SRC_PATH).mtimeMs;

  // Never place compiled binaries inside webroot (outDir); use repo scripts/study or os.tmpdir().
  const candidates = [
    path.join(HERE, BIN_NAME),
    path.join(os.tmpdir(), `poly15-${BIN_NAME.replace(/^\./, '')}`),
  ];

  for (const binPath of candidates) {
    if (isUpToDate(binPath, srcMtimeMs)) return binPath;
  }

  for (const binPath of candidates) {
    try {
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      execFileSync('gcc', ['-O3', '-pthread', '-Wall', '-Wextra', SRC_PATH, '-o', binPath, '-lm'], {
        stdio: 'pipe',
        timeout: 30_000,
      });
      if (isUpToDate(binPath, srcMtimeMs)) return binPath;
    } catch {
      // Try next writable location (e.g. ProtectSystem=strict makes repo read-only)
    }
  }
  return null;
}

function buildScenarioSpec(cfg) {
  const pool = cfg.tradePool;
  const nSamples = pool.length;
  let wins = 0;
  let sumCost = 0;
  let sumPrice = 0;
  const allPnl = [];
  const allRet = [];
  const winPnlList = [];
  const lossPnlList = [];

  for (let i = 0; i < nSamples; i++) {
    const [pnl, cost, price, won] = pool[i];
    allPnl.push(pnl);
    allRet.push(Math.max(-1, cost > 0 ? pnl / cost : pnl / 3.15));
    sumCost += cost;
    sumPrice += price;
    if (won) {
      wins++;
      winPnlList.push(Math.max(0.01, pnl));
    } else {
      lossPnlList.push(-Math.max(0.01, Math.abs(pnl)));
    }
  }

  const avgCost = sumCost / nSamples;
  const avgPrice = sumPrice / nSamples;
  if (winPnlList.length === 0) winPnlList.push(r2((avgCost * (1 - avgPrice)) / avgPrice));
  if (lossPnlList.length === 0) lossPnlList.push(-r2(avgCost));

  const extraCost = Number(cfg.extraCostUsd) || 0;
  const winArr = winPnlList.map((v) => v - extraCost);
  const lossArr = lossPnlList.map((v) => v - extraCost);

  const bayesianAlpha = Number(cfg.bayesianAlpha) || (wins + 12);
  const bayesianBeta = Number(cfg.bayesianBeta) || (nSamples - wins + 8);
  const riskPct = clamp(Number(cfg.riskPct) || 0.03, 0.002, 0.25);
  const minBetUsd = clamp(Number(cfg.minBetUsd) || 3.0, 0.25, 100);
  const maxBetUsd = Math.max(minBetUsd, Number(cfg.maxBetUsd) || 250);
  const empWr = wins / nSamples;
  const wrShiftPp = Number(cfg.wrShiftPp) || 0;
  const pStress = clamp(empWr + wrShiftPp / 100, 0.05, 0.99);
  const stopFloor = cfg.startBankroll >= minBetUsd ? Math.min(minBetUsd * 0.9, avgCost * 0.65) : 0.5;
  const compStopFloor = minBetUsd;
  const modeCode = cfg.mode === 'bayesian' ? 1 : cfg.mode === 'compounding' ? 2 : cfg.mode === 'stress' ? 3 : 0;
  const assumedWrPct = cfg.mode === 'bayesian'
    ? r2((bayesianAlpha / (bayesianAlpha + bayesianBeta)) * 100)
    : cfg.mode === 'stress'
      ? r2(pStress * 100)
      : r2(empWr * 100);

  return {
    meta: {
      id: cfg.id,
      label: cfg.label,
      description: cfg.description,
      mode: cfg.mode,
      startBankroll: r2(cfg.startBankroll),
      sampleTrades: nSamples,
      assumedWrPct,
      riskPct: cfg.mode === 'compounding' ? r2(riskPct * 100) : null,
      maxBetUsd: cfg.mode === 'compounding' ? r2(maxBetUsd) : null,
    },
    wire: [
      `${cfg.id} ${modeCode} ${cfg.seed | 0} ${bayesianAlpha} ${bayesianBeta} ${riskPct} ${minBetUsd} ${maxBetUsd} ${pStress} ${stopFloor} ${compStopFloor}`,
      `${allPnl.length} ${allPnl.join(' ')}`,
      `${allRet.length} ${allRet.join(' ')}`,
      `${winArr.length} ${winArr.join(' ')}`,
      `${lossArr.length} ${lossArr.join(' ')}`,
    ].join('\n'),
  };
}

/**
 * Run the full 5-scenario Monte Carlo bundle via the compiled C11 accelerator.
 * Returns `null` if unavailable so caller can fall back to pure JS.
 */
export function buildMonteCarloBundleNative(trades, opts = {}) {
  const validTrades = (Array.isArray(trades) ? trades : []).filter(
    (t) => t && typeof t.pnl === 'number' && Number.isFinite(t.pnl),
  );
  if (validTrades.length === 0) return null;

  const binPath = resolveNativeMcBinary();
  if (!binPath) return null;

  const generatedAt = opts.generatedAt || new Date().toISOString();
  const nPaths = Math.max(10, Math.min(1_000_000, Math.round(Number(opts.nPaths) || MC_DEFAULT_PATHS)));
  const stats = computeAdaptiveStats(validTrades);
  const currentBankroll = Number.isFinite(Number(opts.startBankroll)) && Number(opts.startBankroll) > 0
    ? r2(Number(opts.startBankroll))
    : 100;

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

  const horizons = [...MC_HORIZONS].sort((a, b) => a - b);
  const fanSteps = [...new Set([0, ...MC_FAN_STEPS, ...horizons])].sort((a, b) => a - b);
  const maxH = horizons[horizons.length - 1];

  const scenarioConfigs = [
    {
      id: 'live_bayesian_adaptive',
      label: `1. Bayesian Adaptive Posterior (${stats.nTrades} tr · ${stats.bayesianWrPct}% post. WR · Fixed)`,
      description: `Beta(${stats.bayesianAlpha}, ${stats.bayesianBeta}) parameter-uncertain posterior around 60% prior. Prevents over-optimism when live sample (${stats.nTrades} trades) is still growing.`,
      mode: 'bayesian',
      tradePool,
      startBankroll: currentBankroll,
      bayesianAlpha: stats.bayesianAlpha,
      bayesianBeta: stats.bayesianBeta,
      seed: makeSeed(stats.nTrades, currentBankroll, 101),
    },
    {
      id: 'live_bootstrap_fixed',
      label: `2. Live Empirical Bootstrap (${stats.wins}W–${stats.losses}L · ${stats.empiricalWrPct}% WR · Fixed)`,
      description: `Direct i.i.d. resampling from all ${stats.nTrades} settled live PnL outcomes (~$${stats.avgCostUsd}/trade) starting at $${currentBankroll}.`,
      mode: 'bootstrap',
      tradePool,
      startBankroll: currentBankroll,
      seed: makeSeed(stats.nTrades, currentBankroll, 202),
    },
    {
      id: 'live_compounding_kelly',
      label: `3. Adaptive Compounding (3% Bankroll · Min $3 / Cap $250)`,
      description: `Sizes each trade dynamically at 3% of simulated bankroll (quarter-Kelly style) capped at $250/trade using empirical return/cost distribution.`,
      mode: 'compounding',
      tradePool,
      startBankroll: currentBankroll,
      riskPct: 0.03,
      minBetUsd: 3.0,
      maxBetUsd: 250.0,
      seed: makeSeed(stats.nTrades, currentBankroll, 303),
    },
    {
      id: 'live_recent_regime',
      label: `4. Recent Regime Adaptive (Last ${recentCount} tr · ${recentStats.empiricalWrPct}% WR · Fixed)`,
      description: `Weights only the most recent ${recentCount} settled trades (${recentStats.wins}W–${recentStats.losses}L, EV ${recentStats.evPerTradeUsd >= 0 ? '+' : ''}$${recentStats.evPerTradeUsd}/tr) to reflect current market conditions & filters.`,
      mode: 'bootstrap',
      tradePool: recentPool,
      startBankroll: currentBankroll,
      seed: makeSeed(stats.nTrades, currentBankroll, 404),
    },
    {
      id: 'live_stress_test',
      label: `5. Stress Test (-3.0pp WR & -$0.05/tr Slippage · Fixed)`,
      description: `Degrades observed win rate by -3.0pp (to ${clamp(stats.empiricalWrPct - 3.0, 5, 99).toFixed(2)}%) and adds $0.05/trade adverse slippage across all trades.`,
      mode: 'stress',
      tradePool,
      startBankroll: currentBankroll,
      wrShiftPp: -3.0,
      extraCostUsd: 0.05,
      seed: makeSeed(stats.nTrades, currentBankroll, 505),
    },
  ];

  const specs = scenarioConfigs.map(buildScenarioSpec);
  const cpuCount = Math.max(1, os.cpus()?.length || 1);
  const nThreads = Math.max(1, Math.min(8, Number(opts.threads) || cpuCount));

  const stdinPayload = [
    `${currentBankroll} ${nPaths} ${nThreads}`,
    `${fanSteps.length} ${fanSteps.join(' ')}`,
    `${horizons.length} ${horizons.join(' ')}`,
    `${specs.length}`,
    ...specs.map((s) => s.wire),
  ].join('\n') + '\n';

  let stdout;
  try {
    stdout = execFileSync(binPath, [], {
      input: stdinPayload,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== specs.length) return null;

  const scenarios = specs.map((sp, i) => ({
    ...sp.meta,
    nPaths,
    fanSteps,
    fan: parsed[i].fan,
    samplePaths: parsed[i].samplePaths,
    horizons: parsed[i].horizons,
    summaryMaxH: maxH,
  }));

  return {
    available: true,
    generatedAt,
    engine: 'native-c11',
    nPaths,
    defaultScenarioId: 'live_bayesian_adaptive',
    defaultHorizon: 5000,
    currentBankroll,
    horizons,
    fanSteps,
    stats,
    tradePool,
    scenarios,
  };
}
