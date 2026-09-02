/**
 * Bounded env var parsing helpers.
 * Shared by bot config, runtime services, and scripts — never use raw
 * Number(process.env.X) for numeric env values; use these instead.
 */

/** Parse a number from env with min/max bounds. Returns default if invalid or out of range. */
export function envNum(envVal: string | null | undefined, defaultVal: number, min = -Infinity, max = Infinity): number {
  if (envVal == null) return defaultVal;
  const n = Number(envVal);
  if (!Number.isFinite(n) || n < min || n > max) return defaultVal;
  return n;
}

/** Parse an integer from env with min/max bounds. Returns default if invalid or out of range. */
export function envInt(envVal: string | null | undefined, defaultVal: number, min = 0, max = Infinity): number {
  return Math.round(envNum(envVal, defaultVal, min, max));
}
