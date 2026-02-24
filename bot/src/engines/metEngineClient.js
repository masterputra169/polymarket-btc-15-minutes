/**
 * MetEngine API client v3 — x402 payment protocol via @x402/core + @x402/svm.
 *
 * Feature 1: Smart Money Pre-Entry Gate (F1)
 *   Blocks if strong consensus (≥65%) is against our signal.
 *
 * Feature 2: Insider Score Gate (F2)
 *   Blocks if top insider score (≥75) on opposite side, regardless of consensus strength.
 *
 * Feature 3: Conviction Wallet Gate (F3) ← NEW
 *   Medium consensus (≥60%) + non-hedging whale/shark wallet (score ≥90, USDC ≥$50) on opp side.
 *   More targeted than F1: requires a quality wallet as independent confirmation.
 *   Catches cases like 59-64% consensus where a conviction player is clearly positioned against us.
 *
 * Feature 1b: Soft consensus + dumb money confirming (F1b)
 *   Consensus ≥55.25% (85% of F1 threshold) AND dumb_money.contrarian_to_smart=true.
 *
 * Payment: x402 protocol — Solana Mainnet USDC, ~$0.05/request.
 * Results cached 90s per conditionId. All errors → neutral (never blocks).
 *
 * Setup:
 *   METENGINE_ENABLED=true
 *   SOLANA_PRIVATE_KEY=<base58 64-byte Solana keypair>
 *
 * Note: registerExactSvmScheme() has a bug where it doesn't pass rpcUrl to
 * ExactSvmScheme constructor. We use ExactSvmScheme directly as workaround.
 */

import { createLogger } from '../logger.js';

const log = createLogger('MetEngine');

// ── Module config (set via initMetEngine) ──
let _cfg = null;

// ── x402 HTTP client (lazy-init on first request) ──
let _httpClient = null;
let _solanaAddress = null;

// Free public Solana RPC — avoids 403 on mainnet-beta.solana.com
const DEFAULT_SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com';

// Endpoint
const INTELLIGENCE_PATH = '/api/v1/markets/intelligence';
const TOP_N_WALLETS = 50;

// Normalize any direction string → canonical 'UP' | 'DOWN' | 'UNKNOWN' | null
// MetEngine returns outcome names verbatim from the market (e.g. "Up", "Down", "Yes", "No").
// We normalize everything to UP/DOWN so comparisons work regardless of market naming.
function normalizeDir(s) {
  if (!s) return null;
  const u = String(s).toUpperCase();
  if (u === 'UP'   || u === 'YES') return 'UP';
  if (u === 'DOWN' || u === 'NO')  return 'DOWN';
  if (u === 'UNKNOWN') return 'UNKNOWN';
  return u; // pass through anything else
}

// Case-insensitive + normalized lookup in by_outcome object.
// by_outcome keys can be "Up"/"Down", "YES"/"NO", "up"/"down" depending on market.
function getOutcomeData(byOutcome, normalizedDir) {
  if (!byOutcome || !normalizedDir || normalizedDir === 'UNKNOWN') return null;
  return (
    byOutcome[normalizedDir] ??                                           // "UP"/"DOWN"
    byOutcome[normalizedDir.toLowerCase()] ??                             // "up"/"down"
    byOutcome[normalizedDir[0] + normalizedDir.slice(1).toLowerCase()] ?? // "Up"/"Down"
    byOutcome[normalizedDir === 'UP' ? 'Yes' : 'No'] ??                   // "Yes"/"No"
    byOutcome[normalizedDir === 'UP' ? 'YES' : 'NO'] ??                   // "YES"/"NO"
    null
  );
}

