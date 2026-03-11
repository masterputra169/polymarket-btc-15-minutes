import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('OrderRouter');

/**
 * Smart Order Router v3 — LIMIT-first strategy (LIMIT 81% WR >> FOK 71%).
 *
 * 7-rule decision tree biased toward LIMIT orders. FOK only for very-high ML + cheap price.
 *
 * Decision matrix:
 *   ┌─────────────────┬──────────────┬──────────────────────┬──────────────┐
 *   │                  │ ML < 65%     │ ML 65-87%            │ ML ≥ 88%     │
 *   ├─────────────────┼──────────────┼──────────────────────┼──────────────┤
 *   │ Ask ≤ 52¢       │ WAIT         │ FOK (cheap, Rule 2)  │ FOK (Rule 1) │
 *   │ Ask 52-58¢      │ WAIT         │ LIMIT (most cases)*  │ FOK (Rule 1) │
 *   │ Ask > 58¢       │ WAIT         │ LIMIT/WAIT           │ LIMIT/WAIT   │
 *   └─────────────────┴──────────────┴──────────────────────┴──────────────┘
 *
 *   * ML 65-87% + 52-58¢ → mostly LIMIT:
 *     Spread < 3% + ML ≥ 80% → FOK (Rule 4) — tight book, limit useless, only high ML
 *     Spread ≥ 3%            → LIMIT (Rule 5) — real discount available
 *     Trending + ML ≥ 80%    → FOK (Rule 6) — momentum, but only high ML
 *     Strong momentum+ML≥80% → FOK (Rule 3) — price moving away, high ML only
 *     Default                → LIMIT (Rule 7) — preferred route
 */
export function routeOrder({ bestAsk, mlConf, elapsedMin, delta1m, mlSide, regime, spread, btcPrice }) {
  const cfg = BOT_CONFIG.orderRouter;
  if (!cfg?.enabled) return { route: 'LIMIT', reason: 'router_disabled' };
  if (bestAsk == null || mlConf == null) return { route: 'LIMIT', reason: 'no_data' };

  // ── GATES ──

  // Price floor — tokens below limit minEntryPrice are priced low because market
  // expects them to lose, not because they're a discount. Don't route these.
  const minPrice = BOT_CONFIG.limitOrder.minEntryPrice ?? 0.50;
  if (bestAsk < minPrice) {
    return { route: 'WAIT', reason: `price${(bestAsk * 100) | 0}¢<floor${(minPrice * 100) | 0}¢` };
  }

  // Past limit window → FOK only
  if (elapsedMin > BOT_CONFIG.limitOrder.maxElapsedMin) {
    return { route: 'FOK', reason: 'past_limit_window' };
  }

  // ── RULES (first match wins) ──

  // Trending premium: in trending regime, allow higher FOK entry prices.
  // At 75¢ with v16 ≥80% WR = 99.3%: EV = 0.993×$0.25 - 0.007×$0.75 = +$0.243/token.
  // Even conservatively at 85% live WR: 0.85×$0.25 - 0.15×$0.75 = +$0.10/token.
  const isTrending = regime === 'trending';
  const maxPrice = isTrending ? (cfg.fokMaxPriceTrending ?? cfg.fokMaxPrice) : cfg.fokMaxPrice;

  // Rule 1: ML ≥ 80% + reasonable price → FOK immediately
  // v16 at ≥80% = 99.3% WR — no reason to wait for limit discount
  if (mlConf >= cfg.fokMlThreshold && bestAsk <= maxPrice) {
    const trendTag = isTrending && bestAsk > cfg.fokMaxPrice ? '+trend_premium' : '';
    return { route: 'FOK', reason: `ml${(mlConf * 100) | 0}%≥${(cfg.fokMlThreshold * 100) | 0}%+ask${(bestAsk * 100) | 0}¢${trendTag}` };
  }

  // Rule 2: Price already cheap + decent ML → FOK (already at limit target levels)
  if (bestAsk <= cfg.cheapPriceThreshold && mlConf >= cfg.cheapMlThreshold) {
    return { route: 'FOK', reason: `cheap${(bestAsk * 100) | 0}¢+ml${(mlConf * 100) | 0}%` };
  }

  // Rule 3: Strong momentum in signal direction → FOK (price moving away from limit)
  // v3: raised ML gate 0.72→0.80 — only FOK on momentum when ML is strong
  if (delta1m != null && mlSide != null && btcPrice > 0) {
    const momentumThreshold = btcPrice * cfg.momentumRelThreshold;
    const aligned = (mlSide === 'UP' && delta1m > momentumThreshold) ||
                    (mlSide === 'DOWN' && delta1m < -momentumThreshold);
    if (aligned && mlConf >= 0.80 && bestAsk <= maxPrice) {
      const bps = Math.abs(delta1m / btcPrice * 10000).toFixed(1);
      const trendTag = isTrending && bestAsk > cfg.fokMaxPrice ? '+trend_premium' : '';
      return { route: 'FOK', reason: `mom${bps}bps+ml${(mlConf * 100) | 0}%${trendTag}` };
    }
  }

  // Rule 4: Narrow spread + high ML → FOK (limit gives no discount)
  // v3: raised ML gate 0.70→0.80 — tight spread alone isn't enough, need strong ML for FOK
  if (spread != null && spread < cfg.spreadNarrowThreshold && mlConf >= 0.80 && bestAsk <= maxPrice) {
    const trendTag = isTrending && bestAsk > cfg.fokMaxPrice ? '+trend_premium' : '';
    return { route: 'FOK', reason: `spread${(spread * 100).toFixed(1)}%<${(cfg.spreadNarrowThreshold * 100) | 0}%narrow+ml${(mlConf * 100) | 0}%${trendTag}` };
  }

  // Rule 5: Wide spread + moderate ML + in window → LIMIT (real discount potential)
  // In trending regime, skip LIMIT — limit orders don't fill during pumps
  if (!isTrending && spread != null && spread >= cfg.spreadWideThreshold && mlConf >= 0.65 && elapsedMin <= BOT_CONFIG.limitOrder.maxElapsedMin) {
    return { route: 'LIMIT', reason: `spread${(spread * 100).toFixed(1)}%≥${(cfg.spreadWideThreshold * 100) | 0}%wide+ml${(mlConf * 100) | 0}%` };
  }

  // Rule 6: Trending regime + high ML → FOK (momentum means limit chasing)
  // v3: raised ML gate 0.68→0.78 — even trending should prefer LIMIT unless ML is strong
  if (isTrending && mlConf >= 0.78 && bestAsk <= maxPrice) {
    const trendTag = bestAsk > cfg.fokMaxPrice ? '+trend_premium' : '';
    return { route: 'FOK', reason: `trending+ml${(mlConf * 100) | 0}%${trendTag}` };
  }

  // Rule 7: Moderate ML + in window → LIMIT (default case, get discount)
  if (mlConf >= 0.65 && elapsedMin <= BOT_CONFIG.limitOrder.maxElapsedMin) {
    return { route: 'LIMIT', reason: `ml${(mlConf * 100) | 0}%+window${elapsedMin.toFixed(1)}m` };
  }

  return { route: 'WAIT', reason: `ml${(mlConf * 100) | 0}%_ask${bestAsk != null ? (bestAsk * 100) | 0 + '¢' : '?'}` };
}
