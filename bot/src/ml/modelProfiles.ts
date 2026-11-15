/**
 * Per-model runtime configuration profiles + runnable model switcher.
 *
 * Keeps a persistent store (`bot/data/model_profiles.json`) mapping registry
 * `modelId` -> model-coupled config overrides (entry filter thresholds, Kelly
 * shrink / max bet, order router, limit order gates, phase thresholds). When
 * an active model changes via startup or the dashboard switcher, baseline env
 * values are restored first and that model's overrides are layered on top.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import {
  deployModel,
  listManifests,
  MODEL_FILES,
  modelStatuses,
  readManifest,
  renderModelsMd,
  type Manifest,
} from '../modelRegistry.ts';
import { getCalibratedPhaseThresholds, getFeaturePipeline } from '../adapters/mlLoader.ts';
import {
  FILTER_THRESHOLD_SPECS,
  validateFilterThresholdOverrides,
  type FilterThresholds,
} from '../safety/filterThresholds.ts';
import {
  applyFilterThresholdOverrides,
  getBaselineFilterThresholds,
} from '../safety/tradeFilters.ts';

const log = createLogger('ModelProfile');

export type PhaseName = 'EARLY' | 'MID' | 'LATE' | 'VERY_LATE';
const PHASES: readonly PhaseName[] = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];

export const DEFAULT_PHASE_THRESHOLDS: Record<PhaseName, { minEdge: number; minProb: number }> = {
  EARLY:     { minEdge: 0.06, minProb: 0.60 },
  MID:       { minEdge: 0.07, minProb: 0.58 },
  LATE:      { minEdge: 0.07, minProb: 0.57 },
  VERY_LATE: { minEdge: 0.07, minProb: 0.56 },
};

/** Primary filter thresholds surfaced cleanly in the dashboard profile editor. */
export const UI_FILTER_KEYS: readonly string[] = [
  'mlConfMin',
  'mlConfRelaxed',
  'highEdgeBypass',
  'hardMlFloor',
  'lateMlMin',
  'lateMlRelaxed',
  'lateEdgeBypass',
  'softEntryCap',
  'baseHardCap',
  'btcDistMinPct',
  'btcDistMlBypass',
  'deadZoneLo',
  'deadZoneHi',
];

export interface PhaseThresholdOverride {
  minEdge?: number;
  minProb?: number;
}

export interface ModelSizingOverride {
  kellyProbShrink?: number;
  maxBetAmountUsd?: number;
}

export interface ModelOrderRouterOverride {
  fokMlThreshold?: number;
  limitMlThreshold?: number;
  cheapMlThreshold?: number;
  fokMaxPrice?: number;
}

export interface ModelLimitOrderOverride {
  minMlConfidence?: number;
  minRemainingEdge?: number;
}

export interface ModelConfigProfile {
  label?: string;
  notes?: string;
  updatedAt?: string;
  filters?: Partial<FilterThresholds>;
  sizing?: ModelSizingOverride;
  orderRouter?: ModelOrderRouterOverride;
  limitOrder?: ModelLimitOrderOverride;
  phaseThresholds?: Partial<Record<PhaseName, PhaseThresholdOverride>>;
}

export interface ModelProfilesFile {
  version: 1;
  activeModelId: string | null;
  profiles: Record<string, ModelConfigProfile>;
}

export interface StoredModelSummary {
  id: string;
  featurePipeline: number;
  registeredAt: string;
  source: string;
  status: string;
  windowDays: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  rows: number | null;
  accuracy: number | null;
  auc: number | null;
  ece: number | null;
  brierSkill: number | null;
  notes: string[];
  hasProfile: boolean;
  profileLabel: string | null;
}

export interface ModelControlState {
  activeModelId: string | null;
  featurePipeline: number;
  models: StoredModelSummary[];
  profiles: Record<string, ModelConfigProfile>;
  baseline: {
    filters: Record<string, number>;
    sizing: { kellyProbShrink: number; maxBetAmountUsd: number };
    orderRouter: { fokMlThreshold: number; limitMlThreshold: number; cheapMlThreshold: number; fokMaxPrice: number };
    limitOrder: { minMlConfidence: number; minRemainingEdge: number };
    phaseThresholds: Record<PhaseName, { minEdge: number; minProb: number }>;
  };
  effective: {
    filters: Record<string, number>;
    sizing: { kellyProbShrink: number; maxBetAmountUsd: number };
    orderRouter: { fokMlThreshold: number; limitMlThreshold: number; cheapMlThreshold: number; fokMaxPrice: number };
    limitOrder: { minMlConfidence: number; minRemainingEdge: number };
    phaseThresholds: Record<PhaseName, { minEdge: number; minProb: number }>;
  };
  version: number;
}

