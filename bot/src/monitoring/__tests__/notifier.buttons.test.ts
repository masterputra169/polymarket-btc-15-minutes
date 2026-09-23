/**
 * Telegram inline buttons: View Market, View Profile, View Web.
 *
 * 2026-09-23 — every alert gains a third button that opens the deployed
 * dashboard, below the existing two. Two properties matter more than the
 * button itself:
 *
 *   - The link carries no botStatusToken. That token also authorises control
 *     commands (pause, setBankroll, sellPosition, forceSettle); a Telegram
 *     message can be forwarded, so it must never ride along in a URL.
 *   - A bad DASHBOARD_URL drops the button, not the alert. Telegram rejects a
 *     whole sendMessage (400) when any inline button carries an invalid URL,
 *     so an unchecked typo would silently swallow every critical notification.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const RAILWAY_DASHBOARD = 'https://frontend-production-d0bf1.up.railway.app';
const MARKET_LINK = '\n<a href="https://polymarket.com/event/btc-updown-15m-1788980400">View Market</a>';

async function loadNotifier(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../notifier.ts');
}

type Button = { text: string; url: string };
const rowsOf = (kb: { inline_keyboard: Button[][] }) => kb.inline_keyboard.map(row => row.map(b => b.text));
const flat = (kb: { inline_keyboard: Button[][] }) => kb.inline_keyboard.flat();

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inline keyboard layout', () => {
  test('View Web sits on its own row below View Market and View Profile', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: undefined });
    const { cleanText, inlineKeyboard } = extractInlineButton(`ENTRY UP @ $0.630${MARKET_LINK}`);

    expect(cleanText).toBe('ENTRY UP @ $0.630');
    expect(rowsOf(inlineKeyboard)).toEqual([
      ['🔗 View Market'],
      ['📊 View Profile'],
      ['🌐 View Web'],
    ]);
  });

  test('a message without a market link still gets Profile then Web', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: undefined });
    const { inlineKeyboard } = extractInlineButton('Circuit breaker: daily loss 15%');

    expect(rowsOf(inlineKeyboard)).toEqual([['📊 View Profile'], ['🌐 View Web']]);
  });

  test('defaults to the Railway dashboard', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: undefined });
    const web = flat(extractInlineButton('x').inlineKeyboard).find(b => b.text === '🌐 View Web');

    expect(web?.url).toBe(RAILWAY_DASHBOARD);
  });
});

describe('DASHBOARD_URL', () => {
  test('overrides the default', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: 'https://dash.example.com/' });
    const web = flat(extractInlineButton('x').inlineKeyboard).find(b => b.text === '🌐 View Web');

    expect(web?.url).toBe('https://dash.example.com/');
  });

  test('is read at send time, so env loaded after import still applies', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: undefined });
    process.env.DASHBOARD_URL = 'https://late.example.com';
    const web = flat(extractInlineButton('x').inlineKeyboard).find(b => b.text === '🌐 View Web');

    expect(web?.url).toBe('https://late.example.com');
  });

  test.each([
    ['not a url', 'frontend-production-d0bf1'],
    ['wrong scheme', 'javascript:alert(1)'],
    ['ftp', 'ftp://dash.example.com'],
  ])('an invalid value (%s) drops the Web button but keeps the others', async (_label, value) => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: value });
    const { inlineKeyboard } = extractInlineButton(`x${MARKET_LINK}`);

    expect(rowsOf(inlineKeyboard)).toEqual([['🔗 View Market'], ['📊 View Profile']]);
  });

  test('a bare host without a scheme is accepted as https', async () => {
    const { extractInlineButton } = await loadNotifier({ DASHBOARD_URL: 'frontend-production-d0bf1.up.railway.app' });
    const web = flat(extractInlineButton('x').inlineKeyboard).find(b => b.text === '🌐 View Web');

    expect(web?.url).toBe(RAILWAY_DASHBOARD);
  });
});

describe('the dashboard link never carries the status token', () => {
  test('STATUS_AUTH_TOKEN stays out of every button URL', async () => {
    const token = 'a'.repeat(64);
    const { extractInlineButton } = await loadNotifier({ STATUS_AUTH_TOKEN: token, DASHBOARD_URL: undefined });
    const urls = flat(extractInlineButton(`x${MARKET_LINK}`).inlineKeyboard).map(b => b.url);

    for (const url of urls) {
      expect(url).not.toContain(token);
      expect(url).not.toContain('botStatusToken');
    }
  });
});

describe('notify() sends the keyboard to Telegram', () => {
  test('the sendMessage payload carries all three buttons in order', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { notify } = await loadNotifier({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_CHAT_ID: '12345',
      DISCORD_WEBHOOK_URL: undefined,
      DASHBOARD_URL: undefined,
    });

    await notify('info', `SETTLED WIN +$0.37${MARKET_LINK}`, { key: 'test:buttons' });

    const telegramCall = fetchMock.mock.calls.find(([url]) => String(url).includes('api.telegram.org'));
    expect(telegramCall).toBeDefined();
    const payload = JSON.parse(String((telegramCall![1] as RequestInit).body));
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).not.toContain('<a href');
    expect(rowsOf(payload.reply_markup)).toEqual([
      ['🔗 View Market'],
      ['📊 View Profile'],
      ['🌐 View Web'],
    ]);
    expect(payload.reply_markup.inline_keyboard[2][0].url).toBe(RAILWAY_DASHBOARD);
  });
});
