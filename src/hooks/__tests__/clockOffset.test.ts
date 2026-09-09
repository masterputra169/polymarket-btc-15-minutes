import { describe, it, expect } from 'vitest';
import { computeClockOffsetMs, remainingMinutes } from '../clockOffset.ts';

// Scenario from 2026-09-08: the operator's PC clock was 36 min slow while the
// bot (Railway) clock was right. The dashboard showed ~37 min left on a
// 15-minute market because it subtracted the browser's Date.now().
const SERVER_NOW = Date.UTC(2026, 8, 8, 7, 43, 38);          // 07:43:38Z (bot ts)
const LOCAL_NOW = SERVER_NOW - 36 * 60_000 - 11_000;         // PC is 36m11s behind
const SETTLEMENT = Date.UTC(2026, 8, 8, 7, 45, 0);           // market ends 07:45:00Z

describe('computeClockOffsetMs', () => {
  it('returns server-minus-local so a slow PC yields a positive offset', () => {
    expect(computeClockOffsetMs(SERVER_NOW, LOCAL_NOW)).toBe(36 * 60_000 + 11_000);
  });

  it('returns 0 when the server timestamp is missing or not a number', () => {
    expect(computeClockOffsetMs(null, LOCAL_NOW)).toBe(0);
    expect(computeClockOffsetMs(undefined, LOCAL_NOW)).toBe(0);
    expect(computeClockOffsetMs(Number.NaN, LOCAL_NOW)).toBe(0);
  });
});

describe('remainingMinutes', () => {
  it('uses the server-corrected clock, not the raw browser clock', () => {
    const offset = computeClockOffsetMs(SERVER_NOW, LOCAL_NOW);
    // 07:45:00 - 07:43:38 = 82 s = 1.3667 min (bot reported 1.36)
    expect(remainingMinutes(SETTLEMENT, LOCAL_NOW, offset)).toBeCloseTo(82 / 60, 3);
  });

  it('falls back to the browser clock when the offset is 0', () => {
    expect(remainingMinutes(SETTLEMENT, LOCAL_NOW, 0)).toBeCloseTo((36 * 60 + 11 + 82) / 60, 3);
  });

  it('clamps to 0 once the corrected clock passes the target', () => {
    expect(remainingMinutes(SETTLEMENT, SETTLEMENT + 5_000, 0)).toBe(0);
    expect(remainingMinutes(SETTLEMENT, LOCAL_NOW, 60 * 60_000)).toBe(0);
  });

  it('returns null when there is no target', () => {
    expect(remainingMinutes(null, LOCAL_NOW, 0)).toBeNull();
    expect(remainingMinutes(undefined, LOCAL_NOW, 0)).toBeNull();
  });
});
