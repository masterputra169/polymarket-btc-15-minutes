/**
 * Trade journal — comprehensive post-trade analysis logging.
 *
 * Captures a full snapshot of ALL indicators, ML state, regime, and decision
 * context at entry AND exit for every trade, enabling post-mortem analysis.
 *
 * Output: bot/data/trade_journal.jsonl (append-only, one JSON object per line)
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { notify } from '../monitoring/notifier.js';
import { getBankroll } from './positionTracker.js';

const log = createLogger('Journal');

// In-memory entry snapshot (stored between entry and exit)
let entrySnapshot = null;

// Cache of recent journal entries (avoids re-reading file on every broadcast)
let recentCache = null;

// ── Daily trade counter (resets at midnight ET) ──
let _dailyDate = null;   // 'YYYY-MM-DD' of current tracking day (ET)
let _dailyCount = 0;     // trades today
let _dailyWins = 0;
let _dailyPnl = 0;
let _dailySummaryTimer = null;

const MAX_MARKETS_PER_DAY = 96; // 24h × 4 markets/hour (15-min markets)

/** Get today's date string in ET timezone (America/New_York, DST-aware). */
function getTodayET() {
  // H6 FIX: Use Intl API for proper DST handling (EDT=UTC-4, EST=UTC-5).
  // Previously used hardcoded -5h offset which was wrong during EDT (April-November).
  // en-CA locale formats as YYYY-MM-DD which matches our logging format.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Reset daily counters for a new trading day. */
function resetDailyCounters() {
  _dailyDate = getTodayET();
  _dailyCount = 0;
  _dailyWins = 0;
  _dailyPnl = 0;
}

/** Increment daily counters after a real trade settles. */
function incrementDailyCounters(outcome, pnl) {
  const today = getTodayET();
  if (_dailyDate !== today) resetDailyCounters();
  _dailyCount++;
  if (outcome === 'WIN' || outcome === 'TAKE_PROFIT') _dailyWins++;
  _dailyPnl += pnl ?? 0;
}

/** Send the daily trade summary to Telegram (called at midnight ET). */
export async function sendDailySummary() {
  const date = _dailyDate ?? getTodayET();
  const count = _dailyCount;
  const wins = _dailyWins;
  const losses = count - wins;
  const pnl = _dailyPnl;
  const wrPct = count > 0 ? Math.round(wins / count * 100) : 0;
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

  const lines = [
    `📊 <b>Daily Trade Summary</b> — ${date}`,
    ``,
    `📈 Trades: <b>${count}/${MAX_MARKETS_PER_DAY}</b> markets`,
    `✅ Wins: ${wins}   ❌ Losses: ${losses}   WR: ${wrPct}%`,
    `💰 P&amp;L Today: <b>${pnlStr}</b>`,
  ];

  await notify('info', lines.join('\n'), { key: `daily_summary:${date}` });
  log.info(`Daily summary sent: ${count}/${MAX_MARKETS_PER_DAY} trades, WR=${wrPct}%, P&L=${pnlStr}`);

  // Reset for the new day
  resetDailyCounters();
}

/**
 * Schedule daily summary to fire at midnight ET every day.
 * Called once from index.js on startup.
 */
export function scheduleDailySummary() {
  function msUntilMidnightET() {
    const now = Date.now();
    // Midnight ET = next 05:00 UTC (UTC-5, approximate, ignoring DST)
    const nowUTC = new Date(now);
    const nextMidnightET = new Date(nowUTC);
    nextMidnightET.setUTCHours(5, 0, 0, 0);
    if (nextMidnightET.getTime() <= now) {
      nextMidnightET.setUTCDate(nextMidnightET.getUTCDate() + 1);
    }
    return nextMidnightET.getTime() - now;
  }

  function scheduleNext() {
    const ms = msUntilMidnightET();
    log.info(`Daily summary scheduled in ${Math.round(ms / 60000)}min`);
    _dailySummaryTimer = setTimeout(async () => {
      await sendDailySummary();
      scheduleNext(); // re-schedule for next midnight
    }, ms);
  }

  scheduleNext();
}

/** Stop daily summary scheduler (called on shutdown). */
export function stopDailySummary() {
  if (_dailySummaryTimer) { clearTimeout(_dailySummaryTimer); _dailySummaryTimer = null; }
}

/**
 * RC1 Fix: Load entry snapshot from disk if it exists (survives bot restarts).
 * Called at startup (index.js) and lazily from writeJournalEntry.
 */
export function loadEntrySnapshotFromDisk() {
  try {
    if (!BOT_CONFIG.entrySnapshotFile || !existsSync(BOT_CONFIG.entrySnapshotFile)) return false;
    const raw = readFileSync(BOT_CONFIG.entrySnapshotFile, 'utf-8');
    const snap = JSON.parse(raw);
    if (snap && snap.side && snap.marketSlug) {
      entrySnapshot = snap;
      log.info(`[RC1] Entry snapshot restored from disk: ${snap.side} on ${snap.marketSlug} (entered ${new Date(snap.enteredAt).toISOString()})`);
      return true;
    }
  } catch (err) {
    log.debug(`[RC1] No entry snapshot to restore: ${err.message}`);
  }
  return false;
}

/**
 * Capture a full snapshot at trade entry. Stored in-memory AND on disk until settlement.
 */
export function captureEntrySnapshot(data) {
  entrySnapshot = {
    ...data,
    enteredAt: Date.now(),
  };
  // RC1 Fix: persist to disk — survives bot restarts
  try {
    const dir = dirname(BOT_CONFIG.entrySnapshotFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BOT_CONFIG.entrySnapshotFile, JSON.stringify(entrySnapshot));
  } catch (err) {
    log.warn(`[RC1] Failed to persist entry snapshot: ${err.message}`);
  }
  log.debug(`Entry snapshot captured: ${data.side} @ BTC $${data.btcPrice?.toFixed(0)}`);
}

/**
 * Write a complete journal entry (entry + exit + analysis) to JSONL file.
 * Skipped in DRY_RUN mode. Sends Telegram alert for every real trade.
 */
export function writeJournalEntry({ outcome, pnl, exitData }) {
  // RC1 Fix: if in-memory snapshot was lost (bot restart), try loading from disk
  if (!entrySnapshot) {
    loadEntrySnapshotFromDisk();
  }
  if (!entrySnapshot) {
    log.debug('No entry snapshot — skipping journal write');
    return;
  }

  // DRY_RUN: skip file write and Telegram — no real trade happened
  if (BOT_CONFIG.dryRun) {
    log.debug(`DRY RUN — journal skipped (${outcome})`);
    entrySnapshot = null;
    return;
  }

  const exit = {
    ...exitData,
    exitedAt: Date.now(),
  };

  const analysis = computeAnalysis(entrySnapshot, exit, outcome, pnl);

  const record = {
    entry: entrySnapshot,
    exit,
    analysis,
    _ts: Date.now(),
  };

  try {
    const dir = dirname(BOT_CONFIG.journalFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(BOT_CONFIG.journalFile, JSON.stringify(record) + '\n');
    log.info(
      `Journal: ${outcome} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl?.toFixed(2) ?? '?'} | ` +
      `${entrySnapshot.side} | edge=${((entrySnapshot.bestEdge ?? 0) * 100).toFixed(1)}%`
    );
  } catch (err) {
    log.warn(`Journal write failed: ${err.message}`);
  }

  // Update cache
  if (recentCache === null) recentCache = [];
  recentCache.unshift(record);
  if (recentCache.length > 20) recentCache.length = 20;

  // Update daily counters
  incrementDailyCounters(outcome, pnl ?? 0);

  // ── Telegram trade alert ──
  _sendTradeAlert(record).catch(() => {});

  // Clear entry snapshot after writing
  entrySnapshot = null;
}

/** Build and send a Telegram alert for a completed trade. */
async function _sendTradeAlert(record) {
  const { entry, analysis } = record;
  const outcome = analysis.outcome ?? 'UNKNOWN';
  const pnl = analysis.pnl ?? 0;
  const side = entry?.side ?? '?';
  const btcEntry = entry?.btcPrice;
  const tokenEntry = entry?.tokenPrice;
  const edge = entry?.bestEdge;
  const mlConf = entry?.mlConfidence;
  const holdSec = analysis?.holdDurationSec;
  const meBoost = entry?.meBoost === true;

  // Outcome emoji
  const isWin = outcome === 'WIN' || outcome === 'TAKE_PROFIT';
  const isNeutral = outcome === 'DRY_RUN' || outcome === 'UNWIND' || outcome === 'REJECTED';
  const emoji = isWin ? '✅' : isNeutral ? '➖' : '❌';

  const outcomeLabel = {
    WIN: 'WIN', LOSS: 'LOSS', TAKE_PROFIT: 'TAKE PROFIT',
    CUT_LOSS: 'CUT LOSS', EMERGENCY_CUT: 'EMERGENCY CUT',
    SMART_SELL_FIRST: 'SMART SELL', UNWIND: 'UNWIND', REJECTED: 'REJECTED',
  }[outcome] ?? outcome;

  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  const holdText = holdSec != null
    ? holdSec < 60 ? `${holdSec}s`
    : `${Math.floor(holdSec / 60)}m ${holdSec % 60}s`
    : '-';

  // Current bankroll after settlement
  let bankrollStr = null;
  try {
    const br = getBankroll();
    if (br != null && br > 0) bankrollStr = `$${br.toFixed(2)}`;
  } catch (_) { /* non-critical */ }

  // Daily progress
  const today = getTodayET();
  if (_dailyDate !== today) resetDailyCounters();
  const todayStr = `${_dailyCount}/${MAX_MARKETS_PER_DAY}`;

  const lines = [
    `${emoji} <b>${outcomeLabel}</b> | ${side === 'UP' ? '↑ UP' : '↓ DOWN'}${meBoost ? ' 🧠 ME↑' : ''}`,
    ``,
    `💰 P&amp;L: <b>${pnlStr}</b>`,
    bankrollStr != null ? `🏦 Bankroll: <b>${bankrollStr}</b>` : null,
    btcEntry != null ? `₿ BTC Entry: $${btcEntry.toFixed(0)}` : null,
    tokenEntry != null ? `🎯 Token: @${tokenEntry.toFixed(3)}c` : null,
    `⏱ Hold: ${holdText}`,
    edge != null ? `📐 Edge: ${(edge * 100).toFixed(1)}%` : null,
    mlConf != null ? `🤖 ML: ${(mlConf * 100).toFixed(0)}%` : null,
    ``,
    `📊 Today: <b>${todayStr}</b> trades`,
  ].filter(Boolean);

  await notify('info', lines.join('\n'), { key: `trade:journal:${record._ts}` });
}

/**
 * Clear entry snapshot without writing (e.g. position unwound, no settlement).
 */
export function clearEntrySnapshot() {
  entrySnapshot = null;
  // RC1 Fix: delete disk file too
  try {
    if (BOT_CONFIG.entrySnapshotFile && existsSync(BOT_CONFIG.entrySnapshotFile)) {
      unlinkSync(BOT_CONFIG.entrySnapshotFile);
    }
  } catch (err) {
    log.debug(`[RC1] Entry snapshot file cleanup failed: ${err.message}`);
  }
}

/**
 * Get the last N journal entries for dashboard display.
 * Uses in-memory cache; loads from disk only on first call.
 */
export function getRecentJournal(n = 5) {
  if (recentCache !== null) return recentCache.slice(0, n);

  // Load from disk on first call
  try {
    if (!existsSync(BOT_CONFIG.journalFile)) { recentCache = []; return []; }
    const lines = readFileSync(BOT_CONFIG.journalFile, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    recentCache = lines.slice(-20).map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean).reverse(); // Most recent first

    return recentCache.slice(0, n);
  } catch {
    recentCache = [];
    return [];
  }
}

/**
 * Compute derived analysis fields from entry + exit snapshots.
 */
function computeAnalysis(entry, exit, outcome, pnl) {
  const a = { outcome, pnl };

  // Hold duration (clamped to [0, 86400] to guard against clock skew)
  if (entry.enteredAt && exit.exitedAt) {
    const raw = Math.round((exit.exitedAt - entry.enteredAt) / 1000);
    a.holdDurationSec = Math.max(0, Math.min(raw, 86400));
  }

  // Price movements
  if (entry.btcPrice && exit.btcPrice) {
    a.btcMovePct = ((exit.btcPrice - entry.btcPrice) / entry.btcPrice) * 100;
  }
  if (entry.tokenPrice && exit.tokenPrice) {
    a.tokenMovePct = ((exit.tokenPrice - entry.tokenPrice) / entry.tokenPrice) * 100;
  }
  if (exit.btcPrice && exit.priceToBeat) {
    a.btcVsPtb = exit.btcPrice - exit.priceToBeat;
  }

  // Was the model right?
  const actualOutcome = exit.btcPrice && exit.priceToBeat
    ? (exit.btcPrice >= exit.priceToBeat ? 'UP' : 'DOWN')
    : null;

  if (actualOutcome) {
    a.actualOutcome = actualOutcome;
    if (entry.mlSide) a.mlWasRight = entry.mlSide === actualOutcome;
    if (entry.ruleUp != null) {
      const ruleSide = entry.ruleUp >= 0.5 ? 'UP' : 'DOWN';
      a.ruleWasRight = ruleSide === actualOutcome;
    }
    a.edgeWasReal = outcome === 'WIN';
  }

  // Regime analysis
  if (entry.regime && exit.regime) {
    a.regimeChanged = entry.regime !== exit.regime;
    a.entryRegime = entry.regime;
    a.exitRegime = exit.regime;
  }

  // Cut-loss specifics
  if (outcome === 'CUT_LOSS') {
    if (exit.cutLossDropPct != null) a.cutLossDropPct = exit.cutLossDropPct;
    if (exit.cutLossRecovered != null) a.cutLossRecovered = exit.cutLossRecovered;
    if (entry.cost != null && pnl != null) {
      a.cutLossSaved = entry.cost - Math.abs(pnl);
    }
  }

  return a;
}
