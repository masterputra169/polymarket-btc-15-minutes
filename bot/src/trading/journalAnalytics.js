/**
 * Journal Time-Series Analytics — computes hourly/session/daily breakdowns,
 * equity curve, event timeline, and pattern detection from trade journals.
 *
 * Cached in-memory; recomputes only when trade count changes.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('JournalAnalytics');

// Cache
let _cache = null;
let _lastTradeCount = -1;
let _lastComputeMs = 0;
let _lastJournalMtimeMs = 0;   // track file modification time
let _lastAuditMtimeMs = 0;
const RECOMPUTE_INTERVAL_MS = 15_000; // throttle recompute to max every 15s

// Session definitions (ET hours)
const SESSIONS = {
  asia:   { label: 'Asia',   hours: [21, 22, 23, 0, 1, 2, 3],       desc: '21:00–04:00 ET' },
  europe: { label: 'Europe', hours: [4, 5, 6, 7, 8],                 desc: '04:00–09:00 ET' },
  us:     { label: 'US',     hours: [9, 10, 11, 12, 13, 14, 15],     desc: '09:00–16:00 ET' },
  off:    { label: 'Off',    hours: [16, 17, 18, 19, 20],             desc: '16:00–21:00 ET' },
};

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Get cached analytics, recompute if stale.
 * @param {number} currentTradeCount — from positionTracker stats
 */
export function getJournalAnalytics(currentTradeCount) {
  const now = Date.now();

  // Throttle: don't recompute more often than every 15s
  if (_cache && (now - _lastComputeMs) < RECOMPUTE_INTERVAL_MS) return _cache;

  // Check if data actually changed (trade count OR file modification time)
  const journalMtime = _safeFileMtime(BOT_CONFIG.journalFile);
  const auditFile = BOT_CONFIG.stateFile.replace('state.json', 'state_audit.jsonl');
  const auditMtime = _safeFileMtime(auditFile);

  const dataChanged =
    !_cache ||
    currentTradeCount !== _lastTradeCount ||
    journalMtime !== _lastJournalMtimeMs ||
    auditMtime !== _lastAuditMtimeMs;

  if (!dataChanged) return _cache;

  try {
    _cache = computeAnalytics();
    _lastTradeCount = currentTradeCount;
    _lastComputeMs = now;
    _lastJournalMtimeMs = journalMtime;
    _lastAuditMtimeMs = auditMtime;
  } catch (err) {
    log.warn(`Analytics computation failed: ${err.message}`);
    if (!_cache) _cache = emptyAnalytics();
  }

  return _cache;
}

/** Get file mtime in ms, 0 if not found. */
function _safeFileMtime(filePath) {
  try {
    return existsSync(filePath) ? statSync(filePath).mtimeMs : 0;
  } catch { return 0; }
}

/** Force recompute on next call. */
export function invalidateAnalyticsCache() {
  _lastTradeCount = -1;
}

function emptyAnalytics() {
  return {
    hourly: Array.from({ length: 24 }, (_, h) => ({ hour: h, trades: 0, wins: 0, losses: 0, pnl: 0, wr: 0 })),
    sessions: Object.fromEntries(Object.entries(SESSIONS).map(([k, v]) => [k, { ...v, trades: 0, wins: 0, losses: 0, pnl: 0, wr: 0 }])),
    dayOfWeek: DOW_NAMES.map(d => ({ day: d, trades: 0, wins: 0, losses: 0, pnl: 0, wr: 0 })),
    equityCurve: [],
    events: [],
    patterns: { totalTrades: 0, totalPnl: 0, overallWr: 0 },
    computedAt: Date.now(),
  };
}

/**
 * Parse all journal files and compute full analytics.
 */
