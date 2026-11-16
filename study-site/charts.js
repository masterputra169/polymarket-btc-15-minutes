/**
 * Pure SVG chart renderers for POLY//15 Study Portal.
 * Zero external charting libraries; accessible, responsive viewBox SVGs.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = text;
  return node;
}

function showTip(evt, text) {
  const tip = document.getElementById('chart-tooltip');
  if (!tip) return;
  tip.textContent = text;
  tip.classList.remove('is-hidden');
  tip.style.left = `${Math.min(window.innerWidth - 240, evt.clientX + 14)}px`;
  tip.style.top = `${Math.max(10, evt.clientY - 26)}px`;
}

function hideTip() {
  const tip = document.getElementById('chart-tooltip');
  if (tip) tip.classList.add('is-hidden');
}

export function drawEquityChart(container, points) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(points) || points.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No trade equity data recorded in this dataset yet.';
    container.appendChild(empty);
    return;
  }

  const W = 680;
  const H = 250;
  const pad = { l: 56, r: 18, t: 18, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const vals = points.map((p) => p.bankroll);
  const base = points[0].bankroll;
  let minV = Math.min(base, ...vals);
  let maxV = Math.max(base, ...vals);
  if (Math.abs(maxV - minV) < 2) { minV -= 2; maxV += 2; }
  const margin = (maxV - minV) * 0.14;
  minV -= margin;
  maxV += margin;

  const xOf = (i) => (points.length === 1 ? pad.l + innerW / 2 : pad.l + (i / (points.length - 1)) * innerW);
  const yOf = (v) => pad.t + innerH - ((v - minV) / (maxV - minV)) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  // Horizontal grid + Y labels
  for (let g = 0; g <= 4; g++) {
    const val = minV + ((maxV - minV) * g) / 4;
    const y = yOf(val);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'rgba(148,163,184,0.12)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '11', 'font-family': 'var(--font-mono)' }, `$${val.toFixed(0)}`));
  }

  // Start baseline
  const baseY = yOf(base);
  svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: baseY, y2: baseY, stroke: 'rgba(245,158,11,0.45)', 'stroke-dasharray': '5,4' }));

  // Area + polyline
  const pathPts = points.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.bankroll).toFixed(1)}`).join(' ');
  const areaD = `M ${xOf(0).toFixed(1)},${yOf(base).toFixed(1)} L ${points.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.bankroll).toFixed(1)}`).join(' L ')} L ${xOf(points.length - 1).toFixed(1)},${yOf(minV).toFixed(1)} L ${xOf(0).toFixed(1)},${yOf(minV).toFixed(1)} Z`;

  const lastBankroll = vals[vals.length - 1];
  const strokeCol = lastBankroll >= base ? '#10b981' : '#f43f5e';
  const fillCol = lastBankroll >= base ? 'rgba(16,185,129,0.12)' : 'rgba(244,63,94,0.12)';
  svg.appendChild(svgEl('path', { d: areaD, fill: fillCol }));
  svg.appendChild(svgEl('polyline', { points: pathPts, fill: 'none', stroke: strokeCol, 'stroke-width': '2.4' }));

  // Markers
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const cx = xOf(i);
    const cy = yOf(p.bankroll);
    const dotCol = i === 0 ? '#22d3ee' : p.outcome === 'WIN' ? '#10b981' : '#f43f5e';
    const circle = svgEl('circle', { cx, cy, r: points.length > 40 ? 3.2 : 4.5, fill: dotCol, stroke: '#040810', 'stroke-width': '1.5', style: 'cursor:pointer' });
    const tipText = i === 0
      ? `Start Baseline: $${p.bankroll.toFixed(2)}`
      : `#${p.idx} ${p.side || ''} (${p.outcome || '?'})\nBankroll: $${p.bankroll.toFixed(2)} | PnL: ${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}`;
    circle.addEventListener('mousemove', (e) => showTip(e, tipText));
    circle.addEventListener('mouseleave', hideTip);
    svg.appendChild(circle);
  }

  // X-axis endpoints
  svg.appendChild(svgEl('text', { x: pad.l, y: H - 8, fill: '#64748b', 'font-size': '11', 'font-family': 'var(--font-mono)' }, 'Start (#0)'));
  svg.appendChild(svgEl('text', { x: W - pad.r, y: H - 8, 'text-anchor': 'end', fill: '#64748b', 'font-size': '11', 'font-family': 'var(--font-mono)' }, `Trade #${points.length - 1}`));

  container.appendChild(svg);
}

export function drawMetricBars(container, items, spec) {
  if (!container) return;
  container.replaceChildren();
  const valid = items.filter((d) => typeof d.value === 'number' && Number.isFinite(d.value));
  if (valid.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No metric values available.';
    container.appendChild(empty);
    return;
  }

  const W = 760;
  const rowH = 38;
  const pad = { l: 175, r: 90, t: 12, b: 14 };
  const H = pad.t + pad.b + valid.length * rowH;
  const innerW = W - pad.l - pad.r;

  const minRaw = Math.min(...valid.map((d) => d.value));
  const maxRaw = Math.max(...valid.map((d) => d.value));
  const floor = spec.minFloor != null ? Math.min(spec.minFloor, minRaw) : Math.min(0, minRaw);
  const span = Math.max(1e-6, maxRaw - floor);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  valid.forEach((d, idx) => {
    const y = pad.t + idx * rowH;
    const barW = Math.max(4, ((d.value - floor) / span) * innerW);
    const barColor = d.isActive ? '#22d3ee' : d.highlight ? '#10b981' : '#64748b';
    const label = d.isActive ? `${d.label} ★` : d.label;

    svg.appendChild(svgEl('text', {
      x: pad.l - 10, y: y + 22, 'text-anchor': 'end',
      fill: d.isActive ? '#22d3ee' : '#cbd5e1', 'font-size': '11.5',
      'font-weight': d.isActive ? '700' : '500', 'font-family': 'var(--font-mono)',
    }, label));

    svg.appendChild(svgEl('rect', {
      x: pad.l, y: y + 7, width: innerW, height: 21, rx: 5,
      fill: 'rgba(148,163,184,0.07)',
    }));

    const bar = svgEl('rect', {
      x: pad.l, y: y + 7, width: barW, height: 21, rx: 5,
      fill: barColor, style: 'cursor:pointer',
    });
    bar.addEventListener('mousemove', (e) => showTip(e, `${d.label}\n${spec.title}: ${spec.format(d.value)}${d.sub ? `\n${d.sub}` : ''}`));
    bar.addEventListener('mouseleave', hideTip);
    svg.appendChild(bar);

    svg.appendChild(svgEl('text', {
      x: pad.l + innerW + 10, y: y + 22,
      fill: d.isActive ? '#22d3ee' : '#e2e8f0', 'font-size': '11.5',
      'font-weight': '600', 'font-family': 'var(--font-mono)',
    }, spec.format(d.value)));
  });

  container.appendChild(svg);
}

export function drawTierCurve(container, series) {
  if (!container) return;
  container.replaceChildren();
  if (!series || series.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No shared OOS confidence tier evaluation found.';
    container.appendChild(empty);
    return;
  }

  const W = 620;
  const H = 230;
  const pad = { l: 48, r: 18, t: 18, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const tiers = ['0.30', '0.45', '0.55', '0.65', '0.70', '0.75', '0.80'];
  const minY = 75;
  const maxY = 100;
  const xOf = (i) => pad.l + (i / (tiers.length - 1)) * innerW;
  const yOf = (v) => pad.t + innerH - ((Math.max(minY, Math.min(maxY, v)) - minY) / (maxY - minY)) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  for (const tick of [75, 80, 85, 90, 95, 100]) {
    const y = yOf(tick);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'rgba(148,163,184,0.12)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x: pad.l - 7, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '10.5', 'font-family': 'var(--font-mono)' }, `${tick}%`));
  }

  tiers.forEach((t, i) => {
    svg.appendChild(svgEl('text', { x: xOf(i), y: H - 10, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'var(--font-mono)' }, `≥${Number(t) * 100}%`));
  });

  const colors = ['#22d3ee', '#10b981', '#f59e0b', '#818cf8'];
  series.forEach((s, si) => {
    const col = colors[si % colors.length];
    const pts = [];
    tiers.forEach((t, i) => {
      const obj = s.tiers?.[t];
      if (obj && typeof obj.acc === 'number') pts.push({ x: xOf(i), y: yOf(obj.acc), t, obj });
    });
    if (pts.length > 1) {
      svg.appendChild(svgEl('polyline', {
        points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
        fill: 'none', stroke: col, 'stroke-width': si === 0 ? '2.6' : '1.8',
      }));
    }
    for (const p of pts) {
      const c = svgEl('circle', { cx: p.x, cy: p.y, r: si === 0 ? 4.2 : 3.2, fill: col, stroke: '#040810', 'stroke-width': '1.3', style: 'cursor:pointer' });
      c.addEventListener('mousemove', (e) => showTip(e, `${s.label}\nConf ≥ ${Number(p.t) * 100}%: ${p.obj.acc.toFixed(2)}% WR\nCoverage: ${p.obj.pct}% (${p.obj.n} mkts)`));
      c.addEventListener('mouseleave', hideTip);
      svg.appendChild(c);
    }
  });

  const legend = document.createElement('div');
  legend.className = 'chip-list';
  series.forEach((s, si) => {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.color = colors[si % colors.length];
    badge.style.borderColor = colors[si % colors.length];
    badge.textContent = s.label;
    legend.appendChild(badge);
  });

  container.appendChild(svg);
  container.appendChild(legend);
}

export function drawPhaseThetaChart(container, xgbPhase, lgbPhase) {
  if (!container) return;
  container.replaceChildren();
  const phases = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];
  if (!xgbPhase && !lgbPhase) return;

  const W = 520;
  const H = 180;
  const pad = { l: 86, r: 50, t: 14, b: 22 };
  const innerW = W - pad.l - pad.r;
  const minT = 0.7;
  const maxT = 1.4;
  const xOf = (v) => pad.l + ((Math.max(minT, Math.min(maxT, v)) - minT) / (maxT - minT)) * innerW;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  const refX = xOf(1.0);
  svg.appendChild(svgEl('line', { x1: refX, x2: refX, y1: pad.t, y2: H - pad.b, stroke: 'rgba(245,158,11,0.55)', 'stroke-dasharray': '4,3' }));
  svg.appendChild(svgEl('text', { x: refX, y: H - 5, 'text-anchor': 'middle', fill: '#f59e0b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, 'θ=1.00 (neutral)'));

  phases.forEach((ph, idx) => {
    const y = pad.t + idx * 34;
    svg.appendChild(svgEl('text', { x: pad.l - 8, y: y + 18, 'text-anchor': 'end', fill: '#cbd5e1', 'font-size': '11', 'font-family': 'var(--font-mono)' }, ph));
    const drawDot = (theta, dy, col, name) => {
      if (typeof theta !== 'number') return;
      const cx = xOf(theta);
      svg.appendChild(svgEl('line', { x1: Math.min(refX, cx), x2: Math.max(refX, cx), y1: y + dy, y2: y + dy, stroke: col, 'stroke-width': '3' }));
      const c = svgEl('circle', { cx, cy: y + dy, r: 4.5, fill: col, style: 'cursor:pointer' });
      c.addEventListener('mousemove', (e) => showTip(e, `${name} ${ph}: θ = ${theta.toFixed(4)}\n(${theta < 1 ? 'softens confidence vs logit' : 'sharpens confidence vs logit'})`));
      c.addEventListener('mouseleave', hideTip);
      svg.appendChild(c);
    };
    drawDot(xgbPhase?.[ph]?.theta, 11, '#22d3ee', 'XGBoost');
    drawDot(lgbPhase?.[ph]?.theta, 21, '#10b981', 'LightGBM');
  });

  container.appendChild(svg);
}

export function drawEvolutionChart(container, timelineModels) {
  if (!container) return;
  container.replaceChildren();
  const valid = (timelineModels || []).filter((m) => typeof m.accuracy === 'number' || typeof m.auc === 'number');
  if (valid.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No model history recorded.' }));
    return;
  }

  const W = 720;
  const H = 260;
  const pad = { l: 48, r: 20, t: 26, b: 48 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const vals = valid.flatMap((m) => [
    typeof m.accuracy === 'number' ? m.accuracy * 100 : null,
    typeof m.auc === 'number' ? m.auc * 100 : null,
  ]).filter((v) => v != null);
  const minY = Math.max(45, Math.floor((Math.min(...vals) - 2) / 5) * 5);
  const maxY = Math.min(100, Math.ceil((Math.max(...vals) + 2) / 5) * 5);

  const xOf = (i) => (valid.length === 1 ? pad.l + innerW / 2 : pad.l + (i / (valid.length - 1)) * innerW);
  const yOf = (v) => pad.t + innerH - ((v - minY) / Math.max(1, maxY - minY)) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  const firstV2Idx = valid.findIndex((m) => (m.featurePipeline ?? 1) >= 2);
  if (firstV2Idx > 0) {
    const splitX = (xOf(firstV2Idx - 1) + xOf(firstV2Idx)) / 2;
    svg.appendChild(svgEl('rect', { x: pad.l, y: pad.t, width: Math.max(0, splitX - pad.l), height: innerH, fill: 'rgba(244,63,94,0.05)' }));
    svg.appendChild(svgEl('rect', { x: splitX, y: pad.t, width: Math.max(0, W - pad.r - splitX), height: innerH, fill: 'rgba(16,185,129,0.05)' }));
    svg.appendChild(svgEl('line', { x1: splitX, x2: splitX, y1: pad.t, y2: H - pad.b, stroke: 'rgba(148,163,184,0.3)', 'stroke-dasharray': '4,3' }));
    svg.appendChild(svgEl('text', { x: pad.l + 8, y: pad.t + 14, fill: '#fb7185', 'font-size': '10', 'font-family': 'var(--font-mono)' }, 'v1 Archive Era (look-ahead / old ticks)'));
    svg.appendChild(svgEl('text', { x: splitX + 8, y: pad.t + 14, fill: '#34d399', 'font-size': '10', 'font-family': 'var(--font-mono)' }, 'v2 / v3 Shared Live Feature Era'));
  }

  for (let t = minY; t <= maxY; t += 10) {
    const y = yOf(t);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'rgba(148,163,184,0.12)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x: pad.l - 7, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `${t}%`));
  }

  const accPts = [];
  const aucPts = [];
  valid.forEach((m, i) => {
    const x = xOf(i);
    if (typeof m.accuracy === 'number') accPts.push({ x, y: yOf(m.accuracy * 100), m });
    if (typeof m.auc === 'number') aucPts.push({ x, y: yOf(m.auc * 100), m });
    if (i === 0 || i === valid.length - 1 || i % Math.max(1, Math.floor(valid.length / 6)) === 0 || m.isActive) {
      svg.appendChild(svgEl('text', {
        x, y: H - 24, 'text-anchor': 'middle',
        fill: m.isActive ? '#22d3ee' : '#64748b', 'font-size': '9', 'font-family': 'var(--font-mono)',
      }, m.id.slice(2, 8)));
    }
  });

  if (aucPts.length > 1) {
    svg.appendChild(svgEl('polyline', {
      points: aucPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: '#10b981', 'stroke-width': '2', 'stroke-opacity': '0.9',
    }));
  }
  if (accPts.length > 1) {
    svg.appendChild(svgEl('polyline', {
      points: accPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: '#22d3ee', 'stroke-width': '2.3',
    }));
  }

  const attachTip = (circle, m) => {
    circle.addEventListener('mousemove', (e) => {
      const lines = [
        `${m.id} (${m.status}${m.isActive ? ' ★ LIVE' : ''})`,
        `Pipeline: v${m.featurePipeline ?? 1} · ${m.dataRange || '—'}`,
        m.accuracy != null ? `Test Acc: ${(m.accuracy * 100).toFixed(2)}%` : null,
        m.auc != null ? `Test AUC: ${m.auc.toFixed(4)}` : null,
        m.ece != null ? `Calib ECE: ${m.ece.toFixed(4)}` : null,
        m.skill != null ? `Market Skill: ${m.skill >= 0 ? '+' : ''}${(m.skill * 100).toFixed(2)}%` : null,
      ].filter(Boolean);
      showTip(e, lines.join('\n'));
    });
    circle.addEventListener('mouseleave', hideTip);
  };

  for (const p of aucPts) {
    const c = svgEl('circle', { cx: p.x, cy: p.y, r: p.m.isActive ? 4.5 : 2.8, fill: '#10b981', stroke: '#040810', 'stroke-width': '1', style: 'cursor:pointer' });
    attachTip(c, p.m);
    svg.appendChild(c);
  }
  for (const p of accPts) {
    if (p.m.isActive) {
      svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 8, fill: 'none', stroke: '#22d3ee', 'stroke-width': '1.6', 'stroke-opacity': '0.65' }));
    }
    const c = svgEl('circle', { cx: p.x, cy: p.y, r: p.m.isActive ? 4.8 : 3.1, fill: p.m.isActive ? '#38bdf8' : '#22d3ee', stroke: '#040810', 'stroke-width': '1.2', style: 'cursor:pointer' });
    attachTip(c, p.m);
    svg.appendChild(c);
  }

  container.appendChild(svg);
  const leg = document.createElement('div');
  leg.className = 'chip-list';
  for (const [txt, col] of [['Test Accuracy %', '#22d3ee'], ['ROC-AUC (×100)', '#10b981']]) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.style.color = col;
    b.style.borderColor = col;
    b.textContent = txt;
    leg.appendChild(b);
  }
  container.appendChild(leg);
}

export function drawCalibrationCurve(container, bins) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(bins) || bins.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No decile calibration bins for this model.' }));
    return;
  }

  const W = 440;
  const H = 260;
  const pad = { l: 46, r: 18, t: 18, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const xOf = (v) => pad.l + Math.max(0, Math.min(1, v)) * innerW;
  const yOf = (v) => pad.t + innerH - Math.max(0, Math.min(1, v)) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  for (const t of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0]) {
    const x = xOf(t);
    const y = yOf(t);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'rgba(148,163,184,0.1)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b, stroke: 'rgba(148,163,184,0.08)' }));
    if (t === 0 || t === 0.2 || t === 0.5 || t === 0.8 || t === 1.0) {
      svg.appendChild(svgEl('text', { x: pad.l - 7, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `${Math.round(t * 100)}%`));
      svg.appendChild(svgEl('text', { x, y: H - 10, 'text-anchor': 'middle', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `${Math.round(t * 100)}%`));
    }
  }

  svg.appendChild(svgEl('line', { x1: xOf(0), y1: yOf(0), x2: xOf(1), y2: yOf(1), stroke: '#f59e0b', 'stroke-width': '1.4', 'stroke-dasharray': '5,4', 'stroke-opacity': '0.75' }));

  const pts = bins.map((b) => ({
    x: xOf(b.avg_predicted ?? ((b.min_prob + b.max_prob) / 2)),
    y: yOf(b.observed_rate ?? 0),
    yDiag: yOf(b.avg_predicted ?? ((b.min_prob + b.max_prob) / 2)),
    b,
  }));

  for (const p of pts) {
    const absGap = Math.abs(p.b.gap ?? ((p.b.observed_rate ?? 0) - (p.b.avg_predicted ?? 0)));
    svg.appendChild(svgEl('line', {
      x1: p.x, x2: p.x, y1: p.yDiag, y2: p.y,
      stroke: absGap <= 0.025 ? '#10b981' : '#f59e0b', 'stroke-width': '2', 'stroke-opacity': '0.85',
    }));
  }

  if (pts.length > 1) {
    svg.appendChild(svgEl('polyline', {
      points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: '#22d3ee', 'stroke-width': '2.3',
    }));
  }

  const maxCount = Math.max(1, ...bins.map((b) => b.count || 0));
  for (const p of pts) {
    const r = 3.5 + 3.5 * ((p.b.count || 0) / maxCount);
    const c = svgEl('circle', { cx: p.x, cy: p.y, r: r.toFixed(1), fill: '#22d3ee', stroke: '#040810', 'stroke-width': '1.3', style: 'cursor:pointer' });
    c.addEventListener('mousemove', (e) => showTip(e,
      `Bin [${(p.b.min_prob * 100).toFixed(0)}%–${(p.b.max_prob * 100).toFixed(0)}%]\n`
      + `Predicted: ${(p.b.avg_predicted * 100).toFixed(2)}% vs Observed: ${(p.b.observed_rate * 100).toFixed(2)}%\n`
      + `Gap: ${(p.b.gap * 100).toFixed(2)} pp · n=${p.b.count} (${p.b.coverage_pct}%)`));
    c.addEventListener('mouseleave', hideTip);
    svg.appendChild(c);
  }

  container.appendChild(svg);
}

export function drawConfidenceBuckets(container, buckets) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(buckets) || buckets.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No confidence bucket breakdown for this model.' }));
    return;
  }

  const W = 440;
  const H = 260;
  const pad = { l: 42, r: 16, t: 22, b: 44 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const minY = 40;
  const maxY = 100;
  const yOf = (v) => pad.t + innerH - ((Math.max(minY, Math.min(maxY, v)) - minY) / (maxY - minY)) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  for (const t of [40, 50, 60, 70, 80, 90, 100]) {
    const y = yOf(t);
    svg.appendChild(svgEl('line', {
      x1: pad.l, x2: W - pad.r, y1: y, y2: y,
      stroke: t === 60 ? 'rgba(245,158,11,0.45)' : 'rgba(148,163,184,0.12)',
      'stroke-dasharray': t === 60 ? '4,3' : '3,3',
    }));
    svg.appendChild(svgEl('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `${t}%`));
  }

  const slot = innerW / buckets.length;
  const bw = Math.min(34, slot * 0.66);

  buckets.forEach((b, i) => {
    const accPct = (b.accuracy ?? 0) * 100;
    const x = pad.l + i * slot + (slot - bw) / 2;
    const y = yOf(accPct);
    const barH = Math.max(2, yOf(minY) - y);
    const col = accPct >= 80 ? '#10b981' : accPct >= 62 ? '#22d3ee' : '#fb7185';
    const rect = svgEl('rect', { x, y, width: bw, height: barH, rx: 4, fill: col, 'fill-opacity': '0.88', style: 'cursor:pointer' });
    rect.addEventListener('mousemove', (e) => showTip(e,
      `Conf [${(b.min_confidence * 100).toFixed(0)}%–${(b.max_confidence * 100).toFixed(0)}%]\n`
      + `Accuracy: ${accPct.toFixed(2)}%\nSamples: ${b.count} (${b.coverage_pct}% coverage)`));
    rect.addEventListener('mouseleave', hideTip);
    svg.appendChild(rect);

    svg.appendChild(svgEl('text', { x: x + bw / 2, y: Math.max(pad.t + 10, y - 5), 'text-anchor': 'middle', fill: '#e2e8f0', 'font-size': '9.5', 'font-family': 'var(--font-mono)' }, `${accPct.toFixed(0)}%`));
    svg.appendChild(svgEl('text', { x: x + bw / 2, y: H - 22, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': '9', 'font-family': 'var(--font-mono)' }, `${Math.round(b.min_confidence * 100)}–${Math.round(b.max_confidence * 100)}`));
    svg.appendChild(svgEl('text', { x: x + bw / 2, y: H - 9, 'text-anchor': 'middle', fill: '#64748b', 'font-size': '8.5', 'font-family': 'var(--font-mono)' }, `${b.coverage_pct}%`));
  });

  container.appendChild(svg);
}

export function drawPhaseResponseCurve(container, xgbPhase, lgbPhase) {
  if (!container) return;
  container.replaceChildren();
  const phases = [
    { key: 'EARLY', col: '#f59e0b' },
    { key: 'MID', col: '#22d3ee' },
    { key: 'LATE', col: '#10b981' },
    { key: 'VERY_LATE', col: '#a78bfa' },
  ];
  const src = xgbPhase || lgbPhase;
  if (!src) return;

  const W = 520;
  const H = 220;
  const pad = { l: 44, r: 16, t: 16, b: 34 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const xOf = (p) => pad.l + p * innerW;
  const yOf = (p) => pad.t + innerH - p * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yOf(t), y2: yOf(t), stroke: 'rgba(148,163,184,0.1)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x: pad.l - 6, y: yOf(t) + 3, 'text-anchor': 'end', fill: '#64748b', 'font-size': '9.5', 'font-family': 'var(--font-mono)' }, `${Math.round(t * 100)}%`));
    svg.appendChild(svgEl('text', { x: xOf(t), y: H - 10, 'text-anchor': 'middle', fill: '#64748b', 'font-size': '9.5', 'font-family': 'var(--font-mono)' }, `${Math.round(t * 100)}%`));
  }
  svg.appendChild(svgEl('line', { x1: xOf(0.05), y1: yOf(0.05), x2: xOf(0.95), y2: yOf(0.95), stroke: 'rgba(148,163,184,0.35)', 'stroke-dasharray': '4,3' }));

  const xs = [];
  for (let p = 0.05; p <= 0.9501; p += 0.05) xs.push(+p.toFixed(2));

  for (const ph of phases) {
    const px = xgbPhase?.[ph.key];
    const pl = lgbPhase?.[ph.key];
    const a = px && pl ? (px.a + pl.a) / 2 : (px?.a ?? pl?.a);
    const b = px && pl ? (px.b + pl.b) / 2 : (px?.b ?? pl?.b);
    if (typeof a !== 'number' || typeof b !== 'number') continue;

    const pts = xs.map((p) => {
      const z = Math.log(p / (1 - p));
      const pCal = 1 / (1 + Math.exp(-(a * z + b)));
      return { p, pCal, x: xOf(p), y: yOf(pCal) };
    });
    svg.appendChild(svgEl('polyline', {
      points: pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: ph.col, 'stroke-width': '2',
    }));
    for (let i = 2; i < pts.length; i += 3) {
      const pt = pts[i];
      const dot = svgEl('circle', { cx: pt.x, cy: pt.y, r: 3, fill: ph.col, style: 'cursor:pointer' });
      dot.addEventListener('mousemove', (e) => showTip(e, `${ph.key} (a=${a.toFixed(3)}, b=${b.toFixed(3)})\nRaw ${(pt.p * 100).toFixed(0)}% → Calibrated ${(pt.pCal * 100).toFixed(2)}%`));
      dot.addEventListener('mouseleave', hideTip);
      svg.appendChild(dot);
    }
  }

  container.appendChild(svg);
  const leg = document.createElement('div');
  leg.className = 'chip-list';
  for (const ph of phases) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.style.color = ph.col;
    b.style.borderColor = ph.col;
    const th = xgbPhase?.[ph.key]?.theta ?? lgbPhase?.[ph.key]?.theta;
    b.textContent = th != null ? `${ph.key} (θ=${th.toFixed(2)})` : ph.key;
    leg.appendChild(b);
  }
  container.appendChild(leg);
}

export function drawFeatureImportanceBars(container, catalog, mode = 'xgbSplits') {
  if (!container) return;
  container.replaceChildren();
  const metricOf = (f) => (mode === 'lgbGainPct' ? (f.lgbGainPct ?? 0) : mode === 'xgbRootSplits' ? (f.xgbRootSplits ?? 0) : (f.xgbSplits ?? 0));
  const sorted = [...(catalog || [])]
    .filter((f) => metricOf(f) > 0)
    .sort((a, b) => metricOf(b) - metricOf(a))
    .slice(0, 18);

  if (sorted.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No tree split data extracted for this model.' }));
    return;
  }

  const groupCol = {
    'Polymarket CLOB': '#22d3ee',
    'Price & PTB': '#f59e0b',
    'Technical / Momentum': '#10b981',
    Volatility: '#a78bfa',
    'Volume / Flow': '#38bdf8',
    'Chainlink & TWAP (v4)': '#fb7185',
    'Context / Regime': '#94a3b8',
  };

  const W = 720;
  const rowH = 26;
  const pad = { l: 215, r: 80, t: 10, b: 14 };
  const H = pad.t + pad.b + sorted.length * rowH;
  const innerW = W - pad.l - pad.r;
  const maxVal = Math.max(1e-6, ...sorted.map(metricOf));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  sorted.forEach((f, i) => {
    const val = metricOf(f);
    const y = pad.t + i * rowH;
    const bw = Math.max(4, (val / maxVal) * innerW);
    const col = groupCol[f.group] || '#64748b';

    svg.appendChild(svgEl('text', {
      x: pad.l - 8, y: y + 16, 'text-anchor': 'end',
      fill: '#e2e8f0', 'font-size': '11', 'font-family': 'var(--font-mono)',
    }, `${i + 1}. ${f.name}`));

    svg.appendChild(svgEl('rect', { x: pad.l, y: y + 5, width: innerW, height: 14, rx: 4, fill: 'rgba(148,163,184,0.07)' }));

    const bar = svgEl('rect', { x: pad.l, y: y + 5, width: bw, height: 14, rx: 4, fill: col, 'fill-opacity': '0.88', style: 'cursor:pointer' });
    bar.addEventListener('mousemove', (e) => showTip(e,
      `#${f.idx} ${f.name} [${f.group}]\n`
      + `XGB Splits: ${f.xgbSplits ?? 0} (${f.xgbSharePct ?? 0}%) · Root: ${f.xgbRootSplits ?? 0}\n`
      + `LGB Splits: ${f.lgbSplits ?? 0} · LGB Gain Share: ${f.lgbGainPct ?? 0}%`));
    bar.addEventListener('mouseleave', hideTip);
    svg.appendChild(bar);

    const lbl = mode === 'lgbGainPct'
      ? `${val.toFixed(2)}%`
      : mode === 'xgbRootSplits'
        ? `${val} root`
        : `${val} (${(f.xgbSharePct ?? 0).toFixed(1)}%)`;
    svg.appendChild(svgEl('text', {
      x: pad.l + innerW + 8, y: y + 16, fill: '#cbd5e1', 'font-size': '10.5', 'font-family': 'var(--font-mono)',
    }, lbl));
  });

  container.appendChild(svg);
}

export function drawTapeCoverageChart(container, daily) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(daily) || daily.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No daily Market Tape coverage series loaded.' }));
    return;
  }

  const W = 720;
  const H = 250;
  const pad = { l: 46, r: 52, t: 22, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;

  const basisVals = daily.map((d) => (typeof d.medianBasisUsd === 'number' ? d.medianBasisUsd : 0));
  const maxBasis = Math.max(40, ...basisVals) * 1.15;
  const stepX = innerW / daily.length;
  const barW = Math.max(3, stepX * 0.68);
  const xCenter = (i) => pad.l + (i + 0.5) * stepX;
  const yPct = (p) => pad.t + innerH - (Math.max(0, Math.min(100, p)) / 100) * innerH;
  const yBasis = (b) => pad.t + innerH - (Math.max(0, Math.min(maxBasis, b)) / maxBasis) * innerH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  for (let g = 0; g <= 4; g++) {
    const pct = g * 25;
    const y = yPct(pct);
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: 'rgba(148,163,184,0.12)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x: pad.l - 6, y: y + 4, 'text-anchor': 'end', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `${pct}%`));
    const bVal = (maxBasis * g) / 4;
    svg.appendChild(svgEl('text', { x: W - pad.r + 6, y: y + 4, fill: '#f59e0b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `$${bVal.toFixed(0)}`));
  }

  const twapPts = [];
  const basisPts = [];
  daily.forEach((d, i) => {
    const cx = xCenter(i);
    const liveH = Math.max(1, (Math.max(0, Math.min(100, d.liveBookPct ?? 0)) / 100) * innerH);
    const bar = svgEl('rect', {
      x: cx - barW / 2,
      y: pad.t + innerH - liveH,
      width: barW,
      height: liveH,
      rx: 2,
      fill: '#22d3ee',
      'fill-opacity': '0.32',
      style: 'cursor:pointer',
    });
    bar.addEventListener('mousemove', (e) => showTip(e,
      `${d.date} · ${d.markets} mkts · ${(d.snapshots ?? 0).toLocaleString()} snaps\n`
      + `Live Book: ${d.liveBookPct}% · TWAP: ${d.twapPct}% · Oracle: ${d.oraclePct}%\n`
      + `Median Basis (Bin - CL): ${d.medianBasisUsd != null ? `$${d.medianBasisUsd.toFixed(2)}` : '—'} · Cross-Feed Blocked: ${d.crossFeedBlocked ?? 0}`));
    bar.addEventListener('mouseleave', hideTip);
    svg.appendChild(bar);

    twapPts.push(`${cx.toFixed(1)},${yPct(d.twapPct ?? 0).toFixed(1)}`);
    if (d.medianBasisUsd != null) {
      basisPts.push(`${cx.toFixed(1)},${yBasis(d.medianBasisUsd).toFixed(1)}`);
    }
  });

  if (twapPts.length > 1) {
    svg.appendChild(svgEl('polyline', { points: twapPts.join(' '), fill: 'none', stroke: '#10b981', 'stroke-width': '1.8' }));
  }
  if (basisPts.length > 1) {
    svg.appendChild(svgEl('polyline', { points: basisPts.join(' '), fill: 'none', stroke: '#f59e0b', 'stroke-width': '2' }));
  }

  svg.appendChild(svgEl('text', { x: pad.l, y: H - 10, fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'var(--font-mono)' }, daily[0].date));
  const midD = daily[Math.floor(daily.length / 2)];
  svg.appendChild(svgEl('text', { x: W / 2, y: H - 10, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'var(--font-mono)' }, `${midD.date} (${daily.length}d)`));
  svg.appendChild(svgEl('text', { x: W - pad.r, y: H - 10, 'text-anchor': 'end', fill: '#94a3b8', 'font-size': '10.5', 'font-family': 'var(--font-mono)' }, daily[daily.length - 1].date));

  container.appendChild(svg);
  const leg = document.createElement('div');
  leg.className = 'chip-list';
  for (const [lbl, col] of [['Live L2 Book % (bars)', '#22d3ee'], ['Chainlink 60s TWAP %', '#10b981'], ['Median BTC Basis $ (Bin − CL)', '#f59e0b']]) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.style.color = col;
    b.style.borderColor = col;
    b.textContent = lbl;
    leg.appendChild(b);
  }
  container.appendChild(leg);
}

export function drawStage2WindowBars(container, normalWindow, finalWindow) {
  if (!container) return;
  container.replaceChildren();
  const keys = ['up_mid', 'v2_prob_up', 'twap_physics', 'v4_standalone', 'v4_hybrid', 'v4_stack'];
  const items = keys
    .map((k) => ({ key: k, n: normalWindow?.[k], f: finalWindow?.[k] }))
    .filter((x) => x.n || x.f);

  if (items.length === 0) {
    container.appendChild(Object.assign(document.createElement('div'), { className: 'empty-state', textContent: 'No Stage 2 OOS comparison metrics loaded.' }));
    return;
  }

  const W = 720;
  const rowH = 38;
  const pad = { l: 190, r: 95, t: 18, b: 22 };
  const H = pad.t + pad.b + items.length * rowH;
  const innerW = W - pad.l - pad.r;
  const minB = 0.07;
  const maxB = 0.18;
  const xB = (b) => pad.l + ((maxB - Math.max(minB, Math.min(maxB, b))) / (maxB - minB)) * innerW;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' });

  for (const b of [0.16, 0.14, 0.12, 0.10, 0.08]) {
    const x = xB(b);
    svg.appendChild(svgEl('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b, stroke: 'rgba(148,163,184,0.12)', 'stroke-dasharray': '3,3' }));
    svg.appendChild(svgEl('text', { x, y: H - 6, 'text-anchor': 'middle', fill: '#64748b', 'font-size': '10', 'font-family': 'var(--font-mono)' }, b.toFixed(2)));
  }

  items.forEach((it, i) => {
    const y = pad.t + i * rowH;
    const label = it.n?.label || it.f?.label || it.key;
    svg.appendChild(svgEl('text', {
      x: pad.l - 8, y: y + 20, 'text-anchor': 'end',
      fill: '#e2e8f0', 'font-size': '11', 'font-family': 'var(--font-mono)',
    }, label));

    if (it.n) {
      const wN = Math.max(6, xB(it.n.brier) - pad.l);
      const r1 = svgEl('rect', { x: pad.l, y: y + 4, width: wN, height: 11, rx: 3, fill: '#22d3ee', 'fill-opacity': '0.85', style: 'cursor:pointer' });
      r1.addEventListener('mousemove', (e) => showTip(e,
        `${label} · Normal (12m→2m)\nBrier: ${it.n.brier} · Acc: ${it.n.accuracyPct}% · AUC: ${it.n.auc}\nSkill vs Mid: ${it.n.skillVsMktPct >= 0 ? '+' : ''}${it.n.skillVsMktPct}%`));
      r1.addEventListener('mouseleave', hideTip);
      svg.appendChild(r1);
      svg.appendChild(svgEl('text', { x: pad.l + wN + 6, y: y + 13, fill: '#22d3ee', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `N:${it.n.brier}`));
    }
    if (it.f) {
      const wF = Math.max(6, xB(it.f.brier) - pad.l);
      const r2 = svgEl('rect', { x: pad.l, y: y + 18, width: wF, height: 11, rx: 3, fill: '#10b981', 'fill-opacity': '0.85', style: 'cursor:pointer' });
      r2.addEventListener('mousemove', (e) => showTip(e,
        `${label} · Final (15s–45s)\nBrier: ${it.f.brier} · Acc: ${it.f.accuracyPct}% · AUC: ${it.f.auc}\nSkill vs Mid: ${it.f.skillVsMktPct >= 0 ? '+' : ''}${it.f.skillVsMktPct}%`));
      r2.addEventListener('mouseleave', hideTip);
      svg.appendChild(r2);
      svg.appendChild(svgEl('text', { x: pad.l + wF + 6, y: y + 27, fill: '#10b981', 'font-size': '10', 'font-family': 'var(--font-mono)' }, `F:${it.f.brier}`));
    }
  });

  container.appendChild(svg);
  const leg = document.createElement('div');
  leg.className = 'chip-list';
  for (const [lbl, col] of [['Longer bar = Lower Brier (better) · Normal 12m→2m', '#22d3ee'], ['Final Minute 15s–45s (TWAP Physics Regime)', '#10b981']]) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.style.color = col;
    b.style.borderColor = col;
    b.textContent = lbl;
    leg.appendChild(b);
  }
  container.appendChild(leg);
}
