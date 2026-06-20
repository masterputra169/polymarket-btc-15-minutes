/**
 * Tests for XGBoost tree traversal.
 * Tier-2 unit tests — pure functions, no I/O.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// Reset state module BEFORE importing tree eval (which reads state at import time)
beforeAll(async () => {
  const S = await import('../../src/engines/ml/state.ts');
  S.setState({ featureNameToIdx: new Map([
    ['rsi', 0],
    ['macd', 1],
    ['vwap_dist', 2],
  ]) });
  S.setBaseFeatureCount(3);
});

describe('indexTree', () => {
  it('handles single leaf node', async () => {
    const { indexTree } = await import('../../src/engines/ml/treeEval.ts');
    const tree = indexTree({ nodeid: 0, leaf: 0.5 });
    expect(tree.get(0)).toEqual({ leaf: 0.5 });
  });

  it('indexes tree with children', async () => {
    const { indexTree } = await import('../../src/engines/ml/treeEval.ts');
    const tree = indexTree({
      nodeid: 0, split: 'rsi', split_condition: 0.5, yes: 1, no: 2,
      children: [
        { nodeid: 1, leaf: 0.7 },
        { nodeid: 2, leaf: -0.3 },
      ],
    });
    expect(tree.size).toBe(3);
    const root = tree.get(0);
    const left = tree.get(1);
    const right = tree.get(2);
    expect(root && 'threshold' in root ? root.threshold : undefined).toBe(0.5);
    expect(left && 'leaf' in left ? left.leaf : undefined).toBe(0.7);
    expect(right && 'leaf' in right ? right.leaf : undefined).toBe(-0.3);
  });
});

describe('evaluateTreeFast', () => {
  it('routes correctly on threshold split (yes branch)', async () => {
    const { indexTree, evaluateTreeFast } = await import('../../src/engines/ml/treeEval.ts');
    const tree = indexTree({
      nodeid: 0, split: 'rsi', split_condition: 0.5, yes: 1, no: 2,
      children: [
        { nodeid: 1, leaf: 1.0 },
        { nodeid: 2, leaf: -1.0 },
      ],
    });
    // feature[0] = 0.3, threshold 0.5 → take yes branch → leaf 1.0
    const features = new Float64Array([0.3, 0, 0]);
    expect(evaluateTreeFast(tree, features)).toBe(1.0);
  });

  it('routes correctly on threshold split (no branch)', async () => {
    const { indexTree, evaluateTreeFast } = await import('../../src/engines/ml/treeEval.ts');
    const tree = indexTree({
      nodeid: 0, split: 'rsi', split_condition: 0.5, yes: 1, no: 2,
      children: [
        { nodeid: 1, leaf: 1.0 },
        { nodeid: 2, leaf: -1.0 },
      ],
    });
    // feature[0] = 0.8, threshold 0.5 → take no branch → leaf -1.0
    const features = new Float64Array([0.8, 0, 0]);
    expect(evaluateTreeFast(tree, features)).toBe(-1.0);
  });

  it('handles missing feature via missing branch', async () => {
    const { indexTree, evaluateTreeFast } = await import('../../src/engines/ml/treeEval.ts');
    const tree = indexTree({
      nodeid: 0, split: 'rsi', split_condition: 0.5, yes: 1, no: 2, missing: 1,
      children: [
        { nodeid: 1, leaf: 0.5 },
        { nodeid: 2, leaf: -0.5 },
      ],
    });
    // NaN feature → take missing branch (=yes branch here) → 0.5
    const features = new Float64Array([NaN, 0, 0]);
    expect(evaluateTreeFast(tree, features)).toBe(0.5);
  });

  it('safety-bounds infinite tree depth at 200', async () => {
    const { indexTree, evaluateTreeFast } = await import('../../src/engines/ml/treeEval.ts');
    // Tree that loops back to itself (malformed)
    const tree = new Map();
    tree.set(0, { featureIdx: 0, threshold: 0.5, yes: 0, no: 0, missing: 0 });
    const features = new Float64Array([0.3, 0, 0]);
    // Should not throw / infinite-loop — returns 0
    expect(evaluateTreeFast(tree, features)).toBe(0);
  });
});