function computeAnalytics() {
  const trades = loadTradeJournal();
  const verifiedTrades = loadVerifiedJournal();
  const auditEvents = loadStateAudit();

  // Filter to real trades only (exclude DRY_RUN, REJECTED, UNWIND without PnL)
  const journalReal = trades.filter(t => {
    const outcome = t.analysis?.outcome;
    return outcome && outcome !== 'DRY_RUN' && outcome !== 'REJECTED';
  });

  // Build verified PnL lookup (marketSlug → on-chain netPnl)
  // Verified journal has on-chain confirmed PnL which is more accurate than local estimates.
  const verifiedPnlMap = new Map();
  for (const v of verifiedTrades) {
    const slug = v.entry?.marketSlug;
    if (slug && v.analysis?.pnl != null) {
      verifiedPnlMap.set(slug, v.analysis.pnl);
    }
  }

  // Override journal PnL with verified on-chain PnL where available
  let verifiedOverrides = 0;
  for (const t of journalReal) {
    const slug = t.entry?.marketSlug;
    if (slug && verifiedPnlMap.has(slug) && t.analysis) {
      const onChainPnl = verifiedPnlMap.get(slug);
      if (Math.abs((t.analysis.pnl ?? 0) - onChainPnl) > 0.01) {
        t.analysis._localPnl = t.analysis.pnl; // preserve original estimate
        t.analysis.pnl = onChainPnl;
        // Fix outcome if local said LOSS but on-chain was WIN (or vice versa)
        if (onChainPnl > 0 && t.analysis.outcome === 'LOSS') {
          t.analysis._localOutcome = t.analysis.outcome;
          t.analysis.outcome = 'WIN';
        } else if (onChainPnl < 0 && t.analysis.outcome === 'WIN') {
          t.analysis._localOutcome = t.analysis.outcome;
          t.analysis.outcome = 'LOSS';
        }
        verifiedOverrides++;
      }
    }
  }
  if (verifiedOverrides > 0) {
    log.info(`PnL corrected from verified journal: ${verifiedOverrides} trades updated`);
  }

  // Merge verified trades that aren't already in journal (by marketSlug + side)
  const journalKeys = new Set(journalReal.map(t =>
    `${t.entry?.marketSlug ?? ''}_${t.entry?.side ?? ''}`
  ));
  const uniqueVerified = verifiedTrades.filter(v =>
    !journalKeys.has(`${v.entry?.marketSlug ?? ''}_${v.entry?.side ?? ''}`)
  );

  const realTrades = [...journalReal, ...uniqueVerified];

  // ── 1. Hourly breakdown ──
  const hourly = computeHourly(realTrades);

  // ── 2. Session breakdown ──
  const sessions = computeSessions(realTrades);

  // ── 3. Day-of-week breakdown ──
  const dayOfWeek = computeDayOfWeek(realTrades);

  // ── 4. Equity curve ──
  const equityCurve = computeEquityCurve(realTrades, auditEvents);

  // ── 5. Event timeline ──
  const events = computeEventTimeline(realTrades, auditEvents);

  // ── 6. Pattern detection ──
  const patterns = computePatterns(realTrades, hourly, sessions, dayOfWeek);

  // ── 7. Actual PnL from audit trail (bankroll-based, reflects on-chain reality) ──
  const actualPnl = computeActualPnlFromAudit(auditEvents);

  return {
    hourly,
    sessions,
    dayOfWeek,
    equityCurve,
    events,
    patterns,
    actualPnl,
    sources: {
      journal: journalReal.length,
      verified: uniqueVerified.length,
      verifiedOverrides,
      total: realTrades.length,
    },
    computedAt: Date.now(),
  };
}

// ─────────────── Data Loading ───────────────

function loadTradeJournal() {
  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return [];
    const raw = readFileSync(BOT_CONFIG.journalFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip corrupt lines */ }
    }
    return entries;
  } catch (err) {
    log.debug(`Failed to load trade journal: ${err.message}`);
    return [];
  }
}

/**
 * Load verified journal and convert to trade_journal format for merging.
 * Verified journal has on-chain confirmed trades that may be missing from trade_journal.
 */
