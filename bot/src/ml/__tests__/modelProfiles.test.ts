import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerModel, readJournal } from '../../modelRegistry.ts';
import { readFilterThresholds } from '../../safety/filterThresholds.ts';
import { createModelProfileManager, sanitizeModelProfile } from '../modelProfiles.ts';

function seedSourceDir(dir: string, modelId: string, accuracy: number) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'xgboost_model.json'), JSON.stringify({ model_id: modelId, trees: [{ id: 0 }] }));
  writeFileSync(join(dir, 'lightgbm_model.json'), JSON.stringify({ model_id: modelId, tree_info: [] }));
  writeFileSync(
    join(dir, 'norm_browser.json'),
    JSON.stringify({
      model_id: modelId,
      feature_pipeline: 2,
      xgb_weight: 0.65,
      lgb_weight: 0.35,
      mean: [0],
      std: [1],
      feature_names: ['f0'],
      calibrated_phase_thresholds: {
        EARLY: { min_edge: 0.06, min_prob: 0.60 },
        MID: { min_edge: 0.07, min_prob: 0.58 },
        LATE: { min_edge: 0.07, min_prob: 0.57 },
        VERY_LATE: { min_edge: 0.07, min_prob: 0.56 },
      },
    }),
  );
  writeFileSync(
    join(dir, 'training_meta.json'),
    JSON.stringify({
      rows: modelId.includes('365d') ? 32096 : 16266,
      first_slug_ts: modelId.includes('365d') ? 1731600000 : 1747200000,
      last_slug_ts: 1763100000,
      feature_pipeline: 2,
    }),
  );
  writeFileSync(
    join(dir, 'training_report.json'),
    JSON.stringify({
      ensemble: { accuracy, auc: accuracy + 0.1, calibration_ece: 0.02, brier_skill_vs_market: 0.01 },
    }),
  );
}

