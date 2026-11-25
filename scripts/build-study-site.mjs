#!/usr/bin/env node
/**
 * Build the static visual portal for POLY//15 reports, ML experiments,
 * study documents, changelog, and sanitized paper-eval performance.
 *
 * Usage:
 *   node scripts/build-study-site.mjs [--root <dir>] [--data-dir <dir>] [--out <dir>] [--only-if-changed]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactSecretText, sanitizeTradeEntry } from './study/redact.mjs';
import { buildFeatureCatalog, extractExperimentSummary } from './study/models.mjs';
import { buildMonteCarloBundleNative } from './study/mc-native.mjs';
import { buildMonteCarloBundle, MC_DEFAULT_PATHS } from '../study-site/mc-engine.js';

const MC_CACHE_VERSION = 'v2-1m-cvar';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

function parseCli(argv) {
  const opts = { root: DEFAULT_ROOT, dataDir: null, outDir: null, onlyIfChanged: false, quiet: false, monteCarloPaths: MC_DEFAULT_PATHS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) opts.root = path.resolve(argv[++i]);
    else if (a === '--data-dir' && argv[i + 1]) opts.dataDir = path.resolve(argv[++i]);
    else if (a === '--out' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (a === '--mc-paths' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 10) opts.monteCarloPaths = Math.round(n);
    }
    else if (a === '--only-if-changed') opts.onlyIfChanged = true;
    else if (a === '--quiet') opts.quiet = true;
  }
  opts.dataDir = opts.dataDir || path.join(opts.root, 'bot', 'data');
  opts.outDir = opts.outDir || path.join(opts.root, 'study-dist');
  return opts;
}

function readTextSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function readJsonSafe(filePath) {
  try {
    const raw = filePath.endsWith('.gz')
      ? zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8')
      : fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonLinesSafe(filePath, maxTailBytes = null) {
  try {
    if (!fs.existsSync(filePath)) return [];
    let text;
    if (maxTailBytes != null) {
      const stat = fs.statSync(filePath);
      if (stat.size > maxTailBytes) {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(maxTailBytes);
        fs.readSync(fd, buf, 0, maxTailBytes, stat.size - maxTailBytes);
        fs.closeSync(fd);
        const s = buf.toString('utf8');
        const firstNl = s.indexOf('\n');
        text = firstNl >= 0 ? s.slice(firstNl + 1) : s;
      } else {
        text = fs.readFileSync(filePath, 'utf8');
      }
    } else {
      text = fs.readFileSync(filePath, 'utf8');
    }
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed line */ }
    }
    return out;
  } catch {
    return [];
  }
}

function readEnvFlags(envPath) {
  const raw = readTextSafe(envPath);
  const out = { dryRun: null, evalWindowStart: null, evalTargetTrades: null };
  if (!raw) return out;
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, val] = m;
    const clean = val.trim().replace(/^["']|["']$/g, '');
    if (key === 'DRY_RUN') out.dryRun = clean === 'true';
    else if (key === 'EVAL_WINDOW_START') out.evalWindowStart = clean;
    else if (key === 'EVAL_TARGET_TRADES') {
      const n = Number(clean);
      if (Number.isFinite(n)) out.evalTargetTrades = n;
    }
  }
  return out;
}

function gitMeta(repoRoot) {
  try {
    const sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim();
    const branch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim();
    const commitAt = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%cI'], { encoding: 'utf8', timeout: 3000 }).trim();
    return { sha, branch, commitAt };
  } catch {
    return { sha: null, branch: null, commitAt: null };
  }
}

function inferTags(title, body = '') {
  const s = `${title}\n${body}`.toLowerCase();
  const tags = [];
  if (/\b(ml|xgboost|lightgbm|shap|platt|calibration|retrain|model|auc|brier|ece)\b/.test(s)) tags.push('ML');
  if (/\b(filter|gate|cross-feed|basis|skew|limit|kelly|cut-loss|safety)\b/.test(s)) tags.push('Filters & Risk');
  if (/\b(chainlink|twap|polybolt|binance|oracle|ws|websocket|clob|tape)\b/.test(s)) tags.push('Oracle & Feeds');
  if (/\b(ui|dashboard|panel|terminal|modal|login|brand|study)\b/.test(s)) tags.push('UI & Portal');
  if (/\b(vps|nginx|cloudflare|tunnel|auto-deploy|backup|systemd|ci)\b/.test(s)) tags.push('Infra & Deploy');
  return tags.length > 0 ? tags : ['General'];
}

export function parseUpdatesMd(rawMd) {
  const md = redactSecretText(rawMd || '');
  const lines = md.split(/\r?\n/);

  let lastUpdated = null;
  const statusRows = [];
  let inStatus = false;
  for (const line of lines) {
    if (/^##\s+Current status/i.test(line)) { inStatus = true; continue; }
    if (inStatus && /^---/.test(line)) break;
    if (inStatus) {
      const mUpd = /^_Last updated:\s*(.+?)_/i.exec(line.trim());
      if (mUpd) { lastUpdated = mUpd[1].trim(); continue; }
      const mRow = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line.trim());
      if (mRow && !/^Area$/i.test(mRow[1]) && !/^-+$/.test(mRow[1].replace(/\s/g, ''))) {
        statusRows.push({ area: mRow[1].trim(), state: mRow[2].trim() });
      }
    }
  }

  const entries = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    const firstBullet = body.split(/\r?\n/).find((l) => /^[-*\d]/.test(l.trim())) || '';
    const summary = firstBullet.replace(/^[-*\d.)\s]+/, '').slice(0, 220);
    entries.push({
      id: `upd-${entries.length + 1}`,
      date: cur.date,
      heading: cur.heading,
      tags: inferTags(cur.heading, body.slice(0, 600)),
      summary,
      body,
    });
    cur = null;
  };

  let skipStatusBlock = false;
  for (const line of lines) {
    if (/^##\s+Current status/i.test(line)) {
      flush();
      skipStatusBlock = true;
      continue;
    }
    if (skipStatusBlock) {
      if (/^---$/.test(line.trim())) skipStatusBlock = false;
      continue;
    }
    const hMatch = /^###\s+(.+)$/.exec(line) || /^##\s+(\d{4}-\d{2}-\d{2}.+)$/.exec(line);
    if (hMatch) {
      flush();
      const heading = hMatch[1].trim();
      const dMatch = /^(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?:\s+\w+)?)?)/.exec(heading);
      cur = {
        date: dMatch ? dMatch[1] : null,
        heading,
        lines: [],
      };
    } else if (cur) {
      if (/^---$/.test(line.trim()) && cur.lines.length > 0) continue;
      cur.lines.push(line);
    }
  }
  flush();

  return { lastUpdated, statusRows, entries };
}

