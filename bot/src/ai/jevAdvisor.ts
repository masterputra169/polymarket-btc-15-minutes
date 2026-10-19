/**
 * JEV decision advisor - TypeSafe System One model (docs.typesafe.ai).
 *
 * One call per market (default) asks JEV three typed questions against the
 * current market state:
 *   - direction      choice: UP / DOWN / NO_EDGE (+ probabilities, confidence)
 *   - settle_above_ptb noul: probability BTC settles above the PTB at close
 *   - regime         choice: trending_up / trending_down / choppy / mean_reverting / neutral
 *
 * Default is SHADOW: the answer is written to bot/data/jev_log.jsonl and the
 * trading path is untouched. JEV becomes an advisory (veto) only when
 * JEV_SHADOW=false is set deliberately after the shadow log has been scored
 * with bot/scripts/jevEvaluate.mts. JEV never triggers entries.
 *
 * Contract:
 *   initJevAdvisor()          - startup log + readiness check
 *   maybeJevAnalyze(snapshot) - fire-and-forget, called from the poll loop
 *   getJevStatus()            - dashboard / diagnostics snapshot
 *   checkJevAdvisory(side)    - future active-mode veto (null while shadow)
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { isTypesafeConfigured, resolveJevProviderConfig, systemOne, TypesafeError } from './typesafeClient.ts';
import { maybeRecordPolicyCandidate } from './jevPolicyShadow.ts';
import type { TypesafeAnswer, TypesafeQuestion } from './typesafeClient.ts';

const log = createLogger('JEV');

export interface JevSnapshot {
  t: number;
  slug: string | null;
  pollCounter: number;
  /** true when this call is a forced refresh after the actual entry fill. */
  entryRefresh?: boolean;
  action: string;
  side: string | null;
  confidence: string | null;
  reason: string | null;
  phase: string | null;
  timeLeftMin: number | null;
  session: string | null;
  btcPrice: number | null;
  priceToBeat: number | null;
  ptbSource: string | null;
  ptbExact: boolean;
  settlePrice: number | null;
  delta1m: number | null;
  delta3m: number | null;
  atrPct: number | null;
  atrRatio: number | null;
  rsi: number | null;
  rsiSlope: number | null;
  macdHist: number | null;
  vwapDist: number | null;
  vwapSlope: number | null;
  bbPercentB: number | null;
  bbWidth: number | null;
  stochK: number | null;
  stochD: number | null;
  emaCrossSignal: string | null;
  emaDistPct: number | null;
  volDeltaBuyRatio: number | null;
  marketUp: number | null;
  marketDown: number | null;
  mlProbUp: number | null;
  mlConfidence: number | null;
  mlSide: string | null;
  mlAgreesWithRules: boolean | null;
  ensembleUp: number | null;
  edgeUp: number | null;
  edgeDown: number | null;
  bestEdge: number | null;
  regime: string | null;
  regimeConfidence: number | null;
  smartFlowSignal: string | null;
  signalConfirmCount: number | null;
  recentFlips: number | null;
  consecutiveLosses: number | null;
  bankroll: number | null;
}

