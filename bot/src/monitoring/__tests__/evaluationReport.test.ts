/**
 * evaluationReport — the daily go-live check: win rate vs breakeven, with an
 * interval, on the trades since the strategy was deployed.
 */
import { describe, test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildEvaluation, formatEvaluation, readEvalConfig, wilson95, msUntilHourUtc, readJournalRows, type EvalRow,
} from '../evaluationReport.ts';
import { breakevenWinRate } from '../../trading/breakevenMargin.ts';

const SINCE = Date.UTC(2026, 8, 25, 13, 28, 12);
const NOW = SINCE + 5 * 86_400_000;

function row(i: number, win: boolean, over: Partial<NonNullable<EvalRow['entry']>> = {}, price = 0.6): EvalRow {
  const cost = 1.2;
  return {
    entry: {
      enteredAt: SINCE + 60_000 * (i + 1), session: i % 2 ? 'US' : 'Asia', modelId: '20260924-p2-0d88d4',
      dryRun: true, fillModel: 'fok_limit', tokenPrice: price, ...over,
    } as any,
    analysis: { outcome: win ? 'WIN' : 'LOSS', pnl: win ? +(cost / price - cost).toFixed(2) : -cost },
  };
}

describe('readEvalConfig', () => {
  test('parses the window start and bounds the numbers', () => {
    expect(readEvalConfig({ EVAL_WINDOW_START: '2026-09-25T13:28:12Z', EVAL_TARGET_TRADES: '200', EVAL_REPORT_HOUR_UTC: '0' }))
      .toEqual({ since: SINCE, targetTrades: 200, hourUtc: 0, problem: null });
  });
  test('unset = off; garbage = off and said out loud', () => {
    expect(readEvalConfig({}).since).toBeNull();
    expect(readEvalConfig({}).problem).toBeNull();
    const bad = readEvalConfig({ EVAL_WINDOW_START: 'yesterday', EVAL_REPORT_HOUR_UTC: '99' });
    expect(bad.since).toBeNull();
    expect(bad.problem).toContain('not an ISO date');
    expect(bad.hourUtc).toBe(0);
  });
});

describe('wilson95', () => {
  test('known values', () => {
    const w = wilson95(60, 100)!;
    expect(w.lo).toBeCloseTo(50.2, 1);
    expect(w.hi).toBeCloseTo(69.1, 1);
    expect(wilson95(0, 0)).toBeNull();
  });
});

describe('buildEvaluation', () => {
  test('only resolved trades inside the window count; unrealistic fills are reported, not scored', () => {
    const rows = [
      row(0, true), row(1, false), row(2, true),
      row(3, true, { enteredAt: SINCE - 1 }),                     // before the window
      row(4, true, { fillModel: undefined }),                      // dry-run row without a realistic fill
      { entry: { enteredAt: SINCE + 1000, tokenPrice: 0.6, dryRun: true, fillModel: 'fok_limit' }, analysis: { outcome: 'OPEN' } } as EvalRow,
    ];
    const s = buildEvaluation(rows, SINCE, NOW, 150);
    expect(s.realistic.trades).toBe(3);
    expect(s.realistic.wins).toBe(2);
    expect(s.excludedNotRealistic).toBe(1);
    expect(s.models).toEqual(['20260924-p2-0d88d4']);
    expect(s.verdict).toBe('too_early');
    expect(s.realistic.breakevenPct! / 100).toBeCloseTo(breakevenWinRate(0.6)!, 3);
  });

  test('verdicts need 30 trades and an interval clear of breakeven', () => {
    const strong = Array.from({ length: 60 }, (_, i) => row(i, i % 10 !== 0));          // 90% at 60c
    expect(buildEvaluation(strong, SINCE, NOW, 150).verdict).toBe('above_breakeven');
    const weak = Array.from({ length: 60 }, (_, i) => row(i, i % 10 < 3));              // 30% at 60c
    expect(buildEvaluation(weak, SINCE, NOW, 150).verdict).toBe('below_breakeven');
    const edge = Array.from({ length: 40 }, (_, i) => row(i, i % 5 < 3));               // 60% ≈ breakeven
    expect(buildEvaluation(edge, SINCE, NOW, 150).verdict).toBe('inconclusive');
    expect(buildEvaluation([], SINCE, NOW, 150).verdict).toBe('no_trades');
  });

  test('splits by session and keeps the last 24 h', () => {
    const rows = [row(0, true), row(1, true), row(2, false), row(3, true, { enteredAt: NOW - 3_600_000 })];
    const s = buildEvaluation(rows, SINCE, NOW, 150);
    expect(s.bySession.map(x => [x.session, x.summary.trades])).toEqual([['Asia', 2], ['US', 2]]);
    expect(s.last24h.trades).toBe(1);
  });
});

describe('formatEvaluation', () => {
  test('says the numbers that decide go-live, and escapes HTML', () => {
    const rows = [row(0, true, { session: '<b>x</b>' }), row(1, false)];
    const text = formatEvaluation(buildEvaluation(rows, SINCE, NOW, 150));
    expect(text).toContain('Dry-run evaluation');
    expect(text).toContain('Trades: <b>2</b> / 150 target');
    expect(text).toContain('vs breakeven');
    expect(text).toContain('Too early to judge');
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).not.toContain('<b>x</b>');
  });
});

describe('msUntilHourUtc', () => {
  test('next occurrence, today or tomorrow', () => {
    const t = Date.UTC(2026, 8, 25, 22, 30, 0);
    expect(msUntilHourUtc(t, 23)).toBe(30 * 60_000);
    expect(msUntilHourUtc(t, 0)).toBe(90 * 60_000);
    expect(msUntilHourUtc(Date.UTC(2026, 8, 25, 0, 0, 0), 0)).toBe(86_400_000);
  });
});

describe('readJournalRows', () => {
  test('keeps window rows, skips older ones before parsing, survives a torn line and a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-journal-'));
    try {
      const path = join(dir, 'trade_journal.jsonl');
      writeFileSync(path, [
        JSON.stringify(row(0, true, { enteredAt: SINCE - 60_000 })),
        JSON.stringify(row(1, true)),
        '{"entry":{"enteredAt":' + (SINCE + 5) + ',"torn',
        JSON.stringify(row(2, false)),
        '',
      ].join('\n'));
      const rows = await readJournalRows(path, SINCE);
      expect(rows.map(r => r.entry?.enteredAt)).toEqual([SINCE + 120_000, SINCE + 180_000]);
      expect(await readJournalRows(join(dir, 'missing.jsonl'), SINCE)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
