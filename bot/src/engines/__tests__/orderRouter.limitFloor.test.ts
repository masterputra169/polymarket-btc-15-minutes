/**
 * OrderRouter ML-floor alignment (ROUTER_LIMIT_ML).
 *
 * Root cause observed in dry-run (2026-11-15, btc-updown-15m-1794712500):
 * tradeFilters relaxes the ML floor to 45% on high-edge entries (edge >= 15%),
 * letting 48% and 53% signals pass, yet orderRouter Rules 5 & 7 hardcoded
 * mlConf >= 0.65. Those signals fell through to WAIT -> fok_limit taker.
 * Aligning limitMlThreshold to 0.45 routes qualified 45%-64% entries to LIMIT.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadRouter(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { BOT_CONFIG } = await import('../../config.ts');
  const { routeOrder } = await import('../orderRouter.ts');
  return { BOT_CONFIG, routeOrder };
}

describe('orderRouter ROUTER_LIMIT_ML alignment', () => {
  const sampleSignal = {
    bestAsk: 0.58,
    mlConf: 0.48,
    elapsedMin: 2.38,
    delta1m: 0,
    mlSide: 'UP',
    regime: 'moderate',
    spread: 0.01,
    btcPrice: 95_000,
  };

  test('default limitMlThreshold (0.45) routes 48%-53% high-edge signals to LIMIT instead of WAIT', async () => {
    const { BOT_CONFIG, routeOrder } = await loadRouter({ LIMIT_MAX_ELAPSED_MIN: '12' });
    expect(BOT_CONFIG.orderRouter.limitMlThreshold).toBe(0.45);
    expect(routeOrder(sampleSignal).route).toBe('LIMIT');
    expect(routeOrder({ ...sampleSignal, mlConf: 0.53 }).route).toBe('LIMIT');
    expect(routeOrder({ ...sampleSignal, mlConf: 0.44 }).route).toBe('WAIT');
  });

  test('wide-spread Rule 5 honours ROUTER_LIMIT_ML override', async () => {
    const { routeOrder } = await loadRouter({
      ROUTER_LIMIT_ML: '0.45',
      LIMIT_MAX_ELAPSED_MIN: '12',
    });
    const wide = routeOrder({ ...sampleSignal, mlConf: 0.48, spread: 0.04 });
    expect(wide.route).toBe('LIMIT');
    expect(wide.reason).toContain('wide+ml48%');
  });

  test('raising ROUTER_LIMIT_ML=0.65 restores legacy WAIT behaviour below 65%', async () => {
    const { BOT_CONFIG, routeOrder } = await loadRouter({
      ROUTER_LIMIT_ML: '0.65',
      LIMIT_MAX_ELAPSED_MIN: '12',
    });
    expect(BOT_CONFIG.orderRouter.limitMlThreshold).toBe(0.65);
    expect(routeOrder(sampleSignal).route).toBe('WAIT');
    expect(routeOrder({ ...sampleSignal, mlConf: 0.65 }).route).toBe('LIMIT');
  });

  test('choppy regime enforces >= 40% ML floor even when ROUTER_LIMIT_ML is lowered to 0.30', async () => {
    const { routeOrder } = await loadRouter({
      ROUTER_LIMIT_ML: '0.30',
      LIMIT_MAX_ELAPSED_MIN: '12',
    });
    const blocked = routeOrder({ ...sampleSignal, regime: 'choppy', mlConf: 0.36 });
    expect(blocked.route).toBe('WAIT');
    expect(blocked.reason).toBe('choppy+ml36%<40%');

    const allowed = routeOrder({ ...sampleSignal, regime: 'choppy', mlConf: 0.40 });
    expect(allowed.route).toBe('LIMIT');
  });
});
