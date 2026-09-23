/**
 * How much of the edge the model claims actually shows up in results.
 *
 * Found by hand on 2026-09-23 and now printed by the dry-run report: over 438
 * dry-run trades the model claimed 88% on the side it bought, won 68%, and the
 * price implied 64%. Realised edge was about a fifth of the claimed edge, and
 * as a predictor of UP/DOWN the market price beat the model outright. Neither
 * number is visible in a win rate.
 *
 * The ratio is also the evidence for KELLY_PROB_SHRINK: Kelly sizes on
 * price + shrink * (model - price), and realised/claimed edge is the shrink the
 * results support.
 */

export interface EdgeRow {
  /** Side bought. */
  side: 'UP' | 'DOWN';
  /** Price paid for that side, 0-1. */
  price: number;
  /** Model probability of UP at entry. */
  probUp: number;
  /** UP-token price at entry. */
  marketUp: number;
  /** Did UP resolve true. */
  upWon: boolean;
}

export interface EdgeRealism {
  n: number;
  /** Mean (model probability of the side bought - price paid), percentage points. */
  claimedEdgePp: number | null;
  /** Mean (won - price paid), percentage points. */
  realisedEdgePp: number | null;
  /** realised / claimed; null unless the claimed edge is positive. */
  ratio: number | null;
  /** Brier on UP/DOWN: model vs the UP price at entry. */
  modelBrier: number | null;
  marketBrier: number | null;
  /** 1 - model/market Brier. Negative = the price predicted better than the model. */
  skillVsMarket: number | null;
}

/** Below this, the ratio is printed but labelled too small to act on. */
export const MIN_ROWS_FOR_SHRINK = 100;

function valid(r: EdgeRow): boolean {
  return (r.side === 'UP' || r.side === 'DOWN')
    && [r.price, r.probUp, r.marketUp].every(v => Number.isFinite(v) && v > 0 && v < 1);
}

export function edgeRealism(rows: readonly EdgeRow[]): EdgeRealism {
  const ok = rows.filter(valid);
  const n = ok.length;
  if (n === 0) {
    return { n: 0, claimedEdgePp: null, realisedEdgePp: null, ratio: null, modelBrier: null, marketBrier: null, skillVsMarket: null };
  }
  let claimed = 0;
  let realised = 0;
  let modelBrier = 0;
  let marketBrier = 0;
  for (const r of ok) {
    const pSide = r.side === 'UP' ? r.probUp : 1 - r.probUp;
    const won = r.side === 'UP' ? r.upWon : !r.upWon;
    claimed += pSide - r.price;
    realised += (won ? 1 : 0) - r.price;
    const y = r.upWon ? 1 : 0;
    modelBrier += (r.probUp - y) ** 2;
    marketBrier += (r.marketUp - y) ** 2;
  }
  claimed /= n;
  realised /= n;
  modelBrier /= n;
  marketBrier /= n;
  return {
    n,
    claimedEdgePp: claimed * 100,
    realisedEdgePp: realised * 100,
    ratio: claimed > 0 ? realised / claimed : null,
    modelBrier,
    marketBrier,
    skillVsMarket: marketBrier > 0 ? 1 - modelBrier / marketBrier : null,
  };
}

/** The KELLY_PROB_SHRINK the results support, or null when there is too little to go on. */
export function suggestedShrink(e: EdgeRealism): number | null {
  if (e.n < MIN_ROWS_FOR_SHRINK || e.ratio == null) return null;
  return Math.max(0, Math.min(1, e.ratio));
}