function loadVerifiedJournal() {
  try {
    if (!existsSync(BOT_CONFIG.verifiedJournalFile)) return [];
    const raw = readFileSync(BOT_CONFIG.verifiedJournalFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try {
        const v = JSON.parse(line);
        // Only include resolved entries with known PnL
        if (!v.outcome || v.netPnl == null) continue;
        const firstTrade = v.trades?.[0];
        if (!firstTrade) continue;
        // Convert to trade_journal-compatible format
        entries.push({
          entry: {
            side: firstTrade.tokenSide ?? 'UP',
            tokenPrice: firstTrade.price ?? 0,
            btcPrice: null,
            priceToBeat: null,
            marketSlug: v.marketSlug,
            cost: v.totalCost ?? 0,
            size: v.netPosition ?? 0,
            enteredAt: firstTrade.matchTime ? parseInt(firstTrade.matchTime) * 1000 : v.marketTime,
          },
          analysis: {
            outcome: v.netPnl > 0 ? 'WIN' : 'LOSS',
            pnl: v.netPnl,
            holdDurationSec: null,
          },
          _ts: v._fetchedAt ?? v.marketTime,
          _source: 'verified',
        });
      } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  }
}

function loadStateAudit() {
  const auditFile = BOT_CONFIG.stateFile.replace('state.json', 'state_audit.jsonl');
  try {
    if (!existsSync(auditFile)) return [];
    const raw = readFileSync(auditFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─────────────── Time Helpers ───────────────

/** Get hour (0-23) in ET timezone from a timestamp. */
function getETHour(tsMs) {
  const d = new Date(tsMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', hour12: false,
  }).formatToParts(d);
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  return h === 24 ? 0 : h;
}

/** Get day-of-week (0=Sun..6=Sat) in ET timezone. */
function getETDow(tsMs) {
  const d = new Date(tsMs);
  const str = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(d);
  return DOW_NAMES.indexOf(str);
}

/** Get session key from ET hour. */
function getSession(etHour) {
  for (const [key, sess] of Object.entries(SESSIONS)) {
    if (sess.hours.includes(etHour)) return key;
  }
  return 'off';
}

/**
 * Compute actual PnL from audit trail — reflects on-chain reality (USDC syncs, settlements).
 * More accurate than journal PnL which uses local settlement estimates.
 */
function computeActualPnlFromAudit(auditEvents) {
  if (auditEvents.length === 0) return null;

  // Find earliest and latest bankroll from meaningful events
  let firstBankroll = null;
  let firstTs = null;
  let lastBankroll = null;
  let lastTs = null;
  let settleCount = 0;
  let settlePnlSum = 0;
  let cutLossCount = 0;
  let cutLossPnlSum = 0;

  for (const ev of auditEvents) {
    if (ev.bankrollAfter == null || ev._ts == null) continue;

    if (firstBankroll === null) {
      firstBankroll = ev.bankrollAfter;
      firstTs = ev._ts;
    }
    lastBankroll = ev.bankrollAfter;
    lastTs = ev._ts;

    if (ev.type === 'SETTLE' && ev.pnl != null) {
      settleCount++;
      settlePnlSum += ev.pnl;
    }
    if (ev.type === 'CUT_LOSS' && ev.pnl != null) {
      cutLossCount++;
      cutLossPnlSum += ev.pnl;
    }
  }

  if (firstBankroll === null || lastBankroll === null) return null;

  return {
    firstBankroll: roundMoney(firstBankroll),
    lastBankroll: roundMoney(lastBankroll),
    bankrollChange: roundMoney(lastBankroll - firstBankroll),
    firstTs,
    lastTs,
    settlePnl: roundMoney(settlePnlSum),
    settleCount,
    cutLossPnl: roundMoney(cutLossPnlSum),
    cutLossCount,
  };
}

/** Check if a trade is a "win". */
function isWin(outcome) {
  return outcome === 'WIN' || outcome === 'TAKE_PROFIT';
}

function isLoss(outcome) {
  return outcome === 'LOSS' || outcome === 'CUT_LOSS' || outcome === 'EMERGENCY_CUT' ||
    outcome === 'SMART_SELL_FIRST' || outcome === 'PHANTOM_LOSS';
}

function roundPct(v) { return Math.round(v * 10) / 10; }
function roundMoney(v) { return Math.round(v * 100) / 100; }

// ─────────────── Computation ───────────────

function computeHourly(trades) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({
    hour: h, trades: 0, wins: 0, losses: 0, pnl: 0,
  }));

  for (const t of trades) {
    const ts = t.entry?.enteredAt ?? t._ts;
    if (!ts) continue;
    const h = getETHour(ts);
    const outcome = t.analysis?.outcome;
    const pnl = t.analysis?.pnl ?? 0;
    buckets[h].trades++;
    if (isWin(outcome)) buckets[h].wins++;
    if (isLoss(outcome)) buckets[h].losses++;
    buckets[h].pnl = roundMoney(buckets[h].pnl + pnl);
  }

  for (const b of buckets) {
    b.wr = b.trades > 0 ? roundPct((b.wins / b.trades) * 100) : 0;
  }
  return buckets;
}

function computeSessions(trades) {
  const result = {};
  for (const [key, sess] of Object.entries(SESSIONS)) {
    result[key] = { label: sess.label, desc: sess.desc, trades: 0, wins: 0, losses: 0, pnl: 0 };
  }

  for (const t of trades) {
    const ts = t.entry?.enteredAt ?? t._ts;
    if (!ts) continue;
    const h = getETHour(ts);
    const sess = getSession(h);
    const outcome = t.analysis?.outcome;
    const pnl = t.analysis?.pnl ?? 0;
    result[sess].trades++;
    if (isWin(outcome)) result[sess].wins++;
    if (isLoss(outcome)) result[sess].losses++;
    result[sess].pnl = roundMoney(result[sess].pnl + pnl);
  }

  for (const s of Object.values(result)) {
    s.wr = s.trades > 0 ? roundPct((s.wins / s.trades) * 100) : 0;
  }
  return result;
}

function computeDayOfWeek(trades) {
  const buckets = DOW_NAMES.map(d => ({ day: d, trades: 0, wins: 0, losses: 0, pnl: 0 }));

  for (const t of trades) {
    const ts = t.entry?.enteredAt ?? t._ts;
    if (!ts) continue;
    const dow = getETDow(ts);
    if (dow < 0) continue;
    const outcome = t.analysis?.outcome;
    const pnl = t.analysis?.pnl ?? 0;
    buckets[dow].trades++;
    if (isWin(outcome)) buckets[dow].wins++;
    if (isLoss(outcome)) buckets[dow].losses++;
    buckets[dow].pnl = roundMoney(buckets[dow].pnl + pnl);
  }

  for (const b of buckets) {
    b.wr = b.trades > 0 ? roundPct((b.wins / b.trades) * 100) : 0;
  }
  return buckets;
}

function computeEquityCurve(trades, auditEvents) {
  const points = [];

  // From audit: bankroll changes with type SETTLE, CUT_LOSS, SET_BANKROLL, etc.
  for (const ev of auditEvents) {
    if (ev.bankrollAfter != null && ev._ts) {
      const type = ev.type ?? 'UNKNOWN';
      // Only track meaningful events (not every fill/status)
      if (['SETTLE', 'CUT_LOSS', 'TAKE_PROFIT', 'EMERGENCY_CUT', 'SMART_SELL_FIRST',
        'SET_BANKROLL', 'STATE_LOADED', 'CB_COOLDOWN_RESET', 'RECONCILE_ADJUST'].includes(type)) {
        points.push({
          ts: ev._ts,
          bankroll: roundMoney(ev.bankrollAfter),
          type,
        });
      }
    }
  }

  // Supplement from trade journal if audit is sparse
  if (points.length < 10) {
    for (const t of trades) {
      const outcome = t.analysis?.outcome;
      const pnl = t.analysis?.pnl;
      if (outcome && pnl != null && t._ts) {
        // We don't have bankrollAfter in journal, so accumulate from first known
        points.push({ ts: t._ts, pnl: roundMoney(pnl), type: outcome });
      }
    }
  }

  // Sort by time, deduplicate close timestamps, limit to 500 points
  points.sort((a, b) => a.ts - b.ts);

  // If too many, sample evenly
  if (points.length > 500) {
    const step = Math.ceil(points.length / 500);
    const sampled = [];
    for (let i = 0; i < points.length; i += step) {
      sampled.push(points[i]);
    }
    // Always include the last point
    if (sampled[sampled.length - 1] !== points[points.length - 1]) {
      sampled.push(points[points.length - 1]);
    }
    return sampled;
  }

  return points;
}

function computeEventTimeline(trades, auditEvents) {
  const events = [];

  // From trades: ENTER, WIN, LOSS, CUT_LOSS, etc.
  for (const t of trades) {
    const ts = t._ts ?? t.entry?.enteredAt;
    const outcome = t.analysis?.outcome;
    if (!ts || !outcome) continue;

    events.push({
      ts,
      type: outcome,
      side: t.entry?.side ?? '?',
      pnl: t.analysis?.pnl != null ? roundMoney(t.analysis.pnl) : null,
      tokenPrice: t.entry?.tokenPrice,
      btcPrice: t.entry?.btcPrice,
      marketSlug: t.entry?.marketSlug,
      holdSec: t.analysis?.holdDurationSec,
      mlConf: t.entry?.mlConfidence != null ? roundPct(t.entry.mlConfidence * 100) : null,
      edge: t.entry?.bestEdge != null ? roundPct(t.entry.bestEdge * 100) : null,
      regime: t.entry?.regime,
    });
  }

  // From audit: circuit breakers, bankroll resets, deposits
  for (const ev of auditEvents) {
    if (!ev._ts || !ev.type) continue;
    if (['CB_COOLDOWN_RESET', 'SET_BANKROLL', 'RECONCILE_ADJUST', 'CONSEC_LOSS_RESET'].includes(ev.type)) {
      events.push({
        ts: ev._ts,
        type: ev.type,
        side: null,
        pnl: null,
        details: ev.type === 'SET_BANKROLL'
          ? `$${ev.prev?.toFixed(2)} → $${ev.next?.toFixed(2)} (${ev.source})`
          : ev.type === 'CB_COOLDOWN_RESET'
            ? `Peak $${ev.prevPeak?.toFixed(2)} → $${ev.nextPeak?.toFixed(2)}`
            : ev.reason ?? '',
      });
    }
  }

  // Sort descending (newest first), limit to 200
  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, 200);
}

