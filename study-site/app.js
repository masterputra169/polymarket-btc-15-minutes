import { renderMarkdown } from './markdown.js';
import {
  drawEquityChart,
  drawMetricBars,
  drawTierCurve,
  drawPhaseThetaChart,
  drawEvolutionChart,
  drawCalibrationCurve,
  drawConfidenceBuckets,
  drawPhaseResponseCurve,
  drawFeatureImportanceBars,
} from './charts.js';

const state = {
  site: null,
  models: null,
  studies: null,
  updates: null,
  activeTab: 'overview',
  metricKey: 'accuracy',
  selectedModelId: null,
  featMode: 'xgbSplits',
  featStatus: 'ALL',
  featGroup: 'ALL',
  featQuery: '',
  presetSlice: 'fullOos',
  showLegacyModels: false,
  selectedReportId: null,
  studyQuery: '',
  studyTag: 'ALL',
  updateQuery: '',
  updateTag: 'ALL',
};

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const fmtPct = (v, mult100 = true) => (typeof v === 'number' && Number.isFinite(v) ? `${(mult100 ? v * 100 : v).toFixed(2)}%` : '—');
const fmtNum = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
const fmtUsd = (v, signed = false) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : (v < 0 ? '-' : '');
  return `${sign}$${Math.abs(v).toFixed(2)}`;
};
const fmtTime = (ms) => {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' WIB';
  } catch { return String(ms); }
};

function makeTable(headers, rows) {
  const table = h('table');
  const thead = h('thead');
  const hr = h('tr');
  for (const col of headers) hr.appendChild(h('th', null, col));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h('tr');
    for (const cell of row) {
      if (cell instanceof Node) {
        const td = h('td');
        td.appendChild(cell);
        tr.appendChild(td);
      } else if (cell && typeof cell === 'object' && 'text' in cell) {
        tr.appendChild(h('td', cell.cls || null, cell.text));
      } else {
        tr.appendChild(h('td', null, cell == null ? '—' : String(cell)));
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function setTab(tabName) {
  const valid = ['overview', 'models', 'studies', 'updates'];
  state.activeTab = valid.includes(tabName) ? tabName : 'overview';
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.tab === state.activeTab);
  });
  document.querySelectorAll('.view').forEach((sec) => {
    sec.classList.toggle('is-hidden', sec.dataset.view !== state.activeTab);
  });
  if (location.hash.replace('#', '') !== state.activeTab) {
    history.replaceState(null, '', `#${state.activeTab}`);
  }
}

function renderHeader() {
  const { site } = state;
  if (!site) return;
  document.getElementById('hdr-meta').textContent =
    `commit ${site.git?.sha || '—'} · updated ${fmtTime(site.generatedAt)}`;
  const modePill = document.getElementById('pill-mode');
  modePill.textContent = site.botMode || 'PAPER';
  modePill.className = `pill ${site.botMode === 'LIVE' ? 'badge--emerald' : 'badge--amber'}`;
  document.getElementById('pill-model').textContent = site.activeModelId || 'no model';
  document.getElementById('footer-build').textContent =
    `Build: ${site.generatedAt} · Git ${site.git?.branch || 'main'}@${site.git?.sha || '?'} · Models ${site.counts?.models ?? 0} · Studies ${site.counts?.studies ?? 0}`;
}

