import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CLOB_OUTAGE_COOLDOWN_MS,
  MAX_CLOB_OUTAGE_COOLDOWN_MS,
  clearClobOutageLatch,
  detectClobOutageReason,
  isClobOutageActive,
  recordClobOrderFailure,
  resetClobOutageStats,
} from '../clobOutageLatch.ts';

describe('clobOutageLatch', () => {
  beforeEach(() => {
    resetClobOutageStats();
  });

  it('detects matching-engine outage variants across error shapes', () => {
    expect(detectClobOutageReason('CLOB rejected: post_only_mode active')).toBe('post_only_mode');
    expect(detectClobOutageReason(new Error('HTTP 425 service not ready'))).toBe('http_425_not_ready');
    expect(detectClobOutageReason({ status: 503, errorMsg: 'Service Unavailable' })).toBe('http_503_unavailable');
    expect(detectClobOutageReason('FOK order could not fill')).toBeNull();
  });

  it('latches bounded cooldown and fails open automatically on expiry', () => {
    const t0 = 1_700_000_000_000;
    expect(isClobOutageActive(t0).active).toBe(false);

    const benign = recordClobOrderFailure('insufficient liquidity', DEFAULT_CLOB_OUTAGE_COOLDOWN_MS, t0);
    expect(benign.tripped).toBe(false);
    expect(isClobOutageActive(t0).active).toBe(false);

    const trip = recordClobOrderFailure('HTTP 425 service not ready', 999_999, t0);
    expect(trip.tripped).toBe(true);
    expect(trip.untilMs).toBe(t0 + MAX_CLOB_OUTAGE_COOLDOWN_MS);

    const mid = isClobOutageActive(t0 + 60_000);
    expect(mid.active).toBe(true);
    expect(mid.remainingMs).toBe(MAX_CLOB_OUTAGE_COOLDOWN_MS - 60_000);
    expect(mid.trips).toBe(1);

    const after = isClobOutageActive(t0 + MAX_CLOB_OUTAGE_COOLDOWN_MS + 1);
    expect(after.active).toBe(false);
    expect(after.remainingMs).toBe(0);

    recordClobOrderFailure('post-only mode', DEFAULT_CLOB_OUTAGE_COOLDOWN_MS, t0 + 200_000);
    clearClobOutageLatch();
    expect(isClobOutageActive(t0 + 200_001).active).toBe(false);
  });
});
