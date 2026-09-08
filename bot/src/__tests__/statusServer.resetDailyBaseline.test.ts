/**
 * Operator RPC: resetDailyBaseline.
 *
 * Measured 2026-09-08 on Railway: a corrected settlement from the previous
 * day left startOfDayBankroll wrong, the daily-loss circuit breaker halted the
 * bot, and there was no way to lift it short of editing state.json on the
 * volume. The status socket (token-gated) now exposes the same reset the
 * cooldown expiry performs.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const PORT = 3199;
process.env.STATUS_PORT = String(PORT);
process.env.STATUS_HOST = '127.0.0.1';
delete process.env.STATUS_AUTH_TOKEN;
delete process.env.STATUS_CONTROL_TOKEN;
delete process.env.BOT_STATUS_TOKEN;

import { startStatusServer, stopStatusServer, registerBotControl } from '../statusServer.ts';

function rpc(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('rpc timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify(msg));
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.type !== 'response') return; // state broadcasts
      clearTimeout(timer); ws.close(); resolve(data);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

beforeAll(() => { startStatusServer(); });
afterAll(() => { stopStatusServer(); });

describe('resetDailyBaseline RPC', () => {
  test('reports not_registered until index.ts wires the callback', async () => {
    registerBotControl(vi.fn(), vi.fn(), null, null);
    const r = await rpc({ type: 'resetDailyBaseline' });
    expect(r).toEqual({ type: 'response', cmd: 'resetDailyBaseline', data: { ok: false, error: 'not_registered' } });
  });

  test('invokes the registered reset and acknowledges', async () => {
    const reset = vi.fn();
    registerBotControl(vi.fn(), vi.fn(), null, reset);
    await new Promise(r => setTimeout(r, 2100)); // control rate limit is 2s
    const r = await rpc({ type: 'resetDailyBaseline' });
    expect(r).toEqual({ type: 'response', cmd: 'resetDailyBaseline', data: { ok: true } });
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
