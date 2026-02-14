/**
 * Trade journal — comprehensive post-trade analysis logging.
 *
 * Captures a full snapshot of ALL indicators, ML state, regime, and decision
 * context at entry AND exit for every trade, enabling post-mortem analysis.
 *
 * Output: bot/data/trade_journal.jsonl (append-only, one JSON object per line)
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Journal');

// In-memory entry snapshot (stored between entry and exit)
let entrySnapshot = null;

// Cache of recent journal entries (avoids re-reading file on every broadcast)
let recentCache = null;

/**
 * Capture a full snapshot at trade entry. Stored in-memory until settlement.
 */
export function captureEntrySnapshot(data) {
  entrySnapshot = {
    ...data,
    enteredAt: Date.now(),
  };
  log.debug(`Entry snapshot captured: ${data.side} @ BTC $${data.btcPrice?.toFixed(0)}`);
}

/**
 * Write a complete journal entry (entry + exit + analysis) to JSONL file.
 * Called at settlement time with the outcome and exit data.
 */
export function writeJournalEntry({ outcome, pnl, exitData }) {
  if (!entrySnapshot) {
    log.debug('No entry snapshot — skipping journal write');
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

  // Clear entry snapshot after writing
  entrySnapshot = null;
}

/**
 * Clear entry snapshot without writing (e.g. position unwound, no settlement).
 */
export function clearEntrySnapshot() {
  entrySnapshot = null;
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

  // Hold duration
  if (entry.enteredAt && exit.exitedAt) {
    a.holdDurationSec = Math.round((exit.exitedAt - entry.enteredAt) / 1000);
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
