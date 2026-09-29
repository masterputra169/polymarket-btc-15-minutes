/**
 * Cross-site WebSocket hijacking guard. Browsers do not apply the same-origin policy to
 * WebSockets, so without a token any page the operator visits could drive a loopback-bound
 * status server (sellPosition / setBankroll / forceSettle).
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { originAllowed } from '../statusServer.ts';

const local = { authRequired: false, bindHost: '127.0.0.1' };

describe('originAllowed', () => {
  test('non-browser clients (no Origin) are fine', () => {
    expect(originAllowed(undefined, local)).toBe(true);
  });
  test('the local dashboard on any loopback origin is fine', () => {
    for (const o of ['http://localhost:3010', 'http://127.0.0.1:5173', 'http://[::1]:3010']) {
      expect(originAllowed(o, local)).toBe(true);
    }
  });
  test('a foreign page (or a DNS-rebinding one) is refused', () => {
    expect(originAllowed('https://evil.example', local)).toBe(false);
    expect(originAllowed('http://attacker.com:3099', local)).toBe(false);
    expect(originAllowed('null', local)).toBe(false);
    expect(originAllowed('http://localhost.evil.example', local)).toBe(false);
  });
  test('STATUS_ALLOWED_ORIGINS admits an explicit origin', () => {
    expect(originAllowed('https://dash.example', { ...local, allowed: 'https://dash.example/, http://x' })).toBe(true);
  });
  test('with a token the token is the credential, so Origin is not checked', () => {
    expect(originAllowed('https://evil.example', { authRequired: true, bindHost: '127.0.0.1' })).toBe(true);
  });
  test('an explicit unauthenticated off-host bind is the operator\'s choice', () => {
    expect(originAllowed('https://evil.example', { authRequired: false, bindHost: '0.0.0.0' })).toBe(true);
  });
});
