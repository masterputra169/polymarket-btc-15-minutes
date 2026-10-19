import { describe, it, expect, vi, afterEach } from 'vitest';
import { systemOne, isTypesafeConfigured, TypesafeError } from '../typesafeClient.ts';

const originalFetch = globalThis.fetch;
const originalKey = process.env.TYPESAFE_API_KEY;
const originalOrKey = process.env.OPENROUTER_API_KEY;
const originalProvider = process.env.JEV_PROVIDER;
const originalModel = process.env.JEV_MODEL;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  if (originalKey == null) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
  if (originalOrKey == null) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalOrKey;
  if (originalProvider == null) delete process.env.JEV_PROVIDER; else process.env.JEV_PROVIDER = originalProvider;
  if (originalModel == null) delete process.env.JEV_MODEL; else process.env.JEV_MODEL = originalModel;
});

describe('isTypesafeConfigured', () => {
  it('reflects the API key presence', () => {
    process.env.JEV_PROVIDER = 'typesafe';
    delete process.env.TYPESAFE_API_KEY;
    expect(isTypesafeConfigured()).toBe(false);
    expect(isTypesafeConfigured({ apiKey: 'k' })).toBe(true);
    process.env.TYPESAFE_API_KEY = 'env-key';
    expect(isTypesafeConfigured()).toBe(true);
  });
});

describe('systemOne', () => {
  it('sends the documented request shape and parses answers', async () => {
    process.env.JEV_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'test-key';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      model: 'jev-1.14.0',
      answers: {
        direction: { type: 'choice', choice: 'UP', probabilities: { UP: 0.7, DOWN: 0.2, NO_EDGE: 0.1 }, confidence: 0.55 },
        settle_above_ptb: { type: 'noul', noul: 0.68 },
      },
      usage: { input_tokens: 420, output_tokens: 18 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await systemOne({ state: { market: 'test' }, questions: { direction: { type: 'choice', instructions: 'q', criteria: { UP: 'u', DOWN: 'd' } } } });
    expect(res.model).toBe('jev-1.14.0');
    expect(res.answers.settle_above_ptb.type).toBe('noul');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.typesafe.ai/v1/systemone');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(call[1].body)) as { model: string; questions: Record<string, unknown> };
    expect(body.model).toBe('jev-latest');
    expect(Object.keys(body.questions)).toEqual(['direction']);
  });

  it('retries 429 once and then succeeds', async () => {
    process.env.JEV_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'test-key';
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { code: 'rate_limited' } });
      return jsonResponse(200, { model: 'jev-latest', answers: { ok: { type: 'noul', noul: 0.5 } } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await systemOne({ state: 's', questions: { ok: { type: 'noul', instructions: 'q' } } }, { maxAttempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.answers.ok.type).toBe('noul');
  });

  it('throws TypesafeError on 401 and on missing key', async () => {
    process.env.JEV_PROVIDER = 'typesafe';
    process.env.TYPESAFE_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: { code: 'unauthorized' } })));
    await expect(systemOne({ state: 's', questions: { q: { type: 'noul', instructions: 'q' } } })).rejects.toMatchObject({ status: 401 });
    delete process.env.TYPESAFE_API_KEY;
    await expect(systemOne({ state: 's', questions: { q: { type: 'noul', instructions: 'q' } } })).rejects.toBeInstanceOf(TypesafeError);
  });

  it('uses the OpenRouter System One endpoint when JEV_PROVIDER=openrouter', async () => {
    process.env.JEV_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.JEV_MODEL = 'typesafe/jev-1.14';
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      model: 'typesafe/jev-1.14',
      answers: { ok: { type: 'noul', noul: 0.61 } },
      usage: { input_tokens: 505, output_tokens: 0, cost: 0.0000212 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await systemOne({ state: 's', questions: { ok: { type: 'noul', instructions: 'q' } } });
    expect(res.model).toBe('typesafe/jev-1.14');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://openrouter.ai/api/v1/systemone');
    expect((call[1].headers as Record<string, string>).authorization).toBe('Bearer or-key');
    const body = JSON.parse(String(call[1].body)) as { model: string };
    expect(body.model).toBe('typesafe/jev-1.14');
  });
});

