/**
 * Automated Milestone Readiness & Auto-Promotion Monitor.
 *
 * Runs automatically on every perfMonitor cycle (startup +5s, then every 15 min)
 * without requiring external cron jobs or manual SSH audits:
 *   1. Refreshes Stage-2 Meta-Labeler from trade_journal.jsonl so auto-promotion
 *      (SHADOW -> VETO at trades >= 100 & holdoutAUC >= 0.58) triggers live with
 *      zero restart, and self-guards (auto-demotes if AUC < 0.56).
 *   2. Evaluates every minimal readiness gate documented in UPDATES.md:
 *      - online_ml_calibration (windows >= 100 & calBrier < rawBrier)
 *      - jev_v5_veto           (v5_windows >= 150 & skill > 0%)
 *      - meta_labeler_veto     (trades >= 100 & holdoutAUC >= 0.58)
 *      - maker_markout_audit   (>= 15 post-Cancel-on-Toxicity maker_join fills w/ markout)
 *      - tape_v4_retrain       (>= 75 distinct tape days)
 *      - live_money_readiness  (advisory ONLY — NEVER auto-switches DRY_RUN=false)
 *   3. Persists transition state to `bot/data/milestone_state.json` (atomic write)
 *      and sends deduplicated Telegram alerts via `notify()` whenever a milestone
 *      transitions WAIT -> READY / AUTO-ACTIVE or ACTIVE -> DEMOTED.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { getMlOnlineCalibrationStatus } from '../ml/onlineCalibration.ts';
import { getMetaLabelerStatus, syncMetaLabelerFromJournal } from '../ml/metaLabeler.ts';
import { notify } from './notifier.ts';

const log = createLogger('Milestones');

/** Timestamp of Cancel-on-Toxicity deployment (commit 48cf9f3, 2026-11-25 09:01 WIB). */
export const MAKER_TOXICITY_AUDIT_SINCE_MS = Date.parse('2026-11-25T02:01:00Z');
/** Archived R2 tape days already covered through 2026-11-16 (per UPDATES.md). */
export const TAPE_BASELINE_DAYS = 54;
export const TAPE_BASELINE_LAST_DATE = '2026-11-16';

export type MilestoneId =
  | 'online_ml_calibration'
  | 'jev_v5_veto'
  | 'meta_labeler_veto'
  | 'maker_markout_audit'
  | 'tape_v4_retrain'
  | 'live_money_readiness';

export type MilestoneStatus = 'wait' | 'ready' | 'active' | 'demoted';

export interface MilestoneResult {
  id: MilestoneId;
  label: string;
  status: MilestoneStatus;
  autoManaged: boolean;
  summary: string;
  detail: string;
}

export interface PersistedMilestoneState {
  version: 1;
  updatedAt: number;
  milestones: Partial<Record<MilestoneId, {
    status: MilestoneStatus;
    notifiedAt: number | null;
    summary: string;
  }>>;
}

export interface MilestoneInputs {
  onlineCalib: {
    mode: 'shadow' | 'active' | 'auto';
    effectiveMode: 'shadow' | 'active';
    historySize: number;
    allowActive: boolean;
    rawMlBrier: number | null;
    calMlBrier: number | null;
    promoteMinWindows?: number;
  };
  jevV5: {
    mode: string;
    v5Windows: number;
    skillPct: number | null;
    dirAccPct: number | null;
  };
  metaLabeler: {
    mode: 'shadow' | 'veto' | 'auto';
    effectiveMode: 'shadow' | 'veto';
    autoPromoted: boolean;
    samples: number;
    holdoutAuc: number | null;
    baseWinRate: number | null;
    promoteMinSamples: number;
    promoteMinAuc: number;
  };
  makerAudit: {
    postPatchFills: number;
    wins: number;
    m15Avg: number | null;
    m60Avg: number | null;
    minFills?: number;
  };
  tapeDays: number;
  paperPerformance: {
    totalTrades: number;
    winRate: number | null;
    avgEntryPrice: number | null;
  };
  dryRun: boolean;
}

