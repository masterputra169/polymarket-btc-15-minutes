/**
 * AI Post-Trade Analyst — reads trade journal, calls LLM for pattern analysis.
 *
 * Runs periodically (default every 4 hours). Outputs structured recommendations
 * to bot/data/ai_analysis.json for the self-optimizer and dashboard display.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { chatCompletion } from './openrouterClient.js';
import { getJournalAnalytics } from '../trading/journalAnalytics.js';

const log = createLogger('TradeAnalyst');

const ANALYSIS_FILE = resolve(BOT_CONFIG.dataDir, 'ai_analysis.json');

let _lastAnalysis = null;
let _lastAnalyzeMs = 0;
let _analyzing = false;

/** Load cached analysis from disk on startup. */
export function loadAnalysisFromDisk() {
  try {
    if (existsSync(ANALYSIS_FILE)) {
      _lastAnalysis = JSON.parse(readFileSync(ANALYSIS_FILE, 'utf-8'));
      log.info(`Loaded AI analysis from disk (${new Date(_lastAnalysis.analyzedAt).toISOString()})`);
    }
  } catch (err) {
    log.debug(`No cached analysis: ${err.message}`);
  }
}

/** Get the last analysis result (in-memory or disk). */
export function getLastAnalysis() {
  return _lastAnalysis;
}

/**
 * Run trade analysis if enough time has elapsed.
 * Called from bot index.js on interval. Non-blocking.
 */
export async function maybeAnalyze(totalTrades) {
  if (_analyzing) return;
  const now = Date.now();
  if (_lastAnalyzeMs > 0 && (now - _lastAnalyzeMs) < BOT_CONFIG.ai.analyzeIntervalMs) return;

  _analyzing = true;
  try {
    await analyzeRecentTrades({ windowHours: 48, minTrades: 10, totalTrades });
  } catch (err) {
    log.warn(`Analysis failed: ${err.message}`);
  } finally {
    _analyzing = false;
    _lastAnalyzeMs = Date.now();
  }
}

/**
 * Analyze recent trades via LLM.
 */
async function analyzeRecentTrades({ windowHours = 48, minTrades = 10, totalTrades = 0 }) {
  // Get pre-computed analytics
  const analytics = getJournalAnalytics(totalTrades);
  if (!analytics || !analytics.patterns || analytics.patterns.totalTrades < minTrades) {
    log.info(`Not enough trades for analysis (${analytics?.patterns?.totalTrades ?? 0} < ${minTrades})`);
    return;
  }

  // Load recent raw trades for detailed context
  const recentTrades = loadRecentTrades(windowHours);
  if (recentTrades.length < minTrades) {
    log.info(`Not enough recent trades in ${windowHours}h window (${recentTrades.length} < ${minTrades})`);
    return;
  }

  // Build the data summary (token-efficient, not raw JSONL)
  const dataSummary = buildDataSummary(analytics, recentTrades);

  // Build current config summary
  const configSummary = buildConfigSummary();

  const system = `You are a quantitative trading analyst for a Polymarket BTC 15-minute binary prediction bot.
The bot trades UP/DOWN tokens on whether BTC price will be higher or lower after 15 minutes.
Analyze the trade data and provide specific, actionable parameter recommendations.

IMPORTANT:
- Focus on patterns that are statistically significant (n >= 5 trades minimum)
- Only recommend changes with clear evidence from the data
- Be conservative — small improvements compound over hundreds of trades
- Parameters you can recommend: CUT_LOSS_MIN_HOLD_SEC, CUT_LOSS_MIN_TOKEN_DROP_PCT, LIMIT_MIN_ML_CONF, LIMIT_MAX_ENTRY_PRICE, ROUTER_FOK_ML, ROUTER_FOK_MAX_PRICE, MAX_BET_AMOUNT_USD, blackout hours
- Each recommendation needs: parameter name, current value, suggested value, reason, confidence (0-1)

Respond ONLY with valid JSON (no markdown, no code blocks).`;

  const user = `## Current Bot Configuration
${configSummary}

## Trade Data Summary (last ${windowHours}h: ${recentTrades.length} trades, all-time: ${analytics.patterns.totalTrades} trades)

### Overall Stats
- Win Rate: ${analytics.patterns.overallWr}% (${analytics.patterns.totalWins}W / ${analytics.patterns.totalLosses}L)
- Total P&L: $${analytics.patterns.totalPnl}
- Avg Win: $${analytics.patterns.avgPnlWin} (hold ${analytics.patterns.avgHoldWin}s)
- Avg Loss: $${analytics.patterns.avgPnlLoss} (hold ${analytics.patterns.avgHoldLoss}s)
- Win Streak: ${analytics.patterns.longestWinStreak}, Loss Streak: ${analytics.patterns.longestLossStreak}

### Hourly Win Rate (ET, trades >= 3)
${analytics.hourly.filter(h => h.trades >= 3).map(h =>
  `${String(h.hour).padStart(2,'0')}:00 — WR ${h.wr}% (${h.trades}t, PnL $${h.pnl})`
).join('\n')}

### Session Breakdown
${Object.entries(analytics.sessions).map(([k, s]) =>
  `${s.label} (${s.desc}): WR ${s.wr}% (${s.trades}t, PnL $${s.pnl})`
).join('\n')}

### Day of Week
${analytics.dayOfWeek.filter(d => d.trades >= 3).map(d =>
  `${d.day}: WR ${d.wr}% (${d.trades}t, PnL $${d.pnl})`
).join('\n')}

### Recent Trades Detail (last ${Math.min(recentTrades.length, 20)})
${dataSummary}

Provide your analysis as JSON:
{
  "recommendations": [
    { "parameter": "...", "current": ..., "suggested": ..., "reason": "...", "confidence": 0.0-1.0, "category": "cut_loss|entry|sizing|timing|filter" }
  ],
  "summary": "2-3 sentence overview",
  "patterns": ["pattern 1", "pattern 2"],
  "risks": ["risk 1", "risk 2"]
}`;

  log.info(`Calling AI for trade analysis (${recentTrades.length} recent trades, ${analytics.patterns.totalTrades} total)...`);

  const result = await chatCompletion({ system, user, temperature: 0.2, maxTokens: 2000 });
  if (!result || !result.content) {
    log.warn('AI returned empty response');
    return;
  }

  // Parse JSON response
  let parsed;
  try {
    // Strip markdown code blocks if present
    let content = result.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(content);
  } catch (err) {
    log.warn(`Failed to parse AI response as JSON: ${err.message}`);
    // Store raw response as fallback
    parsed = {
      recommendations: [],
      summary: result.content.slice(0, 500),
      patterns: [],
      risks: [],
      parseError: true,
    };
  }

  // Build analysis object
  const analysis = {
    ...parsed,
    analyzedAt: Date.now(),
    tradesAnalyzed: recentTrades.length,
    totalTradesAllTime: analytics.patterns.totalTrades,
    model: result.model,
    tokens: result.usage?.total_tokens ?? 0,
  };

  // Save to memory and disk
  _lastAnalysis = analysis;
  try {
    writeFileSync(ANALYSIS_FILE, JSON.stringify(analysis, null, 2));
    log.info(`AI analysis saved: ${parsed.recommendations?.length ?? 0} recommendations, ${parsed.patterns?.length ?? 0} patterns`);
  } catch (err) {
    log.warn(`Failed to save analysis: ${err.message}`);
  }

  return analysis;
}

