import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const PASSWORD = 'test-operator-password';
const SECRET = 'x'.repeat(64);
let child: ChildProcess | null = null;
let base = '';

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

beforeAll(async () => {
  const salt = randomBytes(16);
  const hash = scryptSync(PASSWORD, salt, 64).toString('hex');
  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [resolve('scripts/dashboard-auth-server.mjs')], {
    env: {
      ...process.env,
      AUTH_PORT: String(port),
      AUTH_BIND: '127.0.0.1',
      AUTH_INSECURE_COOKIE: 'true',
      DASHBOARD_PASSWORD_HASH: 'scrypt$' + salt.toString('hex') + '$' + hash,
      AUTH_SESSION_SECRET: SECRET,
      AUTH_TTL_SECONDS: '3600',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('auth server did not start');
});

afterAll(() => {
  child?.kill('SIGTERM');
  child = null;
});

async function login(password: string) {
  return fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

describe('dashboard auth gateway', () => {
  test('rejects a wrong password without a session cookie', async () => {
    const r = await login('wrong');
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  test('sets a session cookie, validates /me, and invalidates on logout', async () => {
    const r = await login(PASSWORD);
    expect(r.status).toBe(200);
    const cookie = r.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toMatch(/^btc15_session=/);

    const me = await fetch(base + '/me', { headers: { Cookie: cookie! } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ ok: true });

    const logout = await fetch(base + '/logout', { method: 'POST', headers: { Cookie: cookie! } });
    expect(logout.status).toBe(200);

    const after = await fetch(base + '/me', { headers: { Cookie: cookie! } });
    expect(after.status).toBe(401);
  });

  test('rejects a tampered session token', async () => {
    const r = await login(PASSWORD);
    const cookie = r.headers.get('set-cookie')!.split(';')[0];
    const tampered = cookie.slice(0, -2) + 'xx';
    const me = await fetch(base + '/me', { headers: { Cookie: tampered } });
    expect(me.status).toBe(401);
  });
});
