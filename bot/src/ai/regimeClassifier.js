/**
 * LLM Regime Classifier — slow-loop advisor for market context.
 *
 * Runs on a ~5-minute cadence (non-blocking, off hot path). Takes a
 * market-context snapshot + sentiment + macro state and asks the LLM:
 *
 *   "What regime are we in? Risk-off? Trending up? Choppy? Risk-on?"
 *
 * Output is structured JSON and feeds the trade filter as an **advisory** layer:
 *   - Shadow mode (default): log only, zero effect on trading.
 *   - Active mode: block entries where signalSide directly fights LLM regime
 *     (e.g. LLM says risk_off, signal says UP, ML < blockMlBypass) — ML ≥ bypass overrides.
 *
 * LLM never triggers entries. Never runs in the hot path. Cost ~$0.001/call
 * with Gemini Flash at 12 calls/hour = ~$0.30/day.
 *
 * Contract:
 *   setContextSnapshot(snapshot)  — loop calls periodically (low cost)
 *   maybeClassify()               — AI interval calls every ~60s (throttled internally)
 *   getLastLLMRegime()            — synchronous read for filters/UI
 *   checkLLMRegimeAdvisory(side)  — filter-oriented decision (block / modify / allow)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { chatCompletion } from './openrouterClient.js';
import { getSentiment } from '../engines/sentimentSignal.js';
import { getMacroStats } from '../monitoring/macroCalendar.js';

const log = createLogger('LLMRegime');

const REGIME_CACHE_FILE = () => resolve(BOT_CONFIG.dataDir, 'llm_regime_current.json');

const VALID_REGIMES = new Set([
  'risk_on', 'risk_off',
  'trending_up', 'trending_down',
  'choppy', 'neutral',
]);

let _snapshot = null;             // latest market context from loop
let _lastSnapshotMs = 0;
let _current = null;              // { regime, confidence, reasoning, signals, classifiedAt }
let _lastClassifyMs = 0;
let _classifying = false;
let _stats = { calls: 0, errors: 0, advisoriesIssued: 0, lastLatencyMs: 0 };

/**
 * Called from index.js on startup. Restores last classification from disk.
 */
export function initLLMRegime() {
  if (!BOT_CONFIG.llmRegime?.enabled) {
    log.info('LLM Regime: disabled (LLM_REGIME_ENABLED=false)');
    return;
  }
  const mode = BOT_CONFIG.llmRegime.shadowMode ? 'SHADOW' : 'ACTIVE';
  log.info(`LLM Regime: enabled [${mode}] interval=${Math.round(BOT_CONFIG.llmRegime.intervalMs / 60_000)}min`);

  try {
    const path = REGIME_CACHE_FILE();
    if (existsSync(path)) {
      _current = JSON.parse(readFileSync(path, 'utf-8'));
      if (_current) {
        const ageMin = Math.round((Date.now() - (_current.classifiedAt ?? 0)) / 60_000);
        log.info(`LLM Regime: restored ${_current.regime} (conf ${_current.confidence}, age ${ageMin}m)`);
      }
    }
  } catch (err) {
    log.debug(`No cached regime: ${err.message}`);
  }
}

/**
 * Called from loop.js each poll (cheap — just stores reference).
 * Snapshot is read asynchronously during maybeClassify().
 */
export function setContextSnapshot(snap) {
  if (!snap) return;
  _snapshot = snap;
  _lastSnapshotMs = Date.now();
}

/**
 * Called from index.js AI interval. Internally throttled — skip if recent.
 */
export async function maybeClassify() {
  if (!BOT_CONFIG.llmRegime?.enabled) return;
  if (_classifying) return;
  if (!_snapshot) return;

  // Stale snapshot guard (> 2 min) → loop may be stuck
  if (Date.now() - _lastSnapshotMs > 2 * 60_000) {
    log.debug(`Snapshot stale (${Math.round((Date.now() - _lastSnapshotMs) / 1000)}s) — skip`);
    return;
  }

  const now = Date.now();
  const interval = BOT_CONFIG.llmRegime.intervalMs ?? 5 * 60_000;
  if (_lastClassifyMs > 0 && (now - _lastClassifyMs) < interval) return;

  _classifying = true;
  try {
    await classify();
  } catch (err) {
    log.warn(`Classify failed: ${err.message}`);
    _stats.errors++;
  } finally {
    _classifying = false;
    _lastClassifyMs = Date.now();
  }
}

/**
 * Synchronous read of current regime (for filters, dashboard).
 */
export function getLastLLMRegime() {
  return _current;
}