// ─────────────── Data Helpers ───────────────

function loadRecentTrades(windowHours) {
  try {
    if (!existsSync(BOT_CONFIG.journalFile)) return [];
    const raw = readFileSync(BOT_CONFIG.journalFile, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - windowHours * 60 * 60 * 1000;
    const trades = [];
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        const outcome = j.analysis?.outcome;
        if (outcome === 'DRY_RUN' || outcome === 'REJECTED') continue;
        if ((j._ts ?? 0) < cutoff) continue;
        trades.push(j);
      } catch { /* skip corrupt */ }
    }
    return trades;
  } catch { return []; }
}

function buildDataSummary(analytics, recentTrades) {
  // Compact per-trade summary (last 20)
  return recentTrades.slice(-20).map(t => {
    const e = t.entry ?? {};
    const a = t.analysis ?? {};
    const side = e.side ?? '?';
    const outcome = a.outcome ?? '?';
    const pnl = a.pnl != null ? (a.pnl >= 0 ? `+${a.pnl.toFixed(2)}` : a.pnl.toFixed(2)) : '?';
    const hold = a.holdDurationSec ?? '?';
    const mlConf = e.mlConfidence != null ? `${(e.mlConfidence * 100).toFixed(0)}%` : '?';
    const price = e.tokenPrice != null ? e.tokenPrice.toFixed(3) : '?';
    const regime = e.regime ?? '?';
    const edge = e.bestEdge != null ? `${(e.bestEdge * 100).toFixed(1)}%` : '?';
    return `${outcome} ${side} @${price} ML:${mlConf} Edge:${edge} Hold:${hold}s PnL:$${pnl} ${regime}`;
  }).join('\n');
}

function buildConfigSummary() {
  const c = BOT_CONFIG;
  return [
    `maxDailyLossPct: ${c.maxDailyLossPct}%`,
    `maxDrawdownPct: ${c.maxDrawdownPct}%`,
    `maxConsecutiveLosses: ${c.maxConsecutiveLosses}`,
    `maxBetAmountUsd: ${c.maxBetAmountUsd}`,
    `cutLoss.minHoldSec: ${c.cutLoss.minHoldSec}`,
    `cutLoss.minTokenDropPct: ${c.cutLoss.minTokenDropPct}`,
    `cutLoss.mlFlipConfidence: ${c.cutLoss.mlFlipConfidence}`,
    `limitOrder.minMlConfidence: ${c.limitOrder.minMlConfidence}`,
    `limitOrder.maxEntryPrice: ${c.limitOrder.maxEntryPrice}`,
    `orderRouter.fokMlThreshold: ${c.orderRouter.fokMlThreshold}`,
    `orderRouter.fokMaxPrice: ${c.orderRouter.fokMaxPrice}`,
  ].join('\n');
}