const BOUNDS = {
  sizing: {
    kellyProbShrink: { min: 0, max: 1 },
    maxBetAmountUsd: { min: 1, max: 100 },
  },
  orderRouter: {
    fokMlThreshold: { min: 0.50, max: 0.95 },
    limitMlThreshold: { min: 0.35, max: 0.85 },
    cheapMlThreshold: { min: 0.45, max: 0.90 },
    fokMaxPrice: { min: 0.45, max: 0.85 },
  },
  limitOrder: {
    minMlConfidence: { min: 0.35, max: 0.90 },
    minRemainingEdge: { min: 0, max: 0.20 },
  },
  phase: {
    minEdge: { min: 0.01, max: 0.30 },
    minProb: { min: 0.50, max: 0.85 },
  },
} as const;

function pickNumberMap(
  raw: unknown,
  specs: Record<string, { min: number; max: number }>,
  section: string,
  refused: string[],
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val === undefined || val === null || val === '') continue;
    const spec = specs[key];
    if (!spec) {
      refused.push(`Unknown ${section}.${key} — ignored`);
      continue;
    }
    const n = typeof val === 'number' ? val : Number(String(val).trim());
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
      refused.push(`${section}.${key}=${String(val)} outside [${spec.min}, ${spec.max}] — ignored`);
      continue;
    }
    out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate and normalize a user-supplied profile before storing/applying it. */
export function sanitizeModelProfile(
  raw: unknown,
  baseFilters: FilterThresholds,
): { profile: ModelConfigProfile; refused: string[] } {
  const refused: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { profile: {}, refused: ['Profile payload must be an object'] };
  }
  const src = raw as Record<string, unknown>;
  const profile: ModelConfigProfile = {
    updatedAt: new Date().toISOString(),
  };

  if (typeof src.label === 'string') {
    const trimmed = src.label.trim().slice(0, 48);
    if (trimmed) profile.label = trimmed;
  }
  if (typeof src.notes === 'string') {
    const trimmed = src.notes.trim().slice(0, 240);
    if (trimmed) profile.notes = trimmed;
  }

  if (src.filters && typeof src.filters === 'object') {
    const res = validateFilterThresholdOverrides(baseFilters, src.filters as Record<string, unknown>);
    refused.push(...res.refused);
    if (Object.keys(res.applied).length > 0) profile.filters = res.applied;
  }

  const sizing = pickNumberMap(src.sizing, BOUNDS.sizing, 'sizing', refused);
  if (sizing) profile.sizing = sizing as ModelSizingOverride;

  const router = pickNumberMap(src.orderRouter, BOUNDS.orderRouter, 'orderRouter', refused);
  if (router) profile.orderRouter = router as ModelOrderRouterOverride;

  const limit = pickNumberMap(src.limitOrder, BOUNDS.limitOrder, 'limitOrder', refused);
  if (limit) profile.limitOrder = limit as ModelLimitOrderOverride;

  if (src.phaseThresholds && typeof src.phaseThresholds === 'object') {
    const ptOut: Partial<Record<PhaseName, PhaseThresholdOverride>> = {};
    for (const [phase, pVal] of Object.entries(src.phaseThresholds as Record<string, unknown>)) {
      if (!PHASES.includes(phase as PhaseName)) {
        refused.push(`Unknown phaseThresholds.${phase} — ignored`);
        continue;
      }
      const picked = pickNumberMap(pVal, BOUNDS.phase, `phaseThresholds.${phase}`, refused);
      if (picked) ptOut[phase as PhaseName] = picked as PhaseThresholdOverride;
    }
    if (Object.keys(ptOut).length > 0) profile.phaseThresholds = ptOut;
  }

  return { profile, refused };
}

