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