function parseModelsMdStatus(rawMd) {
  const statusMap = new Map();
  if (!rawMd) return statusMap;
  for (const line of rawMd.split(/\r?\n/)) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line.trim());
    if (m) {
      const parsePct = (s) => {
        const x = parseFloat(String(s).replace(/[%+]/g, ''));
        return Number.isFinite(x) ? +(x / 100).toFixed(4) : null;
      };
      const parseNum = (s) => {
        const x = parseFloat(String(s));
        return Number.isFinite(x) ? x : null;
      };
      statusMap.set(m[1], {
        status: m[2].trim(),
        pipelineLabel: m[3].trim(),
        dataRange: m[4].trim(),
        mdAccuracy: parsePct(m[5]),
        mdAuc: parseNum(m[6]),
        mdEce: parseNum(m[7]),
        mdSkill: parsePct(m[8]),
      });
    }
  }
  return statusMap;
}

function parseTrainingReportTxt(raw) {
  if (!raw) return null;
  const out = {};
  const mMeth = /^Method:\s*(.+)$/m.exec(raw);
  const mWin = /^Winner:\s*(.+)$/m.exec(raw);
  const mFeat = /^Features:\s*(.+)$/m.exec(raw);
  const mTrees = /Trees:\s*(\d+)/m.exec(raw);
  const mThr = /Threshold:\s*([0-9.]+)/m.exec(raw);
  const mPruned = /^Pruned features \((\d+)\):\s*(.+)$/m.exec(raw);
  const mRecency = /^Recency:\s*(.+)$/m.exec(raw);
  if (mMeth) out.method = mMeth[1].trim();
  if (mWin) out.winner = mWin[1].trim();
  if (mFeat) out.featuresDesc = mFeat[1].trim();
  if (mTrees) out.trees = Number(mTrees[1]);
  if (mThr) out.optimalThreshold = Number(mThr[1]);
  if (mPruned) {
    out.prunedCount = Number(mPruned[1]);
    out.prunedFeatures = mPruned[2].trim().toLowerCase() === 'none'
      ? []
      : mPruned[2].split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (mRecency) out.recency = mRecency[1].trim();
  return out;
}

function extractModelCalibration(repoRoot, modelId, isActiveLive, reportSummary) {
  const modelDir = path.join(repoRoot, 'ml_registry', 'models', modelId);
  const readModelJson = (name) =>
    readJsonSafe(path.join(modelDir, `${name}.json.gz`))
    || readJsonSafe(path.join(modelDir, `${name}.json`))
    || (isActiveLive ? readJsonSafe(path.join(repoRoot, 'public', 'ml', `${name}.json`)) : null);

  const xgbJson = readModelJson('xgboost_model');
  const lgbJson = readModelJson('lightgbm_model');
  const normJson = readModelJson('norm_browser');

  const xgbHeader = xgbJson ? {
    numFeatures: xgbJson.num_features ?? null,
    engineeredFeatures: xgbJson.engineered_features ?? null,
    numTrees: xgbJson.num_trees ?? null,
    bestIteration: xgbJson.best_iteration ?? null,
    optimalThreshold: xgbJson.optimal_threshold ?? null,
    plattA: xgbJson.platt_a ?? null,
    plattB: xgbJson.platt_b ?? null,
    plattOnLogits: xgbJson.platt_on_logits ?? null,
    plattByPhase: xgbJson.platt_by_phase ?? null,
    prunedFeatures: Array.isArray(xgbJson.pruned_features) ? xgbJson.pruned_features : null,
    preExcludedFeatures: Array.isArray(xgbJson.pre_excluded_features) ? xgbJson.pre_excluded_features : null,
    zeroFeatures: Array.isArray(xgbJson.zero_features) ? xgbJson.zero_features : null,
    trainingMethod: xgbJson.training_method ?? null,
    recencyWeighting: xgbJson.recency_weighting ?? null,
  } : null;

  const lgbHeader = lgbJson ? {
    numFeatures: lgbJson.num_features ?? null,
    numTrees: lgbJson.num_trees ?? null,
    initScore: lgbJson.init_score ?? null,
    plattA: lgbJson.platt_a ?? null,
    plattB: lgbJson.platt_b ?? null,
    plattOnLogits: lgbJson.platt_on_logits ?? null,
    plattByPhase: lgbJson.platt_by_phase ?? null,
  } : null;

  const xgbMetricsFull = xgbJson?.metrics && typeof xgbJson.metrics === 'object' ? xgbJson.metrics : null;
  const calibrationBins = Array.isArray(xgbMetricsFull?.calibration_bins) ? xgbMetricsFull.calibration_bins : null;
  const confidenceBuckets = Array.isArray(xgbMetricsFull?.confidence_buckets) ? xgbMetricsFull.confidence_buckets : null;

  const lgbMetrics = lgbJson?.metrics && typeof lgbJson.metrics === 'object' ? lgbJson.metrics : null;
  const xgbParams = xgbJson?.params && typeof xgbJson.params === 'object' ? xgbJson.params : null;
  const validation = xgbJson?.validation && typeof xgbJson.validation === 'object' ? xgbJson.validation : null;
  const featureCatalog = buildFeatureCatalog({ xgbJson, lgbJson, normJson, reportSummary });

  return {
    xgbHeader,
    lgbHeader,
    xgbMetricsFull,
    lgbMetrics,
    xgbParams,
    validation,
    calibrationBins,
    confidenceBuckets,
    featureCatalog,
    signalModifiers: normJson?.signal_modifiers ?? xgbJson?.signal_modifiers ?? null,
    phaseThresholds: normJson?.phase_thresholds ?? xgbJson?.phase_thresholds ?? null,
    trainSamples: normJson?.train_samples ?? null,
    holdoutFrac: normJson?.holdout_frac ?? null,
    ensembleWeights: normJson?.ensemble_weights ?? lgbJson?.ensemble_weights ?? null,
  };
}

function buildModelsBundle(repoRoot, dataDir, modelProfiles) {
  const journalEvents = readJsonLinesSafe(path.join(repoRoot, 'ml_registry', 'journal.jsonl'));
  const statusMap = parseModelsMdStatus(readTextSafe(path.join(repoRoot, 'ml_registry', 'MODELS.md')));
  const normLive = readJsonSafe(path.join(repoRoot, 'public', 'ml', 'norm_browser.json'));
  const liveDirId = normLive?.model_id ?? null;

  const eventsById = new Map();
  const oosBenchmarks = [];
  const experiments = [];
  const journalNotes = [];
  for (const ev of journalEvents) {
    if (ev.id) {
      if (!eventsById.has(ev.id)) eventsById.set(ev.id, []);
      eventsById.get(ev.id).push(ev);
    }
    if (ev.event === 'evaluated') {
      experiments.push(extractExperimentSummary(ev));
      oosBenchmarks.push(ev);
    } else if (ev.event === 'note' && typeof ev.text === 'string') {
      journalNotes.push({
        ts: ev.ts ?? null,
        date: typeof ev.ts === 'string' ? ev.ts.slice(0, 10) : null,
        modelId: ev.id ?? null,
        actor: ev.actor ?? 'manual',
        text: redactSecretText(ev.text),
      });
    }
  }

  const activeModelId = modelProfiles?.activeModelId || liveDirId || [...statusMap.entries()].find(([, v]) => v.status === 'live')?.[0] || null;

  const modelsDir = path.join(repoRoot, 'ml_registry', 'models');
  const dirIds = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  const allIds = new Set([...dirIds, ...statusMap.keys()]);
  const detailed = [];
  const timelineModels = [];

  for (const id of allIds) {
    const mdInfo = statusMap.get(id) || {};
    const manifest = readJsonSafe(path.join(modelsDir, id, 'manifest.json'));
    const reportTxt = readTextSafe(path.join(modelsDir, id, 'training_report.txt'));
    const reportJson = readJsonSafe(path.join(modelsDir, id, 'training_report.json'));
    const trainingMeta = readJsonSafe(path.join(modelsDir, id, 'training_data.meta.json'));
    const evs = eventsById.get(id) || [];
    const latestGate = [...evs].reverse().find((e) => e.event === 'gate') || null;
    const latestEval = [...evs].reverse().find((e) => e.event === 'evaluated') || null;
    const latestDeploy = [...evs].reverse().find((e) => e.event === 'deployed') || null;
    const pipeline = manifest?.featurePipeline ?? (mdInfo.pipelineLabel === 'v2' ? 2 : mdInfo.pipelineLabel === 'v3' ? 3 : 1);
    const status = id === activeModelId ? 'live' : (mdInfo.status || (latestDeploy ? 'retired' : 'candidate'));

    timelineModels.push({
      id,
      status,
      isActive: id === activeModelId,
      featurePipeline: pipeline,
      dataRange: mdInfo.dataRange && mdInfo.dataRange !== '—' ? mdInfo.dataRange : (manifest?.training?.meta?.rows ? `${manifest.training.meta.rows} mkts` : null),
      accuracy: manifest?.metrics?.ensemble?.accuracy ?? manifest?.metrics?.xgb?.accuracy ?? mdInfo.mdAccuracy ?? null,
      auc: manifest?.metrics?.ensemble?.auc ?? manifest?.metrics?.xgb?.auc ?? mdInfo.mdAuc ?? null,
      ece: manifest?.metrics?.ensemble?.calibration_ece ?? manifest?.metrics?.xgb?.calibration_ece ?? mdInfo.mdEce ?? null,
      skill: manifest?.metrics?.ensemble?.brier_skill_vs_market ?? manifest?.metrics?.xgb?.brier_skill_vs_market ?? mdInfo.mdSkill ?? null,
      era: pipeline === 1 ? 'v1 (pre-fix / look-ahead era)' : pipeline === 3 ? 'v3 (per-second prints)' : 'v2 (shared live builder)',
    });

    if (pipeline === 1 && !manifest?.metrics?.ensemble && !id.startsWith('20260905')) {
      continue;
    }

    const parsedReport = parseTrainingReportTxt(reportTxt);
    const cal = extractModelCalibration(repoRoot, id, id === activeModelId || id === liveDirId, parsedReport);
    const profile = modelProfiles?.profiles?.[id] ?? null;

    detailed.push({
      id,
      status,
      isActive: id === activeModelId,
      featurePipeline: pipeline,
      registeredAt: manifest?.registeredAt ?? null,
      source: manifest?.source ?? null,
      notes: Array.isArray(manifest?.notes) ? manifest.notes.map(redactSecretText) : [],
      trainingMeta: manifest?.training?.meta ?? trainingMeta ?? null,
      metrics: manifest?.metrics ? {
        ...manifest.metrics,
        xgb: manifest.metrics.xgb ?? cal.xgbMetricsFull ?? null,
        lgb: cal.lgbMetrics ?? null,
      } : null,
      xgbParams: cal.xgbParams,
      validation: cal.validation,
      calibrationBins: cal.calibrationBins,
      confidenceBuckets: cal.confidenceBuckets,
      featureCatalog: cal.featureCatalog,
      reportSummary: parsedReport || (reportJson ? {
        method: reportJson.training_method ?? null,
        trees: reportJson.num_trees ?? null,
        optimalThreshold: reportJson.optimal_threshold ?? null,
        prunedCount: Array.isArray(reportJson.pruned_features) ? reportJson.pruned_features.length : null,
        prunedFeatures: reportJson.pruned_features ?? null,
      } : null),
      reportText: reportTxt ? redactSecretText(reportTxt) : null,
      calibration: {
        xgb: cal.xgbHeader,
        lgb: cal.lgbHeader,
        ensembleWeights: manifest?.metrics?.ensembleWeights ?? cal.ensembleWeights ?? null,
        signalModifiers: cal.signalModifiers,
        phaseThresholds: cal.phaseThresholds,
      },
      gate: latestGate ? { pass: !!latestGate.pass, checks: latestGate.checks ?? [], ts: latestGate.ts ?? null } : null,
      latestEval: latestEval ? (() => {
        const { summary: _omitSummary, exact2175: _omitEx, fullOos: _omitFo, ...head } = latestEval;
        return head;
      })() : null,
      profile,
      events: evs.map((e) => ({ ts: e.ts ?? null, event: e.event, actor: e.actor ?? null, note: e.note ? redactSecretText(e.note) : null })),
    });
  }

  detailed.sort((a, b) => b.id.localeCompare(a.id));
  timelineModels.sort((a, b) => a.id.localeCompare(b.id));
  experiments.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  return {
    activeModelId,
    liveDirModelId: liveDirId,
    models: detailed,
    timelineModels,
    oosBenchmarks,
    experiments,
    journalNotes,
  };
}

function buildStudiesBundle(repoRoot, dataDir, outDir, journalNotes) {
  const reports = [];
  const analysisRoot = path.join(repoRoot, 'analysis');
  const assetsRoot = path.join(outDir, 'assets', 'reports');

  if (fs.existsSync(analysisRoot)) {
    const dateDirs = fs.readdirSync(analysisRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => b.localeCompare(a));

    for (const dateName of dateDirs) {
      const dirPath = path.join(analysisRoot, dateName);
      const walk = (curDir, relSub = '') => {
        for (const ent of fs.readdirSync(curDir, { withFileTypes: true })) {
          const full = path.join(curDir, ent.name);
          const relPath = relSub ? `${relSub}/${ent.name}` : ent.name;
          if (ent.isDirectory()) {
            walk(full, relPath);
            continue;
          }
          if (/\.(png|jpg|jpeg|svg|webp)$/i.test(ent.name)) {
            const dest = path.join(assetsRoot, dateName, relPath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(full, dest);
            continue;
          }
          if (!ent.name.endsWith('.md')) continue;
          const raw = redactSecretText(readTextSafe(full) || '');
          const h1 = /^#\s+(.+)$/m.exec(raw);
          const title = h1 ? h1[1].trim() : ent.name.replace(/\.md$/, '');
          const firstPara = raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('```') && !l.startsWith('>')) || '';
          // Rewrite local image paths ./foo.png or foo.png to /assets/reports/<date>/...
          const rewritten = raw.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, imgTarget) => {
            const cleanTarget = imgTarget.trim().replace(/^\.\//, '');
            if (/^(https?:|data:|\/)/i.test(cleanTarget) || cleanTarget.includes('..')) return m;
            const resolvedSub = relSub ? `${relSub}/${cleanTarget}` : cleanTarget;
            return `![${alt}](./assets/reports/${dateName}/${resolvedSub})`;
          });

          reports.push({
            id: `${dateName}/${relPath}`,
            date: dateName,
            file: `analysis/${dateName}/${relPath}`,
            title,
            excerpt: firstPara.slice(0, 220),
            tags: inferTags(title, raw.slice(0, 1200)),
            words: raw.split(/\s+/).filter(Boolean).length,
            markdown: rewritten,
          });
        }
      };
      walk(dirPath);
    }
  }

  const quantStudyFiles = [
    { key: 'calibration', file: 'calibration_study.json', title: 'Model vs Market Shrinkage Calibration Study' },
    { key: 'shadowDecision', file: 'shadow_decision_study.json', title: 'Shadow Decision & Candidate Filter Split Study' },
    { key: 'jevTarget', file: 'jev_target_study.json', title: 'JEV Walk-Forward Target Study' },
    { key: 'jevStack', file: 'jev_stack_study.json', title: 'JEV + ML + Market Stacking Study' },
    { key: 'globalRisk', file: 'global_risk_study.json', title: 'Global Risk Window Event Study' },
  ];

  const quantStudies = {};
  for (const spec of quantStudyFiles) {
    const data = readJsonSafe(path.join(dataDir, spec.file));
    if (data && typeof data === 'object') {
      quantStudies[spec.key] = { title: spec.title, file: spec.file, data };
    }
  }

  return {
    reports,
    quantStudies,
    registryNotes: [...journalNotes].reverse(),
  };
}