export interface JevDecision {
  model: string;
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionProbabilities: Record<string, number>;
  directionConfidence: number;
  settleUpProbability: number;
  regime: string;
  regimeConfidence: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

interface JevRecord extends JevDecision {
  ts: number;
  iso: string;
  slug: string | null;
  pollCounter: number;
  mode: 'shadow' | 'active';
  rules: { action: string; side: string | null; confidence: string | null; reason: string | null; phase: string | null };
  market: { timeLeftMin: number | null; session: string | null; btcPrice: number | null; priceToBeat: number | null; ptbSource: string | null; ptbExact: boolean; marketUp: number | null; marketDown: number | null };
  ml: { probUp: number | null; confidence: number | null; side: string | null; agreesWithRules: boolean | null };
  edge: { up: number | null; down: number | null; best: number | null };
}

let _lastSlug: string | null = null;
let _lastCallMs = 0;
let _inFlight = false;
let _pendingRefresh: JevSnapshot | null = null;
let _warnedNoKey = false;
let _pausedUntil = 0;
let _current: (JevDecision & { ts: number; slug: string | null; marketUp?: number | null; marketDown?: number | null }) | null = null;
const _stats = { calls: 0, errors: 0, lastLatencyMs: 0, lastCostUsd: 0, totalCostUsd: 0, lastError: null as string | null };

/** Compact state object. JSON structure is cheaper for JEV than prose. */
export function buildJevState(s: JevSnapshot): Record<string, unknown> {
  return {
    market: {
      asset: 'BTC/USD',
      venue: 'Polymarket 15-minute up/down, settles on Chainlink BTC/USD 60s TWAP vs price-to-beat',
      phase: s.phase,
      time_left_minutes: s.timeLeftMin,
      session: s.session,
      price_to_beat: s.priceToBeat,
      price_to_beat_source: s.ptbSource,
      price_to_beat_is_exact_twap: s.ptbExact,
      btc_price_now: s.btcPrice,
      expected_settlement_price: s.settlePrice,
      distance_to_ptb_usd: s.btcPrice != null && s.priceToBeat != null ? +(s.btcPrice - s.priceToBeat).toFixed(2) : null,
    },
    market_odds: { up: s.marketUp, down: s.marketDown },
    momentum: { delta_1m_usd: s.delta1m, delta_3m_usd: s.delta3m, vwap_distance: s.vwapDist, vwap_slope: s.vwapSlope, ema_cross: s.emaCrossSignal, ema_distance_pct: s.emaDistPct },
    volatility: { atr_pct: s.atrPct, atr_ratio: s.atrRatio, bb_percent_b: s.bbPercentB, bb_width: s.bbWidth },
    oscillators: { rsi: s.rsi, rsi_slope: s.rsiSlope, macd_hist: s.macdHist, stoch_k: s.stochK, stoch_d: s.stochD },
    order_flow: { volume_delta_buy_ratio: s.volDeltaBuyRatio, smart_flow: s.smartFlowSignal },
    algo_view: {
      ml_prob_up: s.mlProbUp,
      ml_confidence: s.mlConfidence,
      ml_side: s.mlSide,
      ml_agrees_with_rules: s.mlAgreesWithRules,
      ensemble_prob_up: s.ensembleUp,
      edge_up: s.edgeUp,
      edge_down: s.edgeDown,
      best_edge: s.bestEdge,
      provisional_action: s.action,
      provisional_side: s.side,
      signal_confirm_count: s.signalConfirmCount,
      recent_flips: s.recentFlips,
    },
    context: {
      regime: s.regime,
      regime_confidence: s.regimeConfidence,
      consecutive_losses: s.consecutiveLosses,
      bankroll_usd: s.bankroll,
    },
  };
}

export function buildJevQuestions(): Record<string, TypesafeQuestion> {
  return {
    direction: {
      type: 'choice',
      instructions: 'This is a 15-minute BTC up/down market. The market odds and the algo view are included in the state; they already reflect public information. Which side is more likely to win: UP (BTC settles above the price to beat), DOWN (below), or NO_EDGE when there is no material edge beyond what the odds already price?',
      criteria: {
        UP: 'BTC is more likely than the market odds imply to settle above the price to beat.',
        DOWN: 'BTC is more likely than the market odds imply to settle below the price to beat.',
        NO_EDGE: 'The state shows no material edge; the market odds and algo view are about right.',
      },
    },
    settle_above_ptb: {
      type: 'noul',
      instructions: 'Will BTC settle above the price to beat at the end of this 15-minute window?',
      criteria: {
        true: 'The expected settlement price is above the price to beat.',
        false: 'The expected settlement price is at or below the price to beat.',
      },
    },
    regime: {
      type: 'choice',
      instructions: 'Classify the current intraday BTC regime from the momentum, volatility and order-flow state.',
      criteria: {
        trending_up: 'Directional upward drift with momentum confirmation.',
        trending_down: 'Directional downward drift with momentum confirmation.',
        mean_reverting: 'Price keeps returning toward a level; breakouts fail.',
        choppy: 'Two-sided, noisy, no persistence.',
        neutral: 'No clear regime.',
      },
    },
  };
}

export function parseJevAnswers(model: string, answers: Record<string, TypesafeAnswer>): JevDecision {
  const directionAnswer = answers.direction;
  if (!directionAnswer || directionAnswer.type !== 'choice') throw new Error('JEV direction answer missing');
  const settleAnswer = answers.settle_above_ptb;
  if (!settleAnswer || settleAnswer.type !== 'noul') throw new Error('JEV settle answer missing');
  const regimeAnswer = answers.regime;
  if (!regimeAnswer || regimeAnswer.type !== 'choice') throw new Error('JEV regime answer missing');
  const choice = directionAnswer.choice === 'UP' || directionAnswer.choice === 'DOWN' ? directionAnswer.choice : 'NO_EDGE';
  return {
    model,
    direction: choice,
    directionProbabilities: directionAnswer.probabilities,
    directionConfidence: directionAnswer.confidence,
    settleUpProbability: settleAnswer.noul,
    regime: regimeAnswer.choice,
    regimeConfidence: regimeAnswer.confidence,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}

export function initJevAdvisor(): void {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled) {
    log.info('JEV: disabled (set JEV_ENABLED=true to enable)');
    return;
  }
  const prov = resolveJevProviderConfig();
  if (!prov.configured) {
    const keyName = prov.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
    log.warn('JEV: enabled but ' + keyName + ' is not set - advisor idle until a key is added');
    return;
  }
  const mode = cfg.shadowMode ? 'SHADOW' : 'ACTIVE';
  log.info('JEV: enabled [' + mode + '] provider=' + prov.provider + ' model=' + prov.model + ' every=' + (cfg.intervalMs > 0 ? Math.round(cfg.intervalMs / 1000) + 's' : 'market') + ' log=' + cfg.logFile);
}

async function runAnalysis(snapshot: JevSnapshot): Promise<void> {
  const started = Date.now();
  const prov = resolveJevProviderConfig();
  const res = await systemOne(
    { state: buildJevState(snapshot), questions: buildJevQuestions(), model: prov.model },
    { apiKey: prov.apiKey, baseUrl: prov.baseUrl, timeoutMs: BOT_CONFIG.jev.timeoutMs },
  );
  const parsed = parseJevAnswers(res.model, res.answers);
  parsed.latencyMs = Date.now() - started;
  parsed.inputTokens = res.usage?.input_tokens ?? null;
  parsed.outputTokens = res.usage?.output_tokens ?? null;
  parsed.costUsd = res.usage?.cost ?? null;
  const record: JevRecord = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    slug: snapshot.slug,
    pollCounter: snapshot.pollCounter,
    mode: BOT_CONFIG.jev.shadowMode ? 'shadow' : 'active',
    rules: { action: snapshot.action, side: snapshot.side, confidence: snapshot.confidence, reason: snapshot.reason, phase: snapshot.phase },
    market: { timeLeftMin: snapshot.timeLeftMin, session: snapshot.session, btcPrice: snapshot.btcPrice, priceToBeat: snapshot.priceToBeat, ptbSource: snapshot.ptbSource, ptbExact: snapshot.ptbExact, marketUp: snapshot.marketUp, marketDown: snapshot.marketDown },
    ml: { probUp: snapshot.mlProbUp, confidence: snapshot.mlConfidence, side: snapshot.mlSide, agreesWithRules: snapshot.mlAgreesWithRules },
    edge: { up: snapshot.edgeUp, down: snapshot.edgeDown, best: snapshot.bestEdge },
    ...parsed,
    ...(snapshot.entryRefresh ? { entryRefresh: true } : {}),
  };
  try {
    mkdirSync(dirname(BOT_CONFIG.jev.logFile), { recursive: true });
    appendFileSync(BOT_CONFIG.jev.logFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err: unknown) {
    log.warn('JEV: cannot write log - ' + (err instanceof Error ? err.message : String(err)));
  }
  _current = { ...parsed, ts: record.ts, slug: record.slug, marketUp: snapshot.marketUp, marketDown: snapshot.marketDown };

  // Fixed-policy forward shadow: only the designated policy/market calls, never
  // the post-fill refresh; candidate recording is record-only and never throws.
  if (!snapshot.entryRefresh && BOT_CONFIG.jev.callOn !== 'entry') {
    try {
      maybeRecordPolicyCandidate({
        slug: record.slug,
        ts: record.ts,
        iso: record.iso,
        direction: parsed.direction,
        directionConfidence: parsed.directionConfidence,
        directionProbabilities: parsed.directionProbabilities,
        settleUpProbability: parsed.settleUpProbability,
        regime: parsed.regime,
        marketUp: snapshot.marketUp,
        marketDown: snapshot.marketDown,
        timeLeftMin: snapshot.timeLeftMin,
        rulesSide: snapshot.side,
        rulesAction: snapshot.action,
        callOn: BOT_CONFIG.jev.callOn,
      });
    } catch { /* record-only */ }
  }
  _lastSlug = snapshot.slug;
  _lastCallMs = Date.now();
  _stats.calls++;
  _stats.lastLatencyMs = parsed.latencyMs;
  _stats.lastCostUsd = parsed.costUsd ?? 0;
  _stats.totalCostUsd += parsed.costUsd ?? 0;
  log.info('JEV ' + snapshot.slug + ': ' + parsed.direction + ' (' + Math.round(parsed.directionConfidence * 100) + '%) | settle_up ' + Math.round(parsed.settleUpProbability * 100) + '% | ' + parsed.regime + ' | ' + parsed.latencyMs + 'ms | ' + (parsed.costUsd != null ? parsed.costUsd.toFixed(6) : 'n/a') + ' usd');
}

/** Fire-and-forget: called from the poll loop, never awaited, never throws. */
export function maybeJevAnalyze(snapshot: JevSnapshot, opts: { force?: boolean } = {}): void {
  const force = opts.force === true;
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled) return;
  if (!isTypesafeConfigured()) {
    if (!_warnedNoKey) {
      _warnedNoKey = true;
      const prov = resolveJevProviderConfig();
      log.info('JEV: waiting for ' + (prov.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY') + ' (no calls made)');
    }
    return;
  }
  if (Date.now() < _pausedUntil) return;
  if (_inFlight) {
    // A forced entry refresh can arrive while the candidate call is in flight.
    // Queue it; the in-flight promise runs it when it finishes.
    if (force) _pendingRefresh = { ...snapshot, entryRefresh: true };
    return;
  }
  // Only evaluate markets with the exact TWAP price-to-beat and after the window
  // has settled: at poll #1 the PTB can still be the approximate oracle/spot value,
  // which made JEV answer against a wrong state (and cost a paid call).
  // Entry-time mode: a JEV opinion about a WAIT poll is not the decision the bot
  // actually makes. Call only when decide() has produced an ENTER candidate.
  if (cfg.callOn === 'entry' && snapshot.action !== 'ENTER') return;
  if (!snapshot.ptbExact) return;
  if (snapshot.timeLeftMin != null && (snapshot.timeLeftMin > 14.4 || snapshot.timeLeftMin < 0.5)) return;
  const now = Date.now();
  if (!force && snapshot.slug && snapshot.slug === _lastSlug && cfg.intervalMs === 0) return;
  if (!force && cfg.intervalMs > 0 && now - _lastCallMs < cfg.intervalMs) return;
  _inFlight = true;
  void runAnalysis(snapshot)
    .catch((err: unknown) => {
      _stats.errors++;
      _stats.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof TypesafeError && (err.status === 401 || err.status === 402)) {
        _pausedUntil = Date.now() + 10 * 60_000;
        log.warn('JEV paused 10 min (HTTP ' + err.status + '): ' + _stats.lastError + (err.status === 402 ? ' - top up OpenRouter credits at https://openrouter.ai/settings/credits' : ''));
        // Tell the operator on Telegram/Discord; a silent pause can waste a whole evaluation day.
        void import('../monitoring/notifier.ts')
          .then(m => m.notify('warn', 'JEV paused 10 min (HTTP ' + err.status + '): ' + _stats.lastError + (err.status === 402 ? ' — top up OpenRouter credits' : ''), { key: 'jev:paused' }))
          .catch(() => {});
      } else {
        log.warn('JEV call failed: ' + _stats.lastError);
      }
    })
    .finally(() => {
      _inFlight = false;
      const pending = _pendingRefresh;
      _pendingRefresh = null;
      if (pending) maybeJevAnalyze(pending, { force: true });
    });
}

/** Age check for the cached decision (one call per market; stale after 20 min). */
function freshDecision(slug?: string | null): (JevDecision & { ts: number; slug: string | null }) | null {
  if (!_current) return null;
  if (slug && _current.slug && slug !== _current.slug) return null;
  if (Date.now() - _current.ts > 20 * 60_000) return null;
  return _current;
}

/** Does JEV settle probability support its direction, with a safety margin? */
function settleSupports(direction: 'UP' | 'DOWN' | 'NO_EDGE', settleUp: number, margin: number): boolean {
  if (!Number.isFinite(settleUp)) return false;
  if (direction === 'UP') return settleUp >= 0.5 + margin;
  if (direction === 'DOWN') return settleUp <= 0.5 - margin;
  return false;
}

/** Latest cached decision for record-only consumers (tape/dashboard). */
export function getJevLatestForTape(): (JevDecision & { ts: number; slug: string | null; marketUp?: number | null; marketDown?: number | null }) | null {
  return _current;
}

/** Primary mode: confident JEV direction for this market, or null. */
export function getJevPrimarySide(slug?: string | null): 'UP' | 'DOWN' | null {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || cfg.mode !== 'primary') return null;
  const d = freshDecision(slug);
  if (!d) return null;
  if (d.direction !== 'UP' && d.direction !== 'DOWN') return null;
  if (d.directionConfidence < cfg.primaryMinConfidence) return null;
  if (!settleSupports(d.direction, d.settleUpProbability, cfg.settleMargin)) return null;
  return d.direction;
}

