import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecretText, sanitizeTradeEntry } from '../../../scripts/study/redact.mjs';
import { parseUpdatesMd, buildStudySite } from '../../../scripts/build-study-site.mjs';

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
  test('parses Current status table and release entries cleanly', () => {
    const md = `# POLY//15\n\n## Current status\n\n_Last updated: 2026-11-16 12:00 WIB_\n\n| Area | State |\n|---|---|\n| Bot | active DRY_RUN |\n\n---\n\n### 2026-11-16 — Cross-feed guard & study portal\n\n- Added Gate 20f.\n`;
    const parsed = parseUpdatesMd(md);
    expect(parsed.lastUpdated).toBe('2026-11-16 12:00 WIB');
    expect(parsed.statusRows).toEqual([{ area: 'Bot', state: 'active DRY_RUN' }]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].tags).toContain('Filters & Risk');
  });

  test('buildStudySite compiles complete static bundle into temp directory', () => {
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

        const res = buildStudySite({ root: repoRoot, dataDir: tmpData, outDir: tmpOut });
        expect(res.skipped).toBe(false);
        const outHtml = fs.readFileSync(path.join(tmpOut, 'index.html'), 'utf8');
        const outApp = fs.readFileSync(path.join(tmpOut, 'app.js'), 'utf8');
        expect(outHtml).toMatch(/\.\/styles\.css\?v=[a-f0-9]{8}/);
        expect(outHtml).toMatch(/\.\/app\.js\?v=[a-f0-9]{8}/);
        expect(outApp).toMatch(/\.\/charts\.js\?v=[a-f0-9]{8}/);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'site.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'models.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'studies.json'))).toBe(true);
        expect(fs.existsSync(path.join(tmpOut, 'data', 'updates.json'))).toBe(true);

        const siteJson = fs.readFileSync(path.join(tmpOut, 'data', 'site.json'), 'utf8');
        expect(siteJson).not.toContain('0xdeadbeef');
        const site = JSON.parse(siteJson);
        expect(site.eval.wins).toBe(1);
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
});