// ── x402 client init (lazy, async) ──
async function _initX402Client() {
  if (_httpClient) return true;
  if (!_cfg?.solanaPrivateKey) return false;

  try {
    const { x402Client, x402HTTPClient } = await import('@x402/core/client');
    const { ExactSvmScheme }             = await import('@x402/svm/exact/client');
    const { toClientSvmSigner }          = await import('@x402/svm');
    const { getBase58Encoder, createKeyPairSignerFromBytes } = await import('@solana/kit');

    const KEY   = _cfg.solanaPrivateKey;
    const bytes = getBase58Encoder().encode(KEY);

    if (bytes.length !== 64) {
      log.warn(`MetEngine: key bytes length ${bytes.length} (expected 64) — check SOLANA_PRIVATE_KEY`);
      return false;
    }

    const signer = await createKeyPairSignerFromBytes(bytes);
    _solanaAddress = signer.address;
    log.info(`MetEngine: Solana address ${_solanaAddress}`);

    const client = new x402Client();

    // Workaround: registerExactSvmScheme() bug — it never passes rpcUrl to ExactSvmScheme.
    // Use ExactSvmScheme directly with rpcUrl config.
    const scheme = new ExactSvmScheme(toClientSvmSigner(signer), { rpcUrl: DEFAULT_SOLANA_RPC });
    client.register('solana:*', scheme);

    _httpClient = new x402HTTPClient(client);
    log.info(`MetEngine: x402 client ready | RPC=${DEFAULT_SOLANA_RPC}`);
    return true;

  } catch (err) {
    log.warn(`MetEngine: x402 init failed — ${err.message}`);
    return false;
  }
}

/** Initialize with BOT_CONFIG.metEngine. Call once on startup. */
export function initMetEngine(cfg) {
  _cfg = cfg ?? {};
  if (_cfg.enabled) {
    const hasKey = !!_cfg.solanaPrivateKey;
    log.info(`MetEngine enabled | base=${_cfg.baseUrl || 'https://agent.metengine.xyz'} | key=${hasKey ? 'set' : 'MISSING'}`);
    if (!hasKey) {
      log.warn('MetEngine: SOLANA_PRIVATE_KEY not set — gate will pass through (neutral)');
      return;
    }
    // Pre-warm x402 client in background
    _initX402Client().catch(err => log.warn(`MetEngine: x402 pre-warm failed — ${err.message}`));
  }
}

