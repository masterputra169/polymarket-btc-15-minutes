/**
 * Safely parse a CLOB amount field (makingAmount / takingAmount).
 * Returns `fallback` if the value is missing, NaN, negative, or unreasonably large — a malformed
 * response must never reach the bankroll arithmetic. One definition: three copies (loop,
 * tradePipeline, statusServer) had been kept in step by hand.
 */
export function parseClobAmount<T = null>(value: unknown, fallback: T = null as T): number | T {
  if (value == null) return fallback;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return fallback;
  return n;
}