/** Pure milestone evaluator — deterministic and unit-testable. */
export function evaluateMilestones(input: MilestoneInputs): MilestoneResult[] {
  const results: MilestoneResult[] = [];

  // 1. Online ML Calibration
  const minCalWin = input.onlineCalib.promoteMinWindows ?? 100;
  const calReady = input.onlineCalib.historySize >= minCalWin && input.onlineCalib.allowActive;
  const calStatus: MilestoneStatus = input.onlineCalib.effectiveMode === 'active'
    ? 'active'
    : (calReady ? 'ready' : 'wait');
  results.push({
    id: 'online_ml_calibration',
    label: 'Online ML Calibration',
    status: calStatus,
    autoManaged: input.onlineCalib.mode === 'auto' || input.onlineCalib.mode === 'active',
    summary: `windows=${input.onlineCalib.historySize}/${minCalWin} raw=${input.onlineCalib.rawMlBrier?.toFixed(4) ?? '-'} cal=${input.onlineCalib.calMlBrier?.toFixed(4) ?? '-'}`,
    detail: `mode=${input.onlineCalib.mode}→${input.onlineCalib.effectiveMode}`,
  });

  // 2. JEV v5 Veto
  const jevReady = input.jevV5.v5Windows >= 150 && input.jevV5.skillPct != null && input.jevV5.skillPct > 0;
  const jevStatus: MilestoneStatus = input.jevV5.mode === 'veto'
    ? 'active'
    : (jevReady ? 'ready' : 'wait');
  results.push({
    id: 'jev_v5_veto',
    label: 'JEV v5 Veto',
    status: jevStatus,
    autoManaged: input.jevV5.mode === 'veto',
    summary: `v5=${input.jevV5.v5Windows}/150 skill=${input.jevV5.skillPct != null ? `${input.jevV5.skillPct >= 0 ? '+' : ''}${input.jevV5.skillPct.toFixed(2)}%` : '-'} dirAcc=${input.jevV5.dirAccPct != null ? `${input.jevV5.dirAccPct.toFixed(1)}%` : '-'}`,
    detail: `mode=${input.jevV5.mode}`,
  });

  // 3. Stage-2 Meta-Labeler (auto-promotes SHADOW -> VETO in mode=auto)
  const mlSamples = input.metaLabeler.samples;
  const mlTarget = input.metaLabeler.promoteMinSamples;
  const mlAuc = input.metaLabeler.holdoutAuc;
  const mlTargetAuc = input.metaLabeler.promoteMinAuc;
  const metaReady = mlSamples >= mlTarget && mlAuc != null && mlAuc >= mlTargetAuc;
  const metaStatus: MilestoneStatus = input.metaLabeler.effectiveMode === 'veto'
    ? 'active'
    : (metaReady ? 'ready' : 'wait');
  results.push({
    id: 'meta_labeler_veto',
    label: 'Stage-2 Meta-Labeler',
    status: metaStatus,
    autoManaged: input.metaLabeler.mode === 'auto' || input.metaLabeler.mode === 'veto',
    summary: `trades=${mlSamples}/${mlTarget} AUC=${mlAuc != null ? mlAuc.toFixed(4) : '-'} (min ${mlTargetAuc}) baseWR=${input.metaLabeler.baseWinRate != null ? `${(input.metaLabeler.baseWinRate * 100).toFixed(1)}%` : '-'}`,
    detail: input.metaLabeler.autoPromoted
      ? 'AUTO-PROMOTED SHADOW → VETO (self-guard active)'
      : `mode=${input.metaLabeler.mode}→${input.metaLabeler.effectiveMode}`,
  });

  // 4. Maker Cancel-on-Toxicity Markout Audit
  const minMakerFills = input.makerAudit.minFills ?? 15;
  const makerReady = input.makerAudit.postPatchFills >= minMakerFills;
  const makerPos = (input.makerAudit.m15Avg ?? -1) >= 0 && (input.makerAudit.m60Avg ?? -1) >= 0;
  const makerWr = input.makerAudit.postPatchFills > 0
    ? `${((input.makerAudit.wins / input.makerAudit.postPatchFills) * 100).toFixed(1)}%`
    : '-';
  results.push({
    id: 'maker_markout_audit',
    label: 'Maker Cancel-on-Toxicity Audit',
    status: makerReady ? 'ready' : 'wait',
    autoManaged: false,
    summary: `fills=${input.makerAudit.postPatchFills}/${minMakerFills} WR=${makerWr} m15=${input.makerAudit.m15Avg != null ? `${(input.makerAudit.m15Avg * 100).toFixed(2)}c` : '-'} m60=${input.makerAudit.m60Avg != null ? `${(input.makerAudit.m60Avg * 100).toFixed(2)}c` : '-'}`,
    detail: makerReady
      ? (makerPos ? 'Markout POSITIVE (adverse selection terkendali)' : 'Markout masih NEGATIF — review threshold Cancel-on-Toxicity')
      : 'Mengumpulkan sampel fill pasca-patch',
  });

  // 5. Pipeline v4 R2 Tape Retrain (>= 75 days)
  const tapeTarget = 75;
  results.push({
    id: 'tape_v4_retrain',
    label: 'Pipeline v4 Tape Retrain',
    status: input.tapeDays >= tapeTarget ? 'ready' : 'wait',
    autoManaged: false,
    summary: `tape=${input.tapeDays}/${tapeTarget} hari`,
    detail: input.tapeDays >= tapeTarget
      ? 'Siap jalankan retrain Pipeline v4 (tape >= 75 hari)'
      : 'Menunggu akumulasi tape R2',
  });

  // 6. Live Money Readiness (Advisory ONLY — never auto-enables real money)
  const wr = input.paperPerformance.winRate;
  const avgPx = input.paperPerformance.avgEntryPrice;
  const bePlus3 = avgPx != null ? avgPx + 0.03 : null;
  const wrClears = wr != null && bePlus3 != null && wr >= bePlus3;
  const liveReady = input.dryRun
    && input.paperPerformance.totalTrades >= 100
    && (metaStatus === 'active' || metaStatus === 'ready')
    && makerReady && makerPos
    && wrClears;
  results.push({
    id: 'live_money_readiness',
    label: 'Live Money Readiness (5-share)',
    status: !input.dryRun ? 'active' : (liveReady ? 'ready' : 'wait'),
    autoManaged: false,
    summary: `trades=${input.paperPerformance.totalTrades}/100 WR=${wr != null ? `${(wr * 100).toFixed(1)}%` : '-'} target>=${bePlus3 != null ? `${(bePlus3 * 100).toFixed(1)}%` : '-'} makerPos=${makerPos}`,
    detail: liveReady
      ? 'Semua syarat minimal terpenuhi — konfirmasi manual diperlukan untuk DRY_RUN=false'
      : (input.dryRun ? 'Tetap DRY_RUN sampai semua syarat minimal lolos' : 'LIVE aktif'),
  });

  return results;
}