function computePatterns(trades, hourly, sessions, dayOfWeek) {
  if (trades.length === 0) {
    return { totalTrades: 0, totalPnl: 0, overallWr: 0 };
  }

  const totalTrades = trades.length;
  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  let winPnlSum = 0;
  let lossPnlSum = 0;
  let winHoldSum = 0;
  let lossHoldSum = 0;
  let winCount = 0;
  let lossCount = 0;

  // Streak tracking
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  // Sort trades by time for streak calc
  const sorted = [...trades].sort((a, b) => (a._ts ?? 0) - (b._ts ?? 0));

  for (const t of sorted) {
    const outcome = t.analysis?.outcome;
    const pnl = t.analysis?.pnl ?? 0;
    const hold = t.analysis?.holdDurationSec;
    totalPnl += pnl;

    if (isWin(outcome)) {
      totalWins++;
      winPnlSum += pnl;
      winCount++;
      if (hold != null) winHoldSum += hold;
      currentWinStreak++;
      currentLossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
    } else if (isLoss(outcome)) {
      totalLosses++;
      lossPnlSum += pnl;
      lossCount++;
      if (hold != null) lossHoldSum += hold;
      currentLossStreak++;
      currentWinStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, currentLossStreak);
    }
  }

  // Best/worst hour (min 3 trades)
  const validHours = hourly.filter(h => h.trades >= 3);
  const bestHour = validHours.length > 0
    ? validHours.reduce((a, b) => a.wr > b.wr ? a : b)
    : null;
  const worstHour = validHours.length > 0
    ? validHours.reduce((a, b) => a.wr < b.wr ? a : b)
    : null;

  // Best/worst session (min 3 trades)
  const sessArr = Object.entries(sessions).map(([k, v]) => ({ key: k, ...v }));
  const validSess = sessArr.filter(s => s.trades >= 3);
  const bestSession = validSess.length > 0
    ? validSess.reduce((a, b) => a.wr > b.wr ? a : b)
    : null;
  const worstSession = validSess.length > 0
    ? validSess.reduce((a, b) => a.wr < b.wr ? a : b)
    : null;

  // Best/worst day-of-week (min 3 trades)
  const validDow = dayOfWeek.filter(d => d.trades >= 3);
  const bestDow = validDow.length > 0
    ? validDow.reduce((a, b) => a.wr > b.wr ? a : b)
    : null;
  const worstDow = validDow.length > 0
    ? validDow.reduce((a, b) => a.wr < b.wr ? a : b)
    : null;

  // Current streak
  const currentStreak = currentWinStreak > 0
    ? { type: 'win', count: currentWinStreak }
    : { type: 'loss', count: currentLossStreak };

  return {
    totalTrades,
    totalWins,
    totalLosses,
    totalPnl: roundMoney(totalPnl),
    overallWr: roundPct((totalWins / totalTrades) * 100),

    avgPnlWin: winCount > 0 ? roundMoney(winPnlSum / winCount) : 0,
    avgPnlLoss: lossCount > 0 ? roundMoney(lossPnlSum / lossCount) : 0,
    avgHoldWin: winCount > 0 ? Math.round(winHoldSum / winCount) : 0,
    avgHoldLoss: lossCount > 0 ? Math.round(lossHoldSum / lossCount) : 0,

    longestWinStreak,
    longestLossStreak,
    currentStreak,

    bestHour: bestHour ? { hour: bestHour.hour, wr: bestHour.wr, pnl: bestHour.pnl, trades: bestHour.trades } : null,
    worstHour: worstHour ? { hour: worstHour.hour, wr: worstHour.wr, pnl: worstHour.pnl, trades: worstHour.trades } : null,
    bestSession: bestSession ? { key: bestSession.key, label: bestSession.label, wr: bestSession.wr, pnl: bestSession.pnl } : null,
    worstSession: worstSession ? { key: worstSession.key, label: worstSession.label, wr: worstSession.wr, pnl: worstSession.pnl } : null,
    bestDow: bestDow ? { day: bestDow.day, wr: bestDow.wr, pnl: bestDow.pnl, trades: bestDow.trades } : null,
    worstDow: worstDow ? { day: worstDow.day, wr: worstDow.wr, pnl: worstDow.pnl, trades: worstDow.trades } : null,
  };
}
