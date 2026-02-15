export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function formatNumber(x, digits = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return '-';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(x);
}

export function formatPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(x)) return '-';
  return `${(x * 100).toFixed(digits)}%`;
}

export function formatProbPct(p, digits = 0) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return '-';
  return `${(Number(p) * 100).toFixed(digits)}%`;
}

export function getCandleWindowTiming(windowMinutes) {
  const nowMs = Date.now();
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  const elapsedMs = nowMs - startMs;
  const remainingMs = endMs - nowMs;
  return {
    startMs,
    endMs,
    elapsedMs,
    remainingMs,
    elapsedMinutes: elapsedMs / 60_000,
    remainingMinutes: remainingMs / 60_000,
  };
}

export function fmtTimeLeft(mins) {
  const totalSeconds = Math.max(0, Math.floor(mins * 60));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function fmtEtTime(now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return '-';
  }
}

export function getBtcSession(now = new Date()) {
  const h = now.getUTCHours();
  const inAsia = h >= 0 && h < 8;
  const inEurope = h >= 7 && h < 16;
  const inUs = h >= 13 && h < 22;

  if (inEurope && inUs) return 'Europe/US Overlap';
  if (inAsia && inEurope) return 'Asia/Europe Overlap';
  if (inAsia) return 'Asia';
  if (inEurope) return 'Europe';
  if (inUs) return 'US';
  return 'Off-hours';
}

export function formatSignedDelta(delta, base) {
  if (delta === null || base === null || base === 0) return '-';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const pct = (Math.abs(delta) / Math.abs(base)) * 100;
  return `${sign}$${Math.abs(delta).toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

export function narrativeFromSign(x) {
  if (x === null || x === undefined || !Number.isFinite(Number(x)) || Number(x) === 0) return 'NEUTRAL';
  return Number(x) > 0 ? 'LONG' : 'SHORT';
}

export function narrativeFromRsi(rsi) {
  if (rsi === null || rsi === undefined || !Number.isFinite(Number(rsi))) return 'NEUTRAL';
  const v = Number(rsi);
  if (v >= 55) return 'LONG';
  if (v <= 45) return 'SHORT';
  return 'NEUTRAL';
}

export function narrativeFromSlope(slope) {
  if (slope === null || slope === undefined || !Number.isFinite(Number(slope)) || Number(slope) === 0) return 'NEUTRAL';
  return Number(slope) > 0 ? 'LONG' : 'SHORT';
}

export function getSessionName() {
  const h = new Date().getUTCHours();
  if (h >= 13 && h < 16) return 'EU/US Overlap';
  if (h >= 13 && h < 22) return 'US';
  if (h >= 8 && h < 16) return 'Europe';
  if (h >= 0 && h < 8) return 'Asia';
  return 'Off-hours';
}

/**
 * Shallow-compare two flat objects.
 * Returns true if any top-level primitive value changed.
 * Object values are compared by reference (skipped if same ref).
 */
export function shallowChanged(prev, next) {
  if (prev === null || prev === undefined) return true;
  const nextKeys = Object.keys(next);
  for (let i = 0; i < nextKeys.length; i++) {
    if (prev[nextKeys[i]] !== next[nextKeys[i]]) return true;
  }
  // Check for removed keys (prev has keys that next doesn't)
  const prevKeys = Object.keys(prev);
  if (prevKeys.length !== nextKeys.length) return true;
  return false;
}

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export { toNumber };

/**
 * ═══ Parse "Price to Beat" from Polymarket market data ═══
 * 
 * Strategy (in priority order):
 * 1. Parse from market question/description (e.g. "$66,500.00")
 * 2. Use market's custom fields (startPrice, referencePrice, etc.)
 * 3. Fall back to klines open price at market start time
 */
// BTC sanity range for PTB validation — prevents wrong parse if format changes
const PTB_MIN_BTC = 10_000;   // BTC unlikely below $10K
const PTB_MAX_BTC = 500_000;  // BTC unlikely above $500K (adjust if needed)

export function parsePriceToBeat(text) {
  if (!text || typeof text !== 'string') return null;

  // Match dollar amounts like $66,500.00 or $100,000 or $67123.45
  const matches = text.match(/\$[\d,]+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;

  const raw = matches[0].replace(/[$,]/g, '');
  const num = Number(raw);
  // Sanity check: must be in plausible BTC price range
  return Number.isFinite(num) && num >= PTB_MIN_BTC && num <= PTB_MAX_BTC ? num : null;
}

/**
 * Extract Price to Beat from Polymarket market object.
 * Tries multiple fields and strategies.
 */
export function extractPriceToBeat(market, klines) {
  if (!market) return null;

  // 1. Try parsing from question text
  const fromQuestion = parsePriceToBeat(market.question);
  if (fromQuestion !== null) return fromQuestion;

  // 2. Try parsing from title
  const fromTitle = parsePriceToBeat(market.title);
  if (fromTitle !== null) return fromTitle;

  // 3. Try parsing from description
  const fromDesc = parsePriceToBeat(market.description);
  if (fromDesc !== null) return fromDesc;

  // 4. Try dedicated fields that Polymarket might use
  const directFields = [
    market.startPrice,
    market.referencePrice,
    market.strikePrice,
    market.openPrice,
    market.priceToBeat,
    market.targetPrice,
  ];
  for (const val of directFields) {
    const n = Number(val);
    if (Number.isFinite(n) && n >= PTB_MIN_BTC && n <= PTB_MAX_BTC) return n;
  }

  // 5. Try parsing from any string field that contains a BTC-like price
  // parsePriceToBeat already applies BTC range check
  const allStrFields = [market.slug, market.groupItemTitle];
  for (const field of allStrFields) {
    const parsed = parsePriceToBeat(String(field ?? ''));
    if (parsed !== null) return parsed;
  }

  // 6. Fall back to klines: find the candle at market start time, use its open price
  const startTime = market.eventStartTime ?? market.startTime ?? market.startDate;
  if (startTime && Array.isArray(klines) && klines.length > 0) {
    const startMs = new Date(startTime).getTime();
    if (Number.isFinite(startMs)) {
      // Find closest 1-min candle to market start
      let best = null;
      let bestDiff = Infinity;
      for (const c of klines) {
        const diff = Math.abs(c.openTime - startMs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }
      // Only use if within 2 minutes of start time + BTC range check
      if (best && bestDiff < 120_000 && best.open >= PTB_MIN_BTC && best.open <= PTB_MAX_BTC) {
        return best.open;
      }
    }
  }

  return null;
}