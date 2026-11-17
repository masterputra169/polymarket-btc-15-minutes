/**
 * CLOB Taker/Exchange Outage Latch (clob_health pattern from djienne/15m).
 *
 * Read-only probes (`GET /book`, `acceptingOrders`) stay green even while
 * `POST /order` rejects matching orders with `post_only_mode`, HTTP 425
 * ("service not ready"), or HTTP 503 ("service unavailable"). This self-expiring
 * fail-open cooldown latch stops both live order retries and dry-run phantom
 * taker fills during those short matching-engine maintenance windows.
 */

export const DEFAULT_CLOB_OUTAGE_COOLDOWN_MS = 90_000;
export const MAX_CLOB_OUTAGE_COOLDOWN_MS = 120_000;
const MIN_CLOB_OUTAGE_COOLDOWN_MS = 5_000;

const OUTAGE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /post[\s_-]*only[\s_-]*mode/i, reason: 'post_only_mode' },
  { pattern: /service not ready|status[_\s=]*425|\bhttp\s*425\b|\(425\)/i, reason: 'http_425_not_ready' },
  { pattern: /status[_\s=]*503|\bhttp\s*503\b|service unavailable|temporarily unavailable/i, reason: 'http_503_unavailable' },
];

export interface ClobOutageStatus {
  active: boolean;
  reason: string | null;
  untilMs: number;
  remainingMs: number;
  trips: number;
}

let unhealthyUntilMs = 0;
let lastReason: string | null = null;
let tripCount = 0;

/** Extract normalized error text from Error objects, SDK responses, or strings. */
function extractErrorText(errOrMsg: unknown): string {
  if (typeof errOrMsg === 'string') return errOrMsg;
  if (errOrMsg instanceof Error) return errOrMsg.message;
  if (errOrMsg && typeof errOrMsg === 'object') {
    const o = errOrMsg as Record<string, unknown>;
    return [o.errorMsg, o.error, o.message, o.status, o.statusCode]
      .filter(v => v != null && String(v).trim() !== '')
      .map(String)
      .join(' ');
  }
  return '';
}

/** Return matched CLOB outage reason if an order failure indicates matching-engine unavailability. */
export function detectClobOutageReason(errOrMsg: unknown): string | null {
  const text = extractErrorText(errOrMsg);
  if (!text) return null;
  for (const { pattern, reason } of OUTAGE_PATTERNS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

/**
 * Inspect an order-POST failure; if it matches a matching-engine outage,
 * engage the fail-open cooldown latch and return true.
 */
export function recordClobOrderFailure(
  errOrMsg: unknown,
  cooldownMs = DEFAULT_CLOB_OUTAGE_COOLDOWN_MS,
  nowMs = Date.now(),
): { tripped: boolean; reason: string | null; untilMs: number } {
  const reason = detectClobOutageReason(errOrMsg);
  if (!reason) return { tripped: false, reason: null, untilMs: unhealthyUntilMs };

  const clampedMs = Math.max(
    MIN_CLOB_OUTAGE_COOLDOWN_MS,
    Math.min(MAX_CLOB_OUTAGE_COOLDOWN_MS, Number.isFinite(cooldownMs) ? cooldownMs : DEFAULT_CLOB_OUTAGE_COOLDOWN_MS),
  );
  const nextUntil = nowMs + clampedMs;
  unhealthyUntilMs = Math.max(unhealthyUntilMs, nextUntil);
  lastReason = reason;
  tripCount += 1;
  return { tripped: true, reason, untilMs: unhealthyUntilMs };
}

/** Query current latch status (automatically clears on expiry — fail-open). */
export function isClobOutageActive(nowMs = Date.now()): ClobOutageStatus {
  if (unhealthyUntilMs > nowMs) {
    return {
      active: true,
      reason: lastReason,
      untilMs: unhealthyUntilMs,
      remainingMs: unhealthyUntilMs - nowMs,
      trips: tripCount,
    };
  }
  return {
    active: false,
    reason: null,
    untilMs: 0,
    remainingMs: 0,
    trips: tripCount,
  };
}

export function getClobOutageStatus(nowMs = Date.now()): ClobOutageStatus {
  return isClobOutageActive(nowMs);
}

export function clearClobOutageLatch(): void {
  unhealthyUntilMs = 0;
  lastReason = null;
}

export function resetClobOutageStats(): void {
  unhealthyUntilMs = 0;
  lastReason = null;
  tripCount = 0;
}