function renderOverview() {
  const { site } = state;
  const ev = site.eval;
  const am = site.activeModelSummary;

  const kpiWrap = document.getElementById('overview-kpis');
  kpiWrap.replaceChildren();
  const retUsd = (ev.bankroll ?? 100) - (ev.startBankroll ?? 100);
  const retPct = ev.startBankroll ? (retUsd / ev.startBankroll) * 100 : 0;

  const cards = [
    {
      k: 'Fresh Eval Capital',
      v: fmtUsd(ev.bankroll),
      cls: retUsd >= 0 ? 'c-pos' : 'c-neg',
      hint: `Start ${fmtUsd(ev.startBankroll)} · Net ${fmtUsd(retUsd, true)} (${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%)`,
    },
    {
      k: 'Eval Record & Margin',
      v: ev.winRatePct != null ? `${ev.wins}W–${ev.losses}L (${ev.winRatePct}%)` : '0W–0L',
      cls: (ev.marginVsBreakevenPp ?? 0) >= 0 ? 'c-pos' : 'c-neg',
      hint: ev.breakevenWrPct != null ? `BE ${ev.breakevenWrPct}% · Margin ${(ev.marginVsBreakevenPp >= 0 ? '+' : '') + ev.marginVsBreakevenPp}pp` : 'Awaiting first settled trades',
    },
    {
      k: 'Active ML Model',
      v: am ? `${fmtPct(am.ensembleAcc)} Acc` : '—',
      cls: 'c-cyan',
      hint: am ? `${am.id} · AUC ${fmtNum(am.ensembleAuc)} · Skill ${fmtPct(am.brierSkillVsMarket)}` : '—',
    },
    {
      k: 'Risk & Execution',
      v: ev.profitFactor != null ? `PF ${ev.profitFactor}` : '—',
      cls: 'c-pos',
      hint: `Max DD ${fmtUsd(ev.maxDrawdownUsd)} · Avg ${ev.avgEntryCents != null ? ev.avgEntryCents + '¢' : '—'} · PTB Exact ${ev.ptbHealth ? ev.ptbHealth.exactPct + '%' : '—'}`,
    },
  ];
  for (const c of cards) {
    const box = h('div', 'kpi');
    box.appendChild(h('div', 'kpi__label', c.k));
    box.appendChild(h('div', `kpi__val ${c.cls}`, c.v));
    box.appendChild(h('div', 'kpi__hint', c.hint));
    kpiWrap.appendChild(box);
  }

  drawEquityChart(document.getElementById('chart-equity'), ev.equityCurve);
  document.getElementById('equity-sub').textContent =
    ev.hasLiveData
      ? `${ev.totalTrades} trade(s) in current window · peak ${fmtUsd(ev.peakBankroll)}${ev.evalWindowStart ? ` · since ${ev.evalWindowStart}` : ''}`
      : 'Local static preview (no VPS bot/data attached — synced live when published on VPS)';

  const amp = document.getElementById('active-model-panel');
  amp.replaceChildren();
  if (am) {
    const grid = h('div', 'stat-pair-grid');
    const pairs = [
      ['Model ID', am.id],
      ['Pipeline', `v${am.featurePipeline} · ${am.rows ? am.rows.toLocaleString() + ' mkts' : '—'}`],
      ['Ensemble Acc', fmtPct(am.ensembleAcc)],
      ['Ensemble AUC', fmtNum(am.ensembleAuc)],
      ['Brier / ECE', `${fmtNum(am.ensembleBrier)} / ${fmtNum(am.calibrationEce)}`],
      ['Skill vs Mkt', fmtPct(am.brierSkillVsMarket)],
      ['Pruned Feats', am.prunedCount != null ? `${am.prunedCount} pruned` : '0 pruned'],
      ['Calibration', am.hasPhaseCalibration ? '4-Phase Power-θ' : 'Global Platt'],
    ];
    for (const [k, v] of pairs) {
      const m = h('div', 'stat-mini');
      m.appendChild(h('div', 'stat-mini__k', k));
      m.appendChild(h('div', 'stat-mini__v', v));
      grid.appendChild(m);
    }
    amp.appendChild(grid);
    if (am.profileLabel) amp.appendChild(h('p', 'mono-dim', `Live Profile: ${am.profileLabel}`));
  }

  // Breakdown
  const bd = document.getElementById('eval-breakdown');
  bd.replaceChildren();
  const bdRows = [];
  const pushMap = (groupName, map) => {
    for (const [k, v] of Object.entries(map || {})) {
      const wr = v.trades > 0 ? ((v.wins / v.trades) * 100).toFixed(1) + '%' : '—';
      bdRows.push([groupName, k, `${v.wins}W–${v.losses}L (${v.trades})`, wr, { text: fmtUsd(v.pnl, true), cls: v.pnl >= 0 ? 'c-pos' : 'c-neg' }]);
    }
  };
  pushMap('Phase', ev.byPhase);
  pushMap('Side', ev.bySide);
  pushMap('Model', ev.byModel);
  if (bdRows.length) bd.appendChild(makeTable(['Group', 'Bucket', 'Record', 'WR', 'PnL'], bdRows));
  else bd.appendChild(h('div', 'empty-state', 'Breakdown populates automatically once trades settle.'));

  // PTB & Archive
  const ha = document.getElementById('health-archive-panel');
  ha.replaceChildren();
  const haGrid = h('div', 'stat-pair-grid');
  if (ev.ptbHealth) {
    const s1 = h('div', 'stat-mini');
    s1.appendChild(h('div', 'stat-mini__k', 'PTB TWAP Exact'));
    s1.appendChild(h('div', 'stat-mini__v c-pos', `${ev.ptbHealth.exactPct}%`));
    haGrid.appendChild(s1);
  }
  const cf = h('div', 'stat-mini');
  cf.appendChild(h('div', 'stat-mini__k', 'Cross-Feed Telemetry'));
  cf.appendChild(h('div', 'stat-mini__v', ev.crossFeed?.trackedTrades > 0 ? `${ev.crossFeed.trackedTrades} tr` : 'Ready'));
  haGrid.appendChild(cf);

  if (ev.archiveSummary) {
    const ar = ev.archiveSummary;
    const s2 = h('div', 'stat-mini');
    s2.appendChild(h('div', 'stat-mini__k', 'Legacy Archive'));
    s2.appendChild(h('div', 'stat-mini__v', `${ar.wins}W–${ar.losses}L`));
    haGrid.appendChild(s2);
    const s3 = h('div', 'stat-mini');
    s3.appendChild(h('div', 'stat-mini__k', 'Archive WR / End'));
    s3.appendChild(h('div', 'stat-mini__v', `${ar.winRatePct}% · ${fmtUsd(ar.endBankroll)}`));
    haGrid.appendChild(s3);
  }
  ha.appendChild(haGrid);

  // Recent trades
  const rtt = document.getElementById('recent-trades-table');
  rtt.replaceChildren();
  document.getElementById('trades-count').textContent = `${ev.recentTrades.length} shown`;
  if (ev.recentTrades.length === 0) {
    rtt.appendChild(h('div', 'empty-state', 'No settled trades in the current dataset yet.'));
  } else {
    const rows = ev.recentTrades.map((t) => {
      const slugLink = t.slug ? h('a', null, t.slug.replace('btc-updown-15m-', '15m-')) : h('span', null, '—');
      if (t.slug) { slugLink.href = `https://polymarket.com/event/${t.slug}`; slugLink.target = '_blank'; slugLink.rel = 'noopener noreferrer'; }
      return [
        fmtTime(t.exitedAt ?? t.ts),
        slugLink,
        t.side || '—',
        t.phase || '—',
        t.tokenPrice != null ? `${(t.tokenPrice * 100).toFixed(1)}¢` : '—',
        t.mlConfidence != null ? `${(t.mlConfidence * 100).toFixed(0)}%` : '—',
        t.bestEdge != null ? `${(t.bestEdge * 100).toFixed(1)}%` : '—',
        t.liveBasisUsd != null ? fmtUsd(t.liveBasisUsd, true) : '—',
        t.modelId || '—',
        { text: t.outcome || '—', cls: t.outcome === 'WIN' ? 'c-pos' : t.outcome === 'LOSS' ? 'c-neg' : '' },
        { text: fmtUsd(t.pnl, true), cls: (t.pnl ?? 0) >= 0 ? 'c-pos' : 'c-neg' },
      ];
    });
    rtt.appendChild(makeTable(['Settled (WIB)', 'Market', 'Side', 'Phase', 'Entry', 'ML Conf', 'Edge', 'Basis', 'Model', 'Result', 'PnL'], rows));
  }

  // Current status from UPDATES.md
  document.getElementById('status-updated-at').textContent = site.currentStatus?.lastUpdated ? `Snapshot: ${site.currentStatus.lastUpdated}` : '';
  const cst = document.getElementById('current-status-table');
  cst.replaceChildren();
  const sRows = (site.currentStatus?.rows || []).map((r) => [r.area, r.state.replace(/`/g, '').replace(/\*\*/g, '')]);
  cst.appendChild(makeTable(['Area', 'Current State'], sRows));
}

function renderModelKpis(m) {
  const badges = document.getElementById('ml-selected-badges');
  badges.replaceChildren();
  badges.appendChild(h('span', `badge ${m.isActive ? 'badge--emerald' : 'badge--cyan'}`, `${m.status}${m.isActive ? ' ★ LIVE' : ''}`));
  badges.appendChild(h('span', 'badge badge--cyan', `Pipeline v${m.featurePipeline}`));
  if (m.trainingMeta?.rows) {
    badges.appendChild(h('span', 'badge', `${m.trainingMeta.rows.toLocaleString()} mkts · ${m.trainingMeta.days || '?'}d`));
  }
  const activeCount = m.featureCatalog ? m.featureCatalog.filter((f) => f.status === 'active').length : m.calibration?.xgb?.numFeatures;
  const totalFeats = m.featureCatalog?.length || activeCount;
  if (activeCount != null) badges.appendChild(h('span', 'badge', `${activeCount}/${totalFeats} features`));
  if (m.gate) {
    badges.appendChild(h('span', `badge ${m.gate.pass ? 'badge--emerald' : 'badge--rose'}`, `Gates ${m.gate.checks?.length || 0}/${m.gate.checks?.length || 0} ${m.gate.pass ? 'PASS' : 'FAIL'}`));
  }

  const ens = m.metrics?.ensemble;
  const xgb = m.metrics?.xgb;
  const primary = ens || xgb || {};
  const prunedCnt = m.reportSummary?.prunedCount ?? m.calibration?.xgb?.prunedFeatures?.length ?? 0;

  const kpiWrap = document.getElementById('ml-kpi-grid');
  kpiWrap.replaceChildren();
  const cards = [
    {
      k: 'Ensemble Test Acc',
      v: fmtPct(primary.accuracy),
      cls: 'c-cyan',
      hint: `XGB ${fmtPct(xgb?.accuracy)} · LGB ${fmtPct(m.metrics?.lgb?.accuracy)}`,
    },
    {
      k: 'Ensemble ROC-AUC',
      v: fmtNum(primary.auc),
      cls: 'c-pos',
      hint: `XGB ${fmtNum(xgb?.auc)} · LGB ${fmtNum(m.metrics?.lgb?.auc)}`,
    },
    {
      k: 'Skill vs Market',
      v: primary.brier_skill_vs_market != null ? `${primary.brier_skill_vs_market >= 0 ? '+' : ''}${(primary.brier_skill_vs_market * 100).toFixed(2)}%` : '—',
      cls: (primary.brier_skill_vs_market ?? 0) >= 0 ? 'c-pos' : 'c-neg',
      hint: `Model Brier ${fmtNum(primary.brier)} vs Mkt ${fmtNum(primary.market_brier)}`,
    },
    {
      k: 'Calibration ECE / MCE',
      v: `${fmtNum(primary.calibration_ece)} / ${fmtNum(primary.calibration_mce)}`,
      cls: (primary.calibration_ece ?? 1) <= 0.03 ? 'c-pos' : 'c-warn',
      hint: m.calibration?.xgb?.plattByPhase ? '4-Phase Power-θ (Holdout Cal)' : 'Global Platt Sigmoid',
    },
    {
      k: 'CV → Holdout Audit',
      v: xgb?.holdout_auc != null ? `${fmtNum(xgb.cv_auc)} → ${fmtNum(xgb.holdout_auc)}` : fmtNum(xgb?.cv_auc),
      cls: 'c-cyan',
      hint: xgb?.test_holdout_acc_gap != null
        ? `CV Acc ${fmtPct(xgb.cv_acc)} · Holdout ${fmtPct(xgb.holdout_accuracy)} · Gap ${(xgb.test_holdout_acc_gap * 100).toFixed(2)}pp`
        : `${primary.test_samples ? primary.test_samples.toLocaleString() + ' test samples' : 'Temporal split'}`,
    },
    {
      k: 'Feature Disposition',
      v: `${activeCount ?? '—'} Active / ${prunedCnt} Pruned`,
      cls: 'c-warn',
      hint: `${m.calibration?.xgb?.numTrees ?? m.reportSummary?.trees ?? '—'} XGB trees + ${m.calibration?.lgb?.numTrees ?? '—'} LGB trees`,
    },
  ];
  for (const c of cards) {
    const box = h('div', 'kpi');
    box.appendChild(h('div', 'kpi__label', c.k));
    box.appendChild(h('div', `kpi__val ${c.cls}`, c.v));
    box.appendChild(h('div', 'kpi__hint', c.hint));
    kpiWrap.appendChild(box);
  }
}

function renderSubmodelMatrix(m) {
  const wrap = document.getElementById('ml-submodel-table');
  wrap.replaceChildren();
  const xgb = m.metrics?.xgb;
  const lgb = m.metrics?.lgb;
  const ens = m.metrics?.ensemble;
  const w = m.calibration?.ensembleWeights;

  const weightStr = (k) => (w && typeof w[k] === 'number' ? `${(w[k] * 100).toFixed(1)}%` : '—');
  const mktBrier = ens?.market_brier ?? xgb?.market_brier ?? null;

  const cols = [
    { name: `Ensemble (${w ? `${weightStr('xgb')}/${weightStr('lgb')}` : 'Blend'})`, src: ens, meta: ens?.weight_source || 'oof_blend' },
    { name: `XGBoost (${m.calibration?.xgb?.numTrees ?? '—'} trees)`, src: xgb, meta: `w=${weightStr('xgb')}` },
    { name: `LightGBM (${m.calibration?.lgb?.numTrees ?? '—'} trees)`, src: lgb, meta: `w=${weightStr('lgb')}` },
  ];

  const rows = [
    ['Test Accuracy', ...cols.map((c) => fmtPct(c.src?.accuracy))],
    ['Test ROC-AUC', ...cols.map((c) => fmtNum(c.src?.auc))],
    ['5-Fold CV Accuracy', fmtPct(xgb?.cv_acc ?? lgb?.cv_acc), fmtPct(xgb?.cv_acc), fmtPct(lgb?.cv_acc)],
    ['5-Fold CV AUC', fmtNum(xgb?.cv_auc ?? lgb?.cv_auc), fmtNum(xgb?.cv_auc), fmtNum(lgb?.cv_auc)],
    ['Strict Holdout Acc / AUC', 'Holdout Cal Source', xgb?.holdout_accuracy != null ? `${fmtPct(xgb.holdout_accuracy)} / ${fmtNum(xgb.holdout_auc)}` : '—', 'Blended via OOF'],
    ['LogLoss / Brier Score', ...cols.map((c) => `${fmtNum(c.src?.logloss)} / ${fmtNum(c.src?.brier)}`)],
    ['Calib ECE / MCE', ...cols.map((c) => `${fmtNum(c.src?.calibration_ece)} / ${fmtNum(c.src?.calibration_mce)}`)],
    ['Brier Skill vs Market', ...cols.map((c) => fmtPct(c.src?.brier_skill_vs_market))],
    ['High-Conf Precision', `${m.calibration?.xgb?.numFeatures ?? '—'} features`, xgb?.high_conf_accuracy != null ? `${fmtPct(xgb.high_conf_accuracy)} (${xgb.high_conf_count} @ ≥${((xgb.high_conf_threshold ?? 0.65) * 100).toFixed(0)}%)` : '—', 'Leaf-wise gain'],
    ['Market Baseline Brier', fmtNum(mktBrier), `${ens?.test_samples ?? xgb?.test_samples ?? '—'} test rows`, `${ens?.holdout_samples ?? xgb?.holdout_samples ?? '—'} holdout`],
  ];
  wrap.appendChild(makeTable(['Metric', cols[0].name, cols[1].name, cols[2].name], rows));
}

function renderAuditPanel(m) {
  const wrap = document.getElementById('ml-audit-panel');
  wrap.replaceChildren();
  const xgb = m.metrics?.xgb || {};
  const val = m.validation || {};
  const p = m.xgbParams || {};

  const gapGrid = h('div', 'stat-pair-grid');
  const auditPairs = [
    ['CV → Test Acc Gap', xgb.cv_test_acc_gap != null ? `${(xgb.cv_test_acc_gap * 100).toFixed(2)} pp` : '—'],
    ['CV → Test AUC Gap', xgb.cv_test_auc_gap != null ? `${xgb.cv_test_auc_gap.toFixed(4)}` : '—'],
    ['Test → Holdout Acc Gap', xgb.test_holdout_acc_gap != null ? `${(xgb.test_holdout_acc_gap * 100).toFixed(2)} pp` : '—'],
    ['Optimal Thr (OOF)', fmtNum(m.calibration?.xgb?.optimalThreshold ?? m.reportSummary?.optimalThreshold, 3)],
    ['Split / Samples', `${val.split || 'temporal'} · ${val.test_samples ?? xgb.test_samples ?? '—'} test`],
    ['Recency Weighting', m.calibration?.xgb?.recencyWeighting ? `${m.calibration.xgb.recencyWeighting.half_life_days || m.calibration.xgb.recencyWeighting.halfLifeDays || '?'}d half-life` : (m.reportSummary?.recency || '—')],
  ];
  for (const [k, v] of auditPairs) {
    const d = h('div', 'stat-mini');
    d.appendChild(h('div', 'stat-mini__k', k));
    d.appendChild(h('div', 'stat-mini__v', v));
    gapGrid.appendChild(d);
  }
  wrap.appendChild(gapGrid);

  if (Object.keys(p).length > 0) {
    const sec = h('div', 'audit-section');
    sec.appendChild(h('h4', null, 'Optuna Tuned XGBoost Hyperparameters'));
    const chips = h('div', 'chip-list');
    const keys = ['max_depth', 'learning_rate', 'min_child_weight', 'subsample', 'colsample_bytree', 'gamma', 'reg_alpha', 'reg_lambda', 'scale_pos_weight'];
    for (const k of keys) {
      if (p[k] == null) continue;
      const num = Number(p[k]);
      const valTxt = Number.isFinite(num) && !Number.isInteger(num) ? num.toFixed(4) : String(p[k]);
      chips.appendChild(h('span', 'badge badge--cyan', `${k}=${valTxt}`));
    }
    sec.appendChild(chips);
    wrap.appendChild(sec);
  }

  const mod = m.calibration?.signalModifiers;
  const pt = m.calibration?.phaseThresholds;
  if (mod || pt) {
    const sec = h('div', 'audit-section');
    sec.appendChild(h('h4', null, 'Learned Signal Modifiers & Phase Thresholds'));
    const chips = h('div', 'chip-list');
    if (pt) {
      for (const [ph, cfg] of Object.entries(pt)) {
        chips.appendChild(h('span', 'badge badge--emerald', `${ph}: edge≥${(cfg.minEdge * 100).toFixed(0)}% prob≥${(cfg.minProb * 100).toFixed(0)}%`));
      }
    }
    if (mod) {
      for (const [k, v] of Object.entries(mod)) {
        chips.appendChild(h('span', 'badge', `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`));
      }
    }
    sec.appendChild(chips);
    wrap.appendChild(sec);
  }
}

function renderCalibrationSection(m) {
  drawCalibrationCurve(document.getElementById('chart-calib-bins'), m.calibrationBins);
  const cWrap = document.getElementById('ml-calib-table');
  cWrap.replaceChildren();
  if (m.calibrationBins?.length) {
    cWrap.appendChild(makeTable(
      ['Decile', 'Pred Avg', 'Emp UP Rate', 'Abs Gap', 'Samples (Cov)'],
      m.calibrationBins.map((b) => [
        `[${(b.min_prob * 100).toFixed(0)}–${(b.max_prob * 100).toFixed(0)}%]`,
        fmtPct(b.avg_predicted),
        fmtPct(b.observed_rate),
        { text: `${(b.gap * 100).toFixed(2)} pp`, cls: Math.abs(b.gap) <= 0.025 ? 'c-pos' : 'c-warn' },
        `${b.count} (${b.coverage_pct}%)`,
      ]),
    ));
  }

  drawConfidenceBuckets(document.getElementById('chart-conf-buckets'), m.confidenceBuckets);
  const bWrap = document.getElementById('ml-buckets-table');
  bWrap.replaceChildren();
  if (m.confidenceBuckets?.length) {
    bWrap.appendChild(makeTable(
      ['Conf Band', 'Test Accuracy', 'Count', 'Coverage'],
      m.confidenceBuckets.map((b) => [
        `${Math.round(b.min_confidence * 100)}%–${Math.round(b.max_confidence * 100)}%`,
        { text: fmtPct(b.accuracy), cls: b.accuracy >= 0.78 ? 'c-pos' : b.accuracy >= 0.60 ? 'c-cyan' : 'c-neg' },
        String(b.count),
        `${b.coverage_pct}%`,
      ]),
    ));
  }

  const xgbP = m.calibration?.xgb?.plattByPhase;
  const lgbP = m.calibration?.lgb?.plattByPhase;
  drawPhaseThetaChart(document.getElementById('chart-phase-theta'), xgbP, lgbP);
  drawPhaseResponseCurve(document.getElementById('chart-phase-response'), xgbP, lgbP);

  const pWrap = document.getElementById('ml-phase-table');
  pWrap.replaceChildren();
  if (xgbP || lgbP) {
    const phases = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];
    pWrap.appendChild(makeTable(
      ['Phase', 'XGB θ (a, b)', 'LGB θ (a, b)', 'Calibration Action'],
      phases.map((ph) => {
        const xp = xgbP?.[ph];
        const lp = lgbP?.[ph];
        const avgTheta = xp && lp ? (xp.theta + lp.theta) / 2 : (xp?.theta ?? lp?.theta);
        return [
          ph,
          xp ? `${xp.theta.toFixed(4)} (${xp.a.toFixed(3)}, ${xp.b >= 0 ? '+' : ''}${xp.b.toFixed(3)})` : '—',
          lp ? `${lp.theta.toFixed(4)} (${lp.a.toFixed(3)}, ${lp.b >= 0 ? '+' : ''}${lp.b.toFixed(3)})` : '—',
          avgTheta == null ? '—' : avgTheta < 0.98 ? 'Soften overconfidence' : avgTheta > 1.03 ? 'Sharpen late certainty' : 'Near identity (θ≈1)',
        ];
      }),
    ));
  }
}

function renderFeatureExplorer(m) {
  const catalog = m?.featureCatalog || [];
  drawFeatureImportanceBars(document.getElementById('chart-feat-importance'), catalog, state.featMode);

  const counts = { ALL: catalog.length, active: 0, pruned: 0, pre_excluded: 0, zero_split: 0 };
  const groups = new Set(['ALL']);
  for (const f of catalog) {
    counts[f.status] = (counts[f.status] || 0) + 1;
    if (f.group) groups.add(f.group);
  }

  const stChips = document.getElementById('feat-status-chips');
  stChips.replaceChildren();
  const statusLabels = [
    ['ALL', `All (${counts.ALL})`],
    ['active', `Active (${counts.active})`],
    ['pruned', `Fold-Pruned (${counts.pruned})`],
    ['pre_excluded', `Pre-Excluded (${counts.pre_excluded})`],
    ['zero_split', `0 Splits (${counts.zero_split})`],
  ];
  for (const [key, label] of statusLabels) {
    if (key !== 'ALL' && !counts[key]) continue;
    const b = h('button', `filter-chip ${state.featStatus === key ? 'is-active' : ''}`, label);
    b.addEventListener('click', () => { state.featStatus = key; renderFeatureExplorer(m); });
    stChips.appendChild(b);
  }

  const grChips = document.getElementById('feat-group-chips');
  grChips.replaceChildren();
  for (const g of groups) {
    const b = h('button', `filter-chip ${state.featGroup === g ? 'is-active' : ''}`, g);
    b.addEventListener('click', () => { state.featGroup = g; renderFeatureExplorer(m); });
    grChips.appendChild(b);
  }

  const q = state.featQuery.trim().toLowerCase();
  const filtered = catalog.filter((f) => {
    if (state.featStatus !== 'ALL' && f.status !== state.featStatus) return false;
    if (state.featGroup !== 'ALL' && f.group !== state.featGroup) return false;
    if (q && !f.name.toLowerCase().includes(q) && !String(f.idx).includes(q)) return false;
    return true;
  });

  const metricOf = (f) => (state.featMode === 'lgbGainPct' ? (f.lgbGainPct ?? 0) : state.featMode === 'xgbRootSplits' ? (f.xgbRootSplits ?? 0) : (f.xgbSplits ?? 0));
  filtered.sort((a, b) => (metricOf(b) - metricOf(a)) || (a.idx - b.idx));

  const tWrap = document.getElementById('ml-features-table');
  tWrap.replaceChildren();
  if (filtered.length === 0) {
    tWrap.appendChild(h('div', 'empty-state', 'No features match this filter.'));
    return;
  }

  const statusBadge = (s) => {
    const cls = s === 'active' ? 'c-pos' : s === 'pruned' || s === 'pre_excluded' ? 'c-warn' : 'mono-dim';
    return { text: s, cls };
  };
  tWrap.appendChild(makeTable(
    ['#', 'Feature Name', 'Group', 'Status', 'XGB Splits', 'XGB Share', 'Root', 'LGB Splits', 'LGB Gain %', 'Norm μ ± σ'],
    filtered.map((f) => [
      String(f.idx),
      { text: `${f.name}${f.isEngineered ? ' *' : ''}`, cls: f.status === 'active' ? 'c-cyan' : 'mono-dim' },
      f.group || '—',
      statusBadge(f.status),
      f.xgbSplits != null ? String(f.xgbSplits) : '—',
      f.xgbSharePct != null ? `${f.xgbSharePct.toFixed(2)}%` : '—',
      f.xgbRootSplits != null ? String(f.xgbRootSplits) : '—',
      f.lgbSplits != null ? String(f.lgbSplits) : '—',
      f.lgbGainPct != null ? `${f.lgbGainPct.toFixed(2)}%` : '—',
      f.mean != null ? `${f.mean.toFixed(3)} ± ${f.std?.toFixed(3) ?? '?'}` : '—',
    ]),
  ));
}

function renderGatesAndReport(m) {
  const wrap = document.getElementById('ml-gates-report');
  wrap.replaceChildren();

  if (m.gate?.checks?.length) {
    const gTitle = h('div', 'mono-dim', `Quality Gates (${m.gate.pass ? 'ALL PASSED' : 'FAILED'}):`);
    wrap.appendChild(gTitle);
    const chips = h('div', 'chip-list');
    for (const c of m.gate.checks) {
      const label = typeof c === 'string' ? c : `${c.name}: ${c.pass ? 'PASS' : 'FAIL'}`;
      const ok = /pass|true/i.test(label);
      chips.appendChild(h('span', `badge ${ok ? 'badge--emerald' : 'badge--rose'}`, label));
    }
    wrap.appendChild(chips);
  }

  if (m.notes?.length) {
    for (const n of m.notes) {
      const p = h('p', 'card__sub', n);
      p.style.marginTop = '10px';
      wrap.appendChild(p);
    }
  }

  if (m.reportText) {
    const rTitle = h('div', 'mono-dim', 'Raw training_report.txt:');
    rTitle.style.marginTop = '12px';
    wrap.appendChild(rTitle);
    wrap.appendChild(h('pre', 'report-pre', m.reportText));
  }
}

function renderModelInspector() {
  const m = state.models?.models?.find((x) => x.id === state.selectedModelId) || state.models?.models?.[0];
  if (!m) return;
  renderModelKpis(m);
  renderSubmodelMatrix(m);
  renderAuditPanel(m);
  renderCalibrationSection(m);
  renderFeatureExplorer(m);
  renderGatesAndReport(m);
}

function renderOosSection() {
  const { models } = state;
  const richEval = [...(models?.oosBenchmarks || [])].reverse().find((e) => e.fullOos && typeof e.fullOos === 'object');
  const sliceKey = state.presetSlice === 'exact2175' ? 'exact2175' : 'fullOos';
  const sliceObj = richEval?.[sliceKey] || richEval?.fullOos;

  const tierSeries = [];
  const presetRows = [];

  if (sliceObj) {
    document.getElementById('oos-slice-sub').textContent =
      `Benchmark slice ${sliceObj.slice || 'shared OOS'} (official CLOB V2 taker fee · Market Brier ${fmtNum(sliceObj.brierMkt)})`;

    for (const [k, obj] of Object.entries(sliceObj)) {
      if (!obj || typeof obj !== 'object' || !obj.tiers) continue;
      tierSeries.push({ label: `${obj.name || k} (${k.slice(-6)})`, tiers: obj.tiers });
      const list = Array.isArray(obj.topPresets) && obj.topPresets.length
        ? obj.topPresets
        : [obj.preset_45_72_06, obj.preset_55_58_06, obj.preset_45_65_06].filter(Boolean);
      for (const pr of list) {
        presetRows.push([
          `${obj.name || k}`,
          `≥${Math.round((pr.confMin ?? 0) * 100)}% / ≤${Math.round((pr.cap ?? 0) * 100)}¢ / ${(pr.minEdge * 100).toFixed(0)}%`,
          String(pr.trades),
          `${pr.wr}%`,
          { text: fmtUsd(pr.pnl, true), cls: pr.pnl >= 0 ? 'c-pos' : 'c-neg' },
          { text: `${pr.roiPct >= 0 ? '+' : ''}${pr.roiPct}%`, cls: pr.roiPct >= 0 ? 'c-pos' : 'c-neg' },
          `${pr.pf} · DD ${fmtUsd(pr.maxDd)}`,
        ]);
      }
    }
  }
  drawTierCurve(document.getElementById('chart-oos-tiers'), tierSeries);

  const opWrap = document.getElementById('oos-presets-table');
  opWrap.replaceChildren();
  const latestAgentEval = models?.models?.find((m) => m.latestEval?.fullOos_acc != null);
  if (latestAgentEval) {
    const e = latestAgentEval.latestEval;
    opWrap.appendChild(h('p', 'mono-dim',
      `Latest Live Model (${latestAgentEval.id}) vs ${e.vs_previous}: `
      + `Full OOS Acc ${e.fullOos_acc}% · AUC ${e.fullOos_auc} · Skill +${e.fullOos_skillPct}% · ECE ${e.fullOos_ece} · `
      + `Exact2175 AUC ${e.exact2175_auc} (+${e.exact2175_skillPct}% skill)`));
  }
  if (presetRows.length) {
    opWrap.appendChild(makeTable(['Model Config', 'Conf / Cap / Edge', 'Trades', 'WR', 'PnL', 'ROI', 'PF · Max DD'], presetRows));
  } else {
    opWrap.appendChild(h('div', 'empty-state', 'No preset sweep rows in this slice.'));
  }
}

function renderModelsLedger() {
  const { models } = state;
  const detailedMap = new Map((models.models || []).map((m) => [m.id, m]));
  const srcList = state.showLegacyModels
    ? [...(models.timelineModels || [])].reverse()
    : [...(models.timelineModels || [])].reverse().filter((m) => (m.featurePipeline ?? 1) >= 2);

  const btn = document.getElementById('btn-toggle-legacy');
  if (btn) btn.textContent = state.showLegacyModels ? `Hide v1 Archive (${models.timelineModels?.length || 0} total)` : `Show All 27 Incl. v1 Archive`;

  const led = document.getElementById('models-ledger-table');
  led.replaceChildren();
  const lRows = srcList.map((t) => {
    const d = detailedMap.get(t.id);
    const acc = d?.metrics?.ensemble?.accuracy ?? d?.metrics?.xgb?.accuracy ?? t.accuracy;
    const auc = d?.metrics?.ensemble?.auc ?? d?.metrics?.xgb?.auc ?? t.auc;
    const brier = d?.metrics?.ensemble?.brier ?? d?.metrics?.xgb?.brier;
    const ece = d?.metrics?.ensemble?.calibration_ece ?? d?.metrics?.xgb?.calibration_ece ?? t.ece;
    const skill = d?.metrics?.ensemble?.brier_skill_vs_market ?? d?.metrics?.xgb?.brier_skill_vs_market ?? t.skill;
    return [
      { text: t.isActive ? `${t.id} ★` : t.id, cls: t.isActive ? 'c-cyan' : '' },
      t.status,
      `v${t.featurePipeline ?? 1}`,
      d?.trainingMeta?.rows ? `${d.trainingMeta.rows.toLocaleString()} (${d.trainingMeta.days || '?'}d)` : (t.dataRange || '—'),
      fmtPct(acc),
      fmtNum(auc),
      fmtNum(brier),
      fmtNum(ece),
      skill != null ? { text: `${skill >= 0 ? '+' : ''}${(skill * 100).toFixed(2)}%`, cls: skill >= 0 ? 'c-pos' : 'c-neg' } : '—',
      d?.reportSummary?.prunedCount != null ? `${d.reportSummary.prunedCount} pruned` : '—',
      d?.gate ? (d.gate.pass ? `${d.gate.checks.length}/${d.gate.checks.length} PASS` : 'FAIL') : '—',
    ];
  });
  led.appendChild(makeTable(['Model ID', 'Status', 'Pipe', 'Dataset', 'Test Acc', 'AUC', 'Brier', 'ECE', 'Skill', 'Pruning', 'Gate'], lRows));
}

function renderModelsTab() {
  const { models } = state;
  if (!models) return;

  const list = models.models || [];
  drawEvolutionChart(document.getElementById('chart-model-evolution'), models.timelineModels);

  const specs = {
    accuracy: { title: 'Test Accuracy', minFloor: 0.72, format: (v) => `${(v * 100).toFixed(2)}%`, pick: (m) => m.metrics?.ensemble?.accuracy ?? m.metrics?.xgb?.accuracy ?? null },
    auc: { title: 'Test ROC-AUC', minFloor: 0.82, format: (v) => v.toFixed(4), pick: (m) => m.metrics?.ensemble?.auc ?? m.metrics?.xgb?.auc ?? null },
    skill: { title: 'Brier Skill vs Market', minFloor: -0.02, format: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`, pick: (m) => m.metrics?.ensemble?.brier_skill_vs_market ?? m.metrics?.xgb?.brier_skill_vs_market ?? null },
    brier: { title: 'Test Brier Score (↓ better)', minFloor: 0.14, format: (v) => v.toFixed(4), pick: (m) => m.metrics?.ensemble?.brier ?? m.metrics?.xgb?.brier ?? null },
    ece: { title: 'Calibration ECE (↓ better)', minFloor: 0, format: (v) => v.toFixed(4), pick: (m) => m.metrics?.ensemble?.calibration_ece ?? m.metrics?.xgb?.calibration_ece ?? null },
  };
  const spec = specs[state.metricKey] || specs.accuracy;
  const items = list.map((m) => ({
    label: m.id,
    value: spec.pick(m),
    isActive: m.isActive,
    highlight: m.latestEval?.fullOos_skillPct != null,
    sub: `${m.trainingMeta?.rows ? m.trainingMeta.rows.toLocaleString() + ' mkts' : ''} · ${m.status}`,
  }));
  drawMetricBars(document.getElementById('chart-models-bar'), items, spec);

  const sel = document.getElementById('model-inspector-select');
  sel.replaceChildren();
  for (const m of list) {
    const opt = h('option', null, `${m.id} (${m.status}${m.isActive ? ' ★' : ''})`);
    opt.value = m.id;
    sel.appendChild(opt);
  }
  if (!state.selectedModelId || !list.some((m) => m.id === state.selectedModelId)) {
    state.selectedModelId = models.activeModelId || list[0]?.id || null;
  }
  sel.value = state.selectedModelId || '';

  renderModelInspector();
  renderOosSection();

  const expWrap = document.getElementById('ml-experiments-table');
  expWrap.replaceChildren();
  const exps = models.experiments || [];
  if (exps.length === 0) {
    expWrap.appendChild(h('div', 'empty-state', 'No offline experiment summaries found.'));
  } else {
    expWrap.appendChild(makeTable(
      ['Date', 'Model', 'Experiment & Outcome', 'Key Metrics'],
      exps.map((e) => [
        e.date || '—',
        e.modelId || '—',
        e.verdict ? `${e.title} [${e.verdict}]` : e.title,
        (e.highlights || []).join(' | ') || '—',
      ]),
    ));
  }

  renderModelsLedger();
}

function renderStudiesTab() {
  const { studies } = state;
  if (!studies) return;

  // Quant JSON studies cards
  const qGrid = document.getElementById('quant-studies-grid');
  qGrid.replaceChildren();
  const qs = studies.quantStudies || {};
  if (qs.calibration?.data) {
    const d = qs.calibration.data;
    const box = h('div', 'quant-box');
    box.appendChild(h('h3', null, qs.calibration.title));
    box.appendChild(h('p', 'mono-dim', `${d.rows} settled · best shrink ${d.bestShrinkWeight} · Test Brier: Model ${d.test?.model?.brier} → Market ${d.test?.market?.brier} → Shrunk ${d.test?.shrunk?.brier}`));
    qGrid.appendChild(box);
  }
  if (qs.shadowDecision?.data) {
    const d = qs.shadowDecision.data;
    const box = h('div', 'quant-box');
    box.appendChild(h('h3', null, qs.shadowDecision.title));
    box.appendChild(h('p', 'mono-dim', `${d.totalSettled} settled (${d.currentModelRows} current) · baseline vs Europe/MID filter split evaluated`));
    qGrid.appendChild(box);
  }
  if (qs.jevStack?.data) {
    const d = qs.jevStack.data;
    const box = h('div', 'quant-box');
    box.appendChild(h('h3', null, qs.jevStack.title));
    const lines = (d.skillVsMarket || []).map((s) => `${s.name}: ${(s.skill * 100).toFixed(2)}% skill`).join(' · ');
    box.appendChild(h('p', 'mono-dim', `${d.samples} mkts (${d.train}/${d.test}) · ${lines || 'evaluated'}`));
    qGrid.appendChild(box);
  }
  if (qs.jevTarget?.data) {
    const d = qs.jevTarget.data;
    const box = h('div', 'quant-box');
    box.appendChild(h('h3', null, qs.jevTarget.title));
    box.appendChild(h('p', 'mono-dim', `${d.samples} samples · ${d.folds} walk-forward folds · market Brier ${d.models?.market?.brier?.toFixed(4)} vs stack3 ${d.models?.stack3?.brier?.toFixed(4)}`));
    qGrid.appendChild(box);
  }
  if (qGrid.children.length === 0) {
    qGrid.appendChild(h('div', 'empty-state', 'VPS quant JSON studies will populate here automatically when synced from bot/data.'));
  }

  // Combine analysis markdown + registry research notes as readable items
  const allReports = [
    ...(studies.reports || []),
    ...(studies.registryNotes || []).map((n, idx) => ({
      id: `note-${idx}`,
      date: n.date || 'note',
      file: `ml_registry (${n.modelId || 'note'})`,
      title: `Research Note · ${n.modelId || ''} (${n.date || ''})`,
      excerpt: n.text.slice(0, 180),
      tags: ['ML'],
      markdown: `# Research Note (${n.date || 'ML Registry'})\n\n**Model:** \`${n.modelId || '—'}\` · **Actor:** \`${n.actor}\`\n\n${n.text}`,
    })),
  ];

  // Tags
  const tagSet = new Set(['ALL']);
  for (const r of allReports) for (const t of r.tags || []) tagSet.add(t);
  const tagWrap = document.getElementById('study-tag-filters');
  tagWrap.replaceChildren();
  for (const t of tagSet) {
    const btn = h('button', `filter-chip ${state.studyTag === t ? 'is-active' : ''}`, t);
    btn.addEventListener('click', () => { state.studyTag = t; renderStudiesTab(); });
    tagWrap.appendChild(btn);
  }

  const q = state.studyQuery.trim().toLowerCase();
  const filtered = allReports.filter((r) => {
    if (state.studyTag !== 'ALL' && !(r.tags || []).includes(state.studyTag)) return false;
    if (!q) return true;
    return `${r.title}\n${r.date}\n${r.markdown}`.toLowerCase().includes(q);
  });

  const listEl = document.getElementById('reports-list');
  listEl.replaceChildren();
  if (filtered.length === 0) {
    listEl.appendChild(h('div', 'empty-state', 'No matching reports.'));
  } else {
    if (!state.selectedReportId || !filtered.some((r) => r.id === state.selectedReportId)) {
      state.selectedReportId = filtered[0].id;
    }
    for (const r of filtered) {
      const btn = h('button', `report-item ${r.id === state.selectedReportId ? 'is-active' : ''}`);
      btn.appendChild(h('div', 'report-item__date', `${r.date} · ${r.file}`));
      btn.appendChild(h('div', 'report-item__title', r.title));
      btn.appendChild(h('div', 'report-item__excerpt', r.excerpt));
      btn.addEventListener('click', () => { state.selectedReportId = r.id; renderStudiesTab(); });
      listEl.appendChild(btn);
    }
  }

  const viewer = document.getElementById('report-viewer');
  const active = filtered.find((r) => r.id === state.selectedReportId) || filtered[0];
  if (active) renderMarkdown(active.markdown, viewer);
  else viewer.replaceChildren(h('div', 'empty-state', 'Select a study report to view.'));
}

function renderUpdatesTab() {
  const { updates } = state;
  if (!updates) return;

  const tagSet = new Set(['ALL']);
  for (const e of updates.entries || []) for (const t of e.tags || []) tagSet.add(t);
  const tagWrap = document.getElementById('update-tag-filters');
  tagWrap.replaceChildren();
  for (const t of tagSet) {
    const btn = h('button', `filter-chip ${state.updateTag === t ? 'is-active' : ''}`, t);
    btn.addEventListener('click', () => { state.updateTag = t; renderUpdatesTab(); });
    tagWrap.appendChild(btn);
  }

  const q = state.updateQuery.trim().toLowerCase();
  const filtered = (updates.entries || []).filter((e) => {
    if (state.updateTag !== 'ALL' && !(e.tags || []).includes(state.updateTag)) return false;
    if (!q) return true;
    return `${e.heading}\n${e.body}`.toLowerCase().includes(q);
  });

  const tl = document.getElementById('updates-timeline');
  tl.replaceChildren();
  if (filtered.length === 0) {
    tl.appendChild(h('div', 'empty-state', 'No matching changelog entries.'));
    return;
  }

  for (const e of filtered.slice(0, 60)) {
    const card = h('article', 'timeline-card');
    const top = h('div', 'timeline-card__top');
    top.appendChild(h('h3', 'timeline-card__title', e.heading));
    const tags = h('div', 'chip-list');
    for (const t of e.tags || []) tags.appendChild(h('span', 'badge badge--cyan', t));
    top.appendChild(tags);
    card.appendChild(top);
    const bodyWrap = h('div');
    renderMarkdown(e.body, bodyWrap);
    card.appendChild(bodyWrap);
    tl.appendChild(card);
  }
}

async function fetchJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function loadAll() {
  const errBox = document.getElementById('banner-error');
  try {
    errBox.classList.add('is-hidden');
    const [site, models, studies, updates] = await Promise.all([
      fetchJson('./data/site.json'),
      fetchJson('./data/models.json'),
      fetchJson('./data/studies.json'),
      fetchJson('./data/updates.json'),
    ]);
    state.site = site;
    state.models = models;
    state.studies = studies;
    state.updates = updates;
    renderHeader();
    renderOverview();
    renderModelsTab();
    renderStudiesTab();
    renderUpdatesTab();
  } catch (err) {
    errBox.textContent = `Failed to load study bundle: ${err.message}`;
    errBox.classList.remove('is-hidden');
  }
}

function wireEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
  document.getElementById('brand-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    setTab('overview');
  });
  document.getElementById('btn-open-models')?.addEventListener('click', () => setTab('models'));
  document.getElementById('btn-refresh')?.addEventListener('click', loadAll);
  document.querySelectorAll('#metric-switcher .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#metric-switcher .seg').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.metricKey = btn.dataset.metric;
      renderModelsTab();
    });
  });
  document.getElementById('model-inspector-select')?.addEventListener('change', (e) => {
    state.selectedModelId = e.target.value;
    renderModelInspector();
  });
  document.querySelectorAll('#feat-mode-switcher .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#feat-mode-switcher .seg').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.featMode = btn.dataset.featMode;
      const m = state.models?.models?.find((x) => x.id === state.selectedModelId) || state.models?.models?.[0];
      if (m) renderFeatureExplorer(m);
    });
  });
  document.getElementById('feat-search')?.addEventListener('input', (e) => {
    state.featQuery = e.target.value;
    const m = state.models?.models?.find((x) => x.id === state.selectedModelId) || state.models?.models?.[0];
    if (m) renderFeatureExplorer(m);
  });
  document.querySelectorAll('#preset-slice-switcher .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#preset-slice-switcher .seg').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.presetSlice = btn.dataset.presetSlice;
      renderOosSection();
    });
  });
  document.getElementById('btn-toggle-legacy')?.addEventListener('click', () => {
    state.showLegacyModels = !state.showLegacyModels;
    renderModelsLedger();
  });
  document.getElementById('study-search')?.addEventListener('input', (e) => {
    state.studyQuery = e.target.value;
    renderStudiesTab();
  });
  document.getElementById('update-search')?.addEventListener('input', (e) => {
    state.updateQuery = e.target.value;
    renderUpdatesTab();
  });
  window.addEventListener('hashchange', () => setTab(location.hash.replace('#', '')));
}

wireEvents();
setTab(location.hash.replace('#', '') || 'overview');
loadAll();
