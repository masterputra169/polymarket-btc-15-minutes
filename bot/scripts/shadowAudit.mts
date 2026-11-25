#!/usr/bin/env node
/**
 * One-command readiness audit for the 3-Stage Shadow -> Active Promotion Schedule:
 *   1. Online Recency ML Calibration (ML_ONLINE_CALIBRATION_MODE=active)
 *   2. JEV v5 Veto                   (JEV_MODE=veto)
 *   3. Stage-2 Meta-Labeler          (ML_META_LABELER_MODE=veto)
 *
 * Usage:
 *   node bot/scripts/shadowAudit.mts [--data-dir /opt/polybtc15/bot/data]
 */
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fitOnlinePlatt, calibrateWithPlatt } from '../src/ai/jevSettleCalibration.ts';
import { fitMetaLabelerModel, type MetaLabelSample } from '../src/ml/metaLabeler.ts';
import { computeConformalQHat, evaluateConformalSet } from '../src/ml/onlineCalibration.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const argIdx = process.argv.indexOf('--data-dir');
const dataDir = argIdx >= 0 && process.argv[argIdx + 1]
  ? resolve(process.argv[argIdx + 1])
  : resolve(__dirname, '..', 'data');

const jevLogPath = resolve(dataDir, 'jev_log.jsonl');
const jevOutcomesPath = resolve(dataDir, 'jev_outcomes.json');
const journalPath = resolve(dataDir, 'trade_journal.jsonl');

