/**
 * Server-clock correction for client-side countdowns.
 *
 * The bot stamps every broadcast with `ts` (its own Date.now()). The browser
 * clock can be wrong (2026-09-08: an operator PC was 36 min slow and the
 * dashboard showed ~37 min left on a 15-minute market), so countdowns must
 * be computed against `Date.now() + offset` rather than the raw local clock.
 */

/** Server time minus local time, in ms. 0 when the server stamp is unusable. */
export function computeClockOffsetMs(serverTs: unknown, localNowMs: number): number {
  if (typeof serverTs !== 'number' || !Number.isFinite(serverTs)) return 0;
  return serverTs - localNowMs;
}

/** Minutes until `targetMs` on the server-corrected clock, clamped at 0. */
export function remainingMinutes(
  targetMs: number | null | undefined,
  localNowMs: number,
  offsetMs: number,
): number | null {
  if (targetMs == null) return null;
  const correctedNow = localNowMs + offsetMs;
  return Math.max(0, (targetMs - correctedNow) / 60_000);
}
