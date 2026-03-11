/**
 * Execution Timing — micro-timing optimizer for order entry.
 *
 * Analyzes short-term conditions to determine optimal entry moment:
 * - Spread narrowing detection (wait for tighter spread)
 * - BTC momentum alignment (enter when BTC confirms direction)
 * - Volume surge detection (liquidity window)
 * - Time urgency override (don't wait too long)
 *
 * Returns: { action, reason, spreadTrend, momentumAligned, volumeSurge }
 * Actions: EXECUTE_NOW, WAIT_NARROWING, WAIT_MOMENTUM, EXECUTE_URGENT
 */

import { createLogger } from '../logger.js';

const log = createLogger('ExecTiming');

// Ring buffers for spread and volume tracking
const SPREAD_BUF_SIZE = 20;
const VOLUME_BUF_SIZE = 10;

const spreadBuf = new Float64Array(SPREAD_BUF_SIZE);
const volumeBuf = new Float64Array(VOLUME_BUF_SIZE);
let spreadIdx = 0, spreadCount = 0;
let volumeIdx = 0, volumeCount = 0;

// State
let _lastDecision = null;
let _waitingSince = 0;
const MAX_WAIT_MS = 8_000; // max 8s wait for better entry

/**
 * Record a spread observation.
 */
export function recordSpreadTick(spread) {
  if (!Number.isFinite(spread) || spread <= 0) return;
  spreadBuf[spreadIdx] = spread;
  spreadIdx = (spreadIdx + 1) % SPREAD_BUF_SIZE;
  if (spreadCount < SPREAD_BUF_SIZE) spreadCount++;
}

/**
 * Record a volume observation.
 */
export function recordVolumeTick(volume) {
  if (!Number.isFinite(volume) || volume < 0) return;
  volumeBuf[volumeIdx] = volume;
  volumeIdx = (volumeIdx + 1) % VOLUME_BUF_SIZE;
  if (volumeCount < VOLUME_BUF_SIZE) volumeCount++;
}

/**
 * Evaluate execution timing.
 *
 * @param {{ spread, delta1m, signalSide, timeLeftMin, btcPrice, prevBtcPrice }} ctx
 * @returns {{ action: string, reason: string, spreadTrend: string, momentumAligned: boolean, volumeSurge: boolean }}
 */
export function evaluateExecutionTiming({
  spread,
  delta1m,
  signalSide,
  timeLeftMin,
  btcPrice,
  prevBtcPrice,
}) {
  const now = Date.now();

  // Time urgency: if < 3 minutes left, execute immediately
  if (timeLeftMin != null && timeLeftMin < 3) {
    _lastDecision = { action: 'EXECUTE_URGENT', reason: `${timeLeftMin.toFixed(1)}min left — no time to wait`, ts: now };
    _waitingSince = 0;
    return buildResult('EXECUTE_URGENT', _lastDecision.reason);
  }

  // Max wait exceeded
  if (_waitingSince > 0 && (now - _waitingSince) > MAX_WAIT_MS) {
    _lastDecision = { action: 'EXECUTE_NOW', reason: `max wait ${MAX_WAIT_MS}ms exceeded`, ts: now };
    _waitingSince = 0;
    return buildResult('EXECUTE_NOW', _lastDecision.reason);
  }

  // 1. Spread narrowing detection
  const spreadTrend = detectSpreadTrend(spread);

  // 2. Momentum alignment
  const momentumAligned = checkMomentumAlignment(delta1m, signalSide, btcPrice, prevBtcPrice);

  // 3. Volume surge
  const volumeSurge = detectVolumeSurge();

  // Decision logic
  if (spreadTrend === 'narrowing' && !momentumAligned) {
    if (_waitingSince === 0) _waitingSince = now;
    _lastDecision = { action: 'WAIT_NARROWING', reason: 'spread narrowing, wait for momentum', ts: now };
    return buildResult('WAIT_NARROWING', _lastDecision.reason, spreadTrend, momentumAligned, volumeSurge);
  }

  if (!momentumAligned && spreadTrend !== 'wide') {
    if (_waitingSince === 0) _waitingSince = now;
    _lastDecision = { action: 'WAIT_MOMENTUM', reason: 'BTC not yet confirming signal direction', ts: now };
    return buildResult('WAIT_MOMENTUM', _lastDecision.reason, spreadTrend, momentumAligned, volumeSurge);
  }

  // All clear — execute
  _waitingSince = 0;
  const reasons = [];
  if (momentumAligned) reasons.push('momentum aligned');
  if (volumeSurge) reasons.push('volume surge');
  if (spreadTrend === 'narrow') reasons.push('tight spread');

  _lastDecision = {
    action: 'EXECUTE_NOW',
    reason: reasons.length > 0 ? reasons.join(' + ') : 'conditions met',
    ts: now,
  };
  return buildResult('EXECUTE_NOW', _lastDecision.reason, spreadTrend, momentumAligned, volumeSurge);
}