/**
 * Returns advisory for current signal side.
 *   null             — no opinion, pass through
 *   { block: true, reason, ... }   — filter should block (ML bypass enforced by caller)
 *   { adjust: {...}, reason }      — sizing hint (future use)
 *
 * Shadow mode returns null so the filter never blocks (but classifications still run).
 */
export function checkLLMRegimeAdvisory(signalSide) {
  if (!BOT_CONFIG.llmRegime?.enabled) return null;
  if (BOT_CONFIG.llmRegime.shadowMode) return null;
  if (!_current) return null;
  if (!signalSide) return null;

  // Skip stale classifications (> 2× interval → likely fetch failure)
  const maxAge = (BOT_CONFIG.llmRegime.intervalMs ?? 5 * 60_000) * 2;
  if (Date.now() - (_current.classifiedAt ?? 0) > maxAge) return null;

  const minConf = BOT_CONFIG.llmRegime.minConfidence ?? 0.70;
  if ((_current.confidence ?? 0) < minConf) return null;

  // Block logic: signal directly fights a high-conviction regime
  const regime = _current.regime;
  let shouldBlock = false;
  let reason = '';

  if (regime === 'risk_off' && signalSide === 'UP') {
    shouldBlock = true;
    reason = `risk_off conf ${(_current.confidence * 100).toFixed(0)}% vs UP signal`;
  } else if (regime === 'trending_down' && signalSide === 'UP') {
    shouldBlock = true;
    reason = `trending_down conf ${(_current.confidence * 100).toFixed(0)}% vs UP signal`;
  } else if (regime === 'trending_up' && signalSide === 'DOWN') {
    shouldBlock = true;
    reason = `trending_up conf ${(_current.confidence * 100).toFixed(0)}% vs DOWN signal`;
  }

  if (shouldBlock) {
    _stats.advisoriesIssued++;
    return {
      block: true,
      reason,
      regime,
      confidence: _current.confidence,
      mlBypassAbove: BOT_CONFIG.llmRegime.blockMlBypass ?? 0.90,
    };
  }

  return null;
}

/**
 * Dashboard stats.
 */
export function getLLMRegimeStats() {
  return {
    enabled: BOT_CONFIG.llmRegime?.enabled ?? false,
    shadowMode: BOT_CONFIG.llmRegime?.shadowMode ?? true,
    ..._stats,
    current: _current ? {
      regime: _current.regime,
      confidence: _current.confidence,
      reasoning: _current.reasoning,
      ageMs: Date.now() - (_current.classifiedAt ?? 0),
    } : null,
  };
}

// ─────────────── Core Classifier ───────────────

async function classify() {
  const snap = _snapshot;
  if (!snap) return;

  const sent = getSentiment();
  const macro = getMacroStats();

  const prompt = buildPrompt(snap, sent, macro);
  const startMs = Date.now();

  _stats.calls++;
  const result = await chatCompletion({
    system: prompt.system,
    user: prompt.user,
    temperature: 0.2,
    maxTokens: BOT_CONFIG.llmRegime.maxTokens ?? 500,
  });

  _stats.lastLatencyMs = Date.now() - startMs;

  if (!result || !result.content) {
    log.warn('LLM returned empty — keeping previous regime');
    return;
  }

  const parsed = parseResponse(result.content);
  if (!parsed) {
    log.warn(`Failed to parse LLM response: ${result.content.slice(0, 200)}`);
    return;
  }

  const classification = {
    ...parsed,
    classifiedAt: Date.now(),
    model: result.model,
    tokens: result.usage?.total_tokens ?? 0,
    snapshotAge: Date.now() - _lastSnapshotMs,
  };

  _current = classification;
  persistCurrent(classification);
  appendAuditLog(classification, snap);

  const mode = BOT_CONFIG.llmRegime.shadowMode ? 'SHADOW' : 'ACTIVE';
  log.info(`LLM Regime [${mode}]: ${classification.regime} conf=${classification.confidence} (${classification.tokens}tok, ${_stats.lastLatencyMs}ms)`);
}

