#!/usr/bin/env node
/**
 * Record-only event-gate study: joins settled trades to the latest global-risk
 * snapshot at or before entry, then compares baseline vs high-risk windows.
 * It does not change any trading rule.
 *
 * Usage: node bot/scripts/globalRiskStudy.mjs [journal] [riskFile]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const JOURNAL = process.argv[2] || '/opt/polybtc15/bot/data/trade_journal.jsonl';
const RISK = process.argv[3] || '/opt/polybtc15/bot/data/global_risk.jsonl';
const OUT = JOURNAL.replace(/trade_journal\.jsonl$/, 'global_risk_study.json');

function loadLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(String.fromCharCode(10)).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
function stat(list) {
  const n = list.length;
  const wins = list.filter((r) => r.analysis?.outcome === 'WIN').length;
  const pnl = list.reduce((s, r) => s + (Number(r.analysis?.pnl) || 0), 0);
  const wr = n ? wins / n : null;
  return { n, wr: wr == null ? null : +(wr * 100).toFixed(1), pnl: +pnl.toFixed(2) };
}

const journal = loadLines(JOURNAL).filter((r) => ['WIN', 'LOSS'].includes(r.analysis?.outcome));
const risk = loadLines(RISK).sort((a, b) => Number(a.ts) - Number(b.ts));
const joined = [];
for (const r of journal) {
  const ts = Number(r.entry?.enteredAt ?? r._ts ?? 0);
  if (!ts) continue;
  let snap = null;
  for (const s of risk) {
    if (Number(s.ts) <= ts) snap = s;
    else break;
  }
  if (!snap || ts - Number(snap.ts) > 15 * 60_000) continue;
  joined.push({ trade: r, risk: snap });
}

const high = joined.filter((x) => x.risk.level === 'high');
const medium = joined.filter((x) => x.risk.level === 'medium');
const low = joined.filter((x) => x.risk.level === 'low');
const macro = joined.filter((x) => x.risk.macro?.active);
const highMacro = joined.filter((x) => x.risk.level === 'high' || x.risk.macro?.active);

const report = {
  generatedAt: new Date().toISOString(),
  journal: JOURNAL,
  riskFile: RISK,
  settledTrades: journal.length,
  riskSnapshots: risk.length,
  joinedTrades: joined.length,
  note: 'record-only; a trade is joined to the latest snapshot at or before entry (within 15 min)',
  baseline: stat(joined),
  low: stat(low),
  medium: stat(medium),
  high: stat(high),
  macroActive: stat(macro),
  highOrMacro: stat(highMacro),
  enoughForDecision: joined.length >= 30 && high.length >= 10,
};
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