function readJsonlSafe(path: string): any[] {
  if (!path || !existsSync(path)) return [];
  const out: any[] = [];
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return out;
}

function readJevV5Stats(logFile: string | undefined): { v5Windows: number; skillPct: number | null; dirAccPct: number | null } {
  if (!logFile || !existsSync(logFile)) return { v5Windows: 0, skillPct: null, dirAccPct: null };
  const outcomesFile = resolve(dirname(logFile), 'jev_outcomes.json');
  if (!existsSync(outcomesFile)) return { v5Windows: 0, skillPct: null, dirAccPct: null };
  try {
    const outcomes = JSON.parse(readFileSync(outcomesFile, 'utf8')) as Record<string, string | { outcome?: string }>;
    const bySlug = new Map<string, any>();
    for (const r of readJsonlSafe(logFile)) {
      const slug = r?.slug;
      const raw = outcomes[slug];
      const out = typeof raw === 'string' ? raw : raw?.outcome;
      if (out !== 'UP' && out !== 'DOWN') continue;
      const ver = String(r.stateVariant ?? r.calibrationVersion ?? r.variant ?? '');
      if (!ver.includes('v5') && !ver.includes('online-platt-v5')) continue;
      bySlug.set(slug, { ...r, y: out === 'UP' ? 1 : 0, outcome: out });
    }
    const list = [...bySlug.values()];
    if (list.length === 0) return { v5Windows: 0, skillPct: null, dirAccPct: null };
    let bSum = 0, mSum = 0, dTot = 0, dHit = 0;
    for (const r of list) {
      const bp = Number(r.bayesianProbUp ?? r.bayesianUpProbability ?? r.settleUpCalibrated ?? r.settleUpProbability ?? 0.5);
      const mp = Number(r.market?.marketUp ?? r.market?.up ?? r.state?.market_odds?.up ?? 0.5);
      bSum += (bp - r.y) ** 2;
      mSum += (mp - r.y) ** 2;
      if (r.direction === 'UP' || r.direction === 'DOWN') {
        dTot++;
        if (r.direction === r.outcome) dHit++;
      }
    }
    const skillPct = mSum > 0 ? ((mSum - bSum) / mSum) * 100 : null;
    const dirAccPct = dTot > 0 ? (dHit / dTot) * 100 : null;
    return { v5Windows: list.length, skillPct, dirAccPct };
  } catch {
    return { v5Windows: 0, skillPct: null, dirAccPct: null };
  }
}