function polyTakerFeePerShare(price) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  return 0.07 * price * (1 - price);
}

function buildEvalAndHealthBundle(repoRoot, dataDir) {
  const envFlags = readEnvFlags(path.join(repoRoot, 'bot', '.env'));
  const state = readJsonSafe(path.join(dataDir, 'state.json'));
  const rawJournal = readJsonLinesSafe(path.join(dataDir, 'trade_journal.jsonl'));
  const trades = rawJournal.map(sanitizeTradeEntry).filter(Boolean);

  // Determine start baseline cleanly (from env/state; $100 reset if eval run active)
  let totalWins = 0;
  let totalLosses = 0;
  let grossWinPnl = 0;
  let grossLossPnl = 0;
  let netPnl = 0;
  let sumPrices = 0;
  let priceCount = 0;
  let sumBreakeven = 0;
  // state.bankroll excludes cost already deducted on an unsettled open position, while
  // state.startOfDayBankroll resets every UTC day — so derive the true starting baseline
  // by subtracting settled journal PnL from realized bankroll.
  const openPosCost = (
    state?.currentPosition &&
    !state.currentPosition.settled &&
    typeof state.currentPosition.cost === 'number' &&
    Number.isFinite(state.currentPosition.cost)
  ) ? state.currentPosition.cost : 0;
  const realizedBankroll = typeof state?.bankroll === 'number' && Number.isFinite(state.bankroll)
    ? Math.round((state.bankroll + openPosCost) * 100) / 100
    : null;
  const tradeSum = Math.round(trades.reduce((acc, t) => acc + (t.pnl ?? 0), 0) * 100) / 100;
  let running = realizedBankroll != null
    ? Math.round((realizedBankroll - tradeSum) * 100) / 100
    : 100;

  let peak = running;
  let maxDd = 0;
  const equityCurve = [{ idx: 0, ts: trades[0]?.enteredAt ?? Date.now(), bankroll: running, pnl: 0, cumPnl: 0, label: 'Start' }];
  let cumPnl = 0;

  const byPhase = {};
  const byModel = {};
  const bySide = {};
  const basisSamples = [];
  const skewSamples = [];

  const bump = (map, key, t) => {
    const k = key || 'UNKNOWN';
    if (!map[k]) map[k] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    map[k].trades++;
    if (t.outcome === 'WIN') map[k].wins++;
    else if (t.outcome === 'LOSS') map[k].losses++;
    map[k].pnl = Math.round((map[k].pnl + (t.pnl ?? 0)) * 100) / 100;
  };

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const pnl = t.pnl ?? 0;
    netPnl = Math.round((netPnl + pnl) * 100) / 100;
    cumPnl = Math.round((cumPnl + pnl) * 100) / 100;
    running = Math.round((running + pnl) * 100) / 100;
    if (running > peak) peak = running;
    const dd = Math.round((peak - running) * 100) / 100;
    if (dd > maxDd) maxDd = dd;

    if (t.outcome === 'WIN') { totalWins++; grossWinPnl += Math.max(0, pnl); }
    else if (t.outcome === 'LOSS') { totalLosses++; grossLossPnl += Math.abs(Math.min(0, pnl)); }

    if (t.tokenPrice != null && t.tokenPrice > 0 && t.tokenPrice < 1) {
      sumPrices += t.tokenPrice;
      sumBreakeven += t.tokenPrice + polyTakerFeePerShare(t.tokenPrice);
      priceCount++;
    }
    if (t.liveBasisUsd != null) basisSamples.push(t.liveBasisUsd);
    if (t.crossFeedSkewUsd != null) skewSamples.push(t.crossFeedSkewUsd);

    bump(byPhase, t.phase, t);
    bump(byModel, t.modelId, t);
    bump(bySide, t.side, t);

    equityCurve.push({
      idx: i + 1,
      ts: t.exitedAt ?? t.ts ?? t.enteredAt,
      slug: t.slug,
      side: t.side,
      outcome: t.outcome,
      pnl,
      cumPnl,
      bankroll: running,
    });
  }

  const settledCount = totalWins + totalLosses;
  const winRatePct = settledCount > 0 ? +((totalWins / settledCount) * 100).toFixed(2) : null;
  const avgEntryCents = priceCount > 0 ? +((sumPrices / priceCount) * 100).toFixed(2) : null;
  const breakevenWrPct = priceCount > 0 ? +((sumBreakeven / priceCount) * 100).toFixed(2) : null;
  const profitFactor = grossLossPnl > 0 ? +(grossWinPnl / grossLossPnl).toFixed(2) : grossWinPnl > 0 ? 99.9 : null;

  // PTB health summary (last ~256 KB)
  const ptbLines = readJsonLinesSafe(path.join(dataDir, 'ptb_health.jsonl'), 256 * 1024);
  let ptbTotal = 0;
  let ptbExact = 0;
  const ptbBySource = {};
  for (const row of ptbLines) {
    if (typeof row.total === 'number' && typeof row.exact === 'number') {
      ptbTotal += row.total;
      ptbExact += row.exact;
    }
    if (row.bySource && typeof row.bySource === 'object') {
      for (const [src, cnt] of Object.entries(row.bySource)) {
        if (typeof cnt === 'number') ptbBySource[src] = (ptbBySource[src] || 0) + cnt;
      }
    }
  }

  // Legacy pre-reset archive summary (if present)
  const archState = readJsonSafe(path.join(dataDir, 'archive_20261116_pre_alltime_100', 'state.json'));
  const archiveSummary = archState ? {
    label: 'Pre-AllTime Legacy Eval Archive',
    totalTrades: archState.totalTrades ?? 0,
    wins: archState.wins ?? 0,
    losses: archState.losses ?? 0,
    winRatePct: archState.totalTrades > 0 ? +((archState.wins / archState.totalTrades) * 100).toFixed(2) : null,
    endBankroll: archState.bankroll ?? null,
    peakBankroll: archState.peakBankroll ?? null,
  } : null;

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return +s[Math.floor(s.length / 2)].toFixed(2);
  };

  // Downsample equityCurve cleanly when very long (> 350 points), always keeping start & last 120 points.
  let compactCurve = equityCurve;
  if (equityCurve.length > 350) {
    const head = equityCurve.slice(0, equityCurve.length - 120);
    const tail = equityCurve.slice(-120);
    const step = Math.ceil(head.length / 220);
    compactCurve = [head[0], ...head.filter((_, i) => i > 0 && i % step === 0), ...tail];
  }

  return {
    botMode: envFlags.dryRun === false ? 'LIVE' : envFlags.dryRun === true ? 'DRY_RUN' : 'PAPER / ENV',
    evalWindowStart: envFlags.evalWindowStart,
    evalTargetTrades: envFlags.evalTargetTrades,
    hasLiveData: Boolean(state || trades.length > 0),
    bankroll: realizedBankroll ?? running,
    startBankroll: equityCurve[0].bankroll,
    peakBankroll: trades.length > 0 ? peak : (state?.peakBankroll ?? peak),
    hasOpenPosition: Boolean(state?.currentPosition && !state.currentPosition.settled),
    totalTrades: state?.totalTrades ?? trades.length,
    wins: state?.wins ?? totalWins,
    losses: state?.losses ?? totalLosses,
    winRatePct,
    netPnl,
    avgEntryCents,
    breakevenWrPct,
    marginVsBreakevenPp: winRatePct != null && breakevenWrPct != null ? +(winRatePct - breakevenWrPct).toFixed(2) : null,
    profitFactor,
    maxDrawdownUsd: maxDd,
    byPhase,
    byModel,
    bySide,
    equityCurve: compactCurve,
    recentTrades: trades.slice(-80).reverse(),
    crossFeed: {
      trackedTrades: basisSamples.length,
      medianBasisUsd: median(basisSamples),
      medianSkewUsd: median(skewSamples),
    },
    ptbHealth: ptbTotal > 0 ? {
      totalPolls: ptbTotal,
      exactPolls: ptbExact,
      exactPct: +((ptbExact / ptbTotal) * 100).toFixed(2),
      bySource: ptbBySource,
    } : null,
    archiveSummary,
    _settledTrades: trades,
  };
}