describe('modelProfiles', () => {
  let root: string;
  let registryRoot: string;
  let publicMlDir: string;
  let backupDir: string;
  let profilesFile: string;
  let idA: string;
  let idB: string;
  let appliedOverridesHistory: Array<Record<string, unknown> | null | undefined>;
  let currentFilters: Record<string, number>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'model-profiles-'));
    registryRoot = join(root, 'ml_registry');
    publicMlDir = join(root, 'public_ml');
    backupDir = join(root, 'backups');
    profilesFile = join(root, 'bot_data', 'model_profiles.json');
    mkdirSync(publicMlDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });

    const srcA = join(root, 'src_a');
    const srcB = join(root, 'src_b');
    seedSourceDir(srcA, 'model-a-180d', 0.61);
    seedSourceDir(srcB, 'model-b-365d', 0.63);

    const regA = registerModel({
      root: registryRoot,
      sourceDir: srcA,
      source: 'test_180d',
      actor: 'test',
      notes: ['180d baseline'],
      trainingMeta: join(srcA, 'training_meta.json'),
      trainingReport: join(srcA, 'training_report.json'),
    });
    const regB = registerModel({
      root: registryRoot,
      sourceDir: srcB,
      source: 'test_365d',
      actor: 'test',
      notes: ['365d candidate'],
      trainingMeta: join(srcB, 'training_meta.json'),
      trainingReport: join(srcB, 'training_report.json'),
    });
    idA = regA.manifest.id;
    idB = regB.manifest.id;

    // Put A initially on disk
    for (const file of ['xgboost_model.json', 'lightgbm_model.json', 'norm_browser.json']) {
      writeFileSync(join(publicMlDir, file), readFileSync(join(srcA, file)));
    }

    appliedOverridesHistory = [];
    currentFilters = { ...readFilterThresholds({}).values };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeMgr() {
    const baseFilters = readFilterThresholds({}).values;
    return createModelProfileManager({
      registryRoot,
      publicMlDir,
      backupDir,
      profilesFile,
      getBaselineFilters: () => ({ ...baseFilters }),
      applyFilters: overrides => {
        appliedOverridesHistory.push(overrides ?? null);
        currentFilters = { ...baseFilters, ...((overrides as Record<string, number>) ?? {}) };
        return { applied: (overrides as Record<string, number>) ?? {}, refused: [] };
      },
      getActiveFeaturePipeline: () => 2,
      getBaselineConfig: () => ({
        kellyProbShrink: 0.6,
        maxBetAmountUsd: 2.5,
        orderRouter: {
          enabled: true,
          fokMlThreshold: 0.72,
          limitMlThreshold: 0.60,
          fokMaxPrice: 0.74,
          fokMaxPriceTrending: 0.68,
          cheapPriceThreshold: 0.50,
          cheapMlThreshold: 0.62,
          momentumRelThreshold: 0.02,
          spreadNarrowThreshold: 0.02,
          spreadWideThreshold: 0.04,
          upgradeMLThreshold: 0.85,
          upgradeHoldSec: 60,
        },
        limitOrder: {
          enabled: true,
          minMlConfidence: 0.62,
          minRemainingEdge: 0.05,
        } as any,
      }),
    });
  }

  it('sanitizes bounds and refuses out-of-range overrides safely', () => {
    const base = readFilterThresholds({}).values;
    const { profile, refused } = sanitizeModelProfile(
      {
        label: '365d Selective',
        filters: { mlConfMin: 0.68, deadZoneLo: 0.99 },
        sizing: { kellyProbShrink: 0.75, maxBetAmountUsd: 500 },
        phaseThresholds: { LATE: { minEdge: 0.09, minProb: 0.62 }, BOGUS: { minEdge: 0.1 } },
      },
      base,
    );
    expect(profile.label).toBe('365d Selective');
    expect(profile.filters?.mlConfMin).toBe(0.68);
    expect(profile.filters?.deadZoneLo).toBeUndefined();
    expect(profile.sizing?.kellyProbShrink).toBe(0.75);
    expect(profile.sizing?.maxBetAmountUsd).toBeUndefined();
    expect(profile.phaseThresholds?.LATE).toEqual({ minEdge: 0.09, minProb: 0.62 });
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('saves, persists, applies per-model profiles and resets cleanly', () => {
    const mgr = makeMgr();
    mgr.init(idA);
    expect(mgr.listModels().map(m => m.id).sort()).toEqual([idA, idB].sort());

    const saveRes = mgr.saveProfile(idA, {
      label: '180d Tight',
      filters: { mlConfMin: 0.67 },
      sizing: { kellyProbShrink: 0.70, maxBetAmountUsd: 4 },
      orderRouter: { fokMlThreshold: 0.78 },
      limitOrder: { minMlConfidence: 0.65 },
      phaseThresholds: { EARLY: { minEdge: 0.08, minProb: 0.63 } },
    });
    expect(saveRes.ok).toBe(true);
    expect(currentFilters.mlConfMin).toBe(0.67);
    expect(mgr.getKellyProbShrink()).toBe(0.70);
    expect(mgr.getMaxBetAmountUsd()).toBe(4);
    expect(mgr.getOrderRouterConfig().fokMlThreshold).toBe(0.78);
    expect(mgr.getLimitOrderConfig().minMlConfidence).toBe(0.65);
    expect(mgr.getEffectivePhaseThresholds().EARLY).toEqual({ minEdge: 0.08, minProb: 0.63 });
    expect(existsSync(profilesFile)).toBe(true);

    // Reload manager from disk to verify persistence
    const mgr2 = makeMgr();
    mgr2.init(idA);
    expect(mgr2.getMaxBetAmountUsd()).toBe(4);

    // Reset reverts to baseline defaults
    const resetRes = mgr2.resetProfile(idA);
    expect(resetRes.ok).toBe(true);
    expect(mgr2.getKellyProbShrink()).toBe(0.6);
    expect(mgr2.getMaxBetAmountUsd()).toBe(2.5);
    expect(currentFilters.mlConfMin).toBe(readFilterThresholds({}).values.mlConfMin);
  });

  it('hot-switches models, switches active config profiles, blocks busy orders, and rolls back failed reloads', async () => {
    const mgr = makeMgr();
    mgr.init(idA);
    mgr.saveProfile(idA, { sizing: { maxBetAmountUsd: 3 } });
    mgr.saveProfile(idB, { label: '365d Guard', filters: { mlConfMin: 0.69 }, sizing: { maxBetAmountUsd: 5 } });

    // Refuses switch while pending order exists
    const busy = await mgr.switchModel(idB, { hasPendingOrder: () => true });
    expect(busy.ok).toBe(false);
    expect(busy.error).toContain('pending_order_active');

    // Rolls back disk files if reload fails
    const badReload = await mgr.switchModel(idB, { reloadModel: () => false });
    expect(badReload.ok).toBe(false);
    expect(badReload.error).toBe('model_reload_failed_rolled_back');
    const normAfterRollback = JSON.parse(readFileSync(join(publicMlDir, 'norm_browser.json'), 'utf-8'));
    expect(normAfterRollback.model_id).toBe('model-a-180d');
    expect(mgr.getActiveModelId()).toBe(idA);

    // Successful switch activates B on disk, applies B's profile, and updates registry status
    let resetCalled = 0;
    const okRes = await mgr.switchModel(idB, {
      reloadModel: () => true,
      getOpenPosition: () => ({ slug: 'btc-updown-15m-1', settled: false }),
      runExclusive: async fn => fn(),
      resetPostSwitch: () => { resetCalled++; },
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.modelId).toBe(idB);
    expect(okRes.warning).toContain('Open position');
    expect(resetCalled).toBe(1);

    const normB = JSON.parse(readFileSync(join(publicMlDir, 'norm_browser.json'), 'utf-8'));
    expect(normB.model_id).toBe(idB);
    expect(currentFilters.mlConfMin).toBe(0.69);
    expect(mgr.getMaxBetAmountUsd()).toBe(5);
    const deployedEvents = readJournal(registryRoot).filter(e => e.event === 'deployed' && e.id === idB);
    expect(deployedEvents.at(-1)?.actor).toBe('dashboard');
    expect(existsSync(join(registryRoot, 'MODELS.md'))).toBe(true);
  });
});
