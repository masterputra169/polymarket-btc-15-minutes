/**
 * JEV decision advisor - TypeSafe System One model (docs.typesafe.ai).
 *
 * v4 architecture:
 *   - Sends structured v4 state including Chainlink TWAP settle distance, Binance/Chainlink basis,
 *     TWAP z-score, L2 book liquidity/spread, order-flow features (VPIN, OFI, microprice edge),
 *     and episodic self-memory (`recent_memory`: recent hit rate, directional bias, streak, misses).
 *   - Asks eight typed questions in one parallel System One evaluation:
 *       1) direction          (choice: UP / DOWN / NO_EDGE)
 *       2) settle_above_ptb   (noul: online rolling Platt calibration or Laplace-10 PAVA fallback + adaptive Bayesian prior)
 *       3) regime             (choice: trending_up / trending_down / mean_reverting / choppy / neutral)
 *       4) chop_hazard        (score 0..4: two-sided chop / whipsaw risk)
 *       5) exhaustion_risk    (score 0..4: overextended spike / snapback risk)
 *       6) flow_contradiction (score 0..4: L2 orderbook / VPIN / basis divergence vs momentum)
 *       7) bull_case_strength (score 0..4: parallel bullish thesis strength)
 *       8) bear_case_strength (score 0..4: parallel bearish thesis strength)
 *   - Combines bull/bear debate disagreement + risk dimensions in code (`jevBayesian.ts`), adapts
 *     Bayesian anchor weight smoothly to rolling Brier skill, applies split-conformal empirical
 *     risk-veto thresholds, and enforces Rolling Brier Skill auto-demotion.
 *
 * Default is SHADOW: the answer is written to bot/data/jev_log.jsonl and the
 * trading path is untouched.
 *
 * Contract:
 *   initJevAdvisor()                 - startup log, key check, Platt & memory warmup
 *   maybeJevAnalyze(snapshot)        - fire-and-forget, called from the poll loop
 *   recordJevWindowOutcome(slug, y)  - feeds resolved market outcome into Brier guard, memory, & online Platt
 *   getJevStatus()                   - dashboard / diagnostics snapshot
 *   checkJevAdvisory(side, slug)     - future active-mode veto (null while shadow / demoted)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { isTypesafeConfigured, resolveJevProviderConfig, systemOne, TypesafeError } from './typesafeClient.ts';
import {
  calibrateJevSettleUp,
  calibrateWithPlatt,
  fitOnlinePlatt,
  JEV_SETTLE_CALIBRATION_VERSION,
  type PlattParams,
} from './jevSettleCalibration.ts';
import {
  computeAdaptiveBayesianWeight,
  computeBullBearDebate,
  computeCompositeRiskScore,
  computeEmpiricalRiskThreshold,
  computeMultiSignalBayesianPosterior,
  evaluateBrierSkillGate,
  isDirectionDebateConsistent,
  normalizeTypesafeScore,
  routeJevDecision,
  summarizeEpisodicMemory,
  type BrierObservation,
  type BrierSkillReport,
  type ConfidenceRoute,
  type JevEpisodicMemorySummary,
  type JevMemoryEntry,
  type RiskDeskScores,
} from './jevBayesian.ts';
import type { OrderFlowFeatures } from '../engines/orderFlowFeatures.ts';
import type { HmmRegimeOutput } from '../../../src/indicators/hmmRegime.ts';
import { maybeRecordPolicyCandidate } from './jevPolicyShadow.ts';
import type { TypesafeAnswer, TypesafeQuestion, TypesafeScoreAnswer } from './typesafeClient.ts';

const log = createLogger('JEV');
const RISK_SCORE_LEVELS = 5;

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
  basisUsd?: number | null;
  twapPhysicsZ?: number | null;
  twapProbUp?: number | null;
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
  spread?: number | null;
  bidLiquidity?: number | null;
  askLiquidity?: number | null;
  mlProbUp: number | null;
  mlConfidence: number | null;
  mlSide: string | null;
  mlAgreesWithRules: boolean | null;
  baseMlProbUp?: number | null;
  hybridDeltaProb?: number | null;
  hybridActive?: boolean;
  ensembleUp: number | null;
  edgeUp: number | null;
  edgeDown: number | null;
  bestEdge: number | null;
  regime: string | null;
  regimeConfidence: number | null;
  hmm?: HmmRegimeOutput | null;
  smartFlowSignal: string | null;
  signalConfirmCount: number | null;
  recentFlips: number | null;
  consecutiveLosses: number | null;
  bankroll: number | null;
  orderFlow?: OrderFlowFeatures;
}

export interface JevDecision {
  model: string;
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionProbabilities: Record<string, number>;
  directionConfidence: number;
  settleUpProbability: number;
  /** Calibrated settle probability; optional for older tests/records. */
  settleUpCalibrated?: number;
  /** Market-anchored Bayesian log-odds posterior; optional for older tests/records. */
  bayesianProbUp?: number;
  regime: string;
  regimeConfidence: number;
  /** TypeSafe Risk Desk normalized dimension scores in [0, 1]. */
  chopHazard?: number | null;
  exhaustionRisk?: number | null;
  flowContradiction?: number | null;
  /** Parallel bull/bear debate strength and disagreement metrics (v4). */
  bullStrength?: number | null;
  bearStrength?: number | null;
  netConviction?: number | null;
  debateDisagreement?: number | null;
  /** Weighted composite risk score in [0, 1] combining Risk Desk dimensions. */
  compositeRisk?: number | null;
  riskConfidence?: number | null;
  onlineCalibrated?: boolean;
  effectiveBayesianWeight?: number;
  effectiveRiskThreshold?: number;
  selfConsistent?: boolean;
  route?: ConfidenceRoute;
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
  stateVariant?: string;
  decisionShadow?: boolean;
  entryRefresh?: boolean;
  rules: { action: string; side: string | null; confidence: string | null; reason: string | null; phase: string | null };
  market: { timeLeftMin: number | null; session: string | null; btcPrice: number | null; priceToBeat: number | null; ptbSource: string | null; ptbExact: boolean; marketUp: number | null; marketDown: number | null };
  ml: { probUp: number | null; confidence: number | null; side: string | null; agreesWithRules: boolean | null; baseMlProbUp?: number | null; hybridDeltaProb?: number | null; hybridActive?: boolean };
  edge: { up: number | null; down: number | null; best: number | null };
  features: {
    timeLeftMin: number | null; session: string | null; phase: string | null;
    btcPrice: number | null; priceToBeat: number | null; settlePrice: number | null;
    basisUsd?: number | null; twapPhysicsZ?: number | null; twapProbUp?: number | null;
    delta1m: number | null; delta3m: number | null; atrPct: number | null; atrRatio: number | null;
    rsi: number | null; rsiSlope: number | null; macdHist: number | null;
    vwapDist: number | null; vwapSlope: number | null; bbPercentB: number | null; bbWidth: number | null;
    stochK: number | null; stochD: number | null; emaCrossSignal: string | null; emaDistPct: number | null;
    volDeltaBuyRatio: number | null; smartFlowSignal: string | null; signalConfirmCount: number | null;
    regime: string | null; regimeConfidence: number | null;
    mlProbUp: number | null; mlConfidence: number | null; marketUp: number | null; marketDown: number | null;
    spread?: number | null; bidLiquidity?: number | null; askLiquidity?: number | null;
    orderFlow?: OrderFlowFeatures;
  };
}

