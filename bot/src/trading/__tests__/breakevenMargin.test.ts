/**
 * Margin over breakeven — the number a win rate alone cannot tell you.
 *
 * Breakeven is not re-derived here. It is solved from computeSettlementPnl, the
 * same function that books the trade. If the fee model changes, this moves with
 * it, and the cross-check test below fails if it ever stops agreeing.
 *
 * The fee model changed on 2026-09-26: the CLOB V2 docs charge the taker
 * shares × 0.07 × p × (1 − p) at match, win or lose, so breakeven is
 * p + 0.07·p·(1 − p). The fee-on-the-winning-profit model it replaced
 * understated breakeven by 1.0-1.3pp across the traded range.
 */

import { describe, test, expect } from 'vitest';
import { computeSettlementPnl } from '../../engines/settlementMath.ts';
import { polyTakerFeePerShare } from '../../../../src/config.ts';
import { breakevenWinRate, summarizeMargin, isRealisticFill } from '../breakevenMargin.ts';

/** A resolved journal row, trimmed to the fields the summary reads. */
function row(tokenPrice: number, outcome: 'WIN' | 'LOSS', pnl: number, entry: Record<string, unknown> = {}) {
  return { entry: { tokenPrice, ...entry }, analysis: { outcome, pnl } };
}

describe('breakevenWinRate', () => {
  test('at the returned win rate, expected P&L is zero by the bot\'s own math', () => {
    for (const p of [0.45, 0.55, 0.632, 0.70, 0.78, 0.88]) {
      const w = breakevenWinRate(p)!;
      const size = 1_000_000;
      const cost = size * p;
      const winPnl = computeSettlementPnl({ won: true, size, cost, price: p });
      const lossPnl = computeSettlementPnl({ won: false, size, cost, price: p });
      const ev = w * winPnl + (1 - w) * lossPnl;
      // Within a cent per $1M of notional — i.e. the rounding, not the model.
      expect(Math.abs(ev)).toBeLessThan(1);
    }
  });

  test('breakeven sits above the raw price — the fee has to be paid from somewhere', () => {
    for (const p of [0.50, 0.632, 0.75]) {
      expect(breakevenWinRate(p)!).toBeGreaterThan(p);
    }
  });

  test('equals p + 0.07·p·(1 − p): the taker pays the fee per share, win or lose', () => {
    for (const p of [0.55, 0.632, 0.70, 0.78]) {
      expect(breakevenWinRate(p)!).toBeCloseTo(p + polyTakerFeePerShare(p), 6);
    }
  });

  test('a 63.2c entry needs 64.8%, not the 63.6% the fee-on-profit model claimed', () => {
    expect(breakevenWinRate(0.632)!).toBeCloseTo(0.6483, 3);
  });

  test('unusable prices return null rather than a plausible-looking number', () => {
    for (const p of [0, 1, -0.2, 1.5, NaN, Infinity]) {
      expect(breakevenWinRate(p as number)).toBeNull();
    }
  });
});