/** Collaborative sizing: slightly larger when JEV agrees with confidence, 1 otherwise. */
export function getJevSizingMultiplier(side: string, slug?: string | null): number {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || cfg.mode === 'shadow' || !cfg.sizingWeight) return 1;
  const d = freshDecision(slug);
  if (!d || d.direction !== side) return 1;
  if (d.directionConfidence < cfg.minConfidence) return 1;
  if (!settleSupports(d.direction, d.settleUpProbability, cfg.settleMargin)) return 1;
  const span = Math.max(0.001, 1 - cfg.minConfidence);
  const k = Math.min(1, (d.directionConfidence - cfg.minConfidence) / span);
  return 1 + cfg.sizingWeight * k;
}

/** Compact one-line summary for Telegram alerts / logs. */
export function getJevSummary(slug?: string | null): string | null {
  const d = freshDecision(slug);
  if (!d) return null;
  return 'JEV: ' + d.direction + ' ' + Math.round(d.directionConfidence * 100) + '% | settle ' + Math.round(d.settleUpProbability * 100) + '% | ' + d.regime;
}

export function getJevStatus() {
  return {
    enabled: BOT_CONFIG.jev?.enabled ?? false,
    configured: isTypesafeConfigured(),
    shadowMode: BOT_CONFIG.jev?.shadowMode ?? true,
    mode: BOT_CONFIG.jev?.mode ?? 'shadow',
    primaryMinConfidence: BOT_CONFIG.jev?.primaryMinConfidence ?? null,
    settleMargin: BOT_CONFIG.jev?.settleMargin ?? null,
    sizingWeight: BOT_CONFIG.jev?.sizingWeight ?? null,
    model: BOT_CONFIG.jev?.model ?? null,
    provider: resolveJevProviderConfig().provider,
    calls: _stats.calls,
    errors: _stats.errors,
    lastLatencyMs: _stats.lastLatencyMs,
    lastCostUsd: _stats.lastCostUsd,
    totalCostUsd: _stats.totalCostUsd,
    lastError: _stats.lastError,
    last: _current,
  };
}