let _lastSlug: string | null = null;
let _decisionSlug: string | null = null;
let _lastCallMs = 0;
let _inFlight = false;
let _pendingRefresh: JevSnapshot | null = null;
let _warnedNoKey = false;
let _pausedUntil = 0;
let _current: (JevDecision & { ts: number; slug: string | null; marketUp?: number | null; marketDown?: number | null }) | null = null;
const _stats = { calls: 0, errors: 0, lastLatencyMs: 0, lastCostUsd: 0, totalCostUsd: 0, lastError: null as string | null };

const MAX_MEMORY_HISTORY = 250;
const PLATT_REFIT_INTERVAL = 10;

interface PendingOutcomeMeta {
  marketProbUp: number;
  jevProbUp: number;
  rawProbUp: number;
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  regime: string | null;
  compositeRisk: number | null;
  stateVariant: string | null;
  ts: number;
}

const _pendingOutcomesBySlug = new Map<string, PendingOutcomeMeta>();
const _recordedSlugs = new Set<string>();
const _brierHistory: BrierObservation[] = [];
const _memorySlugs = new Set<string>();
const _memoryHistory: JevMemoryEntry[] = [];
let _onlinePlatt: PlattParams | null = null;
let _outcomesSincePlattFit = 0;
let _persistOutcomes = false;

function pushMemoryEntry(entry: JevMemoryEntry): void {
  if (_memorySlugs.has(entry.slug)) return;
  if (!(entry.marketProbUp > 0.01 && entry.marketProbUp < 0.99)) return;
  _memorySlugs.add(entry.slug);
  _memoryHistory.push(entry);
  while (_memoryHistory.length > MAX_MEMORY_HISTORY) {
    const dropped = _memoryHistory.shift();
    if (dropped) _memorySlugs.delete(dropped.slug);
  }
}

function isModernJevVariant(variant: string | null | undefined): boolean {
  return typeof variant === 'string' && (variant.endsWith('_v4') || variant.endsWith('_v5'));
}

function refitOnlinePlatt(): void {
  const modern: Array<{ rawProb: number; outcomeUp: 0 | 1 }> = [];
  const all: Array<{ rawProb: number; outcomeUp: 0 | 1 }> = [];
  for (const m of _memoryHistory) {
    if (!Number.isFinite(m.rawProbUp)) continue;
    const item = { rawProb: m.rawProbUp, outcomeUp: m.outcomeUp };
    all.push(item);
    if (isModernJevVariant(m.stateVariant)) modern.push(item);
  }
  const pool = modern.length >= 40 ? modern : all;
  _onlinePlatt = fitOnlinePlatt(pool, { recencyHalfLife: 35 });
}