describe('summarizeMargin', () => {
  test('counts wins and losses and reports the margin over breakeven', () => {
    // 10 trades at 60c, 7 wins. Breakeven at 60c is 60% + 1.68c fee = 61.68%, so +8.3pp.
    const rows = [
      ...Array.from({ length: 7 }, () => row(0.60, 'WIN', 0.39)),
      ...Array.from({ length: 3 }, () => row(0.60, 'LOSS', -0.60)),
    ];
    const s = summarizeMargin(rows);
    expect(s.trades).toBe(10);
    expect(s.wins).toBe(7);
    expect(s.losses).toBe(3);
    expect(s.winRatePct).toBeCloseTo(70, 6);
    expect(s.avgEntryPrice).toBeCloseTo(0.60, 6);
    expect(s.breakevenPct).toBeCloseTo(61.68, 1);
    expect(s.marginPp).toBeCloseTo(70 - 61.68, 1);
  });

  test('a losing book reports a negative margin, not an absolute distance', () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row(0.80, 'WIN', 0.19)),
      ...Array.from({ length: 5 }, () => row(0.80, 'LOSS', -0.80)),
    ];
    const s = summarizeMargin(rows);
    expect(s.marginPp).toBeLessThan(0);
  });

  test('sums P&L across the set', () => {
    const s = summarizeMargin([row(0.6, 'WIN', 0.39), row(0.6, 'LOSS', -0.6)]);
    expect(s.pnl).toBeCloseTo(-0.21, 6);
  });

  test('an empty set reports nulls, so nothing renders as a confident 0%', () => {
    const s = summarizeMargin([]);
    expect(s.trades).toBe(0);
    expect(s.winRatePct).toBeNull();
    expect(s.breakevenPct).toBeNull();
    expect(s.marginPp).toBeNull();
    expect(s.pnl).toBe(0);
  });

  test('unresolved and unpriced rows are excluded rather than counted as losses', () => {
    const rows = [
      row(0.60, 'WIN', 0.39),
      { entry: { tokenPrice: 0.6 }, analysis: { outcome: 'DRY_RUN', pnl: 0 } },
      { entry: { tokenPrice: null }, analysis: { outcome: 'LOSS', pnl: -1 } },
      { entry: {}, analysis: {} },
    ];
    expect(summarizeMargin(rows as never).trades).toBe(1);
  });
});

describe('isRealisticFill — which rows may be judged', () => {
  test('a live row always counts: its fill was real', () => {
    expect(isRealisticFill(row(0.6, 'WIN', 0.1, { dryRun: false }))).toBe(true);
    expect(isRealisticFill(row(0.6, 'WIN', 0.1))).toBe(true);
  });

  test('a dry-run row counts only once it was priced like a live order', () => {
    expect(isRealisticFill(row(0.6, 'WIN', 0.1, { dryRun: true, fillModel: 'fok_limit' }))).toBe(true);
  });

  test('a dry-run row booked at the quote does not count — that is the optimistic bound', () => {
    expect(isRealisticFill(row(0.6, 'WIN', 0.1, { dryRun: true }))).toBe(false);
  });

  test('the window is defined by the data, not by a hardcoded deploy timestamp', () => {
    // fillModel is written by tradePipeline at entry, so a row carries its own
    // provenance. Nothing here needs updating at the next deploy.
    const mixed = [
      row(0.60, 'WIN', 0.39, { dryRun: true }),                          // old model
      row(0.60, 'WIN', 0.39, { dryRun: true, fillModel: 'fok_limit' }),  // current
    ];
    expect(mixed.filter(isRealisticFill)).toHaveLength(1);
  });
});

/**
 * Why the dashboard's dependency lists name every margin field, not just the
 * margin. journalAnalytics overwrites analysis.pnl from the verified on-chain
 * journal and only rewrites `outcome` when the sign flips, so a correction can
 * move P&L while every count and rate is byte-identical. Keying a useMemo or a
 * React.memo comparator on marginPp alone froze "P&L (realistic)" on screen.
 */
describe('P&L moves independently of the rates derived from it', () => {
  test('an on-chain P&L correction that keeps the outcome changes only pnl', () => {
    const before = [row(0.60, 'WIN', 0.39), row(0.60, 'LOSS', -0.60)];
    // Same prices, same outcomes; only the winner's booked P&L is corrected.
    const after = [row(0.60, 'WIN', 0.34), row(0.60, 'LOSS', -0.60)];

    const a = summarizeMargin(before);
    const b = summarizeMargin(after);

    expect(b.pnl).not.toBe(a.pnl);
    // Everything a "marginPp-only" dependency list would have watched is equal,
    // which is exactly why such a list went stale.
    expect(b.trades).toBe(a.trades);
    expect(b.wins).toBe(a.wins);
    expect(b.losses).toBe(a.losses);
    expect(b.winRatePct).toBe(a.winRatePct);
    expect(b.breakevenPct).toBe(a.breakevenPct);
    expect(b.marginPp).toBe(a.marginPp);
  });
});