// ── HTTP POST with x402 payment ──
async function metPost(conditionId) {
  if (!_cfg?.enabled) return null;

  const baseUrl  = _cfg.baseUrl || 'https://agent.metengine.xyz';
  const url      = `${baseUrl}${INTELLIGENCE_PATH}`;
  const body     = JSON.stringify({ condition_id: conditionId, top_n_wallets: TOP_N_WALLETS });
  const timeoutMs = _cfg.timeoutMs ?? 5_000;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // ── Step 1: POST → expect 402 ──
    const res1 = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });

    // If somehow 200 already (e.g. cached session) — great
    if (res1.ok) return await res1.json();

    if (res1.status !== 402) {
      log.debug(`MetEngine: HTTP ${res1.status} on initial request`);
      return null;
    }

    // ── Step 2: Decode PAYMENT-REQUIRED ──
    const payHdrRaw = res1.headers.get('PAYMENT-REQUIRED') || res1.headers.get('payment-required');
    if (!payHdrRaw) {
      log.debug('MetEngine: 402 but no PAYMENT-REQUIRED header');
      return null;
    }

    let paymentRequired;
    try {
      paymentRequired = JSON.parse(Buffer.from(payHdrRaw, 'base64').toString('utf8'));
    } catch (_) {
      log.debug('MetEngine: failed to decode PAYMENT-REQUIRED header');
      return null;
    }

    // ── Step 3: Ensure x402 client is ready ──
    const ready = await _initX402Client();
    if (!ready || !_httpClient) {
      log.debug('MetEngine: x402 client not ready');
      return null;
    }

    // ── Step 4: Create payment payload ──
    let payload;
    try {
      payload = await _httpClient.createPaymentPayload(paymentRequired);
    } catch (payErr) {
      log.debug(`MetEngine: createPaymentPayload failed — ${payErr.message}`);
      return null;
    }

    // ── Step 5: Re-POST with payment headers ──
    const paymentHeaders = _httpClient.encodePaymentSignatureHeader(payload);

    const res2 = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...paymentHeaders,
      },
      body,
      signal: ctrl.signal,
    });

    if (!res2.ok) {
      log.debug(`MetEngine: payment step HTTP ${res2.status}`);
      return null;
    }

    return await res2.json();

  } catch (err) {
    if (err.name !== 'AbortError') {
      log.debug(`MetEngine request: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Result cache ──
const _cache = new Map(); // conditionId → { result, ts }

// ── Last gate result (for dashboard broadcast) ──
let _lastResult = null; // { ...gateResult, ts, conditionId }

const NEUTRAL = Object.freeze({
  blocked: false,
  boost: false,
  direction: null,
  consensusStrength: 0,
  insiderScore: 0,
  smartVsPriceAligned: null,
  contrarian: false,
  source: 'neutral',
  reason: 'MetEngine neutral/unavailable',
});

/**
 * Query MetEngine for smart money + insider signals for a Polymarket market.
 *
 * @param {string} conditionId - Market condition ID (from Polymarket)
 * @param {string} betSide - 'UP' | 'DOWN'
 * @returns {{ blocked, boost, direction, consensusStrength, insiderScore, source, reason }}
 */
export async function querySmartMoney(conditionId, betSide) {
  if (!_cfg?.enabled) return NEUTRAL;
  if (!conditionId)   return NEUTRAL;

  const ttl    = _cfg.cacheTtlMs ?? 90_000;
  const cached = _cache.get(conditionId);
  if (cached && (Date.now() - cached.ts) < ttl) {
    const r = _applyGate(cached.data, betSide, 'cache');
    _lastResult = { ...r, ts: Date.now(), conditionId };
    return r;
  }

  try {
    const data = await metPost(conditionId);
    if (data) {
      _cache.set(conditionId, { data, ts: Date.now() });
      // Evict oldest if cache too large
      if (_cache.size > 200) {
        const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        _cache.delete(oldest[0]);
      }
      const r = _applyGate(data, betSide, 'api');
      _lastResult = { ...r, ts: Date.now(), conditionId };
      return r;
    }
  } catch (err) {
    log.debug(`querySmartMoney error: ${err.message}`);
  }

  return NEUTRAL;
}

/**
 * Apply gate logic to MetEngine API response data.
 * Response shape from /api/v1/markets/intelligence:
 *   data.smart_money.consensus_outcome                     — verbatim market name ("Up"/"Down"/"Yes"/"No"/etc.)
 *   data.smart_money.consensus_strength                    — 0.0-1.0
 *   data.smart_money.by_outcome[side].top_wallets[].score  — insider score 0-100
 *   data.smart_money.by_outcome[side].top_wallets[].wallet_address — wallet ID
 *   data.smart_money.by_outcome[side].top_wallets[].usdc_invested  — USDC in this market
 *   data.smart_money.by_outcome[side].total_usdc / percentage
 *   data.dumb_money.contrarian_to_smart                    — dumb money opposes smart money
 *   data.signal_analysis.smart_vs_price_aligned            — smart money vs market price
 *   data.signal_analysis.contrarian_signal                 — smart diverges from implied prob
 *
 * NOTE on 15m market relevance:
 *   buy_sell_ratio / volume_trend are 24h metrics — irrelevant for 15m markets
 *   (each condition_id lives only 15min, barely any 24h data exists).
 *   We skip those fields intentionally.
 *
 * Gate evaluation order (first match wins):
 *   F1  → consensus ≥ 65% against us                                 → BLOCK
 *   F2  → top insider score ≥ 75 on opposite side                    → BLOCK
 *   F3  → consensus ≥ 60% + conviction wallet (score≥90, $50+, non-hedger) → BLOCK  ← NEW
 *   F1b → consensus ≥ 55.25% + dumb money confirms                   → BLOCK
 *   BOOST → smart agrees ≥ 40%                                        → boost flag
 */
function _applyGate(apiResponse, betSide, source) {
  const blockThresh    = _cfg?.blockConsensusStrength ?? 0.65;
  const boostThresh    = _cfg?.boostInsiderScore      ?? 75;
  const convBlockStr   = _cfg?.convictionBlockStrength ?? 0.60;
  const convScoreMin   = _cfg?.convictionScoreMin      ?? 90;
  const convMinUSDC    = _cfg?.convictionMinUSDC       ?? 50;

  const d = apiResponse?.data ?? apiResponse;
  if (!d) return NEUTRAL;

  const sm = d.smart_money ?? {};
  const dm = d.dumb_money  ?? {};
  const sa = d.signal_analysis ?? {};

  const consensusStrength = parseFloat(sm.consensus_strength ?? 0) || 0;

  // Normalize all directions to 'UP'|'DOWN'|'UNKNOWN' for consistent comparison.
  // MetEngine returns verbatim market outcome names ("Up","Down","Yes","No", etc.)
  const consensusDir = normalizeDir(sm.consensus_outcome ?? 'unknown'); // 'UP'|'DOWN'|'UNKNOWN'
  const ourDir       = normalizeDir(betSide);   // 'UP' | 'DOWN'
  const oppDir       = ourDir === 'UP' ? 'DOWN' : ourDir === 'DOWN' ? 'UP' : null;

  const smartAgrees = !ourDir || consensusDir === 'UNKNOWN' || consensusDir === ourDir;

  // Precompute both side data (used in multiple gates + boost)
  const oppSideData = getOutcomeData(sm.by_outcome, oppDir);
  const ourSideData = getOutcomeData(sm.by_outcome, ourDir);

  // ── Highest insider score on the OPPOSITE side ──
  let insiderScore = 0;
  if (oppSideData?.top_wallets) {
    insiderScore = oppSideData.top_wallets.reduce(
      (max, w) => Math.max(max, parseFloat(w.score ?? 0) || 0), 0
    );
  }

  // ── Additional context fields ──
  const dumbContrarian      = dm.contrarian_to_smart ?? false;
  const smartVsPriceAligned = sa.smart_vs_price_aligned ?? null;
  const contrarian          = sa.contrarian_signal ?? false;

  // Capital context on opposite side (for richer log messages)
  let oppUsdcStr = '';
  if (oppSideData?.total_usdc > 0) {
    oppUsdcStr = ` $${(oppSideData.total_usdc / 1000).toFixed(1)}k(${((oppSideData.percentage ?? 0) * 100).toFixed(0)}%)`;
  }

  // ── F1: Block if strong consensus opposes us ──
  if (!smartAgrees && consensusStrength >= blockThresh) {
    const msg = `Smart money ${consensusDir} (${(consensusStrength * 100).toFixed(0)}%${oppUsdcStr}) vs our ${betSide}`;
    log.info(`[MetEngine] BLOCK F1: ${msg}`);
    return { blocked: true, boost: false, direction: consensusDir, consensusStrength, insiderScore, source, reason: msg };
  }

  // ── F2: Block if high-score insider wallet on opposite side ──
  if (!smartAgrees && insiderScore >= boostThresh) {
    const msg = `Insider score ${insiderScore} on ${oppDir}${oppUsdcStr} vs our ${betSide}`;
    log.info(`[MetEngine] BLOCK F2: ${msg}`);
    return { blocked: true, boost: false, direction: consensusDir, consensusStrength, insiderScore, source, reason: msg };
  }

  // ── F3: Conviction wallet gate ──
  // Medium consensus (≥60%) + non-hedging high-score wallet (score≥90, USDC≥$50) on opposite side.
  // "Non-hedger" = wallet appears on opposite side but NOT on our side.
  // Catches e.g. 60-64% consensus where a single conviction player is clearly positioned against us.
  if (!smartAgrees && consensusStrength >= convBlockStr && oppSideData?.top_wallets?.length) {
    // Build set of wallet IDs on OUR side so we can identify hedgers
    const ourWalletIds = new Set(
      (ourSideData?.top_wallets ?? [])
        .map(w => w.wallet_address ?? w.wallet ?? w.address ?? w.id ?? '')
        .filter(Boolean)
    );

    // Find best (highest score) conviction wallet on opposite side that is NOT hedging
    const convWallet = oppSideData.top_wallets
      .filter(w => {
        const wId   = w.wallet_address ?? w.wallet ?? w.address ?? w.id ?? '';
        const score = parseFloat(w.score ?? 0) || 0;
        // usdc_invested: amount they put into this specific market outcome
        const usdc  = parseFloat(w.usdc_invested ?? w.capital ?? w.size ?? w.total_usdc ?? 0) || 0;
        return score >= convScoreMin && usdc >= convMinUSDC && !ourWalletIds.has(wId);
      })
      .sort((a, b) => (parseFloat(b.score ?? 0) || 0) - (parseFloat(a.score ?? 0) || 0))[0] ?? null;

    if (convWallet) {
      const wId    = (convWallet.wallet_address ?? convWallet.wallet ?? convWallet.address ?? convWallet.id ?? '').slice(0, 10);
      const wScore = parseFloat(convWallet.score ?? 0) || 0;
      const wUsdc  = parseFloat(convWallet.usdc_invested ?? convWallet.capital ?? convWallet.size ?? convWallet.total_usdc ?? 0) || 0;
      const msg    = `Conviction ${wId}… score=${wScore} $${wUsdc.toFixed(0)} on ${oppDir} (${(consensusStrength * 100).toFixed(0)}% consensus) vs our ${betSide}`;
      log.info(`[MetEngine] BLOCK F3: ${msg}`);
      return { blocked: true, boost: false, direction: consensusDir, consensusStrength, insiderScore, source, reason: msg };
    }
  }

  // ── F1b: Smart against us near threshold AND dumb money confirms (contrarian_to_smart) ──
  if (!smartAgrees && consensusStrength >= blockThresh * 0.85 && dumbContrarian) {
    const msg = `Smart ${consensusDir}(${(consensusStrength * 100).toFixed(0)}%) + dumb contrarian vs our ${betSide}`;
    log.info(`[MetEngine] BLOCK F1b: ${msg}`);
    return { blocked: true, boost: false, direction: consensusDir, consensusStrength, insiderScore, source, reason: msg };
  }

  // ── BOOST: Smart money agrees with us ──
  const boost = smartAgrees && ourDir && consensusDir === ourDir && consensusStrength >= 0.40;

  // Rich context string for logging
  const contextParts = [];
  if (consensusDir !== 'UNKNOWN') {
    const ourPct = ourSideData ? `${((ourSideData.percentage ?? 0) * 100).toFixed(0)}%` : '';
    contextParts.push(`smart=${consensusDir}(${(consensusStrength * 100).toFixed(0)}%${ourPct ? ' '+ourPct : ''})`);
  }
  if (insiderScore > 0)             contextParts.push(`topInsider=${insiderScore}`);
  if (smartVsPriceAligned !== null) contextParts.push(`priceAligned=${smartVsPriceAligned}`);
  if (contrarian)                   contextParts.push('contrarian!');
  if (dumbContrarian)               contextParts.push('dumbContra');
  const contextStr = contextParts.length ? ` [${contextParts.join(' ')}]` : '';

  const reason = boost
    ? `Smart money agrees ${ourDir} (${(consensusStrength * 100).toFixed(0)}%)${contextStr}`
    : `No block${contextStr}`;

  // Log every result so backend logs show MetEngine was consulted (neutral = pass through)
  if (boost) {
    log.info(`[MetEngine] BOOST ${ourDir} (${(consensusStrength * 100).toFixed(0)}%)${contextStr}`);
  } else {
    log.info(`[MetEngine] OK (neutral)${contextStr}`);
  }

  return {
    blocked: false,
    boost,
    direction: consensusDir !== 'UNKNOWN' ? consensusDir : null,
    consensusStrength,
    insiderScore,
    smartVsPriceAligned,
    contrarian,
    source,
    reason,
  };
}

/** Dashboard stats — includes last gate result for BotPanel display. */
export function getMetEngineStats() {
  return {
    enabled: _cfg?.enabled ?? false,
    configured: !!_cfg?.solanaPrivateKey,
    cacheSize: _cache.size,
    solanaAddress: _solanaAddress ?? null,
    last: _lastResult, // { blocked, boost, direction, consensusStrength, insiderScore, source, reason, ts, conditionId }
  };
}

/** Clear cache (e.g. on market switch). */
export function clearMetEngineCache() {
  _cache.clear();
}
