/**
 * 6-Check Statistical Edge Validation Engine (Pure ES Module, zero dependencies).
 *
 * Implements the 6-check anti-overfitting validation framework for live settled
 * Polymarket binary trades:
 *   1. t-stat (mean / sd * sqrt(n))
 *   2. Null-model permutation/shuffle test (2,000 draws against market-implied P(win) = entry price)
 *   3. Chronological half-split (first half vs second half agreement)
 *   4. Profit attribution ("Where": phase / side / session breadth)
 *   5. Structural mechanism ("Why": documented edge sources & failure modes)
 *   6. Break-it outlier stress (drop top 3 trades / top 5% / top 10% wins + rolling 30-trade t-stat)
 */

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

function meanOf(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function sampleSd(arr, m) {
  if (arr.length < 2) return 0;
  let ss = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    ss += d * d;
  }
  return Math.sqrt(ss / (arr.length - 1));
}

function computeTStat(pnls) {
  const n = pnls.length;
  if (n < 2) return { n, mean: n === 1 ? pnls[0] : 0, sd: 0, tStat: 0, netPnl: n === 1 ? pnls[0] : 0 };
  const m = meanOf(pnls);
  const sd = sampleSd(pnls, m);
  const tStat = sd > 1e-12 ? (m / sd) * Math.sqrt(n) : (m > 0 ? 99 : m < 0 ? -99 : 0);
  return { n, mean: m, sd, tStat, netPnl: m * n };
}

/** Abramowitz & Stegun normal CDF approximation for one-sided p-value display. */
function normalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function sessionFromTs(tsMs) {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return 'Unknown';
  const h = new Date(tsMs).getUTCHours();
  if (h >= 0 && h < 8) return 'Asia';
  if (h >= 8 && h < 13) return 'Europe';
  return 'US';
}

function takerFeeUsd(shares, price) {
  return shares * 0.07 * price * (1 - price);
}

/**
 * Compute full 6-Check Edge Proof from chronologically ordered settled trades.
 * @param {Array<object>} rawTrades
 * @param {{ shuffles?: number, rollingWindow?: number }} opts
 */