function buildPrompt(snap, sent, macro) {
  const system = `You are a market regime classifier for a Polymarket BTC 15-minute binary prediction bot.
You output a structured regime assessment that is used as an ADVISORY layer — the bot's
existing ML/algorithmic decisions have priority. Your job is to flag macro/sentiment conditions
the algorithmic layer cannot see.

Valid regimes (choose exactly one):
  - risk_on         — bullish, dip-buying active, volatility manageable
  - risk_off        — fear dominant, flight to safety, avoid bullish bets
  - trending_up     — persistent directional BTC strength
  - trending_down   — persistent directional BTC weakness
  - choppy          — range-bound, no clear direction, whipsaw risk
  - neutral         — no strong signal in any direction

Be CONSERVATIVE. When evidence is mixed or weak, answer "neutral" with confidence <0.70.
Only go above 0.80 confidence if multiple independent signals align.

Respond ONLY with valid JSON (no markdown, no code fences). Schema:
{
  "regime": "<one of the valid regimes>",
  "confidence": <0.0-1.0>,
  "reasoning": "<1-2 sentence justification citing specific data>",
  "key_signals": ["signal 1", "signal 2", "signal 3"]
}`;

  const fng = sent?.fng != null ? `${sent.fng} (${sent.classification})` : 'n/a';
  const btcDom = sent?.btcDom != null ? `${sent.btcDom.toFixed(1)}%` : 'n/a';
  const composite = sent?.composite != null ? sent.composite.toFixed(2) : 'n/a';

  const upcoming = (macro?.upcoming ?? []).slice(0, 3)
    .map(e => `  - ${e.currency} ${e.impact} ${e.title} in ${e.minutesUntil}min`)
    .join('\n') || '  (none in next window)';

  const delta1mPct = snap.delta1mPct != null ? `${snap.delta1mPct.toFixed(3)}%` : 'n/a';
  const delta3mPct = snap.delta3mPct != null ? `${snap.delta3mPct.toFixed(3)}%` : 'n/a';

  const user = `## Current Market Context

### BTC Price Action
- Spot: $${snap.btcPrice?.toFixed(0) ?? 'n/a'}
- 1-min delta: ${delta1mPct}
- 3-min delta: ${delta3mPct}
- ATR ratio: ${snap.atrRatio?.toFixed(2) ?? 'n/a'} (vs 1.0 baseline)
- Internal regime (rule-based): ${snap.regime ?? 'n/a'}
- RSI: ${snap.rsi?.toFixed(1) ?? 'n/a'}
- MACD histogram: ${snap.macdHist?.toFixed(2) ?? 'n/a'}
- VWAP distance: ${snap.vwapDist != null ? (snap.vwapDist * 100).toFixed(3) + '%' : 'n/a'}
- EMA cross state: ${snap.emaCross ?? 'n/a'}

### Sentiment
- Crypto Fear & Greed: ${fng}
- BTC Dominance: ${btcDom}
- Composite bias: ${composite} (−1 extreme fear, +1 extreme greed)

### Session / Timing
- US session: ${snap.session ?? 'n/a'}
- ET hour: ${snap.etHour ?? 'n/a'}
- Day of week: ${snap.dayOfWeek ?? 'n/a'}

### Upcoming Macro Events (next window)
${upcoming}

### Recent Trading Performance
- Last 10 trades WR: ${snap.recentWr != null ? (snap.recentWr * 100).toFixed(0) + '%' : 'n/a'}
- Consecutive losses: ${snap.consecutiveLosses ?? 0}

Classify the regime. Remember: be conservative. Prefer "neutral" with low confidence over
overconfident wrong calls.`;

  return { system, user };
}

function parseResponse(raw) {
  let content = (raw ?? '').trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Attempt to extract JSON block from verbose responses
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const regime = String(parsed.regime ?? '').toLowerCase();
  if (!VALID_REGIMES.has(regime)) return null;

  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  return {
    regime,
    confidence: Math.round(confidence * 100) / 100,
    reasoning: String(parsed.reasoning ?? '').slice(0, 500),
    keySignals: Array.isArray(parsed.key_signals)
      ? parsed.key_signals.slice(0, 5).map(s => String(s).slice(0, 200))
      : [],
  };
}

// ─────────────── Persistence ───────────────

function persistCurrent(classification) {
  try {
    _ensureDataDir();
    writeFileSync(REGIME_CACHE_FILE(), JSON.stringify(classification, null, 2));
  } catch (err) {
    log.debug(`Persist regime failed: ${err.message}`);
  }
}

function appendAuditLog(classification, snap) {
  try {
    _ensureDataDir();
    const path = BOT_CONFIG.llmRegime.logFile;
    if (!path) return;
    const row = {
      ...classification,
      _snapshot: {
        btcPrice: snap.btcPrice ?? null,
        regime: snap.regime ?? null,
        session: snap.session ?? null,
        etHour: snap.etHour ?? null,
      },
    };
    appendFileSync(path, JSON.stringify(row) + '\n');
  } catch (err) {
    log.debug(`Audit log append failed: ${err.message}`);
  }
}

function _ensureDataDir() {
  try {
    if (!existsSync(BOT_CONFIG.dataDir)) mkdirSync(BOT_CONFIG.dataDir, { recursive: true });
  } catch { /* best effort */ }
}