function readJsonl(p: string): any[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const outcomes: Record<string, string | { outcome?: string }> = existsSync(jevOutcomesPath)
  ? JSON.parse(readFileSync(jevOutcomesPath, 'utf8'))
  : {};
const jevRows = readJsonl(jevLogPath);
const journalRows = readJsonl(journalPath);

function getOutcome(slug: string): 'UP' | 'DOWN' | null {
  const raw = outcomes[slug];
  const val = typeof raw === 'string' ? raw : raw?.outcome;
  return val === 'UP' || val === 'DOWN' ? val : null;
}

// ── 1. Online ML Calibration Audit ──
const mlBySlug = new Map<string, { rawMl: number; mkt: number; y: 0 | 1; ts: number }>();
for (const r of jevRows) {
  const slug = r.slug;
  const o = getOutcome(slug);
  if (!o) continue;
  const rawMl = Number(r.ml?.probUp ?? r.state?.ml?.prob_up ?? r.rawMlProbUp);
  const mkt = Number(r.market?.marketUp ?? r.market?.up ?? r.state?.market_odds?.up ?? r.marketUp);
  if (!(rawMl > 0.005 && rawMl < 0.995) || !(mkt > 0.01 && mkt < 0.99)) continue;
  mlBySlug.set(slug, { rawMl, mkt, y: o === 'UP' ? 1 : 0, ts: Number(r.ts) || 0 });
}
const mlHist = [...mlBySlug.values()].sort((a, b) => a.ts - b.ts).slice(-300);
const mlPlatt = mlHist.length >= 50
  ? fitOnlinePlatt(mlHist.map(h => ({ rawProb: h.rawMl, outcomeUp: h.y })), { recencyHalfLife: 50, minSamples: 50 })
  : null;
const mlWin = mlHist.slice(-100);
let rawB = 0, calB = 0, mktB = 0;
for (const h of mlWin) {
  rawB += (h.rawMl - h.y) ** 2;
  const cp = mlPlatt ? calibrateWithPlatt(h.rawMl, mlPlatt) : h.rawMl;
  calB += (cp - h.y) ** 2;
  mktB += (h.mkt - h.y) ** 2;
}
const nMl = mlWin.length;
const rawMlBrier = nMl > 0 ? rawB / nMl : null;
const calMlBrier = nMl > 0 ? calB / nMl : null;
const mktMlBrier = nMl > 0 ? mktB / nMl : null;
const stage1Pass = Boolean(mlPlatt && nMl >= 50 && calMlBrier != null && rawMlBrier != null && calMlBrier < rawMlBrier);

// Split-conformal uncertainty audit (ML4T Ch.12): calibrate qHat on first half, score second half
let conformalTag = 'n/a';
if (mlHist.length >= 40) {
  const half = Math.floor(mlHist.length / 2);
  const calScores = mlHist.slice(0, half).map(h => {
    const cp = mlPlatt ? calibrateWithPlatt(h.rawMl, mlPlatt) : h.rawMl;
    return 1 - (h.y === 1 ? cp : 1 - cp);
  });
  const qHat = computeConformalQHat(calScores, 0.15);
  if (qHat != null) {
    let sN = 0, sHit = 0, aN = 0, aHit = 0;
    for (const h of mlHist.slice(half)) {
      const cp = mlPlatt ? calibrateWithPlatt(h.rawMl, mlPlatt) : h.rawMl;
      const cs = evaluateConformalSet(cp, qHat);
      const predOk = (cp >= 0.5 ? 1 : 0) === h.y;
      if (cs.singleton) { sN++; if (predOk) sHit++; }
      else if (cs.ambiguous) { aN++; if (predOk) aHit++; }
    }
    conformalTag = `qHat=${qHat.toFixed(3)} | singleton=${sN > 0 ? `${sHit}/${sN} (${((sHit / sN) * 100).toFixed(1)}%)` : '0'} | ambig=${aN > 0 ? `${aHit}/${aN} (${((aHit / aN) * 100).toFixed(1)}%)` : '0'}`;
  }
}

// ── 2. JEV v5 Veto Readiness Audit ──
const v5BySlug = new Map<string, any>();
for (const r of jevRows) {
  const slug = r.slug;
  const o = getOutcome(slug);
  if (!o) continue;
  const ver = String(r.stateVariant ?? r.calibrationVersion ?? r.variant ?? '');
  if (!ver.includes('v5') && !ver.includes('online-platt-v5')) continue;
  v5BySlug.set(slug, { ...r, y: o === 'UP' ? 1 : 0, outcome: o });
}
const v5List = [...v5BySlug.values()];
let v5BayesB = 0, v5MktB = 0, v5DirTotal = 0, v5DirHit = 0;
for (const r of v5List) {
  const bp = Number(r.bayesianProbUp ?? r.bayesianUpProbability ?? r.settleUpCalibrated ?? r.settleUpProbability ?? 0.5);
  const mp = Number(r.market?.marketUp ?? r.market?.up ?? r.state?.market_odds?.up ?? 0.5);
  v5BayesB += (bp - r.y) ** 2;
  v5MktB += (mp - r.y) ** 2;
  if (r.direction === 'UP' || r.direction === 'DOWN') {
    v5DirTotal++;
    if (r.direction === r.outcome) v5DirHit++;
  }
}
const nV5 = v5List.length;
const v5BayesBrier = nV5 > 0 ? v5BayesB / nV5 : null;
const v5MktBrier = nV5 > 0 ? v5MktB / nV5 : null;
const v5SkillPct = v5BayesBrier != null && v5MktBrier != null && v5MktBrier > 0
  ? ((v5MktBrier - v5BayesBrier) / v5MktBrier) * 100
  : null;
const stage2Pass = Boolean(nV5 >= 150 && v5SkillPct != null && v5SkillPct > 0);

// ── 3. Stage-2 Meta-Labeler Readiness Audit ──
const metaSamples: MetaLabelSample[] = [];
for (const r of journalRows) {
  const e = r.entry;
  const x = r.exit;
  if (!e || !x) continue;
  const out = x.verifiedOutcome ?? x.outcome;
  if (out !== 'UP' && out !== 'DOWN') continue;
  const side = e.side;
  const mlProbUp = Number(e.mlProbUp);
  const price = Number(e.actualPrice ?? e.tokenPrice);
  if (!Number.isFinite(mlProbUp) || !Number.isFinite(price)) continue;
  const mlSideProb = side === 'UP' ? mlProbUp : (1 - mlProbUp);
  const mlConf = Math.abs(mlProbUp - 0.5) * 2;
  metaSamples.push({
    won: out === side ? 1 : 0,
    features: {
      entryPrice: price,
      mlConfidence: mlConf,
      rawMlEdge: mlSideProb - price,
      timeLeftMin: Number(e.timeLeftMin ?? 7.5),
      regime: e.regime ?? 'moderate',
      jevNetConvAligned: 0,
    },
  });
}
const metaModel = metaSamples.length >= 20 ? fitMetaLabelerModel(metaSamples) : null;
const stage3Pass = Boolean(metaSamples.length >= 100 && metaModel?.holdoutAuc != null && metaModel.holdoutAuc >= 0.58);

console.log('=== POLY//15 SHADOW PROMOTION AUDIT ===');
console.log(`Data dir: ${dataDir}`);
console.log('');
console.log(`[1] Online ML Calibration (ML_ONLINE_CALIBRATION_MODE=active): ${stage1Pass ? 'READY' : 'WAIT'}`);
console.log(`    windows=${mlHist.length} (eval=${nMl}) | rawBrier=${rawMlBrier?.toFixed(5) ?? '-'} -> calBrier=${calMlBrier?.toFixed(5) ?? '-'} | mktBrier=${mktMlBrier?.toFixed(5) ?? '-'}`);
console.log(`    conformal(85%): ${conformalTag}`);
console.log('');
console.log(`[2] JEV v5 Veto (JEV_MODE=veto, target >=150 v5 windows & skill >0%): ${stage2Pass ? 'READY' : 'WAIT'}`);
console.log(`    v5_windows=${nV5}/150 | bayesBrier=${v5BayesBrier?.toFixed(5) ?? '-'} vs mktBrier=${v5MktBrier?.toFixed(5) ?? '-'} | skill=${v5SkillPct != null ? `${v5SkillPct >= 0 ? '+' : ''}${v5SkillPct.toFixed(2)}%` : '-'} | dirAcc=${v5DirTotal > 0 ? `${v5DirHit}/${v5DirTotal} (${((v5DirHit / v5DirTotal) * 100).toFixed(1)}%)` : '-'}`);
console.log('');
console.log(`[3] Stage-2 Meta-Labeler (ML_META_LABELER_MODE=veto, target >=100 trades & AUC >=0.58): ${stage3Pass ? 'READY' : 'WAIT'}`);
console.log(`    trades=${metaSamples.length}/100 | baseWR=${metaModel ? `${(metaModel.baseWinRate * 100).toFixed(1)}%` : '-'} | holdoutAUC=${metaModel?.holdoutAuc?.toFixed(4) ?? '-'} | holdoutBrier=${metaModel?.holdoutBrier?.toFixed(4) ?? '-'}`);

// ── 4. Commit-Stamped Performance Breakdown (midas-core pattern) ──
const byCommit = new Map<string, { w: number; l: number; pnl: number }>();
for (const r of journalRows) {
  const e = r.entry;
  const x = r.exit;
  if (!e || !x) continue;
  const out = x.verifiedOutcome ?? x.outcome;
  if (out !== 'UP' && out !== 'DOWN') continue;
  const commit = String(e.gitCommit ?? 'legacy');
  const cur = byCommit.get(commit) ?? { w: 0, l: 0, pnl: 0 };
  if (out === e.side) cur.w++; else cur.l++;
  cur.pnl += Number(r.analysis?.pnl ?? 0);
  byCommit.set(commit, cur);
}
if (byCommit.size > 0) {
  console.log('');
  console.log('[4] Journal Breakdown by Git Commit:');
  for (const [c, s] of byCommit.entries()) {
    const n = s.w + s.l;
    const wr = n > 0 ? ((s.w / n) * 100).toFixed(1) : '0.0';
    console.log(`    ${c.padEnd(10)} n=${String(n).padStart(3)} | ${s.w}W-${s.l}L (${wr}% WR) | PnL=${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`);
  }
}

// ── 5. MAE / MFE Excursion & Fill-Model Markout Audit (ML4T Ch.7) ──
const pctile = (arr: number[], q: number) => {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};
const winMae: number[] = [], winMfe: number[] = [], lossMae: number[] = [], lossMfe: number[] = [];
const byFill = new Map<string, { n: number; w: number; pnl: number; m15: number[]; m60: number[] }>();
for (const r of journalRows) {
  const e = r.entry, a = r.analysis;
  if (!e || !a || (a.outcome !== 'WIN' && a.outcome !== 'LOSS')) continue;
  const fm = String(e.fillModel ?? 'unknown');
  const d = byFill.get(fm) ?? { n: 0, w: 0, pnl: 0, m15: [], m60: [] };
  d.n++;
  if (a.outcome === 'WIN') d.w++;
  d.pnl += Number(a.pnl ?? 0);
  const mk = a.markout;
  if (mk) {
    if (typeof mk.m15s === 'number') d.m15.push(mk.m15s);
    if (typeof mk.m60s === 'number') d.m60.push(mk.m60s);
    if (typeof mk.adversePeak === 'number') (a.outcome === 'WIN' ? winMae : lossMae).push(mk.adversePeak * 100);
    if (typeof mk.favorablePeak === 'number') (a.outcome === 'WIN' ? winMfe : lossMfe).push(mk.favorablePeak * 100);
  }
  byFill.set(fm, d);
}
if (winMae.length + lossMae.length > 0) {
  const fmtP = (arr: number[]) => arr.length > 0 ? `med=${pctile(arr, 0.5)!.toFixed(1)}c p75=${pctile(arr, 0.75)!.toFixed(1)}c (n=${arr.length})` : 'n=0';
  console.log('');
  console.log('[5] MAE / MFE Excursion & Fill-Model Markout:');
  console.log(`    WIN  MAE (adverse): ${fmtP(winMae)} | MFE (favorable): ${fmtP(winMfe)}`);
  console.log(`    LOSS MAE (adverse): ${fmtP(lossMae)} | MFE (favorable): ${fmtP(lossMfe)}`);
  for (const [fm, d] of byFill.entries()) {
    const wr = ((d.w / d.n) * 100).toFixed(1);
    const m15 = d.m15.length ? `${(d.m15.reduce((s, v) => s + v, 0) / d.m15.length * 100).toFixed(2)}c` : '-';
    const m60 = d.m60.length ? `${(d.m60.reduce((s, v) => s + v, 0) / d.m60.length * 100).toFixed(2)}c` : '-';
    console.log(`    ${fm.padEnd(20)} n=${String(d.n).padStart(3)} | ${wr}% WR | PnL=${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)} | m15=${m15} m60=${m60}`);
  }
}
