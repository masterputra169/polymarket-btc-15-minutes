/**
 * /health on the report API must answer without a token.
 *
 * Railway's deploy healthcheck (and any uptime prober) cannot send a bearer
 * token, and the report API is the bot's only HTTP listener. Until now
 * /health sat behind isAuthorized(), so an unauthenticated probe got 401 and
 * the deployment would be marked unhealthy. The endpoint reveals only "ok"
 * and a timestamp; everything under /reports stays token-gated.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const PORT = 30000 + Math.floor(Math.random() * 20000);
const ORIGINAL_ENV = { ...process.env };

beforeAll(async () => {
  process.env.REPORT_SERVER_ENABLED = 'true';
  process.env.REPORT_BIND_HOST = '127.0.0.1';
  process.env.REPORT_PORT = String(PORT);
  process.env.REPORT_AUTH_TOKEN = 'test-secret-token';
  // A pool is created lazily; no connection is attempted until a query runs.
  process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/none';
  const { startReportServer } = await import('../reportServer.ts');
  startReportServer();
  await new Promise(r => setTimeout(r, 150));
});

afterAll(async () => {
  const { stopReportServer } = await import('../reportServer.ts');
  await stopReportServer();
  process.env = { ...ORIGINAL_ENV };
});

describe('report API /health', () => {
  test('answers 200 without any token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('report-api');
  });

  test('/reports still requires the token', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/reports`);
    expect(res.status).toBe(401);
  });
});
