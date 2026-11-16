/**
 * Strict redaction & allowlist sanitization for public poly15-study outputs.
 * Never allow private keys, bearer/query tokens, Telegram bot secrets, or
 * wallet/contract identifiers to reach static study-dist bundles.
 */

const SECRET_PATTERNS = [
  // Telegram bot tokens: <digits>:<alnum_dash_30+>
  [/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TG_TOKEN]'],
  // Bearer auth headers
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  // Query tokens (?token=... or ?botStatusToken=...)
  [/([?&](?:token|botStatusToken|access_token|api_key|apikey|secret|password)=)[^&#\s"'`]+/gi, '$1[REDACTED]'],
  // EVM private keys or 64-char hex tokens following key-like labels
  [/((?:PRIVATE_KEY|API_SECRET|PASSPHRASE|AUTH_TOKEN|SESSION_SECRET|SIGNING_KEY|BOT_TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*[=:]\s*["']?)[^\s"'`\n]+(["']?)/gi, '$1[REDACTED]$2'],
  // OpenRouter / OpenAI / Anthropic / PEM blocks
  [/\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/-----BEGIN [A-Z0-9 ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+PRIVATE KEY-----/g, '[REDACTED_PEM]'],
];

/** Scrub accidental secret-like substrings from markdown/text reports. */
export function redactSecretText(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

const finiteNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const safeStr = (v) => (typeof v === 'string' && v.length > 0 ? redactSecretText(v) : null);

/**
 * Explicit allowlist projection for a trade_journal.jsonl line.
 * Strips conditionId, tokenIds, orderIds, wallets, signatures, and arbitrary bags.
 */
export function sanitizeTradeEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const e = row.entry && typeof row.entry === 'object' ? row.entry : {};
  const x = row.exit && typeof row.exit === 'object' ? row.exit : {};
  const a = row.analysis && typeof row.analysis === 'object' ? row.analysis : {};

  const slug = safeStr(e.marketSlug);
  const side = e.side === 'UP' || e.side === 'DOWN' || e.side === 'ARB' ? e.side : null;
  if (!slug && !side) return null;

  return {
    ts: finiteNum(row._ts) ?? finiteNum(x.exitedAt) ?? finiteNum(e.enteredAt),
    enteredAt: finiteNum(e.enteredAt),
    exitedAt: finiteNum(x.exitedAt),
    slug,
    side,
    phase: safeStr(e.phase),
    session: safeStr(e.session),
    regime: safeStr(e.regime),
    tokenPrice: finiteNum(e.actualPrice) ?? finiteNum(e.tokenPrice),
    expectedPrice: finiteNum(e.expectedPrice),
    cost: finiteNum(e.cost),
    size: finiteNum(e.size),
    fillModel: safeStr(e.fillModel),
    isMaker: typeof e.isMaker === 'boolean' ? e.isMaker : null,
    dryRun: typeof e.dryRun === 'boolean' ? e.dryRun : true,
    ptbSource: safeStr(e.ptbSource),
    priceToBeat: finiteNum(e.priceToBeat),
    settlePrice: finiteNum(e.settlePrice),
    btcPrice: finiteNum(e.btcPrice),
    binanceWindowOpen: finiteNum(e.binanceWindowOpen),
    liveBasisUsd: finiteNum(e.liveBasisUsd),
    crossFeedSkewUsd: finiteNum(e.crossFeedSkewUsd),
    mlProbUp: finiteNum(e.mlProbUp),
    mlConfidence: finiteNum(e.mlConfidence),
    mlSide: e.mlSide === 'UP' || e.mlSide === 'DOWN' ? e.mlSide : null,
    ensembleUp: finiteNum(e.ensembleUp),
    ruleUp: finiteNum(e.ruleUp),
    bestEdge: finiteNum(e.bestEdge),
    timeLeftMin: finiteNum(e.timeLeftMin),
    modelId: safeStr(e.modelId),
    reason: safeStr(e.reason),
    outcome: safeStr(a.outcome) ?? safeStr(x.outcome),
    actualOutcome: safeStr(a.actualOutcome) ?? safeStr(x.verifiedOutcome) ?? safeStr(x.outcome),
    exitSource: safeStr(x.verifiedSource) ?? safeStr(x.source),
    pnl: finiteNum(a.pnl),
    holdDurationSec: finiteNum(a.holdDurationSec),
    mlWasRight: typeof a.mlWasRight === 'boolean' ? a.mlWasRight : null,
    ruleWasRight: typeof a.ruleWasRight === 'boolean' ? a.ruleWasRight : null,
  };
}
