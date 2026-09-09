import { describe, it, expect } from 'vitest';
import { formatClockSkew, CLOCK_SKEW_WARN_MS } from '../clockOffset.ts';

// The dashboard now renders every duration on the bot's clock, so a wrong PC
// clock no longer breaks it — which means nothing on screen would reveal the
// wrong clock either. w32time cannot be enabled on the operator host, so the
// skew has to be said out loud instead of inferred from a mismatch.
// Offset is server-minus-local: positive means the PC is behind.

describe('formatClockSkew', () => {
  it('says nothing while the browser clock is close enough to the bot', () => {
    expect(formatClockSkew(0)).toBeNull();
    expect(formatClockSkew(1_500)).toBeNull();
    expect(formatClockSkew(-1_500)).toBeNull();
    expect(formatClockSkew(CLOCK_SKEW_WARN_MS - 1)).toBeNull();
  });

  it('reports a slow PC when the bot clock is ahead', () => {
    // 2026-09-08: operator PC 36 min behind.
    expect(formatClockSkew(36 * 60_000)).toBe('PC clock 36m slow');
  });

  it('reports a fast PC when the bot clock is behind', () => {
    // 2026-09-09: same PC exactly 12 h ahead after a bad SNTP sync.
    expect(formatClockSkew(-12 * 3_600_000)).toBe('PC clock 12h fast');
  });

  it('combines hours and minutes', () => {
    expect(formatClockSkew(90 * 60_000)).toBe('PC clock 1h 30m slow');
    expect(formatClockSkew(-(2 * 3_600_000 + 5 * 60_000))).toBe('PC clock 2h 5m fast');
  });

  it('drops a zero minute remainder', () => {
    expect(formatClockSkew(3 * 3_600_000)).toBe('PC clock 3h slow');
  });

  it('rounds to the nearest minute at the threshold', () => {
    expect(formatClockSkew(CLOCK_SKEW_WARN_MS)).toBe('PC clock 1m slow');
  });

  it('ignores an unusable offset', () => {
    expect(formatClockSkew(Number.NaN)).toBeNull();
    expect(formatClockSkew(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
