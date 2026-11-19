/**
 * TypeScript AST static anti-regression suite.
 *
 * Scans production code in `bot/src/` (excluding tests) for bug-family patterns
 * already identified during audits so they cannot re-enter in future commits.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const REPO_ROOT = resolve(ROOT, '..', '..');

export interface CodeInvariantViolation {
  rule: string;
  file: string;
  line: number;
  snippet: string;
}

const ORDER_LIFECYCLE_FILES = new Set([
  'bot/src/trading/clobClient.ts',
  'bot/src/engines/limitOrderManager.ts',
  'bot/src/trading/fillTracker.ts',
  'bot/src/engines/settlement.ts',
]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkTsFiles(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function exprTextContains(node: ts.Node, re: RegExp, sf: ts.SourceFile): boolean {
  return re.test(node.getText(sf));
}

function hasNullComparison(expr: ts.Expression, targetRe: RegExp, sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const l = n.left.getText(sf);
      const r = n.right.getText(sf);
      if ((targetRe.test(l) && /^(null|undefined)$/.test(r)) || (targetRe.test(r) && /^(null|undefined)$/.test(l))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

/** Run all 5 AST anti-regression rules on a single TypeScript file text. */
export function scanFileForCodeInvariants(relPath: string, sourceText: string): CodeInvariantViolation[] {
  const normRel = relPath.replace(/\\/g, '/');
  const sf = ts.createSourceFile(normRel, sourceText, ts.ScriptTarget.ES2022, true);
  const violations: CodeInvariantViolation[] = [];

  const push = (rule: string, node: ts.Node) => {
    violations.push({
      rule,
      file: normRel,
      line: lineOf(sf, node),
      snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
    });
  };

  const visit = (node: ts.Node) => {
    // 1. no-bestbid-only-ws-check: wsBook?.up?.bestBid != null without bestAsk check
    if (ts.isConditionalExpression(node) || ts.isIfStatement(node)) {
      const cond = ts.isConditionalExpression(node) ? node.condition : node.expression;
      const condText = cond.getText(sf);
      if (/wsBook\??\.\s*(?:up|down)\??\.\s*bestBid\b/.test(condText) && !/bestAsk\b/.test(condText)) {
        if (hasNullComparison(cond, /bestBid$/, sf)) {
          push('no-bestbid-only-ws-check', cond);
        }
      }
    }

    // 2. no-zero-as-unlimited-liquidity:
    //   a) *Liq* > 0 ? ... : budgetShares (or shares fallback)
    //   b) *Liq* > 0 && *Liq* < ...
    if (ts.isConditionalExpression(node)) {
      const condText = node.condition.getText(sf);
      if (/\b\w*[Ll]iq(?:uidity)?\s*>\s*0\b/.test(condText)) {
        const whenFalse = node.whenFalse.getText(sf).trim();
        if (/^(budgetShares|shares|maxShares|orderShares)$/.test(whenFalse)) {
          push('no-zero-as-unlimited-liquidity', node);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const leftText = node.left.getText(sf);
      const rightText = node.right.getText(sf);
      const gtMatch = /\b(\w*[Ll]iq(?:uidity)?)\s*>\s*0\b/.exec(leftText);
      if (gtMatch && new RegExp(`\\b${gtMatch[1]}\\s*<=?\\s*`).test(rightText)) {
        push('no-zero-as-unlimited-liquidity', node);
      }
    }

    // 3. no-raw-date-match-time: new Date(x.match_time)
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      node.arguments &&
      node.arguments.length >= 1
    ) {
      if (exprTextContains(node.arguments[0], /\.\s*match_time\b/, sf)) {
        push('no-raw-date-match-time', node);
      }
    }

    // 4. no-side-blind-spread-fallback (in tradePipeline.ts)
    if (
      normRel.endsWith('bot/src/engines/tradePipeline.ts') &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const fullText = node.getText(sf);
      if (/^(?:sideBook|betBook)\??\.\s*spread\s*\?\?\s*(?:params\.)?orderbookUp\??\.\s*spread\b/.test(fullText)) {
        push('no-side-blind-spread-fallback', node);
      }
    }

    // 5. no-empty-catch-in-order-lifecycle
    if (ORDER_LIFECYCLE_FILES.has(normRel) && ts.isCatchClause(node)) {
      const block = node.block;
      if (block.statements.length === 0) {
        const inner = sourceText.slice(block.getStart(sf) + 1, block.getEnd() - 1);
        if (inner.trim() === '') {
          push('no-empty-catch-in-order-lifecycle', node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

describe('Static AST code invariants', () => {
  test('all production files under bot/src/ satisfy every AST anti-regression rule', () => {
    const files = walkTsFiles(ROOT);
    expect(files.length).toBeGreaterThan(50);

    const allViolations: CodeInvariantViolation[] = [];
    for (const abs of files) {
      const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
      const src = readFileSync(abs, 'utf8');
      allViolations.push(...scanFileForCodeInvariants(rel, src));
    }

    expect(allViolations).toEqual([]);
  });

  test('self-test: every rule catches synthetic vulnerable snippets and accepts safe ones', () => {
    const v1 = scanFileForCodeInvariants('bot/src/engines/signalComputation.ts', `
      const ob = (wsBook?.up?.bestBid != null) ? wsBook.up : rest;
    `);
    expect(v1.map(v => v.rule)).toContain('no-bestbid-only-ws-check');
    const s1 = scanFileForCodeInvariants('bot/src/engines/signalComputation.ts', `
      const ob = (wsBook?.up?.bestBid != null || wsBook?.up?.bestAsk != null) ? wsBook.up : rest;
    `);
    expect(s1).toEqual([]);

    const v2 = scanFileForCodeInvariants('bot/src/engines/tradePipeline.ts', `
      const liqShares = Number.isFinite(minAskLiq) && minAskLiq > 0 ? Math.floor(minAskLiq) : budgetShares;
      if (bidLiq > 0 && bidLiq < minBidLiquidity) {}
    `);
    expect(v2.filter(v => v.rule === 'no-zero-as-unlimited-liquidity')).toHaveLength(2);
    const s2 = scanFileForCodeInvariants('bot/src/engines/tradePipeline.ts', `
      const liqShares = Number.isFinite(minAskLiq) && minAskLiq >= 0 ? Math.floor(minAskLiq) : budgetShares;
      if (bidLiq != null && Number.isFinite(bidLiq) && bidLiq < minBidLiquidity) {}
    `);
    expect(s2).toEqual([]);

    const v3 = scanFileForCodeInvariants('bot/src/trading/fillTracker.ts', `
      const ts = new Date(t.match_time).getTime();
    `);
    expect(v3.map(v => v.rule)).toContain('no-raw-date-match-time');
    const s3 = scanFileForCodeInvariants('bot/src/trading/fillTracker.ts', `
      const ts = parseTradeTimestampMs(t);
    `);
    expect(s3).toEqual([]);

    const v4 = scanFileForCodeInvariants('bot/src/engines/tradePipeline.ts', `
      const s = sideBook?.spread ?? orderbookUp?.spread ?? null;
    `);
    expect(v4.map(v => v.rule)).toContain('no-side-blind-spread-fallback');
    const s4 = scanFileForCodeInvariants('bot/src/engines/tradePipeline.ts', `
      const s = sideBook ? (sideBook.spread ?? null) : (orderbookUp?.spread ?? null);
    `);
    expect(s4).toEqual([]);

    const v5 = scanFileForCodeInvariants('bot/src/trading/clobClient.ts', `
      try { await foo(); } catch {}
    `);
    expect(v5.map(v => v.rule)).toContain('no-empty-catch-in-order-lifecycle');
    const s5 = scanFileForCodeInvariants('bot/src/trading/clobClient.ts', `
      try { await foo(); } catch { /* explicit ignore */ }
    `);
    expect(s5).toEqual([]);
  });
});
