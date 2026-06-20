/**
 * XGBoost tree indexing and evaluation.
 */

import * as S from './state.ts';
import { resolveFeatureIdx } from './featureMap.ts';

export interface RawTreeNode {
  nodeid: number;
  leaf?: number;
  split?: string;
  split_condition?: number;
  yes?: number;
  no?: number;
  missing?: number;
  children?: RawTreeNode[];
}

export type IndexedTreeNode =
  | { leaf: number }
  | { featureIdx: number; threshold: number; yes: number; no: number; missing: number };

export type IndexedTree = Map<number, IndexedTreeNode>;

export function indexTree(rawTree: RawTreeNode): IndexedTree {
  const nodeMap: IndexedTree = new Map();

  function walk(node: RawTreeNode): void {
    if (node.leaf !== undefined) {
      nodeMap.set(node.nodeid, { leaf: node.leaf });
      return;
    }
    const featureIdx = resolveFeatureIdx(node.split ?? '');
    nodeMap.set(node.nodeid, {
      featureIdx,
      threshold: node.split_condition ?? 0,
      yes: node.yes ?? node.nodeid,
      no: node.no ?? node.nodeid,
      missing: node.missing ?? node.yes,
    });
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }

  walk(rawTree);
  return nodeMap;
}

export function evaluateTreeFast(nodeMap: IndexedTree, features: ArrayLike<number>): number {
  let nodeId = 0;
  for (let depth = 0; depth < 200; depth++) {
    const node = nodeMap.get(nodeId);
    if (!node) return 0;
    if ('leaf' in node) return node.leaf;
    const idx = node.featureIdx;
    if (idx < 0 || idx >= features.length) { nodeId = node.missing; continue; }
    const val = features[idx];
    if (val !== val || val === undefined) { nodeId = node.missing; continue; }
    nodeId = val < node.threshold ? node.yes : node.no;
  }
  return 0; // safety: max depth exceeded
}

/**
 * Returns raw logit (sum of leaf values). Caller applies sigmoid + Platt.
 * v9: Changed from returning probability to returning logit for proper Platt-on-logits.
 */
export function predictXGBoost(features: ArrayLike<number>): number | null {
  if (!S.processedTrees) return null;

  let logit = 0;
  const trees = S.processedTrees;
  const len = S.numUsableTrees;
  for (let i = 0; i < len; i++) {
    logit += evaluateTreeFast(trees[i], features);
  }

  return logit;
}
