/**
 * Performance monitor — rolling win rate alerts + daily P&L summaries.
 *
 * Read-only: only reads from positionTracker (getStats) and trade journal.
 * Writes daily summaries to bot/data/daily_pnl.jsonl for long-term analysis.
 * Can auto-pause the bot if win rate drops below critical threshold.
 *
 * Lifecycle: startMonitor() / stopMonitor() — called from index.js.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getStats } from '../trading/positionTracker.js';
import { pauseBot } from '../loop.js';
import { notify } from './notifier.js';

const log = createLogger('Monitor');

const MIN_TRADES_FOR_ALERT = 8;

let intervalId = null;
let initialTimeoutId = null;
let lastSummaryDate = null; // 'YYYY-MM-DD' of last written daily summary

// ── Lifecycle ──

export function startMonitor() {
  loadLastSummaryDate();

  // Run first check after a short delay (let other systems initialize)
  initialTimeoutId = setTimeout(() => {
    initialTimeoutId = null;
    monitorCycle();
  }, 5_000);

  intervalId = setInterval(monitorCycle, BOT_CONFIG.monitorIntervalMs);
  log.info(`Performance monitor started (every ${Math.round(BOT_CONFIG.monitorIntervalMs / 60000)} min)`);
}

export function stopMonitor() {
  if (initialTimeoutId) {
    clearTimeout(initialTimeoutId);
    initialTimeoutId = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Performance monitor stopped');
  }
}

// ── Main cycle (every 15 min) ──

function monitorCycle() {
  try {
    checkWinRate();
  } catch (err) {
    log.warn(`Win rate check failed: ${err.message}`);
  }

  try {
    checkDayBoundary();
  } catch (err) {
    log.warn(`Daily summary check failed: ${err.message}`);
  }
}

// ── Win rate alert ──

function checkWinRate() {
  const stats = getStats();
  const total = stats.wins + stats.losses;

  if (total < MIN_TRADES_FOR_ALERT) {
    log.debug(`Win rate check skipped: only ${total} trades (need ${MIN_TRADES_FOR_ALERT})`);
    return;
  }

  const wr = stats.winRate;
  const tag = `${(wr * 100).toFixed(1)}% (${stats.wins}W/${stats.losses}L)`;

  if (wr < BOT_CONFIG.winRatePauseThreshold) {
    log.error(`WIN RATE CRITICAL: ${tag} — below ${(BOT_CONFIG.winRatePauseThreshold * 100).toFixed(0)}% pause threshold. Auto-pausing bot.`);
    pauseBot('perfMonitor: win rate critical');
    notify('critical', `Win rate CRITICAL: ${tag} — bot auto-paused`);
    return;
  }

  if (wr < BOT_CONFIG.winRateWarnThreshold) {
    log.warn(`WIN RATE LOW: ${tag} — below ${(BOT_CONFIG.winRateWarnThreshold * 100).toFixed(0)}% warning threshold`);
    notify('warn', `Win rate LOW: ${tag}`);
  } else {
    log.info(`Win rate: ${tag} — OK`);
  }

  if (stats.consecutiveLosses >= 5) {
    log.warn(`LOSING STREAK: ${stats.consecutiveLosses} consecutive losses`);
  }
}

// ── Day boundary detection ──

function checkDayBoundary() {
  const todayUtc = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

  if (lastSummaryDate === todayUtc) return; // Already written today
  if (lastSummaryDate === null) {
    // First run — set baseline, don't write a summary for an incomplete day
    lastSummaryDate = todayUtc;
    log.info(`Daily summary baseline set: ${todayUtc}`);
    return;
  }

  // Day has changed — write summary for YESTERDAY (not lastSummaryDate, which
  // may already be in the file from a previous run). Only write if yesterday
  // hasn't been summarized yet, preventing duplicates on bot restart.
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  const yesterdayUtc = d.toISOString().slice(0, 10);

  if (yesterdayUtc > lastSummaryDate) {
    writeDailySummary(yesterdayUtc);
  }
  lastSummaryDate = todayUtc;
}

// ── Daily summary ──

function writeDailySummary(dateStr) {
  const stats = getStats();
  const journalEntries = loadJournalEntries(dateStr);
  const auditEntries = loadAuditEntries(dateStr);

  // Compute per-trade stats from journal
  let bestTrade = null;
  let worstTrade = null;
  let totalEdge = 0;
  let edgeCount = 0;
  let totalHoldSec = 0;
  let holdCount = 0;
  let mlCorrect = 0;
  let mlTotal = 0;
  let totalMlConf = 0;
  let mlConfCount = 0;
  const byRegime = {};

  for (const entry of journalEntries) {
    const pnl = entry.analysis?.pnl ?? null;
    const slug = entry.entry?.marketSlug ?? null;

    if (pnl !== null) {
      if (bestTrade === null || pnl > bestTrade.pnl) bestTrade = { pnl, slug };
      if (worstTrade === null || pnl < worstTrade.pnl) worstTrade = { pnl, slug };
    }

    const edge = entry.entry?.bestEdge;
    if (edge != null) { totalEdge += edge; edgeCount++; }

    const holdSec = entry.analysis?.holdDurationSec;
    if (holdSec != null) { totalHoldSec += holdSec; holdCount++; }

    if (entry.analysis?.mlWasRight != null) {
      mlTotal++;
      if (entry.analysis.mlWasRight) mlCorrect++;
    }

    const mlConf = entry.entry?.mlConfidence;
    if (mlConf != null) { totalMlConf += mlConf; mlConfCount++; }

    // Per-regime
    const regime = entry.entry?.regime ?? 'unknown';
    if (!byRegime[regime]) byRegime[regime] = { trades: 0, wins: 0, pnl: 0 };
    byRegime[regime].trades++;
    const outcome = entry.analysis?.outcome;
    if (outcome === 'WIN') byRegime[regime].wins++;
    if (pnl !== null) byRegime[regime].pnl = Math.round((byRegime[regime].pnl + pnl) * 100) / 100;
  }

  // Bankroll start/end from audit log
  const bankrollSnapshots = extractBankrollSnapshots(auditEntries, dateStr);

  const cutLossCount = journalEntries.filter(e => e.analysis?.outcome === 'CUT_LOSS').length;
  const winCount = journalEntries.filter(e => e.analysis?.outcome === 'WIN').length;
  const lossCount = journalEntries.filter(e =>
    e.analysis?.outcome === 'LOSS' || e.analysis?.outcome === 'CUT_LOSS'
  ).length;
  const tradeCount = journalEntries.length;

  const bankrollStart = bankrollSnapshots.start ?? stats.bankroll;
  const bankrollEnd = stats.bankroll;
  const pnl = Math.round((bankrollEnd - bankrollStart) * 100) / 100;
  const pnlPct = bankrollStart > 0 ? Math.round((pnl / bankrollStart) * 1000) / 10 : 0;
  const winRate = tradeCount > 0 ? Math.round((winCount / tradeCount) * 1000) / 1000 : 0;

  const dailyEntry = {
    date: dateStr,
    bankrollStart,
    bankrollEnd,
    pnl,
    pnlPct,
    trades: tradeCount,
    wins: winCount,
    losses: lossCount - cutLossCount,
    cutLosses: cutLossCount,
    winRate,
    avgEdgeTaken: edgeCount > 0 ? Math.round((totalEdge / edgeCount) * 1000) / 1000 : null,
    avgHoldSec: holdCount > 0 ? Math.round(totalHoldSec / holdCount) : null,
    bestTrade,
    worstTrade,
    byRegime,
    mlAccuracy: mlTotal > 0 ? Math.round((mlCorrect / mlTotal) * 100) / 100 : null,
    avgMlConfidence: mlConfCount > 0 ? Math.round((totalMlConf / mlConfCount) * 100) / 100 : null,
    _ts: Date.now(),
  };

  // Write to daily_pnl.jsonl
  try {
    const dir = dirname(BOT_CONFIG.dailyPnlFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(BOT_CONFIG.dailyPnlFile, JSON.stringify(dailyEntry) + '\n');
  } catch (err) {
    log.warn(`Failed to write daily P&L: ${err.message}`);
  }

  // Log summary block
  const regimeStr = Object.entries(byRegime)
    .map(([r, d]) => `${r} ${d.wins}/${d.trades}`)
    .join(' | ');

  log.info('');
  log.info('\u2550'.repeat(50));
  log.info(`  Daily Summary \u2014 ${dateStr}`);
  log.info('\u2550'.repeat(50));
  log.info(`  P&L:        ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
  log.info(`  Bankroll:   $${bankrollStart.toFixed(2)} \u2192 $${bankrollEnd.toFixed(2)}`);
  log.info(`  Trades:     ${tradeCount} (${winCount}W / ${lossCount - cutLossCount}L / ${cutLossCount} cut-loss) \u2014 ${(winRate * 100).toFixed(1)}% win rate`);
  if (bestTrade) log.info(`  Best:       ${bestTrade.pnl >= 0 ? '+' : ''}$${bestTrade.pnl.toFixed(2)} (${bestTrade.slug ?? '?'})`);
  if (worstTrade) log.info(`  Worst:      ${worstTrade.pnl >= 0 ? '+' : ''}$${worstTrade.pnl.toFixed(2)} (${worstTrade.slug ?? '?'})`);
  if (dailyEntry.mlAccuracy != null) log.info(`  ML acc:     ${(dailyEntry.mlAccuracy * 100).toFixed(0)}% | Avg conf: ${((dailyEntry.avgMlConfidence ?? 0) * 100).toFixed(0)}%`);
  if (regimeStr) log.info(`  Regimes:    ${regimeStr}`);
  log.info('\u2550'.repeat(50));
  log.info('');
}

// ── Data loaders ──

/**
 * Load journal entries for a given date from trade_journal.jsonl.
 * Filters by entry timestamp matching the target date (UTC).
 */