function isProfileEmpty(profile: ModelConfigProfile | null | undefined): boolean {
  if (!profile) return true;
  return (
    !profile.label &&
    !profile.notes &&
    (!profile.filters || Object.keys(profile.filters).length === 0) &&
    (!profile.sizing || Object.keys(profile.sizing).length === 0) &&
    (!profile.orderRouter || Object.keys(profile.orderRouter).length === 0) &&
    (!profile.limitOrder || Object.keys(profile.limitOrder).length === 0) &&
    (!profile.phaseThresholds || Object.keys(profile.phaseThresholds).length === 0)
  );
}

function summarizeManifest(
  m: Manifest,
  status: string,
  profile: ModelConfigProfile | undefined,
): StoredModelSummary {
  const ens = (m.metrics?.ensemble ?? {}) as Record<string, unknown>;
  const xgb = (m.metrics?.xgb ?? {}) as Record<string, unknown>;
  const meta = (m.training?.meta ?? {}) as Record<string, any>;
  const firstTs = typeof meta.first_slug_ts === 'number' ? meta.first_slug_ts : null;
  const lastTs = typeof meta.last_slug_ts === 'number' ? meta.last_slug_ts : null;
  const windowDays = firstTs != null && lastTs != null && lastTs > firstTs
    ? Math.max(1, Math.round((lastTs - firstTs) / 86_400))
    : null;
  return {
    id: m.id,
    featurePipeline: m.featurePipeline,
    registeredAt: m.registeredAt,
    source: m.source,
    status,
    windowDays,
    dateStart: firstTs != null ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null,
    dateEnd: lastTs != null ? new Date(lastTs * 1000).toISOString().slice(0, 10) : null,
    rows: typeof meta.rows === 'number' ? meta.rows : null,
    accuracy: typeof (ens.accuracy ?? xgb.accuracy) === 'number' ? (ens.accuracy ?? xgb.accuracy) as number : null,
    auc: typeof (ens.auc ?? xgb.auc) === 'number' ? (ens.auc ?? xgb.auc) as number : null,
    ece: typeof (ens.calibration_ece ?? xgb.calibration_ece) === 'number' ? (ens.calibration_ece ?? xgb.calibration_ece) as number : null,
    brierSkill: typeof (ens.brier_skill_vs_market ?? xgb.brier_skill_vs_market) === 'number'
      ? (ens.brier_skill_vs_market ?? xgb.brier_skill_vs_market) as number
      : null,
    notes: Array.isArray(m.notes) ? m.notes.slice(0, 3) : [],
    hasProfile: !isProfileEmpty(profile),
    profileLabel: profile?.label ?? null,
  };
}

function hasStoredArtifacts(registryRoot: string, id: string, m: Manifest): boolean {
  if (m.artifactRef) return false;
  const dir = resolve(registryRoot, 'models', id);
  return MODEL_FILES.every(f => existsSync(resolve(dir, `${f}.gz`)));
}

function pickCuratedFilterMap(filters: FilterThresholds): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of UI_FILTER_KEYS) {
    if (key in filters) out[key] = filters[key];
  }
  return out;
}

export interface ManagerDeps {
  registryRoot: string;
  publicMlDir: string;
  backupDir: string;
  profilesFile: string;
  getBaselineFilters?: () => FilterThresholds;
  applyFilters?: (overrides?: Record<string, unknown> | null) => { applied: Partial<FilterThresholds>; refused: string[] };
  getActiveCalibratedPhases?: () => Record<string, any> | null;
  getActiveFeaturePipeline?: () => number;
  getBaselineConfig?: () => {
    kellyProbShrink: number;
    maxBetAmountUsd: number;
    orderRouter: typeof BOT_CONFIG.orderRouter;
    limitOrder: typeof BOT_CONFIG.limitOrder;
  };
}

export interface SwitchHooks {
  reloadModel?: () => boolean;
  hasPendingOrder?: () => boolean;
  isLimitOrderActive?: () => boolean;
  getOpenPosition?: () => Record<string, any> | null;
  runExclusive?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  resetPostSwitch?: () => void;
}