/**
 * Get execution timing status for dashboard.
 */
export function getExecutionTimingStatus() {
  return _lastDecision ? {
    action: _lastDecision.action,
    reason: _lastDecision.reason,
    waitingMs: _waitingSince > 0 ? Date.now() - _waitingSince : 0,
  } : { action: 'IDLE', reason: 'no evaluation', waitingMs: 0 };
}

/**
 * Get current spread trend from ring buffer.
 * Exported for use by limitOrderManager momentum gate.
 *
 * @param {number} currentSpread - Current spread value
 * @returns {'narrowing'|'narrow'|'wide'|'stable'|'unknown'}
 */
export function getSpreadTrend(currentSpread) {
  return detectSpreadTrend(currentSpread);
}

/**
 * Reset timing state (on market switch or settlement).
 */
export function resetExecutionTiming() {
  spreadIdx = 0; spreadCount = 0;
  volumeIdx = 0; volumeCount = 0;
  _lastDecision = null;
  _waitingSince = 0;
}

// ─────────────── Helpers ───────────────

function buildResult(action, reason, spreadTrend = 'unknown', momentumAligned = false, volumeSurge = false) {
  return { action, reason, spreadTrend, momentumAligned, volumeSurge };
}

function detectSpreadTrend(currentSpread) {
  if (spreadCount < 5 || !Number.isFinite(currentSpread)) return 'unknown';

  // Compare recent 5 vs older 5
  const recentStart = (spreadIdx - Math.min(5, spreadCount) + SPREAD_BUF_SIZE) % SPREAD_BUF_SIZE;
  const olderStart = (spreadIdx - Math.min(10, spreadCount) + SPREAD_BUF_SIZE) % SPREAD_BUF_SIZE;

  let recentSum = 0, olderSum = 0;
  const recentN = Math.min(5, spreadCount);
  const olderN = Math.min(5, Math.max(0, spreadCount - 5));

  for (let i = 0; i < recentN; i++) {
    recentSum += spreadBuf[(recentStart + i) % SPREAD_BUF_SIZE];
  }
  if (olderN > 0) {
    for (let i = 0; i < olderN; i++) {
      olderSum += spreadBuf[(olderStart + i) % SPREAD_BUF_SIZE];
    }
  } else {
    return currentSpread < 0.03 ? 'narrow' : 'wide';
  }

  const recentAvg = recentSum / recentN;
  const olderAvg = olderSum / olderN;

  if (recentAvg < olderAvg * 0.85) return 'narrowing';
  if (currentSpread < 0.03) return 'narrow';
  if (currentSpread > 0.06) return 'wide';
  return 'stable';
}

function checkMomentumAlignment(delta1m, signalSide, btcPrice, prevBtcPrice) {
  if (delta1m == null || signalSide == null) return true; // no data = assume aligned

  // BTC momentum should confirm signal direction
  if (signalSide === 'UP' && delta1m > 0) return true;
  if (signalSide === 'DOWN' && delta1m < 0) return true;

  // Check absolute BTC price movement if delta1m is near zero
  if (Math.abs(delta1m) < 10 && btcPrice != null && prevBtcPrice != null) {
    const priceDelta = btcPrice - prevBtcPrice;
    if (signalSide === 'UP' && priceDelta >= 0) return true;
    if (signalSide === 'DOWN' && priceDelta <= 0) return true;
  }

  return false;
}

function detectVolumeSurge() {
  if (volumeCount < 5) return false;

  // Recent volume vs baseline
  const recentN = Math.min(3, volumeCount);
  const olderN = Math.min(5, Math.max(0, volumeCount - 3));
  if (olderN === 0) return false;

  let recentSum = 0, olderSum = 0;
  const recentStart = (volumeIdx - recentN + VOLUME_BUF_SIZE) % VOLUME_BUF_SIZE;
  const olderStart = (volumeIdx - recentN - olderN + VOLUME_BUF_SIZE) % VOLUME_BUF_SIZE;

  for (let i = 0; i < recentN; i++) {
    recentSum += volumeBuf[(recentStart + i) % VOLUME_BUF_SIZE];
  }
  for (let i = 0; i < olderN; i++) {
    olderSum += volumeBuf[(olderStart + i) % VOLUME_BUF_SIZE];
  }

  const recentAvg = recentSum / recentN;
  const olderAvg = olderSum / olderN;

  // Volume surge = recent > 1.5× baseline
  return olderAvg > 0 && recentAvg > olderAvg * 1.5;
}
