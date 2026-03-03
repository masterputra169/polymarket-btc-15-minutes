import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('OrderRouter');

/**
 * Smart Order Router — decides LIMIT vs FOK vs WAIT.
 *
 * Decision matrix:
 *   ┌─────────────────┬──────────────┬───────────────┬──────────────┐
 *   │                  │ ML < 70%     │ ML 70-87%     │ ML ≥ 88%     │
 *   ├─────────────────┼──────────────┼───────────────┼──────────────┤
 *   │ Ask ≤ 55¢       │ LIMIT        │ FOK           │ FOK          │
 *   │ Ask 55-62¢      │ LIMIT        │ LIMIT         │ FOK          │
 *   │ Ask > 62¢       │ WAIT         │ LIMIT only    │ FOK          │
 *   └─────────────────┴──────────────┴───────────────┴──────────────┘
 */
export function routeOrder({ bestAsk, mlConf, elapsedMin, delta1m, mlSide, regime }) {
  const cfg = BOT_CONFIG.orderRouter;
  if (!cfg?.enabled) return { route: 'LIMIT', reason: 'router_disabled' };
  if (bestAsk == null || mlConf == null) return { route: 'LIMIT', reason: 'no_data' };

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

  // Rule 1: Very high ML + reasonable price → FOK immediately
  if (mlConf >= cfg.fokMlThreshold && bestAsk <= cfg.fokMaxPrice) {
    return { route: 'FOK', reason: `ml${(mlConf * 100) | 0}%≥${(cfg.fokMlThreshold * 100) | 0}%+ask${(bestAsk * 100) | 0}¢` };
  }

  // Rule 2: Price already cheap + decent ML → FOK (already at limit target levels)
  if (bestAsk <= cfg.cheapPriceThreshold && mlConf >= cfg.cheapMlThreshold) {
    return { route: 'FOK', reason: `cheap${(bestAsk * 100) | 0}¢+ml${(mlConf * 100) | 0}%` };
  }

  // Rule 3: Strong momentum in signal direction → FOK (price moving away from limit)
  if (delta1m != null && mlSide != null) {
    const aligned = (mlSide === 'UP' && delta1m > cfg.momentumThreshold) ||
                    (mlSide === 'DOWN' && delta1m < -cfg.momentumThreshold);
    if (aligned && mlConf >= 0.72 && bestAsk <= 0.62) {
      return { route: 'FOK', reason: `momentum${delta1m > 0 ? '+' : ''}${delta1m.toFixed(0)}+ml${(mlConf * 100) | 0}%` };
    }
  }

  // Rule 4: Early market + moderate ML → LIMIT (get price improvement via discount)
  if (elapsedMin <= BOT_CONFIG.limitOrder.maxElapsedMin && mlConf >= 0.60) {
    return { route: 'LIMIT', reason: `early${elapsedMin.toFixed(1)}m+ml${(mlConf * 100) | 0}%` };
  }

  return { route: 'WAIT', reason: `ml${(mlConf * 100) | 0}%_ask${bestAsk != null ? (bestAsk * 100) | 0 + '¢' : '?'}` };
}