/** Create an isolated model profile + switcher manager (testable with tmp dirs). */
export function createModelProfileManager(deps: ManagerDeps) {
  const getBaseFilters = deps.getBaselineFilters ?? getBaselineFilterThresholds;
  const applyFilters = deps.applyFilters ?? applyFilterThresholdOverrides;
  const getBaseCfg = deps.getBaselineConfig ?? (() => ({
    kellyProbShrink: BOT_CONFIG.kellyProbShrink,
    maxBetAmountUsd: BOT_CONFIG.maxBetAmountUsd,
    orderRouter: BOT_CONFIG.orderRouter,
    limitOrder: BOT_CONFIG.limitOrder,
  }));

  let store: ModelProfilesFile = { version: 1, activeModelId: null, profiles: {} };
  let currentActiveId: string | null = null;
  let activeProfile: ModelConfigProfile | null = null;
  let version = 1;
  let cachedState: ModelControlState | null = null;
  let cachedModels: StoredModelSummary[] | null = null;

  function loadStore(): void {
    try {
      if (!existsSync(deps.profilesFile)) return;
      const raw = JSON.parse(readFileSync(deps.profilesFile, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
        const cleanProfiles: Record<string, ModelConfigProfile> = {};
        const baseFilters = getBaseFilters();
        for (const [id, prof] of Object.entries(raw.profiles as Record<string, unknown>)) {
          const { profile } = sanitizeModelProfile(prof, baseFilters);
          if (!isProfileEmpty(profile)) cleanProfiles[id] = profile;
        }
        store = {
          version: 1,
          activeModelId: typeof raw.activeModelId === 'string' ? raw.activeModelId : null,
          profiles: cleanProfiles,
        };
      }
    } catch (err: any) {
      log.warn(`Could not read ${deps.profilesFile}: ${err?.message ?? err}`);
    }
  }

  function persistStore(): void {
    const dir = dirname(deps.profilesFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${deps.profilesFile}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, deps.profilesFile);
  }

  function refreshModels(): StoredModelSummary[] {
    try {
      const manifests = listManifests(deps.registryRoot);
      const statuses = modelStatuses(deps.registryRoot);
      const list = manifests
        .filter(m => hasStoredArtifacts(deps.registryRoot, m.id, m))
        .sort((a, b) => b.id.localeCompare(a.id))
        .map(m => summarizeManifest(m, statuses[m.id] ?? 'candidate', store.profiles[m.id]));
      cachedModels = list;
      return list;
    } catch {
      cachedModels = cachedModels ?? [];
      return cachedModels;
    }
  }

  function buildPhaseBaseline(): Record<PhaseName, { minEdge: number; minProb: number }> {
    const cal = deps.getActiveCalibratedPhases?.() ?? null;
    return {
      EARLY:     { minEdge: cal?.EARLY?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.EARLY.minEdge,         minProb: cal?.EARLY?.minProb ?? DEFAULT_PHASE_THRESHOLDS.EARLY.minProb },
      MID:       { minEdge: cal?.MID?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.MID.minEdge,             minProb: cal?.MID?.minProb ?? DEFAULT_PHASE_THRESHOLDS.MID.minProb },
      LATE:      { minEdge: cal?.LATE?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.LATE.minEdge,           minProb: cal?.LATE?.minProb ?? DEFAULT_PHASE_THRESHOLDS.LATE.minProb },
      VERY_LATE: { minEdge: cal?.VERY_LATE?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.VERY_LATE.minEdge, minProb: cal?.VERY_LATE?.minProb ?? DEFAULT_PHASE_THRESHOLDS.VERY_LATE.minProb },
    };
  }

  function buildEffectivePhases(
    baseCalibrated?: Record<string, any> | null,
  ): Record<PhaseName, { minEdge: number; minProb: number }> {
    const cal = baseCalibrated !== undefined ? baseCalibrated : (deps.getActiveCalibratedPhases?.() ?? null);
    const out = {
      EARLY:     { minEdge: cal?.EARLY?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.EARLY.minEdge,         minProb: cal?.EARLY?.minProb ?? DEFAULT_PHASE_THRESHOLDS.EARLY.minProb },
      MID:       { minEdge: cal?.MID?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.MID.minEdge,             minProb: cal?.MID?.minProb ?? DEFAULT_PHASE_THRESHOLDS.MID.minProb },
      LATE:      { minEdge: cal?.LATE?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.LATE.minEdge,           minProb: cal?.LATE?.minProb ?? DEFAULT_PHASE_THRESHOLDS.LATE.minProb },
      VERY_LATE: { minEdge: cal?.VERY_LATE?.minEdge ?? DEFAULT_PHASE_THRESHOLDS.VERY_LATE.minEdge, minProb: cal?.VERY_LATE?.minProb ?? DEFAULT_PHASE_THRESHOLDS.VERY_LATE.minProb },
    };
    const overrides = activeProfile?.phaseThresholds;
    if (!overrides) return out;
    for (const phase of PHASES) {
      const ov = overrides[phase];
      if (!ov) continue;
      if (typeof ov.minEdge === 'number' && Number.isFinite(ov.minEdge)) out[phase].minEdge = ov.minEdge;
      if (typeof ov.minProb === 'number' && Number.isFinite(ov.minProb)) out[phase].minProb = ov.minProb;
    }
    return out;
  }

  function rebuildState(forceModelScan = false): ModelControlState {
    if (forceModelScan || !cachedModels) refreshModels();
    const baseCfg = getBaseCfg();
    const baseFilters = getBaseFilters();
    const effFilters = applyFilters(activeProfile?.filters ?? null);
    const effFilterValues: FilterThresholds = { ...baseFilters, ...effFilters.applied };
    const phaseBase = buildPhaseBaseline();
    const phaseEff = buildEffectivePhases();

    cachedState = {
      activeModelId: currentActiveId,
      featurePipeline: deps.getActiveFeaturePipeline?.() ?? 2,
      models: cachedModels ?? [],
      profiles: { ...store.profiles },
      baseline: {
        filters: pickCuratedFilterMap(baseFilters),
        sizing: { kellyProbShrink: baseCfg.kellyProbShrink, maxBetAmountUsd: baseCfg.maxBetAmountUsd },
        orderRouter: {
          fokMlThreshold: baseCfg.orderRouter.fokMlThreshold,
          limitMlThreshold: baseCfg.orderRouter.limitMlThreshold,
          cheapMlThreshold: baseCfg.orderRouter.cheapMlThreshold,
          fokMaxPrice: baseCfg.orderRouter.fokMaxPrice,
        },
        limitOrder: {
          minMlConfidence: baseCfg.limitOrder.minMlConfidence,
          minRemainingEdge: baseCfg.limitOrder.minRemainingEdge,
        },
        phaseThresholds: phaseBase,
      },
      effective: {
        filters: pickCuratedFilterMap(effFilterValues),
        sizing: {
          kellyProbShrink: activeProfile?.sizing?.kellyProbShrink ?? baseCfg.kellyProbShrink,
          maxBetAmountUsd: activeProfile?.sizing?.maxBetAmountUsd ?? baseCfg.maxBetAmountUsd,
        },
        orderRouter: {
          fokMlThreshold: activeProfile?.orderRouter?.fokMlThreshold ?? baseCfg.orderRouter.fokMlThreshold,
          limitMlThreshold: activeProfile?.orderRouter?.limitMlThreshold ?? baseCfg.orderRouter.limitMlThreshold,
          cheapMlThreshold: activeProfile?.orderRouter?.cheapMlThreshold ?? baseCfg.orderRouter.cheapMlThreshold,
          fokMaxPrice: activeProfile?.orderRouter?.fokMaxPrice ?? baseCfg.orderRouter.fokMaxPrice,
        },
        limitOrder: {
          minMlConfidence: activeProfile?.limitOrder?.minMlConfidence ?? baseCfg.limitOrder.minMlConfidence,
          minRemainingEdge: activeProfile?.limitOrder?.minRemainingEdge ?? baseCfg.limitOrder.minRemainingEdge,
        },
        phaseThresholds: phaseEff,
      },
      version,
    };
    return cachedState;
  }

  function applyProfileForModel(modelId: string | null): void {
    currentActiveId = modelId;
    activeProfile = modelId ? (store.profiles[modelId] ?? null) : null;
    applyFilters(activeProfile?.filters ?? null);
    version++;
    rebuildState(true);
    if (modelId) {
      const label = activeProfile?.label ? ` (${activeProfile.label})` : '';
      log.info(`Active model profile applied for ${modelId}${label}`);
    }
  }

  function init(activeModelId: string | null): void {
    loadStore();
    const resolvedId = activeModelId ?? store.activeModelId;
    if (resolvedId && store.activeModelId !== resolvedId) {
      store.activeModelId = resolvedId;
      try { persistStore(); } catch { /* */ }
    }
    applyProfileForModel(resolvedId);
  }

  function saveProfile(
    modelId: string,
    rawProfile: unknown,
  ): { ok: boolean; modelId?: string; profile?: ModelConfigProfile | null; refused?: string[]; error?: string; mlControl?: ModelControlState } {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return { ok: false, error: 'invalid_model_id' };
    }
    const id = modelId.trim();
    const manifest = readManifest(deps.registryRoot, id);
    if (!manifest) {
      return { ok: false, error: `model_${id}_not_registered` };
    }
    const baseFilters = getBaseFilters();
    const { profile, refused } = sanitizeModelProfile(rawProfile, baseFilters);
    if (isProfileEmpty(profile)) {
      delete store.profiles[id];
    } else {
      store.profiles[id] = profile;
    }
    try {
      persistStore();
    } catch (err: any) {
      return { ok: false, error: `persist_failed: ${err?.message ?? err}` };
    }
    if (id === currentActiveId) {
      applyProfileForModel(id);
    } else {
      version++;
      rebuildState(true);
    }
    return {
      ok: true,
      modelId: id,
      profile: store.profiles[id] ?? null,
      refused,
      mlControl: getControlState(),
    };
  }

  function resetProfile(modelId: string): { ok: boolean; modelId?: string; error?: string; mlControl?: ModelControlState } {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return { ok: false, error: 'invalid_model_id' };
    }
    const id = modelId.trim();
    delete store.profiles[id];
    try {
      persistStore();
    } catch (err: any) {
      return { ok: false, error: `persist_failed: ${err?.message ?? err}` };
    }
    if (id === currentActiveId) {
      applyProfileForModel(id);
    } else {
      version++;
      rebuildState(true);
    }
    return { ok: true, modelId: id, mlControl: getControlState() };
  }

  function rollbackFiles(): void {
    for (const f of MODEL_FILES) {
      const rb = resolve(deps.backupDir, `rollback_${f}`);
      if (existsSync(rb)) {
        copyFileSync(rb, resolve(deps.publicMlDir, f));
      }
    }
  }

  async function switchModel(
    targetModelId: string,
    hooks: SwitchHooks = {},
  ): Promise<{
    ok: boolean;
    modelId?: string;
    previousId?: string | null;
    warning?: string | null;
    error?: string;
    mlControl?: ModelControlState;
  }> {
    if (typeof targetModelId !== 'string' || !targetModelId.trim()) {
      return { ok: false, error: 'invalid_model_id' };
    }
    const id = targetModelId.trim();
    const manifest = readManifest(deps.registryRoot, id);
    if (!manifest) return { ok: false, error: `Model ${id} is not registered` };
    if (!hasStoredArtifacts(deps.registryRoot, id, manifest)) {
      return { ok: false, error: `Model ${id} has no local runnable artifacts` };
    }
    if (hooks.hasPendingOrder?.()) {
      return { ok: false, error: 'pending_order_active — wait for current order to settle' };
    }
    if (hooks.isLimitOrderActive?.()) {
      return { ok: false, error: 'active_limit_order — wait for limit order fill or cancel first' };
    }

    const execute = async () => {
      if (hooks.hasPendingOrder?.()) {
        return { ok: false, error: 'pending_order_active — wait for current order to settle' };
      }
      if (hooks.isLimitOrderActive?.()) {
        return { ok: false, error: 'active_limit_order — wait for limit order fill or cancel first' };
      }

      const prevId = currentActiveId;
      let previousIdFromDeploy: string | null = prevId;
      try {
        const res = deployModel({
          root: deps.registryRoot,
          id,
          targetDir: deps.publicMlDir,
          backupDir: deps.backupDir,
          actor: 'dashboard',
          note: 'switched via web dashboard',
        });
        previousIdFromDeploy = res.previousId;
      } catch (err: any) {
        return { ok: false, error: `deploy_failed: ${err?.message ?? err}` };
      }

      if (hooks.reloadModel) {
        let reloaded = false;
        try {
          reloaded = hooks.reloadModel();
        } catch {
          reloaded = false;
        }
        if (!reloaded) {
          log.error(`Hot-reload of ${id} failed — rolling back to ${previousIdFromDeploy ?? 'previous'}`);
          try {
            rollbackFiles();
            hooks.reloadModel();
          } catch { /* best-effort */ }
          return { ok: false, error: 'model_reload_failed_rolled_back' };
        }
      }

      try {
        writeFileSync(resolve(deps.registryRoot, 'MODELS.md'), renderModelsMd(deps.registryRoot));
      } catch (err: any) {
        log.warn(`MODELS.md update failed after switch: ${err?.message ?? err}`);
      }

      store.activeModelId = id;
      try { persistStore(); } catch (err: any) { log.warn(`Persist profile store failed: ${err?.message ?? err}`); }
      applyProfileForModel(id);
      hooks.resetPostSwitch?.();

      const openPos = hooks.getOpenPosition?.();
      const warning = openPos && !openPos.settled
        ? 'Open position keeps its original entry modelId until settlement; new model applies to next trade.'
        : null;

      return {
        ok: true,
        modelId: id,
        previousId: previousIdFromDeploy,
        warning,
        mlControl: getControlState(true),
      };
    };

    return hooks.runExclusive ? hooks.runExclusive(execute) : execute();
  }

  function getControlState(refresh = false): ModelControlState {
    if (!cachedState || refresh) return rebuildState(refresh);
    return cachedState;
  }

  function getKellyProbShrink(): number {
    return activeProfile?.sizing?.kellyProbShrink ?? getBaseCfg().kellyProbShrink;
  }

  function getMaxBetAmountUsd(): number {
    return activeProfile?.sizing?.maxBetAmountUsd ?? getBaseCfg().maxBetAmountUsd;
  }

  function getOrderRouterConfig() {
    const base = getBaseCfg().orderRouter;
    const ov = activeProfile?.orderRouter;
    return ov ? { ...base, ...ov } : base;
  }

  function getLimitOrderConfig() {
    const base = getBaseCfg().limitOrder;
    const ov = activeProfile?.limitOrder;
    return ov ? { ...base, ...ov } : base;
  }

  return {
    init,
    applyProfileForModel,
    listModels: refreshModels,
    saveProfile,
    resetProfile,
    switchModel,
    getControlState,
    getEffectivePhaseThresholds: buildEffectivePhases,
    getKellyProbShrink,
    getMaxBetAmountUsd,
    getOrderRouterConfig,
    getLimitOrderConfig,
    getActiveProfile: () => activeProfile,
    getActiveModelId: () => currentActiveId,
    getFilterSpecs: () => FILTER_THRESHOLD_SPECS,
  };
}

