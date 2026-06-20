#!/usr/bin/env node
/**
 * v19 Shadow Replay
 *
 * Reads bot/data/feature_capture.jsonl (written by shadowCapture.js while bot
 * runs production v16) and applies v19 model to the EXACT same feature buffers
 * the bot saw at each poll. Writes v19 predictions to v19_shadow_journal.jsonl.
 *
 * Apples-to-apples: same features, different model.
 *
 * Usage:
 *   node bot/scripts/v19_shadow_replay.mjs
 *   node bot/scripts/v19_shadow_replay.mjs --capture path/to/feature_capture.jsonl --output ...
 *
 * Created 2026-05-14 for v19 validation. See docs/V19_VALIDATION_PLAN.md.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const args = (() => {
  const out = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k.startsWith('--') && i + 1 < process.argv.length && !process.argv[i+1].startsWith('--')) {
      out[k.slice(2)] = process.argv[++i];
    }
  }
  return out;
})();

const STAGING_DIR  = args['staging']  || path.join(ROOT, 'public', 'ml_v19_staging');
const CAPTURE_PATH = args['capture']  || path.join(ROOT, 'bot', 'data', 'feature_capture.jsonl');
const OUTPUT_PATH  = args['output']   || path.join(ROOT, 'bot', 'data', 'v19_shadow_journal.jsonl');

console.log(`v19 staging: ${STAGING_DIR}`);
console.log(`capture in:  ${CAPTURE_PATH}`);
console.log(`shadow out:  ${OUTPUT_PATH}`);

// ────────────────────────────────────────────────────────────────────────────
// XGBoost tree traversal — minimal, self-contained.
// Mirrors src/engines/ml/treeEval.js semantics for production parity.
// ────────────────────────────────────────────────────────────────────────────

function indexTree(rawTree) {
  // rawTree.nodes: array of {nodeid, depth, split, split_condition, yes, no, missing, leaf, ...}
  const nodes = new Map();
  for (const n of rawTree.nodes || []) nodes.set(n.nodeid, n);
  return { nodes, root: 0 };
}

function evalTree(tree, features, featureMap) {
  let nodeId = tree.root;
  while (true) {
    const n = tree.nodes.get(nodeId);
    if (!n) return 0;
    if (n.leaf !== undefined) return n.leaf;
    const fname = n.split;
    let fidx = typeof fname === 'number' ? fname : featureMap.get(fname);
    if (fidx === undefined) {
      // Fallback: treat as missing → take 'missing' branch if set, else 'no'
      nodeId = (n.missing != null) ? n.missing : (n.no != null ? n.no : n.yes);
      continue;
    }
    const v = features[fidx];
    const cond = n.split_condition;
    if (v == null || Number.isNaN(v)) {
      nodeId = (n.missing != null) ? n.missing : n.no;
    } else if (v < cond) {
      nodeId = n.yes;
    } else {
      nodeId = n.no;
    }
  }
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function logit(p)  { const eps = 1e-9; return Math.log((p + eps) / (1 - p + eps)); }

// ────────────────────────────────────────────────────────────────────────────
// LightGBM tree evaluation — minimal traversal for lgb dump format
// ────────────────────────────────────────────────────────────────────────────

function evalLgbTreeNode(node, features) {
  while (true) {
    if (node.leaf_value !== undefined) return node.leaf_value;
    const fidx = node.split_feature;
    const v = features[fidx];
    const thr = node.threshold;
    const dt = node.decision_type ?? '<=';
    const goLeft = (v == null || Number.isNaN(v))
      ? (node.default_left ?? true)
      : (dt === '<=' ? v <= thr : v < thr);
    node = goLeft ? node.left_child : node.right_child;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Load v19 model
// ────────────────────────────────────────────────────────────────────────────

console.log('\nLoading v19 model...');
const xgbRaw = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'xgboost_model.json'), 'utf-8'));
const lgbRaw = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'lightgbm_model.json'), 'utf-8'));
const norm   = JSON.parse(fs.readFileSync(path.join(STAGING_DIR, 'norm_browser.json'), 'utf-8'));

const xgbFeatureMap = new Map();
if (xgbRaw.feature_names) {
  for (let i = 0; i < xgbRaw.feature_names.length; i++) xgbFeatureMap.set(xgbRaw.feature_names[i], i);
}
const totalTrees = xgbRaw.trees.length;
const bestIter = xgbRaw.best_iteration;
const usableTrees = (bestIter != null && bestIter < totalTrees) ? bestIter + 1 : totalTrees;
const xgbTrees = xgbRaw.trees.slice(0, usableTrees).map(indexTree);

const plattA   = xgbRaw.platt_a ?? 1.0;
const plattB   = xgbRaw.platt_b ?? 0.0;
const plattLog = xgbRaw.platt_on_logits ?? false;
const threshold = Math.max(xgbRaw.optimal_threshold ?? 0.555, 0.52);

const lgbTrees = (lgbRaw.tree_info || []).map(t => t.tree_structure);
const lgbPlattA = norm.lgb_platt_a ?? 1.0;
const lgbPlattB = norm.lgb_platt_b ?? 0.0;
const lgbPlattLog = norm.lgb_platt_on_logits ?? false;

const wXgb = norm.ensemble_weights?.xgb ?? 0.75;
const wLgb = norm.ensemble_weights?.lgb ?? 0.25;

console.log(`  XGB: ${usableTrees}/${totalTrees} trees, threshold=${threshold}`);
console.log(`  LGB: ${lgbTrees.length} trees`);
console.log(`  Ensemble weights: XGB=${wXgb} LGB=${wLgb}`);
console.log(`  Platt XGB: A=${plattA.toFixed(4)} B=${plattB.toFixed(4)} onLogits=${plattLog}`);

// ────────────────────────────────────────────────────────────────────────────
// Predict function
// ────────────────────────────────────────────────────────────────────────────

function predictV19(features) {
  // XGB margin (sum of tree leaf values + global bias)
  let xgbMargin = 0;
  for (const t of xgbTrees) xgbMargin += evalTree(t, features, xgbFeatureMap);

  let xgbProb;
  if (plattLog) {
    const calLogit = plattA * xgbMargin + plattB;
    xgbProb = sigmoid(calLogit);
  } else {
    const raw = sigmoid(xgbMargin);
    const calLogit = plattA * logit(raw) + plattB;
    xgbProb = sigmoid(calLogit);
  }

  // LGB margin (sum of leaf values)
  let lgbMargin = 0;
  for (const t of lgbTrees) lgbMargin += evalLgbTreeNode(t, features);
  let lgbProb;
  if (lgbPlattLog) {
    lgbProb = sigmoid(lgbPlattA * lgbMargin + lgbPlattB);
  } else {
    const raw = sigmoid(lgbMargin);
    lgbProb = sigmoid(lgbPlattA * logit(raw) + lgbPlattB);
  }

  const ensembleUp = wXgb * xgbProb + wLgb * lgbProb;
  const ensembleConf = Math.abs(ensembleUp - 0.5) * 2;
  const side = ensembleUp >= 0.5 ? 'UP' : 'DOWN';
  const highConf = ensembleUp > threshold || ensembleUp < (1 - threshold);

  return { xgbProb, lgbProb, ensembleUp, ensembleConf, side, highConf };
}

// ────────────────────────────────────────────────────────────────────────────
// Stream replay
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(CAPTURE_PATH)) {
    console.error(`\n[FATAL] Capture file not found: ${CAPTURE_PATH}`);
    console.error(`Run bot with SHADOW_CAPTURE=true to populate it.`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(CAPTURE_PATH, 'utf-8') });
  const out = fs.createWriteStream(OUTPUT_PATH, { flags: 'w' });

  let count = 0;
  let skipped = 0;
  let agreeCount = 0;
  let v16HighConf = 0;
  let v19HighConf = 0;

  console.log(`\nReplaying...`);
  for await (const line of rl) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    if (!Array.isArray(rec.features) || rec.features.length !== 79) {
      skipped++; continue;
    }
    const v19 = predictV19(rec.features);
    const v16Side = rec.v16?.mlSide ?? null;
    const agree = v16Side && v16Side === v19.side;
    if (agree) agreeCount++;
    if (rec.v16?.highConf) v16HighConf++;
    if (v19.highConf) v19HighConf++;

    out.write(JSON.stringify({
      t: rec.t,
      slugTs: rec.slugTs,
      slug: rec.slug,
      phase: rec.phase,
      timeLeftMin: rec.timeLeftMin,
      lastPrice: rec.lastPrice,
      ptb: rec.ptb,
      regime: rec.regime,
      session: rec.session,
      v16: rec.v16,
      v19: {
        ensembleUp: v19.ensembleUp,
        xgbProb: v19.xgbProb,
        lgbProb: v19.lgbProb,
        side: v19.side,
        confidence: v19.ensembleConf,
        highConf: v19.highConf,
      },
      agreeSide: agree,
    }) + '\n');
    count++;
    if (count % 1000 === 0) process.stdout.write(`\r  ${count} processed, agree=${(agreeCount/count*100).toFixed(1)}%`);
  }
  out.end();
  console.log(`\n\nDone.`);
  console.log(`  Records:    ${count}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Side agree: ${agreeCount}/${count} (${(agreeCount/count*100).toFixed(1)}%)`);
  console.log(`  v16 HC:     ${v16HighConf} (${(v16HighConf/count*100).toFixed(1)}%)`);
  console.log(`  v19 HC:     ${v19HighConf} (${(v19HighConf/count*100).toFixed(1)}%)`);
  console.log(`\nOutput: ${OUTPUT_PATH}`);
  console.log(`Next: node bot/scripts/compare_v16_vs_v19.mjs`);
}

main().catch(err => { console.error(err); process.exit(1); });
