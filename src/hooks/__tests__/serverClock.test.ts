import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setServerClockOffset,
  getServerClockOffset,
  serverNow,
  subscribeServerClock,
  resetServerClock,
  OFFSET_APPLY_TOLERANCE_MS,
} from '../serverClock.ts';

// The bot stamps every snapshot with `ts`. The browser clock may be wrong by
// any amount — 2026-09-08 an operator PC was 36 min slow, 2026-09-09 the same
// PC was 12 h fast after a bad SNTP sync, which pinned every countdown at 0.
// The shared offset is what keeps the dashboard on the bot's clock regardless.
const SERVER_NOW = Date.UTC(2026, 8, 9, 1, 20, 33);
const LOCAL_SLOW = SERVER_NOW - 36 * 60_000;      // PC 36 min behind
const LOCAL_FAST = SERVER_NOW + 12 * 3_600_000;   // PC 12 h ahead

beforeEach(() => {
  resetServerClock();
});

describe('setServerClockOffset', () => {
  it('starts at zero so a dashboard with no snapshot yet uses the browser clock', () => {
    expect(getServerClockOffset()).toBe(0);
  });

  it('applies the first usable sample immediately', () => {
    expect(setServerClockOffset(SERVER_NOW, LOCAL_FAST)).toBe(-12 * 3_600_000);
    expect(getServerClockOffset()).toBe(-12 * 3_600_000);
  });

  it('applies a slow clock as a positive offset', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_SLOW);
    expect(getServerClockOffset()).toBe(36 * 60_000);
  });

  it('keeps the last good offset when a snapshot carries no usable ts', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    setServerClockOffset(null, LOCAL_FAST);
    setServerClockOffset(undefined, LOCAL_FAST);
    setServerClockOffset(Number.NaN, LOCAL_FAST);
    setServerClockOffset('1788959427000', LOCAL_FAST);
    expect(getServerClockOffset()).toBe(-12 * 3_600_000);
  });

  it('ignores sub-tolerance jitter so the countdown does not stutter', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_SLOW);
    const stable = getServerClockOffset();
    // Broadcast throttle + 500 ms flush make each sample land a bit late.
    setServerClockOffset(SERVER_NOW + 900, LOCAL_SLOW);
    setServerClockOffset(SERVER_NOW - 800, LOCAL_SLOW);
    expect(getServerClockOffset()).toBe(stable);
  });

  it('adopts a drift larger than the tolerance', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_SLOW);
    const drifted = SERVER_NOW + OFFSET_APPLY_TOLERANCE_MS + 5_000;
    setServerClockOffset(drifted, LOCAL_SLOW);
    expect(getServerClockOffset()).toBe(drifted - LOCAL_SLOW);
  });
});

describe('serverNow', () => {
  it('returns the browser clock while no offset is known', () => {
    expect(serverNow(LOCAL_FAST)).toBe(LOCAL_FAST);
  });

  it('maps a wrong browser clock back onto the bot clock', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    expect(serverNow(LOCAL_FAST)).toBe(SERVER_NOW);
    setServerClockOffset(SERVER_NOW, LOCAL_SLOW);
    expect(serverNow(LOCAL_SLOW)).toBe(SERVER_NOW);
  });

  it('keeps advancing between snapshots', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    expect(serverNow(LOCAL_FAST + 5_000)).toBe(SERVER_NOW + 5_000);
  });
});

describe('stale replayed snapshot', () => {
  // statusServer replays `lastSnapshot` verbatim to every new client, so the
  // first sample a dashboard sees can be older than the moment it arrived.
  // That biases the offset by however stale the replay was; the next live
  // broadcast (<=750 ms apart on a healthy bot) must pull it back.
  it('is corrected by the next live snapshot', () => {
    const staleBy = 9 * 60_000;
    setServerClockOffset(SERVER_NOW - staleBy, LOCAL_FAST);
    expect(getServerClockOffset()).toBe(-12 * 3_600_000 - staleBy);

    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    expect(getServerClockOffset()).toBe(-12 * 3_600_000);
    expect(serverNow(LOCAL_FAST)).toBe(SERVER_NOW);
  });
});

describe('subscribeServerClock', () => {
  it('notifies subscribers when the offset actually moves', () => {
    const seen = vi.fn();
    subscribeServerClock(seen);
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stays quiet on jitter and on unusable samples', () => {
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    const seen = vi.fn();
    subscribeServerClock(seen);
    setServerClockOffset(SERVER_NOW + 700, LOCAL_FAST);
    setServerClockOffset(null, LOCAL_FAST);
    expect(seen).not.toHaveBeenCalled();
  });

  it('stops notifying once unsubscribed', () => {
    const seen = vi.fn();
    const off = subscribeServerClock(seen);
    off();
    setServerClockOffset(SERVER_NOW, LOCAL_FAST);
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not let one throwing subscriber starve the others', () => {
    const good = vi.fn();
    subscribeServerClock(() => { throw new Error('panel blew up'); });
    subscribeServerClock(good);
    expect(() => setServerClockOffset(SERVER_NOW, LOCAL_FAST)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
