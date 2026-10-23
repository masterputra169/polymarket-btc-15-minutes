#!/usr/bin/env node
/**
 * Record-only shadow decision study.
 * Time-split 60/40 on the live journal, Wilson intervals, candidate filters,
 * and model champion/challenger gate metrics. Changes no trading behaviour.
 *
 * Usage: node bot/scripts/shadowDecisionStudy.mjs [journalPath]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const JOURNAL = process.argv[2] || '/opt/polybtc15/bot/data/trade_journal.jsonl';
const OUT = JOURNAL.replace(/trade_journal\.jsonl$/, 'shadow_decision_study.json');
const CURRENT_MODEL = '20260924-p2-0d88d4';

if (!existsSync(JOURNAL)) {
  console.error('journal not found: ' + JOURNAL);
  process.exit(2);
}

const rows = readFileSync(JOURNAL, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function entry(r) { return r.entry || {}; }
function outcome(r) { return r.analysis && r.analysis.outcome; }
function sideProb(r) {
  const p = num(entry(r).mlProbUp);
  const side = entry(r).side;
  if (p == null || (side !== 'UP' && side !== 'DOWN')) return null;
  return side === 'UP' ? p : 1 - p;
}
function settled(r) {
  return outcome(r) === 'WIN' || outcome(r) === 'LOSS';
}
function ts(r) {
  return Number(entry(r).enteredAt || r._ts || 0);
}
function priceOf(r) {
  return num(entry(r).actualPrice) ?? num(entry(r).tokenPrice) ?? num(entry(r).expectedPrice);
}
function stat(list) {
  const n = list.length;
  const wins = list.filter((r) => outcome(r) === 'WIN').length;
  const pnl = list.reduce((s, r) => s + (num(r.analysis && r.analysis.pnl) || 0), 0);
  const prices = list.map(priceOf).filter((p) => p != null);
  const avgEntry = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null;
  const breakeven = prices.length ? prices.reduce((s, p) => s + p + 0.07 * p * (1 - p), 0) / prices.length : null;
  const wr = n ? wins / n : null;
  const margin = wr != null && breakeven != null ? wr - breakeven : null;
  // Wilson 95% interval for win rate.
  let lo = null, hi = null;
  if (n > 0) {
    const z = 1.96, p = wr, d = 1 + z * z / n;
    const c = p + z * z / (2 * n);
    const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    lo = (c - m) / d; hi = (c + m) / d;
  }
  return {
    n,
    wins,
    wr: wr == null ? null : +(wr * 100).toFixed(1),
    wilsonLow: lo == null ? null : +(lo * 100).toFixed(1),
    wilsonHigh: hi == null ? null : +(hi * 100).toFixed(1),
    avgEntry: avgEntry == null ? null : +(avgEntry * 100).toFixed(1),
    breakeven: breakeven == null ? null : +(breakeven * 100).toFixed(2),
    margin: margin == null ? null : +(margin * 100).toFixed(2),
    pnl: +pnl.toFixed(2)
  };
}
function brier(list) {
  let bm = 0, bk = 0, n = 0;
  for (const r of list) {
    const p = num(entry(r).mlProbUp);
    const market = num(entry(r).marketUp);
    const actual = r.exit && r.exit.verifiedOutcome ? r.exit.verifiedOutcome : (r.analysis && r.analysis.actualOutcome);
    if (p == null || market == null || (actual !== 'UP' && actual !== 'DOWN')) continue;
    const y = actual === 'UP' ? 1 : 0;
    bm += (p - y) * (p - y);
    bk += (market - y) * (market - y);
    n++;
  }
  return n ? { n, modelBrier: +(bm / n).toFixed(4), marketBrier: +(bk / n).toFixed(4), skillPct: +(((bk - bm) / bk) * 100).toFixed(1) } : null;
}

const settledRows = rows.filter(settled);
const withModel = settledRows.filter((r) => entry(r).modelId === CURRENT_MODEL);
withModel.sort((a, b) => ts(a) - ts(b));
const split = Math.max(1, Math.floor(withModel.length * 0.6));
const train = withModel.slice(0, split);
const test = withModel.slice(split);

const filters = [
  { name: 'baseline', keep: () => true },
  { name: 'no-Europe', keep: (r) => entry(r).session !== 'Europe' },
  { name: 'no-MID', keep: (r) => entry(r).phase !== 'MID' },
  { name: 'no-Europe+MID', keep: (r) => entry(r).session !== 'Europe' && entry(r).phase !== 'MID' },
  { name: 'no-LATE', keep: (r) => entry(r).phase !== 'LATE' },
  { name: 'no-sideProb-0.6', keep: (r) => { const p = sideProb(r); return p == null || p < 0.6 || p >= 0.7; } },
  { name: 'no-sideProb-0.8', keep: (r) => { const p = sideProb(r); return p == null || p < 0.8 || p >= 0.9; } },
  { name: 'no-Europe+MID+0.6+0.8', keep: (r) => entry(r).session !== 'Europe' && entry(r).phase !== 'MID' && (() => { const p = sideProb(r); return p == null || (p >= 0.7 && p < 0.8) || p >= 0.9; })() }
];

const candidates = filters.map((f) => {
  const tr = train.filter(f.keep);
  const te = test.filter(f.keep);
  const a = stat(tr), b = stat(te);
  return {
    filter: f.name,
    train: a,
    test: b,
    eligible: b.n >= 20 && a.margin != null && b.margin != null && a.margin > 0 && b.margin > 0,
    note: b.n < 20 ? 'test sample too small' : (a.margin != null && b.margin != null && a.margin > 0 && b.margin > 0 ? 'survived basic split' : 'rejected on split')
  };
});

const groups = new Map();
for (const r of settledRows) {
  const id = entry(r).modelId || 'pre-registry';
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(r);
}
const models = [];
for (const [id, list] of groups) {
  models.push(Object.assign({ model: id }, stat(list), { brier: brier(list) }));
}
models.sort((a, b) => b.n - a.n);

const report = {
  generatedAt: new Date().toISOString(),
  journal: JOURNAL,
  totalSettled: settledRows.length,
  currentModelRows: withModel.length,
  split: { train: train.length, test: test.length },
  currentModel: stat(withModel),
  allSettled: stat(settledRows),
  candidates,
  models,
  championGate: {
    policy: 'candidate must have >=100 settled trades, model Brier < market Brier, and positive margin; otherwise not deployable',
    currentModel: models.find((m) => m.model === CURRENT_MODEL) || null,
    candidateCount: models.length,
    note: 'no candidate model is currently supplied; this is a gate for a future shadow model, not a deploy'
  }
};
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
