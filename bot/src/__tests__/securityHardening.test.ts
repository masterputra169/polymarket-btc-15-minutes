import { describe, test, expect } from 'vitest';
import { parseRss } from '../monitoring/globalRisk.ts';
import { MAX_X402_PAYMENT_ATOMIC, validateX402Payment } from '../engines/metEngineClient.ts';

describe('security hardening regressions', () => {
  test('parseRss drops non-http(s) links and keeps valid https links', () => {
    const xml = [
      '<item><title>Bitcoin ETF shock</title><link>javascript:alert(1)</link><pubDate>Mon, 17 Nov 2026 00:00:00 GMT</pubDate></item>',
      '<item><title>Fed liquidity</title><link>https://news.example.com/fed</link><pubDate>Mon, 17 Nov 2026 01:00:00 GMT</pubDate></item>',
    ].join('');
    const items = parseRss(xml, 'Feed');
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('');
    expect(items[1].url).toBe('https://news.example.com/fed');
  });

  test('validateX402Payment enforces per-call USDC atomic cap', () => {
    expect(validateX402Payment({ accepts: [{ amount: String(MAX_X402_PAYMENT_ATOMIC) }] })).toBe(true);
    expect(validateX402Payment({ accepts: [{ maxAmountRequired: '50000' }] })).toBe(true);
    expect(validateX402Payment({ accepts: [{ amount: '50001' }] })).toBe(false);
    expect(validateX402Payment({ accepts: [{ amount: '50000' }, { amount: '999999999' }] })).toBe(false);
    expect(validateX402Payment({ accepts: [{ amount: '0' }] })).toBe(false);
    expect(validateX402Payment({ accepts: [{ amount: 'abc' }] })).toBe(false);
    expect(validateX402Payment({ accepts: [] })).toBe(false);
  });
});
