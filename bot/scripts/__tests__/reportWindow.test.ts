/**
 * Report window resolution.
 *
 * Why it exists: --days N is a ROLLING window, and on 2026-09-20 the same
 * unchanged journal read 85.7% WR over --days 1 and 66.1% over --days 14. The
 * go-live criterion agreed that day is "margin >= +2.5pp measured on the
 * post-fix window ALONE", which needs a fixed boundary at the deploy instant
 * (2026-09-20T07:18:56Z), not "the last N days" evaluated whenever the report
 * happens to run.
 *
 * An unparseable boundary must throw rather than silently fall back to a
 * rolling window: a report that quietly scores the wrong period is worse than
 * one that refuses to run, because the number still looks plausible.
 */
import { describe, test, expect } from 'vitest';
import { resolveWindow, inWindow } from '../reportWindow.mts';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const DAY = 86_400_000;

describe('resolveWindow', () => {
  test('default is the last 1 day, open-ended at the top', () => {
    const w = resolveWindow({}, NOW);
    expect(w.sinceMs).toBe(NOW - DAY);
    expect(w.untilMs).toBe(Infinity);
    expect(w.label).toBe('last 1 day(s)');
  });

  test('--days N looks back N days', () => {
    const w = resolveWindow({ days: '14' }, NOW);
    expect(w.sinceMs).toBe(NOW - 14 * DAY);
    expect(w.label).toBe('last 14 day(s)');
  });

  test('--all covers everything', () => {
    const w = resolveWindow({ all: true }, NOW);
    expect(w.sinceMs).toBe(0);
    expect(w.untilMs).toBe(Infinity);
    expect(w.label).toBe('entire journal');
  });

  test('--since pins the lower boundary and names it in the label', () => {
    const w = resolveWindow({ since: '2026-09-20T07:18:56Z' }, NOW);
    expect(w.sinceMs).toBe(Date.parse('2026-09-20T07:18:56Z'));
    expect(w.untilMs).toBe(Infinity);
    // The label has to be quotable — the whole point is an unambiguous window.
    expect(w.label).toContain('2026-09-20T07:18:56');
    expect(w.label).not.toContain('last');
  });

  test('--since overrides --days rather than intersecting with it', () => {
    // Both given: the explicit boundary wins, silently combining them would
    // produce a window neither flag describes.
    const w = resolveWindow({ since: '2026-09-20T07:18:56Z', days: '14' }, NOW);
    expect(w.sinceMs).toBe(Date.parse('2026-09-20T07:18:56Z'));
  });

  test('--until pins the upper boundary', () => {
    const w = resolveWindow({ since: '2026-09-01T00:00:00Z', until: '2026-09-15T00:00:00Z' }, NOW);
    expect(w.sinceMs).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(w.untilMs).toBe(Date.parse('2026-09-15T00:00:00Z'));
    expect(w.label).toContain('2026-09-01T00:00:00');
    expect(w.label).toContain('2026-09-15T00:00:00');
  });

  test('--until alone keeps the lower boundary open', () => {
    const w = resolveWindow({ until: '2026-09-15T00:00:00Z' }, NOW);
    expect(w.sinceMs).toBe(0);
    expect(w.untilMs).toBe(Date.parse('2026-09-15T00:00:00Z'));
  });

  test('epoch milliseconds are accepted as a boundary', () => {
    const ms = Date.parse('2026-09-20T07:18:56Z');
    const w = resolveWindow({ since: String(ms) }, NOW);
    expect(w.sinceMs).toBe(ms);
  });

  test('--all wins over explicit boundaries', () => {
    const w = resolveWindow({ all: true, since: '2026-09-01T00:00:00Z' }, NOW);
    expect(w.sinceMs).toBe(0);
    expect(w.untilMs).toBe(Infinity);
  });

  describe('refuses to guess', () => {
    test('an unparseable --since throws instead of falling back to --days', () => {
      expect(() => resolveWindow({ since: 'yesterday' }, NOW)).toThrow(/since/i);
    });

    test('an unparseable --until throws', () => {
      expect(() => resolveWindow({ until: 'not-a-date' }, NOW)).toThrow(/until/i);
    });

    test('--since with no value (bare flag) throws', () => {
      expect(() => resolveWindow({ since: true }, NOW)).toThrow(/since/i);
    });

    test('an inverted window throws rather than reporting zero trades', () => {
      expect(() => resolveWindow({
        since: '2026-09-15T00:00:00Z',
        until: '2026-09-01T00:00:00Z',
      }, NOW)).toThrow(/before/i);
    });

    test('a non-numeric --days throws', () => {
      expect(() => resolveWindow({ days: 'ten' }, NOW)).toThrow(/days/i);
    });

    test('a negative --days throws', () => {
      expect(() => resolveWindow({ days: '-3' }, NOW)).toThrow(/days/i);
    });
  });

  test('the JSON window tag is machine-readable, not the human label', () => {
    const w = resolveWindow({ since: '2026-09-20T07:18:56Z' }, NOW);
    expect(w.tag).toEqual({ since: '2026-09-20T07:18:56.000Z', until: null });
    expect(resolveWindow({ days: '7' }, NOW).tag).toEqual({ days: 7 });
    expect(resolveWindow({ all: true }, NOW).tag).toEqual({ all: true });
  });
});

describe('inWindow', () => {
  /**
   * Both the journal rows and the PTB-health rollups filter through this. They
   * used to carry two separate inline conditions, and the PTB one silently
   * dropped the upper bound — the report then printed trade numbers for one
   * period next to a diagnostic for another.
   */
  const w = { sinceMs: 1000, untilMs: 2000 };

  test('lower bound is inclusive, upper bound is exclusive', () => {
    expect(inWindow(999, w)).toBe(false);
    expect(inWindow(1000, w)).toBe(true);
    expect(inWindow(1999, w)).toBe(true);
    expect(inWindow(2000, w)).toBe(false);
  });

  test('an open upper bound accepts anything above since', () => {
    expect(inWindow(1e15, { sinceMs: 1000, untilMs: Infinity })).toBe(true);
  });

  test('missing or non-numeric timestamps are excluded, never included by default', () => {
    for (const bad of [null, undefined, NaN, 'x' as unknown as number]) {
      expect(inWindow(bad as number, w)).toBe(false);
    }
  });

  test('agrees with the window resolveWindow produced', () => {
    const win = resolveWindow({ since: '2026-09-20T07:18:56Z', until: '2026-09-21T00:00:00Z' }, NOW);
    expect(inWindow(Date.parse('2026-09-20T07:18:55Z'), win)).toBe(false);
    expect(inWindow(Date.parse('2026-09-20T07:18:56Z'), win)).toBe(true);
    expect(inWindow(Date.parse('2026-09-20T23:59:59Z'), win)).toBe(true);
    expect(inWindow(Date.parse('2026-09-21T00:00:00Z'), win)).toBe(false);
  });
});
