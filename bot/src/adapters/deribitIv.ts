/**
 * Lightweight zero-auth Deribit BTC DVOL (30-day forward-looking implied volatility index) adapter.
 *
 * Concept adapted from djienne/POLYMARKET_UP_DOWN_DERIBIT_STRATEGY_15m:
 * combines Deribit options implied volatility with short-window realized volatility
 * to detect regime under/over-pricing in binary 15m option probabilities.
 *
 * Total & non-blocking: refreshes in the background at most once per 60s and never throws.
 */

const DERIBIT_DVOL_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const POLL_INTERVAL_MS = 60_000;
const STALE_MS = 300_000;
const FETCH_TIMEOUT_MS = 4_000;
const SECONDS_PER_YEAR = 365.25 * 86_400;

export interface DeribitIvSnapshot {
  /** Annualized DVOL percentage, e.g. 52.4 means 52.4% IV. */
  dvolPct: number | null;
  /** Dollar-per-second implied volatility scaled by spot price: btcPrice * (dvolPct / 100) / sqrt(365.25 * 86400). */
  sigmaPerSec: number | null;
  updatedAt: number | null;
  source: 'deribit_dvol' | 'none';
}

let _dvolPct: number | null = null;
let _updatedAt: number | null = null;
let _lastAttemptAt = 0;
let _inFlight: Promise<void> | null = null;

async function fetchDvolOnce(now: number): Promise<void> {
  const start = Math.max(0, now - 180_000);
  const url = `${DERIBIT_DVOL_URL}?currency=BTC&resolution=60&start_timestamp=${start}&end_timestamp=${now}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return;
    const json = await res.json() as { result?: { data?: unknown[][] } };
    const rows = json?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const last = rows[rows.length - 1];
    if (!Array.isArray(last) || last.length < 5) return;
    const close = Number(last[4]);
    if (Number.isFinite(close) && close > 5 && close < 300) {
      _dvolPct = close;
      _updatedAt = Date.now();
    }
  } catch {
    // Non-blocking background adapter: keep last valid snapshot or null until next refresh window.
  }
}

/**
 * Trigger an asynchronous background refresh of Deribit BTC DVOL at most once per 60s.
 * Can be disabled with DERIBIT_IV_ENABLED=false. Never throws.
 */
export function refreshDeribitIv(now = Date.now()): void {
  if (process.env.DERIBIT_IV_ENABLED === 'false') return;
  if (_inFlight) return;
  if (now - _lastAttemptAt < POLL_INTERVAL_MS) return;
  _lastAttemptAt = now;
  _inFlight = fetchDvolOnce(now).finally(() => {
    _inFlight = null;
  });
}

/**
 * Pure snapshot getter. Returns cached DVOL & spot-scaled sigmaPerSec ($/sec) if fresh (< 5m old).
 */
export function getDeribitIvSnapshot(btcPrice: number | null, now = Date.now()): DeribitIvSnapshot {
  if (
    _dvolPct == null ||
    _updatedAt == null ||
    !Number.isFinite(_dvolPct) ||
    now - _updatedAt > STALE_MS
  ) {
    return {
      dvolPct: null,
      sigmaPerSec: null,
      updatedAt: _updatedAt,
      source: 'none',
    };
  }
  const sigmaPerSec =
    btcPrice != null && Number.isFinite(btcPrice) && btcPrice > 0
      ? (btcPrice * (_dvolPct / 100)) / Math.sqrt(SECONDS_PER_YEAR)
      : null;
  return {
    dvolPct: _dvolPct,
    sigmaPerSec,
    updatedAt: _updatedAt,
    source: 'deribit_dvol',
  };
}

/** Deterministic helper for unit tests. */
export function setDeribitIvForTest(dvolPct: number | null, updatedAt: number | null = Date.now()): void {
  _dvolPct = dvolPct;
  _updatedAt = dvolPct == null ? null : updatedAt;
  _lastAttemptAt = updatedAt ?? 0;
}
