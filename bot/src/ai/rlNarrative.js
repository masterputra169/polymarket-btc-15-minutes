/**
 * RL Narrative Generator — LLM analysis of RL agent behavior.
 *
 * Reads rl_trace.jsonl (outcome records) + trade_journal.jsonl (rlScalar entries)
 * to compute action distribution, outcome correlation, and per-action reward stats.
 *
 * Calls OpenRouter to produce a plain-text narrative explaining what the
 * contextual bandit is learning — surfaced in daily summary, dashboard, Telegram.
 *
 * Exports:
 *   loadRLNarrativeFromDisk()  — load cache on startup
 *   getLastRLNarrative()       — get cached result (summary + stats)
 *   maybeGenerateRLNarrative() — throttled auto-call (every 8h, min 20 outcomes)
 *   generateRLNarrative()      — force immediate generation
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { chatCompletion } from './openrouterClient.js';

const log = createLogger('RLNarrative');

const NARRATIVE_FILE = resolve(BOT_CONFIG.dataDir, 'rl_narrative.json');
const NARRATIVE_INTERVAL_MS = 8 * 60 * 60 * 1000;  // Every 8 hours
const MIN_OUTCOMES = 20;                              // Min outcome records to generate narrative

const RL_ACTIONS = [0.5, 0.75, 1.0, 1.25, 1.5];

let _lastNarrative = null;
let _lastGenerateMs = 0;
let _generating = false;

// ── Public API ──

/** Load last narrative from disk on bot startup. */
export function loadRLNarrativeFromDisk() {
  try {
    if (existsSync(NARRATIVE_FILE)) {
      _lastNarrative = JSON.parse(readFileSync(NARRATIVE_FILE, 'utf-8'));
      log.info(`Loaded RL narrative from disk (${new Date(_lastNarrative.generatedAt).toISOString()})`);
    }
  } catch (err) {
    log.debug(`No cached RL narrative: ${err.message}`);
  }
}

/** Get last cached narrative (in-memory or loaded from disk). */
export function getLastRLNarrative() {
  return _lastNarrative;
}

/**
 * Generate RL narrative if enough time has elapsed and data is available.
 * Called from index.js AI interval. Non-blocking.
 */
export async function maybeGenerateRLNarrative() {
  if (_generating) return;
  if (!BOT_CONFIG.rl?.enabled || !BOT_CONFIG.ai?.enabled) return;
  const now = Date.now();
  if (_lastGenerateMs > 0 && (now - _lastGenerateMs) < NARRATIVE_INTERVAL_MS) return;

  _generating = true;
  try {
    await generateRLNarrative();
  } catch (err) {
    log.warn(`RL narrative failed: ${err.message}`);
  } finally {
    _generating = false;
    _lastGenerateMs = Date.now();
  }
}

/**
 * Force-generate RL narrative immediately.
 * Called from perfMonitor.js writeDailySummary() (fire-and-forget).
 * @returns {Promise<Object|null>} narrative object or null if insufficient data
 */
export async function generateRLNarrative() {
  const outcomes = loadOutcomes();
  if (outcomes.length < MIN_OUTCOMES) {
    log.info(`Not enough RL outcomes (${outcomes.length} < ${MIN_OUTCOMES}) — skipping narrative`);
    return null;
  }

  const journalEntries = loadJournalWithRL();
  const stats = computeRLStats(outcomes, journalEntries);

  const system = `You are a quantitative analyst reviewing a contextual bandit RL agent that adjusts bet sizing for a Polymarket binary prediction trading bot.
The agent picks from sizing multipliers [0.5, 0.75, 1.0, 1.25, 1.5] applied to the Kelly base bet.
Currently in shadow mode — observing but not yet changing real bet sizes.
Analyze the data and write exactly 3-4 sentences covering:
1. What sizing the agent currently favors and in what conditions
2. Whether scale-up vs scale-down choices correlate with better outcomes
3. One concrete insight: is the agent adding value or needs retraining?
Be direct and quantitative. No preamble or hedging.`;

  const user = buildPrompt(stats, outcomes.length, journalEntries.length);

  log.info(`Generating RL narrative (${outcomes.length} outcomes, ${journalEntries.length} journal entries)...`);

  const result = await chatCompletion({ system, user, temperature: 0.25, maxTokens: 350 });
  if (!result?.content) {
    log.warn('RL narrative: empty LLM response');
    return null;
  }

  const narrative = {
    summary: result.content.trim(),
    stats,
    generatedAt: Date.now(),
    outcomesAnalyzed: outcomes.length,
    journalEntriesAnalyzed: journalEntries.length,
    model: result.model,
  };

  _lastNarrative = narrative;
  try {
    writeFileSync(NARRATIVE_FILE, JSON.stringify(narrative, null, 2));
    log.info(`RL narrative saved: "${narrative.summary.slice(0, 100)}..."`);
  } catch (err) {
    log.warn(`Failed to save RL narrative: ${err.message}`);
  }

  return narrative;
}

