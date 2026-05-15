#!/usr/bin/env node
/**
 * v16 vs v19 Comparison Reporter
 *
 * Joins v19_shadow_journal.jsonl (per-poll v16/v19 predictions) with resolved
 * market outcomes from polymarket_lookup.json. Produces per-phase agreement
 * rate, hit rate (when high-conf), and decision overlap statistics.
 *
 * Usage:
 *   node bot/scripts/compare_v16_vs_v19.mjs
 *
 * Created 2026-05-14 for v19 validation.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SHADOW_PATH = process.argv.find(a => a.startsWith('--shadow='))?.slice(9)
  || path.join(ROOT, 'bot', 'data', 'v19_shadow_journal.jsonl');
const LOOKUP_PATH = process.argv.find(a => a.startsWith('--lookup='))?.slice(9)
  || path.join(ROOT, 'backtest', 'ml_training', 'polymarket_lookup.json');

console.log(`Shadow:  ${SHADOW_PATH}`);
console.log(`Lookup:  ${LOOKUP_PATH}`);

if (!fs.existsSync(SHADOW_PATH)) {
  console.error(`\n[FATAL] Shadow journal missing — run v19_shadow_replay.mjs first.`);
  process.exit(1);
}
if (!fs.existsSync(LOOKUP_PATH)) {
  console.error(`\n[FATAL] Polymarket lookup missing.`);
  process.exit(1);
}

console.log(`\nLoading lookup...`);
const lookup = JSON.parse(fs.readFileSync(LOOKUP_PATH, 'utf-8'));
console.log(`  ${Object.keys(lookup).length} markets`);

// Aggregators
const phases = ['EARLY', 'MID', 'LATE', 'VERY_LATE', 'UNKNOWN'];
const stat = {};
for (const p of phases) {
  stat[p] = {
    polls: 0, agreeSide: 0, resolved: 0,
    v16Correct: 0, v19Correct: 0,
    v16HC: 0, v16HCCorrect: 0,
    v19HC: 0, v19HCCorrect: 0,
    bothHC: 0, bothHCAgree: 0, bothHCCorrect: 0,
  };
}
const overall = { polls: 0, resolvedMarkets: new Set(), missingLabel: 0 };
const perSlugLast = new Map(); // slugTs → latest record (used for "decision at last-poll-before-resolution")

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(SHADOW_PATH, 'utf-8') });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    overall.polls++;
    const phase = stat[r.phase] ? r.phase : 'UNKNOWN';
    const s = stat[phase];
    s.polls++;

    if (r.agreeSide) s.agreeSide++;
    const v16HC = !!r.v16?.highConf;
    const v19HC = !!r.v19?.highConf;
    if (v16HC) s.v16HC++;
    if (v19HC) s.v19HC++;
    if (v16HC && v19HC) {
      s.bothHC++;
      if (r.agreeSide) s.bothHCAgree++;
    }

    // Resolution
    const slugTs = r.slugTs;
    if (slugTs == null) continue;
    const m = lookup[String(slugTs)];
    if (!m || (m.label !== 0 && m.label !== 1)) {
      overall.missingLabel++;
      continue;
    }
    overall.resolvedMarkets.add(slugTs);
    s.resolved++;
    const truth = m.label === 1 ? 'UP' : 'DOWN';

    if (r.v16?.mlSide === truth) s.v16Correct++;
    if (r.v19?.side === truth) s.v19Correct++;
    if (v16HC && r.v16?.mlSide === truth) s.v16HCCorrect++;
    if (v19HC && r.v19?.side === truth) s.v19HCCorrect++;
    if (v16HC && v19HC && r.v16?.mlSide === truth && r.v19?.side === truth) s.bothHCCorrect++;

    perSlugLast.set(slugTs, r);
  }

  // ─── Per-slug summary (one decision per market = most-recent poll) ───
  const slugSummary = { totalSlugs: 0, agreeSide: 0,
    v16Correct: 0, v19Correct: 0,
    v16HC: 0, v16HCCorrect: 0,
    v19HC: 0, v19HCCorrect: 0,
  };
  for (const [slugTs, r] of perSlugLast) {
    const m = lookup[String(slugTs)];
    if (!m || (m.label !== 0 && m.label !== 1)) continue;
    slugSummary.totalSlugs++;
    if (r.agreeSide) slugSummary.agreeSide++;
    const truth = m.label === 1 ? 'UP' : 'DOWN';
    if (r.v16?.mlSide === truth) slugSummary.v16Correct++;
    if (r.v19?.side === truth) slugSummary.v19Correct++;
    if (r.v16?.highConf) { slugSummary.v16HC++; if (r.v16?.mlSide === truth) slugSummary.v16HCCorrect++; }
    if (r.v19?.highConf) { slugSummary.v19HC++; if (r.v19?.side === truth) slugSummary.v19HCCorrect++; }
  }

  // ─── Report ───
  const pct = (n, d) => d > 0 ? `${(n/d*100).toFixed(1)}%` : 'n/a';

  console.log(`\n══════ v16 vs v19 SHADOW COMPARISON ══════`);
  console.log(`Total polls observed:    ${overall.polls.toLocaleString()}`);
  console.log(`Resolved markets:        ${overall.resolvedMarkets.size}`);
  console.log(`Polls w/ missing label:  ${overall.missingLabel}`);

  console.log(`\n── PER-PHASE (all polls) ──`);
  console.log(`Phase         polls    agree   v16-acc  v19-acc   v16-HC   v19-HC  both-HC-agree`);
  for (const p of phases) {
    const s = stat[p];
    if (s.polls === 0) continue;
    console.log(
      `${p.padEnd(13)} ` +
      `${String(s.polls).padStart(5)}    ` +
      `${pct(s.agreeSide, s.polls).padStart(5)}    ` +
      `${pct(s.v16Correct, s.resolved).padStart(5)}    ` +
      `${pct(s.v19Correct, s.resolved).padStart(5)}    ` +
      `${pct(s.v16HC, s.polls).padStart(5)}    ` +
      `${pct(s.v19HC, s.polls).padStart(5)}     ` +
      `${pct(s.bothHCAgree, s.bothHC).padStart(5)}`
    );
  }

  console.log(`\n── PER-PHASE HIGH-CONF HIT RATE ──`);
  console.log(`Phase         v16-HC-acc  v19-HC-acc  both-HC-acc`);
  for (const p of phases) {
    const s = stat[p];
    if (s.polls === 0) continue;
    console.log(
      `${p.padEnd(13)} ` +
      `${pct(s.v16HCCorrect, s.v16HC).padStart(7)}     ` +
      `${pct(s.v19HCCorrect, s.v19HC).padStart(7)}     ` +
      `${pct(s.bothHCCorrect, s.bothHC).padStart(7)}`
    );
  }

  console.log(`\n── PER-MARKET (last poll before resolution) ──`);
  console.log(`Total resolved markets:   ${slugSummary.totalSlugs}`);
  console.log(`Side agreement:           ${pct(slugSummary.agreeSide, slugSummary.totalSlugs)}`);
  console.log(`v16 accuracy:             ${pct(slugSummary.v16Correct, slugSummary.totalSlugs)}`);
  console.log(`v19 accuracy:             ${pct(slugSummary.v19Correct, slugSummary.totalSlugs)}`);
  console.log(`v16 high-conf entries:    ${slugSummary.v16HC} (${pct(slugSummary.v16HC, slugSummary.totalSlugs)})`);
  console.log(`v16 HC accuracy:          ${pct(slugSummary.v16HCCorrect, slugSummary.v16HC)}`);
  console.log(`v19 high-conf entries:    ${slugSummary.v19HC} (${pct(slugSummary.v19HC, slugSummary.totalSlugs)})`);
  console.log(`v19 HC accuracy:          ${pct(slugSummary.v19HCCorrect, slugSummary.v19HC)}`);

  // ─── Promotion gate ───
  console.log(`\n══════ PROMOTION GATE CHECK ══════`);
  const gate1 = (slugSummary.agreeSide / slugSummary.totalSlugs) >= 0.60;
  const gate2 = slugSummary.v19HC > 0 && (slugSummary.v19HCCorrect / slugSummary.v19HC) >= 0.75;
  const lateAcc = stat.LATE.resolved > 0 ? stat.LATE.v19Correct / stat.LATE.resolved : 0;
  const veryLateAcc = stat.VERY_LATE.resolved > 0 ? stat.VERY_LATE.v19Correct / stat.VERY_LATE.resolved : 0;
  const gate3 = lateAcc >= 0.85 && veryLateAcc >= 0.85;

  console.log(`  [${gate1 ? 'PASS' : 'FAIL'}] Side agreement ≥60%`);
  console.log(`  [${gate2 ? 'PASS' : 'FAIL'}] v19 HC accuracy ≥75%`);
  console.log(`  [${gate3 ? 'PASS' : 'FAIL'}] LATE+VERY_LATE accuracy ≥85%`);

  const allPass = gate1 && gate2 && gate3;
  console.log(`\n  Verdict: ${allPass ? 'PROMOTE v19 to production' : 'KEEP v16 — v19 needs more shadow time or retraining'}`);
  if (!allPass && overall.resolvedMarkets.size < 50) {
    console.log(`  Note: only ${overall.resolvedMarkets.size} resolved markets — sample too small. Run shadow longer.`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
