import { describe, test, expect } from 'vitest';
import { redactSecrets } from '../utils/redact.ts';

const env = {
  POLYGON_RPC_URL: 'https://polygon-mainnet.example.com/v2/abcdef0123456789abcdef0123456789',
  POLYMARKET_API_SECRET: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=',
  TELEGRAM_BOT_TOKEN: '123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK00',
  DATABASE_URL: 'postgresql://polymarket:hunter2hunter2@postgres:5432/polymarket',
  STATUS_BIND_HOST: '0.0.0.0',
  LOG_LEVEL: 'info',
};

describe('redactSecrets', () => {
  test('masks an RPC URL and the key part of it when a message quotes only that', () => {
    const msg = 'could not detect network (url=https://polygon-mainnet.example.com/v2/abcdef0123456789abcdef0123456789)';
    expect(redactSecrets(msg, env)).not.toContain('abcdef0123456789');
    expect(redactSecrets('GET /v2/abcdef0123456789abcdef0123456789 failed', env)).toBe('GET /v2/[REDACTED] failed');
  });

  test('masks env secret values wherever they appear', () => {
    expect(redactSecrets('bad sig c2VjcmV0LXNlY3JldC1zZWNyZXQ=', env)).toBe('bad sig [REDACTED]');
  });

  test('masks connection-string credentials, Telegram tokens and hex keys even outside the env', () => {
    expect(redactSecrets('connect postgres://bob:pw123456@db:5432/x refused', {})).toBe('connect postgres://[REDACTED]@db:5432/x refused');
    expect(redactSecrets('POST https://api.telegram.org/bot987654321:ZZZaaaBBBcccDDDeeeFFFgggHHHiiiJJJ00/sendMessage', {}))
      .toContain('/bot[REDACTED]/sendMessage');
    expect(redactSecrets(`key 0x${'ab'.repeat(32)} bad`, {})).toBe('key [REDACTED-HEX32] bad');
  });

  test('leaves ordinary text and non-secret env values alone', () => {
    expect(redactSecrets('bind 0.0.0.0 level info', env)).toBe('bind 0.0.0.0 level info');
    expect(redactSecrets('Position opened: UP 6 shares @ $0.605', env)).toBe('Position opened: UP 6 shares @ $0.605');
    expect(redactSecrets('', env)).toBe('');
  });
});
