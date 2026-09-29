import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getBotStatusToken } from '../botWsUrl.ts';

// The status token also authorises control commands (sellPosition, setBankroll, forceSettle).
// After the first visit with ?botStatusToken=… it is kept in localStorage and must leave the
// address bar: history, screenshots, shared links and Referer headers all carry the URL.
function stubBrowser(href: string) {
  const url = new URL(href);
  const store = new Map<string, string>();
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { href: url.href, search: url.search }, history: { replaceState } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  });
  return { store, replaceState };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('getBotStatusToken', () => {
  it('stores the token from the URL and removes it from the address bar', () => {
    const { store, replaceState } = stubBrowser('https://dash.example/app?botStatusToken=s3cret&tab=positions#top');
    expect(getBotStatusToken()).toBe('s3cret');
    expect(store.get('botStatusToken')).toBe('s3cret');
    expect(replaceState).toHaveBeenCalledTimes(1);
    const cleaned = replaceState.mock.calls[0][2] as string;
    expect(cleaned).not.toContain('s3cret');
    expect(cleaned).toBe('/app?tab=positions#top'); // other params and the hash survive
  });

  it('every alias of the parameter is removed', () => {
    const { replaceState } = stubBrowser('https://dash.example/?botToken=aaa&statusToken=bbb');
    expect(getBotStatusToken()).toBe('aaa');
    expect(replaceState.mock.calls[0][2]).toBe('/');
  });

  it('reads the stored token afterwards without touching the URL', () => {
    const { store, replaceState } = stubBrowser('https://dash.example/');
    store.set('botStatusToken', 'stored');
    expect(getBotStatusToken()).toBe('stored');
    expect(replaceState).not.toHaveBeenCalled();
  });
});
