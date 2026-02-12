/**
 * XGBoost tree indexing and evaluation.
 */

import * as S from './state.js';
import { resolveFeatureIdx } from './featureMap.js';

export function indexTree(rawTree) {
  const nodeMap = new Map();

  function walk(node) {
    if (node.leaf !== undefined) {
      nodeMap.set(node.nodeid, { leaf: node.leaf });
      return;
    }
    const featureIdx = resolveFeatureIdx(node.split);
    nodeMap.set(node.nodeid, {
      featureIdx,
      threshold: node.split_condition,
      yes: node.yes,
      no: node.no,
      missing: node.missing ?? node.yes,
    });
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }

  walk(rawTree);
  return nodeMap;
}

export function evaluateTreeFast(nodeMap, features) {
  let nodeId = 0;
  for (let depth = 0; depth < 200; depth++) {
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    if (node.leaf !== undefined) return node.leaf;
    const idx = node.featureIdx;
    if (idx < 0 || idx >= features.length) { nodeId = node.missing; continue; }
    const val = features[idx];
    if (val !== val || val === undefined) { nodeId = node.missing; continue; }
    nodeId = val < node.threshold ? node.yes : node.no;
  }
  return 0; // safety: max depth exceeded
}

export function predictXGBoost(features) {
  if (!S.processedTrees) return null;

  let logit = 0;
  const trees = S.processedTrees;
  const len = S.numUsableTrees;
  for (let i = 0; i < len; i++) {
    logit += evaluateTreeFast(trees[i], features);
  }

  return 1 / (1 + Math.exp(-logit));
}