function readJournalStats(journalFile: string, makerSinceMs = MAKER_TOXICITY_AUDIT_SINCE_MS) {
  const rows = readJsonlSafe(journalFile);
  let total = 0, wins = 0, pxSum = 0;
  let postFills = 0, postWins = 0;
  const m15: number[] = [];
  const m60: number[] = [];
  for (const r of rows) {
    const e = r?.entry;
    const a = r?.analysis;
    if (!e || !a) continue;
    const isWin = a.outcome === 'WIN';
    const isLoss = a.outcome === 'LOSS';
    if (!isWin && !isLoss) continue;
    total++;
    if (isWin) wins++;
    const px = Number(e.actualPrice ?? e.tokenPrice);
    if (Number.isFinite(px) && px > 0 && px < 1) pxSum += px;

    const enteredAt = Number(e.enteredAt ?? r._ts ?? 0);
    if (e.fillModel === 'maker_join' && enteredAt >= makerSinceMs) {
      const mk = a.markout;
      if (mk && typeof mk.m15s === 'number' && Number.isFinite(mk.m15s)) {
        postFills++;
        if (isWin) postWins++;
        m15.push(mk.m15s);
        if (typeof mk.m60s === 'number' && Number.isFinite(mk.m60s)) m60.push(mk.m60s);
      }
    }
  }
  return {
    paperPerformance: {
      totalTrades: total,
      winRate: total > 0 ? wins / total : null,
      avgEntryPrice: total > 0 ? pxSum / total : null,
    },
    makerAudit: {
      postPatchFills: postFills,
      wins: postWins,
      m15Avg: m15.length > 0 ? m15.reduce((s, v) => s + v, 0) / m15.length : null,
      m60Avg: m60.length > 0 ? m60.reduce((s, v) => s + v, 0) / m60.length : null,
    },
  };
}

function estimateTapeDays(dataDir: string): number {
  // Baseline 54 days already archived in R2 through 2026-11-16 + new tape days since.
  // Finished hourly tape files are uploaded to R2 and deleted locally, so count calendar days
  // since 2026-11-16 whenever local tape dir is active (has at least 1 day dir >= 2026-11-17).
  const tapeDir = resolve(dataDir, 'tape');
  let latestDate = TAPE_BASELINE_LAST_DATE;
  if (existsSync(tapeDir)) {
    try {
      for (const name of readdirSync(tapeDir)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name > latestDate) latestDate = name;
      }
    } catch { /* ignore */ }
  }
  const extraDays = Math.max(
    0,
    Math.floor((Date.parse(`${latestDate}T00:00:00Z`) - Date.parse(`${TAPE_BASELINE_LAST_DATE}T00:00:00Z`)) / 86_400_000),
  );
  return TAPE_BASELINE_DAYS + extraDays;
}

