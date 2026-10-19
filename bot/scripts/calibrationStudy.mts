/** Probability calibration study for the bot's directional entries (record-only).
 *
 *   node --env-file=./.env scripts/calibrationStudy.mts
 *
 * Uses settled journal rows with entry.ensembleUp and entry market odds. Fits a
 * single shrink weight on the FIRST 60% (time-ordered) and evaluates on the last
 * 40%, comparing model, market and shrunk model probabilities.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });
const JOURNAL = resolve(ROOT, 'bot', 'data', 'trade_journal.jsonl');
const OUT = resolve(ROOT, 'bot', 'data', 'calibration_study.json');
if (!existsSync(JOURNAL)) { console.error('journal not found'); process.exit(2); }
const rows = readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);
const usable = [];
for (const r of rows) {
  const side = r.entry?.side;
  const modelUp = Number(r.entry?.ensembleUp);
  const marketUp = Number(r.entry?.marketUp);
  const marketDown = Number(r.entry?.marketDown);
  const outcome = r.exit?.verifiedOutcome ?? r.exit?.outcome;
  const ts = Number(r.entry?.enteredAt ?? r._ts ?? 0);
  if ((side !== 'UP' && side !== 'DOWN') || !['UP','DOWN'].includes(outcome)) continue;
  if (!Number.isFinite(modelUp) || !Number.isFinite(marketUp) || !Number.isFinite(marketDown)) continue;
  const pModel = side === 'UP' ? modelUp : 1 - modelUp;
  const pMarket = side === 'UP' ? marketUp : marketDown;
  if (!(pModel > 0 && pModel < 1) || !(pMarket > 0 && pMarket < 1)) continue;
  usable.push({ ts, side, pModel, pMarket, y: outcome === side ? 1 : 0 });
}
usable.sort((a,b) => a.ts - b.ts);
if (usable.length < 20) { console.log('not enough rows: ' + usable.length); process.exit(0); }
const split = Math.max(10, Math.floor(usable.length * 0.6));
const train = usable.slice(0, split), test = usable.slice(split);
function brier(rows, pOf) {
  if (!rows.length) return null;
  let s = 0;
  for (const r of rows) s += Math.pow(pOf(r) - r.y, 2);
  return s / rows.length;
}
function report(rows, pOf) {
  if (!rows.length) return { n: 0 };
  let b = 0, correct = 0, psum = 0;
  for (const r of rows) { const p = pOf(r); b += Math.pow(p - r.y, 2); psum += p; if ((p >= 0.5) === (r.y === 1)) correct++; }
  return { n: rows.length, brier: +(b / rows.length).toFixed(4), meanP: +(psum / rows.length).toFixed(4), winRate: +(100 * rows.filter(r=>r.y===1).length / rows.length).toFixed(1), sideAcc: +(100 * correct / rows.length).toFixed(1) };
}
let best = { w: 1, trainBrier: Infinity };
for (let w = 0; w <= 1.0001; w += 0.05) {
  const b = brier(train, r => r.pMarket + w * (r.pModel - r.pMarket));
  if (b < best.trainBrier) best = { w: +w.toFixed(2), trainBrier: b };
}
const pCal = r => r.pMarket + best.w * (r.pModel - r.pMarket);
const out = {
  generatedAt: new Date().toISOString(),
  rows: usable.length,
  trainRows: train.length,
  testRows: test.length,
  bestShrinkWeight: best.w,
  train: { model: report(train, r=>r.pModel), market: report(train, r=>r.pMarket), shrunk: report(train, pCal) },
  test: { model: report(test, r=>r.pModel), market: report(test, r=>r.pMarket), shrunk: report(test, pCal) },
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
