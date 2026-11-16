import { renderMarkdown } from './markdown.js';
import { drawEquityChart, drawMetricBars, drawTierCurve, drawPhaseThetaChart } from './charts.js';

const state = {
  site: null,
  models: null,
  studies: null,
  updates: null,
  activeTab: 'overview',
  metricKey: 'accuracy',
  selectedModelId: null,
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

function renderModelsTab() {
  const { models } = state;
  if (!models) return;

  const list = models.models;
  const specs = {
    accuracy: {
      title: 'Test Accuracy',
      minFloor: 0.72,
      format: (v) => `${(v * 100).toFixed(2)}%`,
      pick: (m) => m.metrics?.ensemble?.accuracy ?? m.metrics?.xgb?.accuracy ?? null,
    },
    auc: {
      title: 'Test ROC-AUC',
      minFloor: 0.82,
      format: (v) => v.toFixed(4),
      pick: (m) => m.metrics?.ensemble?.auc ?? m.metrics?.xgb?.auc ?? null,
    },
    skill: {
      title: 'Brier Skill vs Market',
      minFloor: -0.02,
      format: (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
      pick: (m) => m.metrics?.ensemble?.brier_skill_vs_market ?? m.metrics?.xgb?.brier_skill_vs_market ?? null,
    },
    brier: {
      title: 'Test Brier Score (↓ better)',
      minFloor: 0.14,
      format: (v) => v.toFixed(4),
      pick: (m) => m.metrics?.ensemble?.brier ?? m.metrics?.xgb?.brier ?? null,
    },
    ece: {
      title: 'Calibration ECE (↓ better)',
      minFloor: 0,
      format: (v) => v.toFixed(4),
      pick: (m) => m.metrics?.ensemble?.calibration_ece ?? m.metrics?.xgb?.calibration_ece ?? null,
    },
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

  // OOS shared slice comparison (find newest evaluated event carrying fullOos presets/tiers)
  const richEval = [...models.oosBenchmarks].reverse().find((e) => e.fullOos && typeof e.fullOos === 'object');
  const tierSeries = [];
  const presetRows = [];
  if (richEval?.fullOos) {
    for (const [k, obj] of Object.entries(richEval.fullOos)) {
      if (obj && typeof obj === 'object' && obj.tiers) {
        tierSeries.push({ label: `${k} (${obj.name || ''})`, tiers: obj.tiers });
        const p55 = obj.preset_55_58_06 || obj.preset_45_65_06;
        presetRows.push([
          k,
          obj.name || '—',
          `${obj.acc?.toFixed(2) ?? '—'}%`,
          obj.auc?.toFixed(4) ?? '—',
          obj.skillPct != null ? `+${obj.skillPct}%` : '—',
          obj.ece?.toFixed(4) ?? '—',
          p55 ? `${p55.wr}% (${p55.trades} tr, ROI +${p55.roiPct}%)` : '—',
        ]);
      }
    }
    document.getElementById('oos-slice-sub').textContent =
      `Benchmark slice ${richEval.fullOos.slice || 'shared OOS'} (official CLOB V2 taker fee)`;
  }
  drawTierCurve(document.getElementById('chart-oos-tiers'), tierSeries);

  // Append latest agent fullOos eval row (e.g. 20261116-p2-ef8dfd) cleanly if separate
  const latestAgentEval = models.models.find((m) => m.latestEval?.fullOos_acc != null);
  if (latestAgentEval) {
    const e = latestAgentEval.latestEval;
    presetRows.unshift([
      latestAgentEval.id,
      'Group-1 TreeSHAP + 4-Phase',
      `${e.fullOos_acc}%`,
      `${e.fullOos_auc}`,
      `+${e.fullOos_skillPct}%`,
      `${e.fullOos_ece}`,
      `exact2175: ${e.exact2175_auc} AUC · +${e.exact2175_skillPct}% skill`,
    ]);
  }
  const opWrap = document.getElementById('oos-presets-table');
  opWrap.replaceChildren();
  if (presetRows.length) {
    opWrap.appendChild(makeTable(['Model', 'Config', 'OOS Acc', 'OOS AUC', 'Skill', 'ECE', 'Preset / Exact'], presetRows));
  }

  // Selector for Model Inspector
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

  // Ledger table
  const led = document.getElementById('models-ledger-table');
  led.replaceChildren();
  const lRows = list.map((m) => [
    { text: m.isActive ? `${m.id} ★` : m.id, cls: m.isActive ? 'c-cyan' : '' },
    m.status,
    `v${m.featurePipeline}`,
    m.trainingMeta?.rows ? `${m.trainingMeta.rows.toLocaleString()} (${m.trainingMeta.days || '?'}d)` : '—',
    fmtPct(m.metrics?.ensemble?.accuracy ?? m.metrics?.xgb?.accuracy),
    fmtNum(m.metrics?.ensemble?.auc ?? m.metrics?.xgb?.auc),
    fmtNum(m.metrics?.ensemble?.brier ?? m.metrics?.xgb?.brier),
    fmtNum(m.metrics?.ensemble?.calibration_ece ?? m.metrics?.xgb?.calibration_ece),
    fmtPct(m.metrics?.ensemble?.brier_skill_vs_market ?? m.metrics?.xgb?.brier_skill_vs_market),
    m.reportSummary?.prunedCount != null ? `${m.reportSummary.prunedCount} pruned` : '0',
    m.gate ? (m.gate.pass ? `${m.gate.checks.length}/${m.gate.checks.length} PASS` : 'FAIL') : '—',
  ]);
  led.appendChild(makeTable(['Model ID', 'Status', 'Pipe', 'Dataset', 'Test Acc', 'AUC', 'Brier', 'ECE', 'Skill', 'Pruning', 'Gate'], lRows));
}

function renderModelInspector() {
  const wrap = document.getElementById('model-inspector-detail');
  wrap.replaceChildren();
  const m = state.models?.models?.find((x) => x.id === state.selectedModelId);
  if (!m) { wrap.appendChild(h('div', 'empty-state', 'No model selected.')); return; }

  const xgbP = m.calibration?.xgb?.plattByPhase;
  const lgbP = m.calibration?.lgb?.plattByPhase;
  if (xgbP || lgbP) {
    wrap.appendChild(h('div', 'mono-dim', 'Per-Phase Power-θ Calibration (XGB cyan / LGB emerald):'));
    const cbox = h('div', 'chart-box');
    drawPhaseThetaChart(cbox, xgbP, lgbP);
    wrap.appendChild(cbox);
  } else {
    wrap.appendChild(h('p', 'mono-dim', `Legacy Global Platt Calibration: XGB A=${fmtNum(m.calibration?.xgb?.plattA)} B=${fmtNum(m.calibration?.xgb?.plattB)}`));
  }

  const pruned = m.reportSummary?.prunedFeatures || m.calibration?.xgb?.prunedFeatures || [];
  if (pruned.length > 0) {
    const pTitle = h('div', 'mono-dim', `Pruned Features (${pruned.length}):`);
    pTitle.style.marginTop = '10px';
    wrap.appendChild(pTitle);
    const chips = h('div', 'chip-list');
    for (const f of pruned) chips.appendChild(h('span', 'badge badge--amber', f));
    wrap.appendChild(chips);
  }

  if (m.gate?.checks?.length) {
    const gTitle = h('div', 'mono-dim', `Quality Gate Checks (${m.gate.pass ? 'PASS' : 'FAIL'}):`);
    gTitle.style.marginTop = '12px';
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