function loadJournalEntries(dateStr) {
  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return [];
    const content = readFileSync(BOT_CONFIG.journalFile, 'utf-8').trim();
    if (!content) return [];

    const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(entry => {
      if (!entry) return false;
      const ts = entry._ts ?? entry.entry?.enteredAt ?? 0;
      return ts >= dayStart && ts < dayEnd;
    });
  } catch {
    return [];
  }
}

/**
 * Load audit entries for a given date from state_audit.jsonl.
 */
function loadAuditEntries(dateStr) {
  try {
    const auditPath = BOT_CONFIG.stateFile.replace('.json', '_audit.jsonl');
    if (!existsSync(auditPath)) return [];
    const content = readFileSync(auditPath, 'utf-8').trim();
    if (!content) return [];

    const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(entry => {
      if (!entry) return false;
      return entry._ts >= dayStart && entry._ts < dayEnd;
    });
  } catch {
    return [];
  }
}

/**
 * Extract bankroll start/end from audit entries for a given day.
 * Uses STATE_LOADED or first ENTER as start, last entry as end.
 */
function extractBankrollSnapshots(auditEntries, dateStr) {
  if (auditEntries.length === 0) return { start: null, end: null };

  // Look for STATE_LOADED at day start, otherwise use earliest bankrollAfter
  const stateLoaded = auditEntries.find(e => e.type === 'STATE_LOADED');
  let start = stateLoaded?.bankroll ?? null;

  if (start === null) {
    // Use bankrollAfter from earliest entry that has it
    for (const entry of auditEntries) {
      if (entry.bankrollAfter != null) {
        // For ENTER, bankroll was higher before entry — reconstruct
        if (entry.type === 'ENTER' && entry.cost != null) {
          start = Math.round((entry.bankrollAfter + entry.cost) * 100) / 100;
        } else {
          start = entry.bankrollAfter;
        }
        break;
      }
    }
  }

  // End: last bankrollAfter value of the day
  let end = null;
  for (let i = auditEntries.length - 1; i >= 0; i--) {
    if (auditEntries[i].bankrollAfter != null) {
      end = auditEntries[i].bankrollAfter;
      break;
    }
  }

  return { start, end };
}

/**
 * Load the date of the last written summary from daily_pnl.jsonl.
 */
function loadLastSummaryDate() {
  try {
    if (!existsSync(BOT_CONFIG.dailyPnlFile)) return;
    const content = readFileSync(BOT_CONFIG.dailyPnlFile, 'utf-8').trim();
    if (!content) return;
    const lines = content.split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);
    if (entry.date) {
      lastSummaryDate = entry.date;
      log.info(`Resuming from last daily summary: ${lastSummaryDate}`);
    }
  } catch {
    // Fresh start
  }
}