function persistJevOutcome(slug: string, outcomeLabel: 'UP' | 'DOWN'): void {
  if (!_persistOutcomes) return;
  const logFile = BOT_CONFIG.jev?.logFile;
  if (!logFile) return;
  const outcomesFile = resolve(dirname(logFile), 'jev_outcomes.json');
  try {
    mkdirSync(dirname(outcomesFile), { recursive: true });
    let outcomes: Record<string, 'UP' | 'DOWN'> = {};
    if (existsSync(outcomesFile)) {
      try {
        const parsed = JSON.parse(readFileSync(outcomesFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          outcomes = parsed as Record<string, 'UP' | 'DOWN'>;
        }
      } catch { /* start fresh if corrupted */ }
    }
    if (outcomes[slug] === outcomeLabel) return;
    outcomes[slug] = outcomeLabel;
    const tmp = `${outcomesFile}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(outcomes), 'utf8');
    renameSync(tmp, outcomesFile);
  } catch {
    // Non-critical disk persistence; never break settlement or polling
  }
}

function roundOpt(v: number | null | undefined, digits = 4): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

/** Compact structured state object (v4). JSON structure is cheaper and sharper for JEV than prose. */
export function buildJevState(
  s: JevSnapshot,
  independent = false,
  memory?: JevEpisodicMemorySummary | null,
): Record<string, unknown> {
  const basisUsd = s.basisUsd != null && Number.isFinite(s.basisUsd)
    ? s.basisUsd
    : (s.btcPrice != null && s.settlePrice != null ? s.btcPrice - s.settlePrice : null);

  const state: Record<string, unknown> = {
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
      settle_distance_to_ptb_usd: s.settlePrice != null && s.priceToBeat != null ? +(s.settlePrice - s.priceToBeat).toFixed(2) : null,
      binance_chainlink_basis_usd: roundOpt(basisUsd, 2),
      twap_physics_z: roundOpt(s.twapPhysicsZ, 3),
      twap_prob_up: roundOpt(s.twapProbUp, 4),
    },
    market_odds: { up: s.marketUp, down: s.marketDown },
    order_book: {
      spread: roundOpt(s.spread ?? s.orderFlow?.spread, 4),
      bid_liquidity_usd: roundOpt(s.bidLiquidity, 2),
      ask_liquidity_usd: roundOpt(s.askLiquidity, 2),
      book_skew_ratio:
        s.bidLiquidity != null && s.askLiquidity != null && (s.bidLiquidity + s.askLiquidity) > 0
          ? roundOpt(s.bidLiquidity / (s.bidLiquidity + s.askLiquidity), 4)
          : null,
    },
    momentum: { delta_1m_usd: s.delta1m, delta_3m_usd: s.delta3m, vwap_distance: s.vwapDist, vwap_slope: s.vwapSlope, ema_cross: s.emaCrossSignal, ema_distance_pct: s.emaDistPct },
    volatility: { atr_pct: s.atrPct, atr_ratio: s.atrRatio, bb_percent_b: s.bbPercentB, bb_width: s.bbWidth },
    oscillators: { rsi: s.rsi, rsi_slope: s.rsiSlope, macd_hist: s.macdHist, stoch_k: s.stochK, stoch_d: s.stochD },
    order_flow: {
      volume_delta_buy_ratio: s.volDeltaBuyRatio,
      smart_flow: s.smartFlowSignal,
      vpin: roundOpt(s.orderFlow?.vpin, 4),
      ofi: roundOpt(s.orderFlow?.ofi, 2),
      microprice_edge_pct: roundOpt(s.orderFlow?.micropriceEdgePct, 4),
      depth_imbalance: roundOpt(s.orderFlow?.depthImbalance, 4),
      top_imbalance: roundOpt(s.orderFlow?.topImbalance, 4),
      trade_imbalance: roundOpt(s.orderFlow?.tradeImbalance, 4),
      trade_count: s.orderFlow?.tradeCount ?? null,
    },
    algo_view: {
      ml_prob_up: s.mlProbUp,
      ml_confidence: s.mlConfidence,
      ml_side: s.mlSide,
      ml_agrees_with_rules: s.mlAgreesWithRules,
      base_ml_prob_up: roundOpt(s.baseMlProbUp, 4),
      hybrid_delta_prob: roundOpt(s.hybridDeltaProb, 4),
      hybrid_active: s.hybridActive ?? false,
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
      ...(s.hmm
        ? {
            hmm_regime: {
              dominant: s.hmm.dominantState,
              p_trending: s.hmm.pTrending,
              p_choppy: s.hmm.pChoppy,
              p_mean_reverting: s.hmm.pMeanReverting,
              entropy: s.hmm.entropy,
            },
          }
        : {}),
      consecutive_losses: s.consecutiveLosses,
      bankroll_usd: s.bankroll,
    },
  };
  if (memory && memory.sampleCount >= 3) {
    state.recent_memory = {
      window_count: memory.sampleCount,
      market_up_rate: memory.marketUpRate,
      streak: memory.streakSide ? `${memory.streakSide}x${memory.streakLength}` : null,
      whipsaw_rate: memory.whipsawRate,
      jev_down_call_rate: memory.jevDownCallRate,
      jev_up_call_rate: memory.jevUpCallRate,
      jev_direction_hit_rate: memory.jevDirectionHitRate,
      jev_prob_bias: memory.jevProbBias,
      recent_misses: memory.recentMisses,
    };
  }
  if (independent) delete state.algo_view;
  state.state_variant = independent ? 'independent_v5' : 'collaborative_v5';
  return state;
}

export function buildJevQuestions(independent = false): Record<string, TypesafeQuestion> {
  return {
    direction: {
      type: 'choice',
      instructions: independent
        ? 'This is a 15-minute BTC up/down market settling on Chainlink 60s TWAP vs price-to-beat. Use settle_distance_to_ptb_usd, market_odds, momentum, volatility, order_flow, and recent_memory (NO bot recommendation in state). Choose UP or DOWN whenever settle distance, twap_physics_z, or momentum/order_flow point to a directional edge beyond market_odds while avoiding streak bias from recent_memory; choose NO_EDGE only when bullish and bearish evidence are genuinely balanced or choppy.'
        : 'This is a 15-minute BTC up/down market settling on Chainlink 60s TWAP vs price-to-beat. Use settle_distance_to_ptb_usd, market_odds, order_flow, recent_memory, and algo_view. Which side has a clear edge beyond market_odds: UP, DOWN, or NO_EDGE?',
      criteria: {
        UP: 'Expected settlement is above PTB or momentum/order flow support higher UP probability than market_odds.up.',
        DOWN: 'Expected settlement is below PTB or momentum/order flow support higher DOWN probability than market_odds.down.',
        NO_EDGE: 'Bullish and bearish evidence are genuinely balanced, compressed near PTB, or severely choppy.',
      },
    },
    settle_above_ptb: {
      type: 'noul',
      instructions: 'Estimate the probability that Chainlink 60s TWAP settles at or above price_to_beat at market close. Superforecaster workflow: start from market_odds.up as outside-view base rate, adjust using settle_distance_to_ptb_usd, twap_physics_z, and remaining time; if recent_memory.jev_prob_bias is negative/positive, actively correct your recent bias; avoid 0 or 1 extremes unless near-certain.',
      criteria: {
        true: 'Chainlink 60s TWAP settles >= price_to_beat.',
        false: 'Chainlink 60s TWAP settles < price_to_beat.',
      },
    },
    regime: {
      type: 'choice',
      instructions: 'Classify the current intraday BTC regime from momentum, volatility, and order-flow state.',
      criteria: {
        trending_up: 'Directional upward drift with momentum and flow confirmation.',
        trending_down: 'Directional downward drift with momentum and flow confirmation.',
        mean_reverting: 'Price keeps snapping back toward PTB or VWAP; breakouts stall.',
        choppy: 'Two-sided whipsaw noise with weak persistence.',
        neutral: 'Balanced/quiet regime without strong trend.',
      },
    },
    chop_hazard: {
      type: 'score',
      instructions: 'Score the structural chop / whipsaw hazard in this 15-minute window based on narrow settle distance to PTB, flat slope, low ATR/BB width, and noisy oscillators.',
      criteria: [
        'Clean persistent directional movement far from PTB; minimal whipsaw risk.',
        'Mild noise, trend mostly intact.',
        'Mixed signals or moderate oscillation near VWAP/PTB.',
        'Repeated reversals across PTB or compressed choppy range.',
        'Severe two-sided chop right on PTB with contradicting short-term swings.',
      ],
    },
    exhaustion_risk: {
      type: 'score',
      instructions: 'Score short-term exhaustion / snapback risk where an overextended move (extreme RSI, Stoch, stretched BB %B, large delta) is vulnerable to mean-reversion before settle.',
      criteria: [
        'Fresh move with plenty of room; oscillators neutral and unstretched.',
        'Healthy trend progression with mild extension.',
        'Moderately stretched oscillators; minor pullback possible.',
        'Overbought/oversold extension with slowing slope or fading delta.',
        'Extreme parabolic spike (RSI/BB/Stoch pinned) with stalled slope; high reversal hazard.',
      ],
    },
    flow_contradiction: {
      type: 'score',
      instructions: 'Score how strongly order flow (VPIN, depth/top/trade imbalance, microprice_edge_pct, OFI) and Binance/Chainlink basis contradict price direction.',
      criteria: [
        'Order flow, L2 book imbalance, and momentum align in the same direction.',
        'Mostly aligned order flow with minor noise.',
        'Neutral or thin order flow without strong confirmation.',
        'Noticeable divergence between spot move and VPIN/book/trade imbalance.',
        'Strong flow contradiction: heavy opposite-side book pressure, high VPIN, or adverse basis against spot drift.',
      ],
    },
    bull_case_strength: {
      type: 'score',
      instructions: 'Argue the strongest objective BULLISH case (why BTC settles >= price_to_beat) from settle distance, TWAP z-score, VWAP slope, and positive order flow.',
      criteria: [
        'No credible bullish thesis; price, momentum, and flow all favor lower settle.',
        'Weak bullish case: minor bounce potential only.',
        'Moderate bullish case: balanced upside arguments or positive support.',
        'Strong bullish case: solid upward drift above PTB or supportive buy flow.',
        'Dominant bullish case: decisive settle lead, rising momentum, and aligned bid/OFI support.',
      ],
    },
    bear_case_strength: {
      type: 'score',
      instructions: 'Argue the strongest objective BEARISH case (why BTC settles < price_to_beat) from settle distance, TWAP z-score, exhaustion, and selling order flow.',
      criteria: [
        'No credible bearish thesis; upward drift and bid support dominate.',
        'Weak bearish case: minor pullback risk only.',
        'Moderate bearish case: mixed overhead resistance or fading momentum.',
        'Strong bearish case: clear downward drift below PTB or heavy sell pressure.',
        'Dominant bearish case: decisive deficit below PTB, falling slope, and aligned ask/OFI selling.',
      ],
    },
  };
}

function extractScoreDimension(ans: TypesafeAnswer | undefined): { normalized: number; confidence: number } | null {
  if (!ans || ans.type !== 'score') return null;
  const sAns = ans as TypesafeScoreAnswer;
  const normalized = normalizeTypesafeScore(sAns.score, RISK_SCORE_LEVELS);
  if (normalized == null) return null;
  return { normalized, confidence: Number.isFinite(sAns.confidence) ? sAns.confidence : 0 };
}

export interface ParseJevContext {
  marketUp?: number | null;
  bayesianMaxWeight?: number;
  minConfidence?: number;
  riskVetoThreshold?: number;
  plattParams?: PlattParams | null;
  skillReport?: BrierSkillReport | null;
  memoryHistory?: readonly JevMemoryEntry[];
}

export function parseJevAnswers(
  model: string,
  answers: Record<string, TypesafeAnswer>,
  ctx: ParseJevContext = {},
): JevDecision {
  const directionAnswer = answers.direction;
  if (!directionAnswer || directionAnswer.type !== 'choice') throw new Error('JEV direction answer missing');
  const settleAnswer = answers.settle_above_ptb;
  if (!settleAnswer || settleAnswer.type !== 'noul') throw new Error('JEV settle answer missing');
  const regimeAnswer = answers.regime;
  if (!regimeAnswer || regimeAnswer.type !== 'choice') throw new Error('JEV regime answer missing');

  const choice = directionAnswer.choice === 'UP' || directionAnswer.choice === 'DOWN' ? directionAnswer.choice : 'NO_EDGE';
  const onlineCalibrated = Boolean(ctx.plattParams);
  const settleUpCalibrated = calibrateWithPlatt(settleAnswer.noul, ctx.plattParams ?? null);

  const chopDim = extractScoreDimension(answers.chop_hazard);
  const exhaustDim = extractScoreDimension(answers.exhaustion_risk);
  const flowDim = extractScoreDimension(answers.flow_contradiction);
  const bullDim = extractScoreDimension(answers.bull_case_strength);
  const bearDim = extractScoreDimension(answers.bear_case_strength);
  const debate = computeBullBearDebate(bullDim, bearDim);

  const riskScores: RiskDeskScores = {
    chopHazard: chopDim,
    exhaustionRisk: exhaustDim,
    flowContradiction: flowDim,
    debateDisagreement: debate.disagreement != null ? { normalized: debate.disagreement, confidence: debate.confidence } : null,
  };
  const composite = computeCompositeRiskScore(riskScores);

  const baseMaxWeight = ctx.bayesianMaxWeight ?? BOT_CONFIG.jev?.bayesianMaxWeight ?? 0.20;
  const effectiveBayesianWeight = ctx.skillReport
    ? computeAdaptiveBayesianWeight(baseMaxWeight, ctx.skillReport)
    : baseMaxWeight;

  const bayes = computeMultiSignalBayesianPosterior({
    marketPrior: ctx.marketUp ?? null,
    jevCalibratedProb: settleUpCalibrated,
    directionConfidence: directionAnswer.confidence,
    maxWeight: effectiveBayesianWeight,
    debate,
  });

  const fallbackRiskThresh = BOT_CONFIG.jev?.riskVetoThreshold ?? 0.78;
  const effectiveRiskThreshold = ctx.riskVetoThreshold
    ?? (ctx.memoryHistory
      ? computeEmpiricalRiskThreshold(ctx.memoryHistory, { fallbackThreshold: fallbackRiskThresh })
      : fallbackRiskThresh);

  const selfConsistent = isDirectionDebateConsistent(choice, debate.netConviction);
  const route = routeJevDecision({
    direction: choice,
    directionConfidence: directionAnswer.confidence,
    compositeRisk: composite.compositeRisk,
    riskConfidence: composite.riskConfidence,
    minConfidence: ctx.minConfidence ?? BOT_CONFIG.jev?.minConfidence ?? 0.60,
    riskVetoThreshold: effectiveRiskThreshold,
    netConviction: debate.netConviction,
  });

  return {
    model,
    direction: choice,
    directionProbabilities: directionAnswer.probabilities,
    directionConfidence: directionAnswer.confidence,
    settleUpProbability: settleAnswer.noul,
    settleUpCalibrated: +settleUpCalibrated.toFixed(4),
    bayesianProbUp: +bayes.posterior.toFixed(4),
    regime: regimeAnswer.choice,
    regimeConfidence: regimeAnswer.confidence,
    chopHazard: chopDim ? +chopDim.normalized.toFixed(4) : null,
    exhaustionRisk: exhaustDim ? +exhaustDim.normalized.toFixed(4) : null,
    flowContradiction: flowDim ? +flowDim.normalized.toFixed(4) : null,
    bullStrength: debate.bullStrength,
    bearStrength: debate.bearStrength,
    netConviction: debate.netConviction,
    debateDisagreement: debate.disagreement,
    compositeRisk: composite.compositeRisk != null ? +composite.compositeRisk.toFixed(4) : null,
    riskConfidence: composite.dimensionsPresent > 0 ? +composite.riskConfidence.toFixed(4) : null,
    onlineCalibrated,
    effectiveBayesianWeight: +effectiveBayesianWeight.toFixed(4),
    effectiveRiskThreshold: +effectiveRiskThreshold.toFixed(4),
    selfConsistent,
    route,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}

function pushBrierObservation(obs: BrierObservation): void {
  if (_recordedSlugs.has(obs.slug)) return;
  if (!(obs.marketProbUp > 0.01 && obs.marketProbUp < 0.99)) return;
  if (!Number.isFinite(obs.jevProbUp)) return;
  _recordedSlugs.add(obs.slug);
  _brierHistory.push(obs);
  const maxKeep = Math.max(20, BOT_CONFIG.jev?.brierGateWindow ?? 100);
  while (_brierHistory.length > maxKeep) {
    const dropped = _brierHistory.shift();
    if (dropped) _recordedSlugs.delete(dropped.slug);
  }
}

/** Record settled market outcome (`'UP' | 'DOWN' | 0 | 1`) for the rolling Brier guard, memory, & online Platt. */
export function recordJevWindowOutcome(slug: string | null | undefined, outcome: 'UP' | 'DOWN' | 0 | 1): boolean {
  if (!slug) return false;
  const outcomeUp: 0 | 1 = outcome === 'UP' || outcome === 1 ? 1 : 0;
  persistJevOutcome(slug, outcomeUp === 1 ? 'UP' : 'DOWN');
  const pred = _pendingOutcomesBySlug.get(slug);
  if (!pred) return false;
  _pendingOutcomesBySlug.delete(slug);
  pushBrierObservation({
    slug,
    ts: pred.ts,
    marketProbUp: pred.marketProbUp,
    jevProbUp: pred.jevProbUp,
    outcomeUp,
  });
  pushMemoryEntry({
    slug,
    ts: pred.ts,
    direction: pred.direction,
    rawProbUp: pred.rawProbUp,
    marketProbUp: pred.marketProbUp,
    outcomeUp,
    regime: pred.regime,
    compositeRisk: pred.compositeRisk,
    stateVariant: pred.stateVariant,
  });
  _outcomesSincePlattFit++;
  if (_memoryHistory.length >= 40 && (_onlinePlatt == null || _outcomesSincePlattFit >= PLATT_REFIT_INTERVAL)) {
    refitOnlinePlatt();
    _outcomesSincePlattFit = 0;
  }
  return true;
}

function warmLoadBrierHistory(): void {
  const cfg = BOT_CONFIG.jev;
  if (!cfg?.logFile || !existsSync(cfg.logFile)) return;
  const outcomesFile = resolve(dirname(cfg.logFile), 'jev_outcomes.json');
  if (!existsSync(outcomesFile)) return;
  try {
    const outcomes = JSON.parse(readFileSync(outcomesFile, 'utf8')) as Record<string, 'UP' | 'DOWN'>;
    const rawLines = readFileSync(cfg.logFile, 'utf8').split('\n').filter(Boolean);
    const maxKeep = Math.max(20, cfg.brierGateWindow ?? 100);
    const tail = rawLines.slice(-Math.max(maxKeep * 15, 2500));
    for (const line of tail) {
      let row: Partial<JevRecord> | null = null;
      try { row = JSON.parse(line) as Partial<JevRecord>; } catch { row = null; }
      if (!row?.slug) continue;
      const out = outcomes[row.slug];
      if (out !== 'UP' && out !== 'DOWN') continue;
      const mktUp = row.market?.marketUp;
      if (typeof mktUp !== 'number' || mktUp <= 0.01 || mktUp >= 0.99) continue;
      const jevP = row.bayesianProbUp ?? row.settleUpCalibrated ?? (typeof row.settleUpProbability === 'number' ? calibrateJevSettleUp(row.settleUpProbability) : null);
      if (jevP == null || !Number.isFinite(jevP)) continue;
      const outcomeUp: 0 | 1 = out === 'UP' ? 1 : 0;
      const ts = Number(row.ts) || Date.now();
      pushBrierObservation({
        slug: row.slug,
        ts,
        marketProbUp: mktUp,
        jevProbUp: jevP,
        outcomeUp,
      });
      if (typeof row.settleUpProbability === 'number' && Number.isFinite(row.settleUpProbability)) {
        const dir: 'UP' | 'DOWN' | 'NO_EDGE' = row.direction === 'UP' || row.direction === 'DOWN' ? row.direction : 'NO_EDGE';
        pushMemoryEntry({
          slug: row.slug,
          ts,
          direction: dir,
          rawProbUp: row.settleUpProbability,
          marketProbUp: mktUp,
          outcomeUp,
          regime: typeof row.regime === 'string' ? row.regime : null,
          compositeRisk: typeof row.compositeRisk === 'number' && Number.isFinite(row.compositeRisk) ? row.compositeRisk : null,
          stateVariant: typeof row.stateVariant === 'string' ? row.stateVariant : null,
        });
      }
    }
    refitOnlinePlatt();
  } catch {
    // Non-critical warmup; starts empty cleanly if malformed
  }
}

export function getJevBrierSkill(): BrierSkillReport {
  const cfg = BOT_CONFIG.jev;
  return evaluateBrierSkillGate(_brierHistory, {
    windowSize: cfg?.brierGateWindow ?? 100,
    minSamples: cfg?.brierGateMinSamples ?? 30,
    enabled: cfg?.brierGateEnabled ?? true,
  });
}

export function initJevAdvisor(): void {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled) {
    log.info('JEV: disabled (set JEV_ENABLED=true to enable)');
    return;
  }
  _persistOutcomes = true;
  warmLoadBrierHistory();
  const prov = resolveJevProviderConfig();
  if (!prov.configured) {
    const keyName = prov.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
    log.warn('JEV: enabled but ' + keyName + ' is not set - advisor idle until a key is added');
    return;
  }
  const mode = cfg.shadowMode ? 'SHADOW' : 'ACTIVE';
  const skill = getJevBrierSkill();
  const riskThresh = computeEmpiricalRiskThreshold(_memoryHistory, { fallbackThreshold: cfg.riskVetoThreshold ?? 0.78 });
  const plattDesc = _onlinePlatt
    ? `${_onlinePlatt.version}(a=${_onlinePlatt.a},b=${_onlinePlatt.b},n=${_onlinePlatt.samples})`
    : `static(${JEV_SETTLE_CALIBRATION_VERSION})`;
  log.info(
    'JEV v5: enabled [' + mode + '] provider=' + prov.provider + ' model=' + prov.model +
    ' every=' + (cfg.intervalMs > 0 ? Math.round(cfg.intervalMs / 1000) + 's' : 'market') +
    ' brierGuard=' + skill.status + '(' + skill.samples + ')' +
    ' platt=' + plattDesc +
    ' mem=' + _memoryHistory.length +
    ' riskThresh=' + riskThresh +
    ' log=' + cfg.logFile,
  );
}

async function runAnalysis(snapshot: JevSnapshot, mode: 'normal' | 'decision' = 'normal'): Promise<void> {
  const decision = mode === 'decision';
  const started = Date.now();
  const prov = resolveJevProviderConfig();
  const independent = BOT_CONFIG.jev.independentState;
  const memSummary = summarizeEpisodicMemory(_memoryHistory);
  const res = await systemOne(
    { state: buildJevState(snapshot, independent, memSummary), questions: buildJevQuestions(independent), model: prov.model },
    { apiKey: prov.apiKey, baseUrl: prov.baseUrl, timeoutMs: BOT_CONFIG.jev.timeoutMs },
  );
  const parsed = parseJevAnswers(res.model, res.answers, {
    marketUp: snapshot.marketUp,
    bayesianMaxWeight: BOT_CONFIG.jev.bayesianMaxWeight,
    minConfidence: BOT_CONFIG.jev.minConfidence,
    plattParams: _onlinePlatt,
    skillReport: getJevBrierSkill(),
    memoryHistory: _memoryHistory,
  });
  parsed.latencyMs = Date.now() - started;
  parsed.inputTokens = res.usage?.input_tokens ?? null;
  parsed.outputTokens = res.usage?.output_tokens ?? null;
  parsed.costUsd = res.usage?.cost ?? null;

  const basisUsd = snapshot.basisUsd != null
    ? snapshot.basisUsd
    : (snapshot.btcPrice != null && snapshot.settlePrice != null ? snapshot.btcPrice - snapshot.settlePrice : null);

  const record: JevRecord = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    slug: snapshot.slug,
    pollCounter: snapshot.pollCounter,
    mode: BOT_CONFIG.jev.shadowMode ? 'shadow' : 'active',
    rules: { action: snapshot.action, side: snapshot.side, confidence: snapshot.confidence, reason: snapshot.reason, phase: snapshot.phase },
    market: { timeLeftMin: snapshot.timeLeftMin, session: snapshot.session, btcPrice: snapshot.btcPrice, priceToBeat: snapshot.priceToBeat, ptbSource: snapshot.ptbSource, ptbExact: snapshot.ptbExact, marketUp: snapshot.marketUp, marketDown: snapshot.marketDown },
    ml: {
      probUp: snapshot.mlProbUp,
      confidence: snapshot.mlConfidence,
      side: snapshot.mlSide,
      agreesWithRules: snapshot.mlAgreesWithRules,
      baseMlProbUp: snapshot.baseMlProbUp ?? null,
      hybridDeltaProb: snapshot.hybridDeltaProb ?? null,
      hybridActive: snapshot.hybridActive ?? false,
    },
    edge: { up: snapshot.edgeUp, down: snapshot.edgeDown, best: snapshot.bestEdge },
    features: {
      timeLeftMin: snapshot.timeLeftMin, session: snapshot.session, phase: snapshot.phase,
      btcPrice: snapshot.btcPrice, priceToBeat: snapshot.priceToBeat, settlePrice: snapshot.settlePrice,
      basisUsd: roundOpt(basisUsd, 2), twapPhysicsZ: roundOpt(snapshot.twapPhysicsZ, 3), twapProbUp: roundOpt(snapshot.twapProbUp, 4),
      delta1m: snapshot.delta1m, delta3m: snapshot.delta3m, atrPct: snapshot.atrPct, atrRatio: snapshot.atrRatio,
      rsi: snapshot.rsi, rsiSlope: snapshot.rsiSlope, macdHist: snapshot.macdHist,
      vwapDist: snapshot.vwapDist, vwapSlope: snapshot.vwapSlope, bbPercentB: snapshot.bbPercentB, bbWidth: snapshot.bbWidth,
      stochK: snapshot.stochK, stochD: snapshot.stochD, emaCrossSignal: snapshot.emaCrossSignal, emaDistPct: snapshot.emaDistPct,
      volDeltaBuyRatio: snapshot.volDeltaBuyRatio, smartFlowSignal: snapshot.smartFlowSignal, signalConfirmCount: snapshot.signalConfirmCount,
      regime: snapshot.regime, regimeConfidence: snapshot.regimeConfidence,
      mlProbUp: snapshot.mlProbUp, mlConfidence: snapshot.mlConfidence, marketUp: snapshot.marketUp, marketDown: snapshot.marketDown,
      spread: roundOpt(snapshot.spread ?? snapshot.orderFlow?.spread, 4),
      bidLiquidity: roundOpt(snapshot.bidLiquidity, 2),
      askLiquidity: roundOpt(snapshot.askLiquidity, 2),
      orderFlow: snapshot.orderFlow,
    },
    ...parsed,
    ...(snapshot.entryRefresh ? { entryRefresh: true } : {}),
    stateVariant: independent ? 'independent_v5' : 'collaborative_v5',
    ...(decision ? { decisionShadow: true } : {}),
  };
  try {
    const logFile = decision ? BOT_CONFIG.jev.decisionLogFile : BOT_CONFIG.jev.logFile;
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err: unknown) {
    log.warn('JEV: cannot write log - ' + (err instanceof Error ? err.message : String(err)));
  }
  if (!decision) {
    _current = { ...parsed, ts: record.ts, slug: record.slug, marketUp: snapshot.marketUp, marketDown: snapshot.marketDown };
    if (record.slug && snapshot.marketUp != null && snapshot.marketUp > 0.01 && snapshot.marketUp < 0.99) {
      _pendingOutcomesBySlug.set(record.slug, {
        marketProbUp: snapshot.marketUp,
        jevProbUp: parsed.bayesianProbUp ?? parsed.settleUpCalibrated ?? parsed.settleUpProbability,
        rawProbUp: parsed.settleUpProbability,
        direction: parsed.direction,
        regime: parsed.regime ?? null,
        compositeRisk: parsed.compositeRisk ?? null,
        stateVariant: record.stateVariant ?? null,
        ts: record.ts,
      });
      if (_pendingOutcomesBySlug.size > 200) {
        const oldestKey = _pendingOutcomesBySlug.keys().next().value;
        if (oldestKey) _pendingOutcomesBySlug.delete(oldestKey);
      }
    }
  }

  // Fixed-policy forward shadow: only the designated policy/market calls, never
  // the post-fill refresh; candidate recording is record-only and never throws.
  if (!decision && !snapshot.entryRefresh && BOT_CONFIG.jev.callOn !== 'entry') {
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
  if (!decision) {
    _lastSlug = snapshot.slug;
    _lastCallMs = Date.now();
  }
  _stats.calls++;
  _stats.lastLatencyMs = parsed.latencyMs;
  _stats.lastCostUsd = parsed.costUsd ?? 0;
  _stats.totalCostUsd += parsed.costUsd ?? 0;
  const riskTag = parsed.compositeRisk != null ? ' | risk ' + Math.round(parsed.compositeRisk * 100) + '%' : '';
  const bayesTag = parsed.bayesianProbUp != null ? ' bayes ' + Math.round(parsed.bayesianProbUp * 100) + '%' : '';
  const debateTag = parsed.netConviction != null
    ? ' | deb ' + (parsed.netConviction >= 0 ? '+' : '') + Math.round(parsed.netConviction * 100) + '%(dis ' + Math.round((parsed.debateDisagreement ?? 0) * 100) + '%)'
    : '';
  const calTag = parsed.onlineCalibrated && _onlinePlatt ? _onlinePlatt.version : JEV_SETTLE_CALIBRATION_VERSION;
  log.info(
    (decision ? 'JEV decision shadow ' : 'JEV ') + snapshot.slug + ': ' +
    parsed.direction + ' (' + Math.round(parsed.directionConfidence * 100) + '%) | settle_up raw ' +
    Math.round(parsed.settleUpProbability * 100) + '% -> cal ' +
    Math.round((parsed.settleUpCalibrated ?? parsed.settleUpProbability) * 100) + '%' + bayesTag + riskTag + debateTag +
    ' | ' + parsed.regime + ' | ' + parsed.latencyMs + 'ms | ' +
    (parsed.costUsd != null ? parsed.costUsd.toFixed(6) : 'n/a') + ' usd | cal ' + calTag,
  );
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
    if (force) _pendingRefresh = { ...snapshot, entryRefresh: true };
    return;
  }
  if (cfg.callOn === 'entry' && snapshot.action !== 'ENTER') return;
  if (!snapshot.ptbExact) return;
  const maxTimeLeft = cfg.maxTimeLeftMin ?? 14.2;
  if (snapshot.timeLeftMin != null && (snapshot.timeLeftMin > maxTimeLeft || snapshot.timeLeftMin < 0.5)) return;
  if (!force && cfg.callOn === 'policy' && snapshot.timeLeftMin != null && snapshot.timeLeftMin < cfg.policyMinTimeLeft) return;
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

/** Entry-time decision shadow: one call at the actual ENTER candidate. Record-only. */
export function maybeJevDecisionShadow(snapshot: JevSnapshot): void {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled || !cfg.decisionShadow) return;
  if (!isTypesafeConfigured()) return;
  if (snapshot.action !== 'ENTER') return;
  if (!snapshot.slug || snapshot.slug === _decisionSlug) return;
  if (!snapshot.ptbExact) return;
  const maxTimeLeft = cfg.maxTimeLeftMin ?? 14.2;
  if (snapshot.timeLeftMin != null && (snapshot.timeLeftMin > maxTimeLeft || snapshot.timeLeftMin < 0.5)) return;
  if (Date.now() < _pausedUntil) return;
  if (_inFlight) return;
  _decisionSlug = snapshot.slug;
  _inFlight = true;
  void runAnalysis(snapshot, 'decision')
    .catch((err: unknown) => {
      _stats.errors++;
      _stats.lastError = err instanceof Error ? err.message : String(err);
      log.warn('JEV decision shadow failed: ' + _stats.lastError);
      if (err instanceof TypesafeError && (err.status === 401 || err.status === 402)) {
        _pausedUntil = Date.now() + 10 * 60_000;
        log.warn('JEV paused 10 min (HTTP ' + err.status + ')');
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
  const skill = getJevBrierSkill();
  if ((cfg.brierGateEnabled ?? true) && !skill.allowActiveVeto) return null;
  const d = freshDecision(slug);
  if (!d) return null;
  if (d.direction !== 'UP' && d.direction !== 'DOWN') return null;
  if (d.directionConfidence < cfg.primaryMinConfidence) return null;
  if (!settleSupports(d.direction, d.settleUpCalibrated ?? d.settleUpProbability, cfg.settleMargin)) return null;
  return d.direction;
}

/** Collaborative sizing: slightly larger when JEV agrees with confidence, 1 otherwise. */
export function getJevSizingMultiplier(side: string, slug?: string | null): number {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || cfg.mode === 'shadow' || !cfg.sizingWeight) return 1;
  const skill = getJevBrierSkill();
  if ((cfg.brierGateEnabled ?? true) && !skill.allowActiveVeto) return 1;
  const d = freshDecision(slug);
  if (!d || d.direction !== side) return 1;
  if (d.directionConfidence < cfg.minConfidence) return 1;
  if (!settleSupports(d.direction, d.settleUpCalibrated ?? d.settleUpProbability, cfg.settleMargin)) return 1;
  const span = Math.max(0.001, 1 - cfg.minConfidence);
  const k = Math.min(1, (d.directionConfidence - cfg.minConfidence) / span);
  return 1 + cfg.sizingWeight * k;
}

/** Compact one-line summary for Telegram alerts / logs. */
export function getJevSummary(slug?: string | null, opts?: { includeGuard?: boolean }): string | null {
  const d = freshDecision(slug);
  if (!d) return null;
  const base = 'JEV: ' + d.direction + ' ' + Math.round(d.directionConfidence * 100) + '% | settle ' + Math.round((d.settleUpCalibrated ?? d.settleUpProbability) * 100) + '% | ' + d.regime;
  let line = d.compositeRisk != null ? base + ' | risk ' + Math.round(d.compositeRisk * 100) + '%' : base;
  if (opts?.includeGuard) {
    const cfg = BOT_CONFIG.jev;
    if (cfg?.mode === 'veto' && (cfg.brierGateEnabled ?? true) && !getJevBrierSkill().allowActiveVeto) {
      line += ' [veto off: brierGuard]';
    }
    const ageSec = d.ts ? Math.round((Date.now() - d.ts) / 1000) : 0;
    if (ageSec >= 20) line += ` (${ageSec}s ago)`;
  }
  return line;
}

export function getJevStatus() {
  const effectiveRiskThreshold = computeEmpiricalRiskThreshold(_memoryHistory, {
    fallbackThreshold: BOT_CONFIG.jev?.riskVetoThreshold ?? 0.78,
  });
  return {
    enabled: BOT_CONFIG.jev?.enabled ?? false,
    configured: isTypesafeConfigured(),
    shadowMode: BOT_CONFIG.jev?.shadowMode ?? true,
    mode: BOT_CONFIG.jev?.mode ?? 'shadow',
    primaryMinConfidence: BOT_CONFIG.jev?.primaryMinConfidence ?? null,
    settleMargin: BOT_CONFIG.jev?.settleMargin ?? null,
    sizingWeight: BOT_CONFIG.jev?.sizingWeight ?? null,
    calibrationVersion: _onlinePlatt ? _onlinePlatt.version : JEV_SETTLE_CALIBRATION_VERSION,
    onlinePlatt: _onlinePlatt,
    effectiveRiskThreshold,
    memorySummary: summarizeEpisodicMemory(_memoryHistory),
    brierSkill: getJevBrierSkill(),
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

/** Mode-aware advisory. Returns null in shadow/primary (or when Brier skill guard demotes active JEV). */
export function checkJevAdvisory(side: string, slug?: string | null): { action: 'block'; reason: string } | null {
  const cfg = BOT_CONFIG.jev;
  if (!cfg || !cfg.enabled) return null;
  if (cfg.mode === 'shadow' || cfg.mode === 'primary') return null;

  const skill = getJevBrierSkill();
  if ((cfg.brierGateEnabled ?? true) && !skill.allowActiveVeto) return null;

  const d = freshDecision(slug);
  if (!d) return null;

  const riskVetoThreshold = d.effectiveRiskThreshold ?? computeEmpiricalRiskThreshold(_memoryHistory, {
    fallbackThreshold: cfg.riskVetoThreshold ?? 0.78,
  });
  const route = d.route ?? routeJevDecision({
    direction: d.direction,
    directionConfidence: d.directionConfidence,
    compositeRisk: d.compositeRisk ?? null,
    riskConfidence: d.riskConfidence ?? 0,
    minConfidence: cfg.minConfidence,
    riskVetoThreshold,
  });

  if (route === 'risk_veto') {
    const riskPct = Math.round((d.compositeRisk ?? 0) * 100);
    return {
      action: 'block',
      reason: 'JEV Risk Desk block (risk ' + riskPct + '%, chop ' + Math.round((d.chopHazard ?? 0) * 100) + '%, flow ' + Math.round((d.flowContradiction ?? 0) * 100) + '%)',
    };
  }

  const conf = Math.round(d.directionConfidence * 100);
  if (cfg.mode === 'veto') {
    if (route === 'uncertain_passthrough' || d.direction === 'NO_EDGE') return null;
    if (d.directionConfidence < cfg.minConfidence) return null;
    if (d.direction !== side) {
      if (!settleSupports(d.direction, d.settleUpCalibrated ?? d.settleUpProbability, cfg.settleMargin)) return null;
      return { action: 'block', reason: 'JEV ' + d.direction + ' (' + conf + '%) disagrees with ' + side + ' | settle ' + Math.round((d.settleUpCalibrated ?? d.settleUpProbability) * 100) + '%' };
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
  if (!settleSupports(side === 'UP' ? 'UP' : 'DOWN', d.settleUpCalibrated ?? d.settleUpProbability, cfg.settleMargin)) {
    return { action: 'block', reason: 'JEV gate: settle ' + Math.round((d.settleUpCalibrated ?? d.settleUpProbability) * 100) + '% contradicts ' + side };
  }
  return null;
}

export function resetJevAdvisorForTests(): void {
  _persistOutcomes = false;
  _lastSlug = null;
  _decisionSlug = null;
  _lastCallMs = 0;
  _inFlight = false;
  _pendingRefresh = null;
  _warnedNoKey = false;
  _pausedUntil = 0;
  _current = null;
  _stats.calls = 0;
  _stats.errors = 0;
  _stats.lastLatencyMs = 0;
  _stats.lastCostUsd = 0;
  _stats.lastError = null;
  _stats.totalCostUsd = 0;
  _pendingOutcomesBySlug.clear();
  _recordedSlugs.clear();
  _brierHistory.length = 0;
  _memorySlugs.clear();
  _memoryHistory.length = 0;
  _onlinePlatt = null;
  _outcomesSincePlattFit = 0;
}

/** Test-only: inject a cached decision so mode logic can be unit-tested without a network call. */
export function __setJevDecisionForTests(partial: {
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionConfidence: number;
  settleUpProbability: number;
  settleUpCalibrated?: number;
  bayesianProbUp?: number;
  regime: string;
  compositeRisk?: number | null;
  riskConfidence?: number | null;
  chopHazard?: number | null;
  exhaustionRisk?: number | null;
  flowContradiction?: number | null;
  bullStrength?: number | null;
  bearStrength?: number | null;
  netConviction?: number | null;
  debateDisagreement?: number | null;
  effectiveRiskThreshold?: number;
  route?: ConfidenceRoute;
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
    settleUpCalibrated: partial.settleUpCalibrated,
    bayesianProbUp: partial.bayesianProbUp,
    regime: partial.regime,
    regimeConfidence: 0,
    chopHazard: partial.chopHazard ?? null,
    exhaustionRisk: partial.exhaustionRisk ?? null,
    flowContradiction: partial.flowContradiction ?? null,
    bullStrength: partial.bullStrength ?? null,
    bearStrength: partial.bearStrength ?? null,
    netConviction: partial.netConviction ?? null,
    debateDisagreement: partial.debateDisagreement ?? null,
    effectiveRiskThreshold: partial.effectiveRiskThreshold,
    compositeRisk: partial.compositeRisk ?? null,
    riskConfidence: partial.riskConfidence ?? null,
    route: partial.route,
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
