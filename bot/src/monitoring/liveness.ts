/**
 * Bot liveness from the PTB health rollups.
 *
 * Measured 2026-09-06 14:39Z → 2026-09-07 02:27Z: the container stayed "Up",
 * the Docker engine answered, and every poll failed on fetch timeouts for
 * 11.8 hours. The watchdog checks "engine up" and "container running" and saw
 * nothing wrong, so the observation period silently collected nothing.
 *
 * ptb_health.jsonl is appended roughly once a minute by a poll that got far
 * enough to evaluate the trade filters (see ptbHealth.ts). Its last `to`
 * timestamp is therefore a cheap heartbeat for "the bot can see the market":
 * if it stops advancing while the container runs, the bot is alive but blind.
 *
 * Pure: takes the file's content, returns a verdict. The CLI wrapper in
 * bot/scripts/botLiveness.mts turns that into an exit code for the watchdog.
 */

export type LivenessStatus = 'fresh' | 'stale' | 'no_data';

export interface Liveness {
  status: LivenessStatus;
  /** `to` of the newest complete rollup, or null when none parsed. */
  lastTo: number | null;
  /** now − lastTo, or null when none parsed. */
  ageMs: number | null;
}

export function assessLiveness(content: string, { now, staleMs }: { now: number; staleMs: number }): Liveness {
  let lastTo: number | null = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rollup = JSON.parse(trimmed);
      const to = Number(rollup?.to);
      if (Number.isFinite(to) && (lastTo == null || to > lastTo)) lastTo = to;
    } catch {
      // torn last line from a write in progress — the previous rollup still counts
    }
  }
  if (lastTo == null) return { status: 'no_data', lastTo: null, ageMs: null };
  const ageMs = now - lastTo;
  return { status: ageMs > staleMs ? 'stale' : 'fresh', lastTo, ageMs };
}