function loadState(stateFile: string): PersistedMilestoneState | null {
  if (!existsSync(stateFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (parsed && parsed.version === 1 && typeof parsed.milestones === 'object') return parsed;
  } catch { /* ignore corrupt file */ }
  return null;
}

function saveState(stateFile: string, state: PersistedMilestoneState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}

/**
 * Process evaluated milestones against persisted state and emit deduplicated Telegram alerts.
 * Pure-ish orchestration helper separated for clean unit testing with injected `sendNotify`.
 */
export async function reconcileMilestoneAlerts(
  results: readonly MilestoneResult[],
  stateFile: string,
  sendNotify: typeof notify = notify,
): Promise<{ alerted: MilestoneId[]; state: PersistedMilestoneState }> {
  const prev = loadState(stateFile);
  const firstRun = prev == null;
  const next: PersistedMilestoneState = {
    version: 1,
    updatedAt: Date.now(),
    milestones: { ...(prev?.milestones ?? {}) },
  };
  const alerted: MilestoneId[] = [];

  for (const r of results) {
    const prevEntry = prev?.milestones?.[r.id];
    const prevStatus: MilestoneStatus = prevEntry?.status ?? 'wait';

    // On very first initialization, silently seed already-active milestones so startup never spams.
    if (firstRun && r.status === 'active') {
      next.milestones[r.id] = { status: 'active', notifiedAt: null, summary: r.summary };
      continue;
    }

    const becameReadyOrActive = (prevStatus === 'wait' || prevStatus === 'demoted')
      && (r.status === 'ready' || r.status === 'active');
    const promotedFromReady = prevStatus === 'ready' && r.status === 'active';
    const demotedFromActive = prevStatus === 'active' && r.status === 'wait' && r.autoManaged;

    if (becameReadyOrActive || promotedFromReady) {
      const tag = r.status === 'active' && r.autoManaged
        ? '🚀 <b>MILESTONE AUTO-PROMOTED</b>'
        : '✅ <b>MILESTONE READY</b>';
      const msg = `${tag}\n<b>${r.label}</b>\n${r.summary}\n${r.detail}`;
      const ok = await sendNotify('info', msg, { key: `milestone:${r.id}:${r.status}` });
      alerted.push(r.id);
      next.milestones[r.id] = {
        status: r.status,
        notifiedAt: ok ? Date.now() : (prevEntry?.notifiedAt ?? null),
        summary: r.summary,
      };
    } else if (demotedFromActive) {
      const msg = `⚠️ <b>MILESTONE AUTO-DEMOTED</b>\n<b>${r.label}</b>\n${r.summary}\n${r.detail}`;
      const ok = await sendNotify('warn', msg, { key: `milestone:${r.id}:demoted` });
      alerted.push(r.id);
      next.milestones[r.id] = {
        status: 'demoted',
        notifiedAt: ok ? Date.now() : (prevEntry?.notifiedAt ?? null),
        summary: r.summary,
      };
    } else {
      next.milestones[r.id] = {
        status: r.status,
        notifiedAt: prevEntry?.notifiedAt ?? null,
        summary: r.summary,
      };
    }
  }

  saveState(stateFile, next);
  return { alerted, state: next };
}

/** Main entry called automatically by perfMonitor every 15 min (+5s on startup). */
export async function checkMilestones(): Promise<MilestoneResult[]> {
  // 1. Keep Meta-Labeler synced with newly settled trades without needing restart
  syncMetaLabelerFromJournal(BOT_CONFIG.journalFile);

  const onlineCalib = getMlOnlineCalibrationStatus();
  const metaLabeler = getMetaLabelerStatus();
  const jevV5 = {
    mode: BOT_CONFIG.jev?.mode ?? 'shadow',
    ...readJevV5Stats(BOT_CONFIG.jev?.logFile),
  };
  const { paperPerformance, makerAudit } = readJournalStats(BOT_CONFIG.journalFile);
  const tapeDays = estimateTapeDays(dirname(BOT_CONFIG.journalFile));

  const results = evaluateMilestones({
    onlineCalib: {
      mode: onlineCalib.mode,
      effectiveMode: onlineCalib.effectiveMode,
      historySize: onlineCalib.historySize,
      allowActive: onlineCalib.allowActive,
      rawMlBrier: onlineCalib.rawMlBrier,
      calMlBrier: onlineCalib.calMlBrier,
      promoteMinWindows: BOT_CONFIG.mlOnlineCalibration?.promoteMinWindows ?? 100,
    },
    jevV5,
    metaLabeler,
    makerAudit,
    tapeDays,
    paperPerformance,
    dryRun: BOT_CONFIG.dryRun,
  });

  const { alerted } = await reconcileMilestoneAlerts(results, BOT_CONFIG.milestoneStateFile);
  const compact = results.map(r => `${r.id}=${r.status.toUpperCase()}`).join(' | ');
  log.info(`[Milestones] ${compact}${alerted.length > 0 ? ` (alerted: ${alerted.join(',')})` : ''}`);
  return results;
}