/** Future active-mode veto. Returns null while shadow (the default). */
/** Mode-aware advisory. Returns null in shadow/primary (primary is handled in the loop). */
export function checkJevAdvisory(side: string, slug?: string | null): { action: 'block'; reason: string } | null {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled) return null;
  if (cfg.mode === 'shadow' || cfg.mode === 'primary') return null;
  const d = freshDecision(slug);
  if (!d) return null;
  const conf = Math.round(d.directionConfidence * 100);
  if (cfg.mode === 'veto') {
    if (d.direction === 'NO_EDGE') return null;
    if (d.directionConfidence < cfg.minConfidence) return null;
    if (d.direction !== side) {
      // Only veto when JEV's settle probability also supports the opposite side.
      if (!settleSupports(d.direction, d.settleUpProbability, cfg.settleMargin)) return null;
      return { action: 'block', reason: 'JEV ' + d.direction + ' (' + conf + '%) disagrees with ' + side + ' | settle ' + Math.round(d.settleUpProbability * 100) + '%' };
    }
    return null;
  }
  // gate: require a confident JEV agreement with the entry side and its settle probability
  if (d.direction !== side) {
    return { action: 'block', reason: 'JEV gate: needs ' + side + ', got ' + d.direction + ' (' + conf + '%)' };
  }
  if (d.directionConfidence < cfg.minConfidence) {
    return { action: 'block', reason: 'JEV gate: confidence ' + conf + '% < ' + Math.round(cfg.minConfidence * 100) + '%' };
  }
  if (!settleSupports(side === 'UP' ? 'UP' : 'DOWN', d.settleUpProbability, cfg.settleMargin)) {
    return { action: 'block', reason: 'JEV gate: settle ' + Math.round(d.settleUpProbability * 100) + '% contradicts ' + side };
  }
  return null;
}
export function resetJevAdvisorForTests(): void {
  _lastSlug = null;
  _pendingRefresh = null;
  _lastCallMs = 0;
  _inFlight = false;
  _warnedNoKey = false;
  _current = null;
  _stats.calls = 0;
  _stats.errors = 0;
  _stats.lastLatencyMs = 0;
  _stats.lastError = null;
  _stats.totalCostUsd = 0;
  _pausedUntil = 0;
}

/** Test-only: inject a cached decision so mode logic can be unit-tested without a network call. */
export function __setJevDecisionForTests(partial: {
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionConfidence: number;
  settleUpProbability: number;
  regime: string;
  slug?: string | null;
  ts?: number;
  marketUp?: number | null;
  marketDown?: number | null;
}): void {
  _current = {
    model: 'test',
    direction: partial.direction,
    directionProbabilities: {},
    directionConfidence: partial.directionConfidence,
    settleUpProbability: partial.settleUpProbability,
    regime: partial.regime,
    regimeConfidence: 0,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    ts: partial.ts ?? Date.now(),
    slug: partial.slug ?? 'btc-updown-15m-test',
    marketUp: partial.marketUp ?? null,
    marketDown: partial.marketDown ?? null,
  };
}

/** Fire-and-forget: called from the poll loop, never awaited, never throws. */