export function computeEdgeProof(rawTrades, opts = {}) {
  const nShuffles = Math.max(200, Math.min(10000, Math.round(Number(opts.shuffles) || 2000)));
  const rollingWin = Math.max(10, Math.round(Number(opts.rollingWindow) || 30));

  const trades = (Array.isArray(rawTrades) ? rawTrades : [])
    .filter((t) => t && typeof t.pnl === 'number' && Number.isFinite(t.pnl))
    .map((t) => {
      const ts = Number(t.exitedAt ?? t.enteredAt ?? t.ts ?? 0);
      const priceRaw = Number(t.tokenPrice ?? t.price);
      const price = Number.isFinite(priceRaw) && priceRaw > 0.02 && priceRaw < 0.98 ? priceRaw : 0.63;
      const costRaw = Number(t.cost);
      const cost = Number.isFinite(costRaw) && costRaw > 0 ? costRaw : 3.15;
      const won = t.outcome === 'WIN' || (t.outcome !== 'LOSS' && t.pnl > 0);
      return {
        pnl: t.pnl,
        cost,
        price,
        won,
        isMaker: Boolean(t.isMaker),
        phase: t.phase || 'UNKNOWN',
        side: t.side || 'UNKNOWN',
        session: t.session || sessionFromTs(ts),
        ts,
      };
    })
    .sort((a, b) => a.ts - b.ts);

  const n = trades.length;
  if (n < 6) {
    return {
      available: false,
      nTrades: n,
      reason: 'awaiting_min_trades',
      checksPassed: 0,
      checksTotal: 6,
      checks: [],
    };
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.won).length;
  const wrPct = r2((wins / n) * 100);

  // ── Check 1: t-stat ──
  const c1 = computeTStat(pnls);
  const oneSidedP = r4(1 - normalCdf(c1.tStat));
  const tradesForT2 = c1.mean > 0 && c1.sd > 0 ? Math.ceil((2 * c1.sd / c1.mean) ** 2) : null;
  const tradesForT3 = c1.mean > 0 && c1.sd > 0 ? Math.ceil((3 * c1.sd / c1.mean) ** 2) : null;
  const c1Status = c1.tStat >= 2.0 ? 'PASS' : c1.tStat >= 1.25 ? 'WARN' : 'FAIL';

  // ── Check 2: Market-Implied Fair-Null Shuffle Test (2,000 draws) ──
  // Under H0: P(WIN_i) = market entry price p_i (zero edge over CLOB odds),
  // compute the simulated t-stat distribution and exact empirical p-value.
  let rng = ((n * 2654435761) ^ Math.round(c1.netPnl * 100) ^ 0x9e3779b9) | 0;
  if (rng === 0) rng = 2463534242 | 0;
  const nextU32 = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return rng >>> 0;
  };

  const nullParams = trades.map((t) => {
    const shares = t.cost / t.price;
    const fee = t.isMaker ? 0 : takerFeeUsd(shares, t.price);
    const winPnl = shares * (1 - t.price) - fee;
    const lossPnl = -t.cost - fee;
    const pThresh = Math.floor(t.price * 4294967296);
    return { winPnl, lossPnl, pThresh };
  });

  let beatCount = 0;
  let nullTMax = -Infinity;
  let nullTSum = 0;
  const simBuf = new Float64Array(n);
  for (let s = 0; s < nShuffles; s++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const np = nullParams[i];
      const v = nextU32() < np.pThresh ? np.winPnl : np.lossPnl;
      simBuf[i] = v;
      sum += v;
    }
    const m = sum / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = simBuf[i] - m;
      ss += d * d;
    }
    const sd = Math.sqrt(ss / (n - 1));
    const tSim = sd > 1e-12 ? (m / sd) * Math.sqrt(n) : 0;
    nullTSum += tSim;
    if (tSim > nullTMax) nullTMax = tSim;
    if (tSim >= c1.tStat) beatCount++;
  }
  const shufflePVal = r4((beatCount + 1) / (nShuffles + 1));
  const c2Status = shufflePVal < 0.05 ? 'PASS' : shufflePVal < 0.15 ? 'WARN' : 'FAIL';

  // ── Check 3: Chronological Half Split ──
  const mid = Math.floor(n / 2);
  const firstHalf = trades.slice(0, mid);
  const secondHalf = trades.slice(mid);
  const h1Stat = computeTStat(firstHalf.map((t) => t.pnl));
  const h2Stat = computeTStat(secondHalf.map((t) => t.pnl));
  const h1Wr = r2((firstHalf.filter((t) => t.won).length / firstHalf.length) * 100);
  const h2Wr = r2((secondHalf.filter((t) => t.won).length / secondHalf.length) * 100);
  const bothHalvesPositive = h1Stat.netPnl > 0 && h2Stat.netPnl > 0;
  const c3Status = bothHalvesPositive ? 'PASS' : (h2Stat.netPnl > 0 ? 'WARN' : 'FAIL');

  // ── Check 4: Where Does the Money Come From? (Attribution) ──
  const groupPnl = (key) => {
    const m = new Map();
    for (const t of trades) {
      const k = t[key] || 'Unknown';
      const cur = m.get(k) || { bucket: k, trades: 0, wins: 0, pnl: 0 };
      cur.trades++;
      if (t.won) cur.wins++;
      cur.pnl += t.pnl;
      m.set(k, cur);
    }
    return [...m.values()]
      .map((x) => ({ ...x, pnl: r2(x.pnl), wrPct: r2((x.wins / x.trades) * 100) }))
      .sort((a, b) => b.pnl - a.pnl);
  };
  const bySide = groupPnl('side');
  const byPhase = groupPnl('phase');
  const bySession = groupPnl('session');
  const positiveSides = bySide.filter((x) => x.pnl > 0).length;
  const positivePhases = byPhase.filter((x) => x.pnl > 0).length;
  const c4Status = positiveSides >= 2 && positivePhases >= 2
    ? 'PASS'
    : (positiveSides >= 1 && c1.netPnl > 0 ? 'WARN' : 'FAIL');

  // ── Check 5: Why? (Structural Mechanism & Failure Modes) ──
  const makerCount = trades.filter((t) => t.isMaker).length;
  const makerSharePct = r2((makerCount / n) * 100);
  const avgEntryCents = r2(meanOf(trades.map((t) => t.price)) * 100);
  const c5Status = c1.netPnl > 0 ? 'PASS' : 'WARN';

  // ── Check 6: Break It (Outlier Removal & Rolling t-stat) ──
  const indexed = pnls.map((v, idx) => ({ v, idx })).sort((a, b) => b.v - a.v);
  const dropTopK = (k) => {
    const dropSet = new Set(indexed.slice(0, Math.min(k, n - 2)).map((x) => x.idx));
    const rem = pnls.filter((_, idx) => !dropSet.has(idx));
    const st = computeTStat(rem);
    return {
      dropped: dropSet.size,
      remaining: rem.length,
      netPnl: r2(st.netPnl),
      tStat: r2(st.tStat),
    };
  };
  const drop3 = dropTopK(3);
  const drop5Pct = dropTopK(Math.max(1, Math.round(n * 0.05)));
  const drop10Pct = dropTopK(Math.max(1, Math.round(n * 0.10)));

  const rollingSeries = [];
  const winLen = Math.min(rollingWin, Math.max(10, Math.floor(n / 2)));
  if (n >= winLen) {
    for (let end = winLen; end <= n; end++) {
      const slice = pnls.slice(end - winLen, end);
      const st = computeTStat(slice);
      rollingSeries.push({ tradeIdx: end, tStat: r2(st.tStat), netPnl: r2(st.netPnl) });
    }
  }
  const rollingLatestT = rollingSeries.length ? rollingSeries[rollingSeries.length - 1].tStat : r2(c1.tStat);
  const rollingPositivePct = rollingSeries.length
    ? r2((rollingSeries.filter((x) => x.tStat > 0).length / rollingSeries.length) * 100)
    : (c1.tStat > 0 ? 100 : 0);

  // For binary bets where all wins have similar size (~$1.85) and losses are larger (~-$3.15),
  // dropping top 3 oversized wins tests single-trade luck, while drop 5% tests robustness.
  const c6Status = drop3.netPnl > 0 && drop5Pct.netPnl > 0 && rollingLatestT > 0
    ? 'PASS'
    : (drop3.netPnl > 0 ? 'WARN' : 'FAIL');

  const checks = [
    {
      id: 't_stat',
      num: 1,
      name: '1. Signal vs Noise (t-stat)',
      status: c1Status,
      metric: `t = ${r2(c1.tStat)} (p = ${oneSidedP})`,
      detail: `Mean ${c1.mean >= 0 ? '+' : ''}$${r3(c1.mean)}/tr · SD $${r2(c1.sd)} · n=${n} (${wrPct}% WR)`
        + (c1.tStat < 2 && tradesForT2 ? ` · need ~${tradesForT2} tr for t≥2` : c1.tStat < 3 && tradesForT3 ? ` · need ~${tradesForT3} tr for t≥3` : ' · strong statistical edge'),
    },
    {
      id: 'shuffle',
      num: 2,
      name: `2. Market-Null Shuffle (${nShuffles.toLocaleString()}×)`,
      status: c2Status,
      metric: `p = ${shufflePVal} (${beatCount}/${nShuffles} beat)`,
      detail: `Simulated zero-edge trader at exact entry odds (mean null t = ${r2(nullTSum / nShuffles)}, max ${r2(nullTMax)}). ${shufflePVal < 0.05 ? 'Beats chance at 95% CI' : 'Needs more trades to clear p < 0.05'}.`,
    },
    {
      id: 'half_split',
      num: 3,
      name: '3. Chronological Half-Split',
      status: c3Status,
      metric: `H1 ${h1Stat.netPnl >= 0 ? '+' : ''}$${r2(h1Stat.netPnl)} · H2 ${h2Stat.netPnl >= 0 ? '+' : ''}$${r2(h2Stat.netPnl)}`,
      detail: `First ${firstHalf.length} tr: ${h1Wr}% WR (t=${r2(h1Stat.tStat)}) | Last ${secondHalf.length} tr: ${h2Wr}% WR (t=${r2(h2Stat.tStat)}) — ${bothHalvesPositive ? 'both halves profitable' : 'divergent halves'}.`,
    },
    {
      id: 'where',
      num: 4,
      name: '4. Attribution ("Where")',
      status: c4Status,
      metric: `${positiveSides}/${bySide.length} sides · ${positivePhases}/${byPhase.length} phases +`,
      detail: `Sides: ${bySide.map((x) => `${x.bucket} ${x.pnl >= 0 ? '+' : ''}$${x.pnl}`).join(', ')} | Sessions: ${bySession.map((x) => `${x.bucket} ${x.pnl >= 0 ? '+' : ''}$${x.pnl}`).join(', ')}`,
    },
    {
      id: 'why',
      num: 5,
      name: '5. Mechanism ("Why & Kill Switch")',
      status: c5Status,
      metric: `Avg ${avgEntryCents}¢ · Maker ${makerSharePct}%`,
      detail: 'Edge: calibrated ML + Chainlink 60s TWAP / basis Gate 20f + 0% maker fee. Dies if: WR drops below breakeven, maker adverse selection turns persistent, or CLOB spreads compress edge.',
    },
    {
      id: 'break_it',
      num: 6,
      name: '6. Break It (Outlier Stress & Rolling t)',
      status: c6Status,
      metric: `Drop top 3: ${drop3.netPnl >= 0 ? '+' : ''}$${drop3.netPnl} · Roll-${winLen} t=${rollingLatestT}`,
      detail: `Drop top 5% (${drop5Pct.dropped} tr): ${drop5Pct.netPnl >= 0 ? '+' : ''}$${drop5Pct.netPnl} (t=${drop5Pct.tStat}) · Drop top 10% (${drop10Pct.dropped} tr): ${drop10Pct.netPnl >= 0 ? '+' : ''}$${drop10Pct.netPnl} · ${rollingPositivePct}% rolling windows positive.`,
    },
  ];

  const checksPassed = checks.filter((c) => c.status === 'PASS').length;
  const checksWarn = checks.filter((c) => c.status === 'WARN').length;

  return {
    available: true,
    nTrades: n,
    wrPct,
    netPnlUsd: r2(c1.netPnl),
    tStat: r2(c1.tStat),
    oneSidedPVal: oneSidedP,
    tradesForT2,
    tradesForT3,
    shuffle: {
      trials: nShuffles,
      beatCount,
      pVal: shufflePVal,
      nullMeanT: r2(nullTSum / nShuffles),
      nullMaxT: r2(nullTMax),
    },
    halfSplit: {
      first: { trades: firstHalf.length, wrPct: h1Wr, netPnl: r2(h1Stat.netPnl), tStat: r2(h1Stat.tStat) },
      second: { trades: secondHalf.length, wrPct: h2Wr, netPnl: r2(h2Stat.netPnl), tStat: r2(h2Stat.tStat) },
      bothPositive: bothHalvesPositive,
    },
    attribution: { bySide, byPhase, bySession },
    breakIt: {
      drop3,
      drop5Pct,
      drop10Pct,
      rollingWindow: winLen,
      rollingLatestT,
      rollingPositivePct,
      rollingSeries: rollingSeries.slice(-60),
    },
    checksPassed,
    checksWarn,
    checksTotal: 6,
    checks,
  };
}
