import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecretText, sanitizeTradeEntry } from '../../../scripts/study/redact.mjs';
import { parseUpdatesMd, buildStudySite } from '../../../scripts/build-study-site.mjs';
import { buildMonteCarloBundleNative } from '../../../scripts/study/mc-native.mjs';
import { computeEdgeProof } from '../../../scripts/study/edgeProof.mjs';
import { buildMonteCarloBundle, MC_DEFAULT_PATHS } from '../../../study-site/mc-engine.js';

describe('study portal redaction & sanitization', () => {
  test('redactSecretText scrubs tokens, keys, bearer headers, and query params', () => {
    const dirty = [
      'Bearer 0000111122223333444455556666777788889999aaaabbbbcccc',
      'https://poly15.dollarkilat.xyz/?token=dummy123456&botStatusToken=dummysecret99',
      'TELEGRAM_BOT_TOKEN=123456789:DUMMY_TEST_TOKEN_NOT_REAL_1234567890',
      'sk-or-v1-dummytestkeynotreal0123456789abcdef',
    ].join('\n');

    const clean = redactSecretText(dirty);
    expect(clean).not.toContain('0000111122223333');
    expect(clean).not.toContain('dummy123456');
    expect(clean).not.toContain('dummysecret99');
    expect(clean).not.toContain('DUMMY_TEST_TOKEN');
    expect(clean).not.toContain('sk-or-v1-dummytestkey');
    expect(clean).toContain('[REDACTED]');
  });

  test('sanitizeTradeEntry drops private IDs while preserving cross-feed & PnL telemetry', () => {
    const out = sanitizeTradeEntry({
      _ts: 1794801601402,
      entry: {
        side: 'UP',
        marketSlug: 'btc-updown-15m-1794800700',
        conditionId: '0xsecretconditionid',
        orderId: 'ord-secret',
        tokenId: 'tok-secret',
        actualPrice: 0.65,
        phase: 'LATE',
        mlConfidence: 0.71,
        bestEdge: 0.175,
        liveBasisUsd: 62.15,
        crossFeedSkewUsd: -14.2,
        binanceWindowOpen: 64970,
        modelId: '20261115-p2-c3e0fd',
      },
      exit: { outcome: 'UP', verifiedSource: 'oracle', exitedAt: 1794801601401 },
      analysis: { outcome: 'WIN', pnl: 1.67 },
    });

    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty('conditionId');
    expect(out).not.toHaveProperty('orderId');
    expect(out).not.toHaveProperty('tokenId');
    expect(out!.outcome).toBe('WIN');
    expect(out!.pnl).toBe(1.67);
    expect(out!.liveBasisUsd).toBe(62.15);
    expect(out!.crossFeedSkewUsd).toBe(-14.2);
  });
});