// ── Data loaders ──

function loadOutcomes() {
  try {
    if (!BOT_CONFIG.rl?.traceFile || !existsSync(BOT_CONFIG.rl.traceFile)) return [];
    const content = readFileSync(BOT_CONFIG.rl.traceFile, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(e => e?.type === 'outcome' && e.rlActionIdx != null && Number.isFinite(e.pnl));
  } catch { return []; }
}

function loadJournalWithRL() {
  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return [];
    const content = readFileSync(BOT_CONFIG.journalFile, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(e => {
      if (!e) return false;
      const outcome = e.analysis?.outcome;
      return e.entry?.rlScalar != null && outcome && outcome !== 'DRY_RUN' && outcome !== 'REJECTED';
    });
  } catch { return []; }
}

// ── Stats computation ──

function computeRLStats(outcomes, journalEntries) {
  const byAction = RL_ACTIONS.map((scalar, idx) => ({
    scalar, idx, count: 0, wins: 0, totalReward: 0, totalPnl: 0,
  }));

  for (const o of outcomes) {
    const a = byAction[o.rlActionIdx];
    if (!a) continue;
    a.count++;
    if (o.won) a.wins++;
    a.totalReward += (o.reward ?? 0);
    a.totalPnl += (o.pnl ?? 0);
  }

  // Scaling correlation from journal (win rate per scale direction)
  let upWin = 0, upLoss = 0, downWin = 0, downLoss = 0, neutralWin = 0, neutralLoss = 0;
  for (const e of journalEntries) {
    const scalar = e.entry.rlScalar;
    const isWin = e.analysis.outcome === 'WIN';
    const isLoss = e.analysis.outcome === 'LOSS' || e.analysis.outcome === 'CUT_LOSS';
    if (scalar > 1.0) {
      if (isWin) upWin++; if (isLoss) upLoss++;
    } else if (scalar < 1.0) {
      if (isWin) downWin++; if (isLoss) downLoss++;
    } else {
      if (isWin) neutralWin++; if (isLoss) neutralLoss++;
    }
  }

  const total = outcomes.length;
  const overallWins = outcomes.filter(o => o.won).length;

  return {
    total,
    overallWr: total > 0 ? Math.round(overallWins / total * 100) : 0,
    byAction: byAction.map(a => ({
      scalar: a.scalar,
      count: a.count,
      pct: total > 0 ? Math.round(a.count / total * 100) : 0,
      wr: a.count > 0 ? Math.round(a.wins / a.count * 100) : null,
      avgReward: a.count > 0 ? +(a.totalReward / a.count).toFixed(3) : null,
      avgPnl: a.count > 0 ? +(a.totalPnl / a.count).toFixed(2) : null,
    })),
    correlation: {
      scaleUp:   { win: upWin,      loss: upLoss,      total: upWin + upLoss,      wr: (upWin + upLoss) > 0      ? Math.round(upWin      / (upWin + upLoss)      * 100) : null },
      scaleDown: { win: downWin,    loss: downLoss,    total: downWin + downLoss,  wr: (downWin + downLoss) > 0  ? Math.round(downWin    / (downWin + downLoss)  * 100) : null },
      neutral:   { win: neutralWin, loss: neutralLoss, total: neutralWin + neutralLoss, wr: (neutralWin + neutralLoss) > 0 ? Math.round(neutralWin / (neutralWin + neutralLoss) * 100) : null },
    },
  };
}

function buildPrompt(stats, outcomeCount, journalCount) {
  const actionRows = stats.byAction
    .filter(a => a.count > 0)
    .map(a => `  x${a.scalar}: ${a.count} trades (${a.pct}%), WR ${a.wr ?? '?'}%, avg PnL $${a.avgPnl ?? '?'}, avg reward ${a.avgReward ?? '?'}`)
    .join('\n');

  const { scaleUp, scaleDown, neutral } = stats.correlation;
  const corrRows = [
    scaleUp.total   > 0 ? `  Scale-up (x>1.0):   ${scaleUp.win}W/${scaleUp.loss}L, WR ${scaleUp.wr}%` : null,
    scaleDown.total > 0 ? `  Scale-down (x<1.0): ${scaleDown.win}W/${scaleDown.loss}L, WR ${scaleDown.wr}%` : null,
    neutral.total   > 0 ? `  Neutral (x1.0):     ${neutral.win}W/${neutral.loss}L, WR ${neutral.wr}%` : null,
  ].filter(Boolean).join('\n');

  return `RL trace outcomes: ${outcomeCount} | Journal entries with RL scalar: ${journalCount}
Overall WR: ${stats.overallWr}%

Action distribution (settled trades):
${actionRows || '  (no data yet)'}

Scaling vs outcome (from journal):
${corrRows || '  (no data yet)'}`;
}