function computeSignature(pathsToCheck) {
  const parts = [];
  const walkStat = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name === 'node_modules' || name === 'tape' || name === '.git') continue;
        walkStat(path.join(p, name));
      }
    } else {
      parts.push(`${path.basename(p)}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  };
  for (const p of pathsToCheck) walkStat(p);
  return parts.join('|');
}

function copyStaticFrontend(repoRoot, outDir) {
  const siteSrc = path.join(repoRoot, 'study-site');
  if (!fs.existsSync(siteSrc)) throw new Error(`Missing study-site templates at ${siteSrc}`);
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(siteSrc).sort().filter((f) => fs.statSync(path.join(siteSrc, f)).isFile());
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(siteSrc, file)));
  }
  const bundleVer = hash.digest('hex').slice(0, 8);

  for (const file of files) {
    const src = path.join(siteSrc, file);
    const dest = path.join(outDir, file);
    if (file === 'index.html') {
      const html = fs.readFileSync(src, 'utf8')
        .replace(/href="\.\/styles\.css(?:\?[^"]*)?"/, `href="./styles.css?v=${bundleVer}"`)
        .replace(/src="\.\/app\.js(?:\?[^"]*)?"/, `src="./app.js?v=${bundleVer}"`);
      fs.writeFileSync(dest, html);
    } else if (file === 'app.js') {
      const js = fs.readFileSync(src, 'utf8')
        .replace(/from '\.\/markdown\.js(?:\?[^']*)?'/, `from './markdown.js?v=${bundleVer}'`)
        .replace(/from '\.\/charts\.js(?:\?[^']*)?'/, `from './charts.js?v=${bundleVer}'`)
        .replace(/from '\.\/mc-engine\.js(?:\?[^']*)?'/, `from './mc-engine.js?v=${bundleVer}'`);
      fs.writeFileSync(dest, js);
    } else {
      fs.copyFileSync(src, dest);
    }
  }
  const brandSrc = path.join(repoRoot, 'public', 'brand');
  if (fs.existsSync(brandSrc)) {
    const brandOut = path.join(outDir, 'brand');
    fs.mkdirSync(brandOut, { recursive: true });
    for (const file of fs.readdirSync(brandSrc)) {
      const s = path.join(brandSrc, file);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(brandOut, file));
    }
  }
  for (const rootAsset of ['favicon.ico', 'favicon.svg', 'site.webmanifest']) {
    const s = path.join(repoRoot, 'public', rootAsset);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(outDir, rootAsset));
  }
}

export function buildStage2Bundle(repoRoot, dataDir, activeModelId = null) {
  const snapshotPath = path.join(repoRoot, 'scripts', 'study', 'stage2_snapshot.json');
  const snapshot = readJsonSafe(snapshotPath);
  const coverage = readJsonSafe(path.join(dataDir, 'tape_coverage_study.json')) || snapshot?.coverage || null;
  const study = readJsonSafe(path.join(dataDir, 'stage2_pipeline_v4_study.json')) || snapshot?.study || null;
  const hybRaw = readJsonSafe(path.join(repoRoot, 'public', 'ml', 'hybrid_residual_v4.json'));
  const liveHybridArtifact = hybRaw ? {
    id: hybRaw.id ?? null,
    requiresBaseModelId: hybRaw.requires_base_model_id ?? null,
    activeMatch: Boolean(hybRaw.requires_base_model_id && activeModelId && hybRaw.requires_base_model_id === activeModelId),
    numTrees: hybRaw.num_trees ?? (Array.isArray(hybRaw.trees) ? hybRaw.trees.length : null),
    features: Array.isArray(hybRaw.feature_names) ? hybRaw.feature_names.length : 13,
    trainingSplit: hybRaw.training_split ?? null,
    metrics: hybRaw.metrics ?? null,
    featureGains: Array.isArray(hybRaw.feature_gains) ? hybRaw.feature_gains : [],
  } : null;

  const v4Features = [
    {
      idx: 58,
      name: 'oracle_ptb_dist_pct',
      formula: '(settlePrice − exactPtb) / exactPtb',
      role: 'True Chainlink distance vs settlement PTB (removes Binance/USDT basis bias)',
    },
    {
      idx: 59,
      name: 'twap_physics_z',
      formula: '(settlePrice − exactPtb) / (σ_1s · √T_eff)',
      role: 'Exact 60s TWAP variance-horizon z-score; unlocks late-window precision',
    },
    {
      idx: 60,
      name: 'basis_pct',
      formula: '(binance − chainlinkSpot) / chainlinkSpot',
      role: 'Instantaneous USDT vs USD cross-feed premium/discount regime',
    },
    {
      idx: 61,
      name: 'basis_drift_pct',
      formula: 'binanceDistPct − oracleDistPct',
      role: 'Combined Binance/Oracle window-open drift + pre-open TWAP skew',
    },
    {
      idx: 62,
      name: 'cross_feed_lead',
      formula: 'binance_3s_delta − oracle_3s_delta',
      role: '3s exchange vs oracle lead-lag separation (impulse vs basis widening)',
    },
  ];

  return {
    available: Boolean(coverage || study || liveHybridArtifact),
    coverage,
    study,
    liveHybridArtifact,
    v4Features,
    findings: {
      normalWindow: 'Confirming twapModelStudy.py: during the 2–12m normal trading window, CLOB market makers track Chainlink + TWAP so raw market mid achieves 0.1590 Brier; Pipeline v4 Hybrid cuts Baseline v2 error by 90% of the gap vs mid (Brier 0.1656 → 0.1597, AUC 0.8397 → 0.8468, ECE 0.0439 → 0.0177) by subtracting basis drift.',
      finalMinute: 'In the final 15–45s before resolution, TWAP variance physics sharpens predictions sharply vs Binance-only v2 (Brier 0.1277 → 0.0903 Standalone / 0.0874 Calibrated Stack, AUC 0.9014 → 0.9509).',
      executionReplay: 'On strict 1,237-market OOS execution replay against real L2 asks + official CLOB V2 taker fee (0.07·p·(1−p)), Gate 20f blocks cross-feed-mismatched entries (cutting 58c-cap DD $23.89 → $13.34 and loss 71%) and Hybrid v4 + Gate 20f reaches 80.0% WR (+15.97pp above breakeven) on the 65c cap preset.',
    },
  };
}

function buildQuantStackSummary(dataDir) {
  const outcomesRaw = readJsonSafe(path.join(dataDir, 'jev_outcomes.json')) || {};
  const jevRows = readJsonLinesSafe(path.join(dataDir, 'jev_log.jsonl'));
  const journalRows = readJsonLinesSafe(path.join(dataDir, 'trade_journal.jsonl'));

  const getOutcome = (slug) => {
    const v = outcomesRaw[slug];
    const s = typeof v === 'string' ? v : v?.outcome;
    return s === 'UP' || s === 'DOWN' ? s : null;
  };

  const mlBySlug = new Map();
  const v5BySlug = new Map();
  for (const r of jevRows) {
    const slug = r?.slug;
    const o = getOutcome(slug);
    if (!o) continue;
    const y = o === 'UP' ? 1 : 0;
    const rawMl = Number(r.ml?.probUp ?? r.rawMlProbUp);
    const mkt = Number(r.market?.marketUp ?? r.market?.up ?? r.marketUp);
    if (rawMl > 0.005 && rawMl < 0.995 && mkt > 0.01 && mkt < 0.99) {
      mlBySlug.set(slug, { rawMl, mkt, y, ts: Number(r.ts) || 0 });
    }
    const ver = String(r.stateVariant ?? r.calibrationVersion ?? r.variant ?? '');
    if (ver.includes('v5') || ver.includes('online-platt-v5')) {
      v5BySlug.set(slug, { r, y, outcome: o });
    }
  }

  const mlHist = [...mlBySlug.values()].sort((a, b) => a.ts - b.ts).slice(-300);
  const mlEval = mlHist.slice(-100);
  const nMl = mlEval.length;
  const rawMlBrier = nMl > 0 ? +(mlEval.reduce((s, x) => s + (x.rawMl - x.y) ** 2, 0) / nMl).toFixed(5) : null;
  const mktMlBrier = nMl > 0 ? +(mlEval.reduce((s, x) => s + (x.mkt - x.y) ** 2, 0) / nMl).toFixed(5) : null;

  const v5List = [...v5BySlug.values()];
  const nV5 = v5List.length;
  let v5BayesSum = 0;
  let v5MktSum = 0;
  let v5DirTotal = 0;
  let v5DirHits = 0;
  for (const { r, y, outcome } of v5List) {
    const bp = Number(r.bayesianProbUp ?? r.settleUpCalibrated ?? r.settleUpProbability ?? 0.5);
    const mp = Number(r.market?.marketUp ?? r.market?.up ?? 0.5);
    v5BayesSum += (bp - y) ** 2;
    v5MktSum += (mp - y) ** 2;
    if (r.direction === 'UP' || r.direction === 'DOWN') {
      v5DirTotal++;
      if (r.direction === outcome) v5DirHits++;
    }
  }
  const v5BayesBrier = nV5 > 0 ? +(v5BayesSum / nV5).toFixed(5) : null;
  const v5MktBrier = nV5 > 0 ? +(v5MktSum / nV5).toFixed(5) : null;
  const v5SkillPct = v5BayesBrier != null && v5MktBrier != null && v5MktBrier > 0
    ? +(((v5MktBrier - v5BayesBrier) / v5MktBrier) * 100).toFixed(2)
    : null;
  const v5DirAccPct = v5DirTotal > 0 ? +((v5DirHits / v5DirTotal) * 100).toFixed(1) : null;

  const byCommit = new Map();
  let totalSettled = 0;
  let totalWins = 0;
  for (const r of journalRows) {
    const e = r?.entry;
    const x = r?.exit;
    if (!e || !x) continue;
    const out = x.verifiedOutcome ?? x.outcome;
    if (out !== 'UP' && out !== 'DOWN') continue;
    const won = out === e.side;
    totalSettled++;
    if (won) totalWins++;
    const commit = String(e.gitCommit || 'legacy');
    const cur = byCommit.get(commit) || { commit, trades: 0, wins: 0, losses: 0, pnlUsd: 0 };
    cur.trades++;
    if (won) cur.wins++; else cur.losses++;
    cur.pnlUsd += Number(r.analysis?.pnl ?? 0);
    byCommit.set(commit, cur);
  }

  const commitBreakdown = [...byCommit.values()].map((c) => ({
    ...c,
    winRatePct: c.trades > 0 ? +((c.wins / c.trades) * 100).toFixed(1) : 0,
    pnlUsd: +c.pnlUsd.toFixed(2),
  }));

  const mlCalActive = nMl < 100 || (rawMlBrier != null && mktMlBrier != null && rawMlBrier <= mktMlBrier);
  const jevVetoActive = nV5 < 100 || (v5SkillPct != null && v5SkillPct > 0);

  return {
    onlineCalibration: {
      mode: mlCalActive ? 'ACTIVE' : 'DEMOTED (BRIER GUARD)',
      windows: mlHist.length,
      evalSamples: nMl,
      rawMlBrier,
      mktBrier: mktMlBrier,
      ready: mlHist.length >= 50 && mlCalActive,
    },
    jevV5: {
      mode: jevVetoActive ? 'ACTIVE (VETO)' : 'DEMOTED (BRIER GUARD)',
      windows: nV5,
      target: 150,
      bayesBrier: v5BayesBrier,
      mktBrier: v5MktBrier,
      skillPct: v5SkillPct,
      dirHits: v5DirHits,
      dirTotal: v5DirTotal,
      dirAccPct: v5DirAccPct,
      ready: nV5 >= 150 && (v5SkillPct ?? -1) > 0,
    },
    metaLabeler: {
      mode: 'SHADOW',
      trades: totalSettled,
      target: 100,
      baseWrPct: totalSettled > 0 ? +((totalWins / totalSettled) * 100).toFixed(1) : null,
      ready: totalSettled >= 100,
    },
    engines: [
      {
        name: 'Online Recency Platt Calibration',
        status: mlCalActive ? 'ACTIVE' : 'DEMOTED',
        detail: mlCalActive
          ? '300-window recency Platt + Rolling Brier Self-Guard'
          : `Auto-paused by Brier Guard (ML ${rawMlBrier} > Mkt ${mktMlBrier} over last ${nMl}w)`,
      },
      {
        name: 'JEV v5 Bayesian + Debate Veto',
        status: jevVetoActive ? 'ACTIVE' : 'DEMOTED',
        detail: jevVetoActive
          ? '8-question TypeSafe System One + Rolling 100-win Brier Guard'
          : `Veto auto-paused by Brier Guard (skill ${v5SkillPct}% <= 0% over ${nV5}w)`,
      },
      { name: 'Compound Anomaly Guards (11c, 20h–20j)', status: 'ACTIVE', detail: 'Moderate thin ML edge + Squeeze-Flip + Skew-JEV-Hybrid (0 FP)' },
      { name: 'Step-Compounding + Drawdown Guard', status: 'ACTIVE', detail: 'Tiered caps + peak-drawdown step-down + MAX_DAILY_LOSS 15%' },
      { name: 'Stage-2 Meta-Labeler (L2 Logistic)', status: 'SHADOW', detail: `Chronological holdout P(WIN|ENTER) — ${totalSettled}/100 trades` },
      { name: 'HMM · Kalman · GARCH(1,1) · Kyle λ', status: 'SHADOW', detail: 'Causal 3-state HMM, 2-state Kinematic Kalman, vol clustering & impact' },
    ],
    commitBreakdown,
  };
}

export function buildStudySite(options = {}) {
  const root = path.resolve(options.root || DEFAULT_ROOT);
  const dataDir = path.resolve(options.dataDir || path.join(root, 'bot', 'data'));
  const outDir = path.resolve(options.outDir || path.join(root, 'study-dist'));
  const onlyIfChanged = Boolean(options.onlyIfChanged);

  const watched = [
    path.join(root, 'UPDATES.md'),
    path.join(root, 'ml_registry', 'journal.jsonl'),
    path.join(root, 'ml_registry', 'MODELS.md'),
    path.join(root, 'analysis'),
    path.join(root, 'study-site'),
    path.join(root, 'scripts', 'build-study-site.mjs'),
    path.join(root, 'scripts', 'study'),
    path.join(root, 'public', 'ml', 'hybrid_residual_v4.json'),
    path.join(dataDir, 'model_profiles.json'),
    path.join(dataDir, 'state.json'),
    path.join(dataDir, 'trade_journal.jsonl'),
    path.join(dataDir, 'jev_log.jsonl'),
    path.join(dataDir, 'jev_outcomes.json'),
    path.join(dataDir, 'ptb_health.jsonl'),
    path.join(dataDir, 'calibration_study.json'),
    path.join(dataDir, 'shadow_decision_study.json'),
    path.join(dataDir, 'jev_target_study.json'),
    path.join(dataDir, 'jev_stack_study.json'),
    path.join(dataDir, 'global_risk_study.json'),
    path.join(dataDir, 'tape_coverage_study.json'),
    path.join(dataDir, 'stage2_pipeline_v4_study.json'),
  ];

  const sigPath = path.join(outDir, '.build-sig.txt');
  const sig = computeSignature(watched);
  if (onlyIfChanged && fs.existsSync(sigPath) && fs.readFileSync(sigPath, 'utf8') === sig) {
    return { skipped: true, outDir };
  }

  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  copyStaticFrontend(root, outDir);

  const generatedAt = new Date().toISOString();
  const git = gitMeta(root);
  const updates = parseUpdatesMd(readTextSafe(path.join(root, 'UPDATES.md')) || '');
  const modelProfiles = readJsonSafe(path.join(dataDir, 'model_profiles.json'));
  const modelsBundle = buildModelsBundle(root, dataDir, modelProfiles);
  const studiesBundle = buildStudiesBundle(root, dataDir, outDir, modelsBundle.journalNotes);
  const evalBundle = buildEvalAndHealthBundle(root, dataDir);
  const settledTrades = Array.isArray(evalBundle._settledTrades) ? evalBundle._settledTrades : [];
  delete evalBundle._settledTrades;
  const activeModel = modelsBundle.models.find((m) => m.id === modelsBundle.activeModelId) || modelsBundle.models[0] || null;
  const stage2Bundle = buildStage2Bundle(root, dataDir, activeModel?.id ?? null);
  const quantStack = buildQuantStackSummary(dataDir);
  const targetMcPaths = Math.max(10, Math.min(1_000_000, Math.round(Number(options.monteCarloPaths ?? MC_DEFAULT_PATHS))));
  const mcCacheKey = crypto.createHash('sha256').update(JSON.stringify({
    v: MC_CACHE_VERSION,
    nPaths: targetMcPaths,
    startBankroll: evalBundle.bankroll,
    trades: settledTrades.map((t) => [t.pnl, t.cost, t.tokenPrice, t.outcome, t.isMaker, t.exitedAt]),
  })).digest('hex').slice(0, 24);

  const existingMcPath = path.join(outDir, 'data', 'montecarlo.json');
  const cachedMc = readJsonSafe(existingMcPath);
  let mcBundle = null;
  if (
    cachedMc
    && cachedMc.cacheKey === mcCacheKey
    && cachedMc.nPaths === targetMcPaths
    && cachedMc.available === (settledTrades.length > 0)
  ) {
    mcBundle = cachedMc;
  } else {
    if (targetMcPaths > 25_000 && options.preferNative !== false) {
      mcBundle = buildMonteCarloBundleNative(settledTrades, {
        startBankroll: evalBundle.bankroll,
        nPaths: targetMcPaths,
        generatedAt,
      });
    }
    if (!mcBundle) {
      mcBundle = buildMonteCarloBundle(settledTrades, {
        startBankroll: evalBundle.bankroll,
        nPaths: targetMcPaths,
        generatedAt,
      });
    }
    mcBundle.cacheKey = mcCacheKey;
  }

  const pickSnap = (scen, h) => {
    const row = scen?.horizons?.[h];
    if (!row) return null;
    return {
      p5: row.p5,
      cvar95Final: row.cvar95Final,
      p50: row.p50,
      p95: row.p95,
      mean: row.mean,
      probProfitPct: row.probProfitPct,
      probDoublePct: row.probDoublePct,
      p95MaxDdPct: row.p95MaxDdPct,
      cvar95MaxDdPct: row.cvar95MaxDdPct,
      probRuinHalfPct: row.probRuinHalfPct,
    };
  };
  const defaultMcScen = mcBundle.available
    ? (mcBundle.scenarios.find((s) => s.id === mcBundle.defaultScenarioId) || mcBundle.scenarios[0] || null)
    : null;
  const monteCarloSummary = mcBundle.available && defaultMcScen ? {
    available: true,
    nPaths: mcBundle.nPaths,
    defaultScenarioId: mcBundle.defaultScenarioId,
    defaultHorizon: mcBundle.defaultHorizon,
    currentBankroll: mcBundle.currentBankroll,
    stats: mcBundle.stats,
    snapshots: {
      1000: pickSnap(defaultMcScen, 1000),
      5000: pickSnap(defaultMcScen, 5000),
      10000: pickSnap(defaultMcScen, 10000),
    },
  } : { available: false, nPaths: mcBundle.nPaths };

  const sitePayload = {
    generatedAt,
    git,
    botMode: evalBundle.botMode,
    activeModelId: modelsBundle.activeModelId,
    activeModelSummary: activeModel ? {
      id: activeModel.id,
      status: activeModel.status,
      featurePipeline: activeModel.featurePipeline,
      rows: activeModel.trainingMeta?.rows ?? null,
      ensembleAcc: activeModel.metrics?.ensemble?.accuracy ?? activeModel.metrics?.xgb?.accuracy ?? null,
      ensembleAuc: activeModel.metrics?.ensemble?.auc ?? activeModel.metrics?.xgb?.auc ?? null,
      ensembleBrier: activeModel.metrics?.ensemble?.brier ?? activeModel.metrics?.xgb?.brier ?? null,
      calibrationEce: activeModel.metrics?.ensemble?.calibration_ece ?? activeModel.metrics?.xgb?.calibration_ece ?? null,
      brierSkillVsMarket: activeModel.metrics?.ensemble?.brier_skill_vs_market ?? activeModel.metrics?.xgb?.brier_skill_vs_market ?? null,
      prunedCount: activeModel.reportSummary?.prunedCount ?? activeModel.calibration?.xgb?.prunedFeatures?.length ?? null,
      hasPhaseCalibration: Boolean(activeModel.calibration?.xgb?.plattByPhase),
      profileLabel: activeModel.profile?.label ?? null,
      hybridOverlay: stage2Bundle.liveHybridArtifact ? {
        id: stage2Bundle.liveHybridArtifact.id,
        activeMatch: stage2Bundle.liveHybridArtifact.activeMatch,
        numTrees: stage2Bundle.liveHybridArtifact.numTrees,
        valAcc: stage2Bundle.liveHybridArtifact.metrics?.hybrid_val_acc ?? null,
        valEce: stage2Bundle.liveHybridArtifact.metrics?.hybrid_val_ece ?? null,
      } : null,
    } : null,
    currentStatus: {
      lastUpdated: updates.lastUpdated,
      rows: updates.statusRows,
    },
    eval: evalBundle,
    quantStack,
    monteCarloSummary,
    stage2Available: stage2Bundle.available,
    counts: {
      models: modelsBundle.models.length,
      studies: studiesBundle.reports.length,
      quantStudies: Object.keys(studiesBundle.quantStudies).length,
      updates: updates.entries.length,
    },
  };

  fs.writeFileSync(path.join(outDir, 'data', 'site.json'), JSON.stringify(sitePayload, null, 2));
  fs.writeFileSync(path.join(outDir, 'data', 'models.json'), JSON.stringify(modelsBundle, null, 2));
  fs.writeFileSync(path.join(outDir, 'data', 'studies.json'), JSON.stringify(studiesBundle, null, 2));
  fs.writeFileSync(path.join(outDir, 'data', 'updates.json'), JSON.stringify(updates, null, 2));
  fs.writeFileSync(path.join(outDir, 'data', 'stage2.json'), JSON.stringify(stage2Bundle, null, 2));
  fs.writeFileSync(path.join(outDir, 'data', 'montecarlo.json'), JSON.stringify(mcBundle));
  fs.writeFileSync(sigPath, sig);

  return {
    skipped: false,
    outDir,
    generatedAt,
    counts: sitePayload.counts,
    activeModelId: sitePayload.activeModelId,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseCli(process.argv.slice(2));
  const res = buildStudySite(cli);
  if (!cli.quiet) {
    if (res.skipped) console.log(`[study-build] unchanged — skipped (${res.outDir})`);
    else console.log(`[study-build] built ${res.outDir} | active=${res.activeModelId} | models=${res.counts.models} studies=${res.counts.studies} updates=${res.counts.updates}`);
  }
}