describe('parseUpdatesMd & buildStudySite', () => {
  test('parses Current status table and both ## / ### release entries cleanly', () => {
    const md = `# POLY//15\n\n---\n\n## 2026-11-16 — Live Pipeline v4 Hybrid Residual Overlay\n\n- Added 412 depth-2 residual trees.\n\n---\n\n## Current status\n\n_Last updated: 2026-11-16 12:00 WIB_\n\n| Area | State |\n|---|---|\n| Bot | active DRY_RUN |\n\n---\n\n### 2026-11-16 — Cross-feed guard & study portal\n\n- Added Gate 20f.\n`;
    const parsed = parseUpdatesMd(md);
    expect(parsed.lastUpdated).toBe('2026-11-16 12:00 WIB');
    expect(parsed.statusRows).toEqual([{ area: 'Bot', state: 'active DRY_RUN' }]);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].heading).toContain('Hybrid Residual Overlay');
    expect(parsed.entries[1].tags).toContain('Filters & Risk');
  });

  test('buildStudySite compiles complete static bundle into temp directory', { timeout: 20_000 }, () => {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-test-'));
    try {
      const repoRoot = path.resolve(process.cwd());
      const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-data-'));
      try {
        fs.writeFileSync(path.join(tmpData, 'state.json'), JSON.stringify({
          bankroll: 101.67,
          startOfDayBankroll: 100,
          peakBankroll: 101.67,
          totalTrades: 1,
          wins: 1,
          losses: 0,
          currentPosition: null,
        }));
        fs.writeFileSync(path.join(tmpData, 'trade_journal.jsonl'), JSON.stringify({
          _ts: 1794801601402,
          entry: {
            side: 'UP',
            marketSlug: 'btc-updown-15m-1794800700',
            tokenPrice: 0.65,
            phase: 'LATE',
            modelId: '20261116-p2-ef8dfd',
            liveBasisUsd: 62.15,
            conditionId: '0xdeadbeef',
          },
          exit: { outcome: 'UP' },
          analysis: { outcome: 'WIN', pnl: 1.67 },
        }) + '\n');

        const res = buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, monteCarloPaths: 500 });
        expect(res.skipped).toBe(false);
        const outHtml = fs.readFileSync(path.join(tmpOut, 'index.html'), 'utf8');
        const outApp = fs.readFileSync(path.join(tmpOut, 'app.js'), 'utf8');
        expect(outHtml).toMatch(/\.\/styles\.css\?v=[a-f0-9]{8}/);
        expect(outHtml).toMatch(/\.\/app\.js\?v=[a-f0-9]{8}/);
        expect(outApp).toMatch(/\.\/charts\.js\?v=[a-f0-9]{8}/);
        expect(outApp).toMatch(/\.\/mc-engine\.js\?v=[a-f0-9]{8}/);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'site.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'models.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'studies.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'updates.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'stage2.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'montecarlo.json'))).toBe(true);
        const mcRaw = fs.readFileSync(path.join(tmpOut, 'data', 'montecarlo.json'), 'utf8');
        expect(mcRaw).not.toContain('0xdeadbeef');
        const mcJson = JSON.parse(mcRaw);
        expect(mcJson.available).toBe(true);
        expect(mcJson.nPaths).toBe(500);
        expect(mcJson.scenarios).toHaveLength(5);
        const stage2Json = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'stage2.json'), 'utf8'));
        expect(stage2Json.available).toBe(true);
        expect(stage2Json.coverage?.dateRange?.totalDays).toBeGreaterThanOrEqual(54);
        expect(stage2Json.liveHybridArtifact?.id).toBe('v4-hybrid-20261116');

        const siteJson = fs.readFileSync(path.join(tmpOut, 'data', 'site.json'), 'utf8');
        expect(siteJson).not.toContain('0xdeadbeef');
        const site = JSON.parse(siteJson);
        expect(site.eval.wins).toBe(1);
        expect(site.eval.bankroll).toBe(101.67);
        expect(site.monteCarloSummary?.available).toBe(true);
        expect(site.monteCarloSummary?.nPaths).toBe(500);
        expect(site.eval.bankroll).toBe(101.67);

        const modelsJson = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'models.json'), 'utf8'));
        expect(Array.isArray(modelsJson.timelineModels)).toBe(true);
        expect(modelsJson.timelineModels.length).toBeGreaterThanOrEqual(20);
        expect(Array.isArray(modelsJson.experiments)).toBe(true);
        expect(modelsJson.experiments.length).toBeGreaterThanOrEqual(5);
        const activeM = modelsJson.models.find((m: any) => m.id === modelsJson.activeModelId);
        expect(activeM).toBeDefined();
        expect(activeM.featureCatalog.length).toBeGreaterThanOrEqual(70);
        expect(activeM.calibrationBins).toHaveLength(10);
        expect(activeM.confidenceBuckets.length).toBeGreaterThanOrEqual(5);
        expect(activeM.metrics?.lgb?.auc).toBeGreaterThan(0.8);
        expect(activeM.xgbParams?.max_depth).toBeDefined();

        // --only-if-changed skips cleanly on unchanged second call
        const second = buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, onlyIfChanged: true });
        expect(second.skipped).toBe(true);
      } finally {
        fs.rmSync(tmpData, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('derives eval startBankroll and peakBankroll accurately across daily rollover and open positions', { timeout: 20_000 }, () => {
    const repoRoot = path.resolve(process.cwd());
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-rollover-'));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-rollover-data-'));
    try {
      const journalRows = [
        { pnl: 13.53, outcome: 'WIN', slug: 'btc-updown-15m-1794795300', exitedAt: 1794796200000 },
        { pnl: -3.15, outcome: 'LOSS', slug: 'btc-updown-15m-1794800700', exitedAt: 1795032900000 },
      ];
      fs.writeFileSync(
        path.join(tmpData, 'trade_journal.jsonl'),
        journalRows.map((r) => JSON.stringify({
          _ts: r.exitedAt,
          entry: { side: 'UP', marketSlug: r.slug, tokenPrice: 0.55, enteredAt: r.exitedAt - 600_000 },
          exit: { outcome: r.outcome === 'WIN' ? 'UP' : 'DOWN', exitedAt: r.exitedAt },
          analysis: { outcome: r.outcome, pnl: r.pnl },
        })).join('\n') + '\n',
      );

      // Case 1: Daily rollover reset startOfDayBankroll to 110.38 and stale state.peakBankroll
      fs.writeFileSync(path.join(tmpData, 'state.json'), JSON.stringify({
        bankroll: 110.38,
        startOfDayBankroll: 110.38,
        peakBankroll: 111.68,
        totalTrades: 2,
        wins: 1,
        losses: 1,
        currentPosition: null,
      }));
      buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, monteCarloPaths: 200 });
      const siteFlat = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'site.json'), 'utf8'));
      expect(siteFlat.eval.startBankroll).toBe(100);
      expect(siteFlat.eval.bankroll).toBe(110.38);
      expect(siteFlat.eval.netPnl).toBe(10.38);
      expect(siteFlat.eval.peakBankroll).toBe(113.53);
      expect(siteFlat.eval.equityCurve[0].bankroll).toBe(100);
      expect(siteFlat.eval.equityCurve.at(-1).bankroll).toBe(110.38);

      // Case 2: Open position has cost 3.15 deducted from state.bankroll while unsettled
      fs.writeFileSync(path.join(tmpData, 'state.json'), JSON.stringify({
        bankroll: 107.23,
        startOfDayBankroll: 110.38,
        peakBankroll: 111.68,
        totalTrades: 3,
        wins: 1,
        losses: 1,
        currentPosition: { settled: false, cost: 3.15 },
      }));
      buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, monteCarloPaths: 200 });
      const siteOpen = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'site.json'), 'utf8'));
      expect(siteOpen.eval.startBankroll).toBe(100);
      expect(siteOpen.eval.bankroll).toBe(110.38);
      expect(siteOpen.eval.equityCurve.at(-1).bankroll).toBe(110.38);
    } finally {
      fs.rmSync(tmpData, { recursive: true, force: true });
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('buildMonteCarloBundle runs full 10,000-trial adaptive simulation up to 10,000 trades', { timeout: 30_000 }, () => {
    const empty = buildMonteCarloBundle([], { startBankroll: 100, nPaths: 10000 });
    expect(empty.available).toBe(false);
    expect(empty.scenarios).toEqual([]);

    const startTs = 1794795465000;
    const trades = Array.from({ length: 50 }, (_, i) => {
      const won = i < 34; // 34W-16L = 68.0% WR
      return {
        pnl: won ? 1.85 : -3.15,
        cost: 3.15,
        tokenPrice: 0.63,
        outcome: won ? 'WIN' : 'LOSS',
        isMaker: true,
        enteredAt: startTs + i * 2_400_000,
        exitedAt: startTs + i * 2_400_000 + 600_000,
      };
    });

    const bundle = buildMonteCarloBundle(trades, { startBankroll: 110.65, nPaths: 10000 });
    expect(bundle.available).toBe(true);
    expect(bundle.nPaths).toBe(10000);
    expect(bundle.currentBankroll).toBe(110.65);
    expect(bundle.scenarios).toHaveLength(5);

    // Bayesian Beta(34+12, 16+8) posterior shrinks 68.0% empirical WR conservatively toward 60% prior
    expect(bundle.stats.empiricalWrPct).toBe(68);
    expect(bundle.stats.bayesianWrPct).toBeLessThan(68);
    expect(bundle.stats.bayesianWrPct).toBeGreaterThan(64);

    const byId = Object.fromEntries(bundle.scenarios.map((s: any) => [s.id, s]));
    for (const sc of bundle.scenarios) {
      expect(sc.nPaths).toBe(10000);
      for (const hz of [100, 250, 500, 1000, 2000, 5000, 10000]) {
        const h = sc.horizons[hz];
        expect(h).toBeDefined();
        const finalSum = h.finalHist.counts.reduce((a: number, b: number) => a + b, 0);
        const ddSum = h.ddHist.counts.reduce((a: number, b: number) => a + b, 0);
        expect(finalSum).toBe(10000);
        expect(ddSum).toBe(10000);
      }
    }

    // Stress test (-3pp WR & -$0.05 slippage) must produce strictly lower median than fixed empirical bootstrap
    expect(byId.live_stress_test.horizons[5000].p50).toBeLessThan(byId.live_bootstrap_fixed.horizons[5000].p50);
    expect(byId.live_compounding_kelly.horizons[5000].p50).toBeGreaterThan(byId.live_bootstrap_fixed.horizons[5000].p50);

    // Default study-portal path count is 1,000,000
    expect(MC_DEFAULT_PATHS).toBe(1_000_000);

    // When a C compiler is available (e.g. Linux CI / VPS), verify native C11 engine parity
    const nativeBundle = buildMonteCarloBundleNative(trades, { startBankroll: 110.65, nPaths: 2000, threads: 2 });
    if (nativeBundle) {
      expect(nativeBundle.engine).toBe('native-c11');
      expect(nativeBundle.nPaths).toBe(2000);
      expect(nativeBundle.scenarios).toHaveLength(5);
      const nById = Object.fromEntries(nativeBundle.scenarios.map((s: any) => [s.id, s]));
      for (const sc of nativeBundle.scenarios) {
        const h5k = sc.horizons[5000];
        expect(h5k.finalHist.counts.reduce((a: number, b: number) => a + b, 0)).toBe(2000);
        expect(h5k.ddHist.counts.reduce((a: number, b: number) => a + b, 0)).toBe(2000);
        expect(h5k.cvar95Final).toBeLessThanOrEqual(h5k.p5);
        expect(h5k.cvar95MaxDdPct).toBeGreaterThanOrEqual(h5k.p95MaxDdPct);
      }
      // Median should closely agree with JS engine on the same trade pool (within sampling variance)
      const jsMed = byId.live_bootstrap_fixed.horizons[5000].p50;
      const cMed = nById.live_bootstrap_fixed.horizons[5000].p50;
      expect(Math.abs(cMed - jsMed) / Math.max(1, jsMed)).toBeLessThan(0.05);
    }
  });

  test('buildStudySite reuses cached montecarlo.json when non-trade telemetry changes', { timeout: 20_000 }, () => {
    const repoRoot = path.resolve(process.cwd());
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-cache-'));
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'poly15-study-cache-data-'));
    try {
      fs.writeFileSync(path.join(tmpData, 'state.json'), JSON.stringify({
        bankroll: 101.85,
        startOfDayBankroll: 100,
        peakBankroll: 101.85,
        totalTrades: 1,
        wins: 1,
        losses: 0,
        currentPosition: null,
      }));
      fs.writeFileSync(path.join(tmpData, 'trade_journal.jsonl'), JSON.stringify({
        _ts: 1794801601402,
        entry: { side: 'UP', marketSlug: 'btc-updown-15m-1794800700', tokenPrice: 0.63 },
        exit: { outcome: 'UP', exitedAt: 1794801601401 },
        analysis: { outcome: 'WIN', pnl: 1.85 },
      }) + '\n');

      buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, monteCarloPaths: 200 });
      const firstMc = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'montecarlo.json'), 'utf8'));
      expect(typeof firstMc.cacheKey).toBe('string');

      // Mutate non-trade file (jev_log.jsonl) -> build runs, but montecarlo.json reuses cached generatedAt
      fs.writeFileSync(path.join(tmpData, 'jev_log.jsonl'), '{"ts":1794801700000,"probUp":0.6}\n');
      buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut, monteCarloPaths: 200 });
      const secondMc = JSON.parse(fs.readFileSync(path.join(tmpOut, 'data', 'montecarlo.json'), 'utf8'));
      expect(secondMc.cacheKey).toBe(firstMc.cacheKey);
      expect(secondMc.generatedAt).toBe(firstMc.generatedAt);
    } finally {
      fs.rmSync(tmpData, { recursive: true, force: true });
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('computeEdgeProof validates 6-check statistical edge (t-stat, market-null shuffle, half-split, break-it)', () => {
    const small = computeEdgeProof([{ pnl: 1.8, cost: 3.15, tokenPrice: 0.63 }]);
    expect(small.available).toBe(false);

    // 80 trades @ 75% WR on 63c entry (+1.85 win / -3.15 loss) spread across both halves, sides, phases
    const startTs = 1794800000000;
    const trades = Array.from({ length: 80 }, (_, i) => {
      const isWin = (i % 10) < 7 || (i % 40 === 7) || (i % 40 === 17);
      return {
        pnl: isWin ? 1.85 : -3.15,
        cost: 3.15,
        tokenPrice: 0.63,
        outcome: isWin ? 'WIN' : 'LOSS',
        side: i % 2 === 0 ? 'UP' : 'DOWN',
        phase: i % 3 === 0 ? 'EARLY' : i % 3 === 1 ? 'MID' : 'LATE',
        isMaker: true,
        exitedAt: startTs + i * 3_600_000,
      };
    });

    const proof = computeEdgeProof(trades, { shuffles: 1000 });
    expect(proof.available).toBe(true);
    expect(proof.nTrades).toBe(80);
    expect(proof.checks).toHaveLength(6);
    expect(proof.tStat).toBeGreaterThan(1.5);
    expect(proof.shuffle.pVal).toBeLessThan(0.1);
    expect(proof.halfSplit.bothPositive).toBe(true);
    expect(proof.breakIt.drop3.netPnl).toBeGreaterThan(0);
    expect(proof.checksPassed).toBeGreaterThanOrEqual(4);
  });
});
