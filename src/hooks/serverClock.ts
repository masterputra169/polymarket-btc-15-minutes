/**
 * Shared server-clock offset for the dashboard.
 *
 * Every panel that shows a duration mixes a bot timestamp (`settlementMs`,
 * `enteredAt`, `placedAt`, `data.ts`) with the browser clock. When the browser
 * clock is wrong, every one of those readings is wrong by the same amount:
 *   - 2026-09-08 an operator PC ran 36 min slow  -> a 15-minute market showed ~37 min left
 *   - 2026-09-09 the same PC ran 12 h fast       -> every countdown pinned at 0, ages read "43200s ago"
 *
 * The bot stamps each broadcast with `ts`, so the browser can learn how far its
 * own clock is off and subtract that everywhere. `useBotData` feeds this module
 * on every snapshot; panels read `serverNow()` instead of `Date.now()`.
 *
 * Known bound: `statusServer` replays `lastSnapshot` verbatim to each new
 * client, and the offset absorbs however stale that replay was — under a
 * second on a healthy bot (750 ms broadcast throttle), longer against a
 * stalled one, in which case the data age briefly under-reports until the
 * next live snapshot corrects it. The OFFLINE badge, not this offset, is what
 * tells an operator the bot stopped.
 *
 * Kept free of React so it stays a plain, directly testable module.
 */
import { computeClockOffsetMs } from './clockOffset.ts';

/**
 * Below this, a change is snapshot jitter rather than clock drift.
 *
 * The bot throttles broadcasts to 750 ms and the client flushes every 500 ms,
 * so consecutive samples land up to ~1.3 s apart through no fault of either
 * clock. Re-applying that jitter would make the countdown stutter, so only a
 * genuine drift moves the offset.
 */
export const OFFSET_APPLY_TOLERANCE_MS = 2_000;

let offsetMs = 0;
let hasSample = false;
const listeners = new Set<() => void>();

/**
 * Learn the offset from a snapshot's server timestamp.
 *
 * A snapshot without a usable `ts` leaves the last known offset alone — losing
 * it would silently hand the dashboard back to the wrong browser clock.
 *
 * @param serverTs - `ts` from the bot snapshot (server Date.now())
 * @param localNowMs - browser clock at the moment the snapshot was parsed
 * @returns the offset now in effect
 */
export function setServerClockOffset(serverTs: unknown, localNowMs: number = Date.now()): number {
  if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) return offsetMs;

  const next = computeClockOffsetMs(serverTs, localNowMs);
  if (hasSample && Math.abs(next - offsetMs) < OFFSET_APPLY_TOLERANCE_MS) return offsetMs;

  offsetMs = next;
  hasSample = true;
  notify();
  return offsetMs;
}

/** Server time minus browser time, in ms. 0 until the first snapshot lands. */
export function getServerClockOffset(): number {
  return offsetMs;
}

/** The bot's clock, as best the browser can tell. Drop-in for `Date.now()`. */
export function serverNow(localNowMs: number = Date.now()): number {
  return localNowMs + offsetMs;
}

/**
 * Subscribe to offset changes so a panel can re-render the moment the browser
 * learns its clock is wrong, instead of waiting for its own tick.
 *
 * @returns unsubscribe function
 */
export function subscribeServerClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: forget the learned offset and every subscriber. */
export function resetServerClock(): void {
  offsetMs = 0;
  hasSample = false;
  listeners.clear();
}

function notify(): void {
  for (const listener of listeners) {
    // One panel throwing must not stop the rest from learning the new offset.
    try { listener(); } catch { /* a subscriber's own problem */ }
  }
}
