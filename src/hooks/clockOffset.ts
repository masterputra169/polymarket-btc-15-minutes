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

/**
 * Past this, the browser clock is wrong enough that an operator should be told.
 * Well above the sub-second bias a snapshot's one-way latency introduces.
 */
export const CLOCK_SKEW_WARN_MS = 60_000;

/**
 * Plain-language description of how wrong the browser clock is, or null when
 * it is close enough to ignore.
 *
 * Now that every duration renders on the bot's clock, a wrong PC clock no
 * longer distorts the dashboard — so nothing on screen would betray it either.
 * This is what says it out loud.
 *
 * @param offsetMs - server minus local; positive means the PC is behind
 */
export function formatClockSkew(offsetMs: number, thresholdMs = CLOCK_SKEW_WARN_MS): string | null {
  if (!Number.isFinite(offsetMs)) return null;

  const totalMinutes = Math.round(Math.abs(offsetMs) / 60_000);
  if (Math.abs(offsetMs) < thresholdMs || totalMinutes === 0) return null;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  // A bot clock ahead of the browser means the browser is running slow.
  return `PC clock ${parts.join(' ')} ${offsetMs > 0 ? 'slow' : 'fast'}`;
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