// ── Default singleton wired to repo paths ──
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const defaultManager = createModelProfileManager({
  registryRoot: resolve(REPO_ROOT, 'ml_registry'),
  publicMlDir: resolve(REPO_ROOT, 'public', 'ml'),
  backupDir: resolve(REPO_ROOT, 'public', 'ml', 'backups'),
  profilesFile: resolve(REPO_ROOT, 'bot', 'data', 'model_profiles.json'),
  getActiveCalibratedPhases: () => getCalibratedPhaseThresholds(),
  getActiveFeaturePipeline: () => getFeaturePipeline(),
});

export const initModelProfiles = defaultManager.init;
export const listStoredModels = defaultManager.listModels;
export const saveModelProfile = defaultManager.saveProfile;
export const resetModelProfile = defaultManager.resetProfile;
export const switchActiveModel = defaultManager.switchModel;
export const getModelControlState = defaultManager.getControlState;
export const getEffectivePhaseThresholds = defaultManager.getEffectivePhaseThresholds;
export const getEffectiveKellyProbShrink = defaultManager.getKellyProbShrink;
export const getEffectiveMaxBetAmountUsd = defaultManager.getMaxBetAmountUsd;
export const getEffectiveOrderRouterConfig = defaultManager.getOrderRouterConfig;
export const getEffectiveLimitOrderConfig = defaultManager.getLimitOrderConfig;
