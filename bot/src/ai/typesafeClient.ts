/**
 * TypeSafe / JEV client - POST /v1/systemone.
 *
 * JEV (TypeSafe's System One model) takes a state plus typed questions and
 * returns structured answers: choice + probabilities + confidence, noul 0..1,
 * score. Docs: https://docs.typesafe.ai/api
 *
 * Read-only decision model: this client never places orders. It throws
 * TypesafeError on failure; callers must catch (the loop wrapper does).
 */
import { createLogger } from '../logger.ts';

const log = createLogger('TypeSafe');

export type TypesafeInstructions = string | Record<string, unknown> | unknown[];

export type TypesafeQuestion =
  | { type: 'noul'; instructions: TypesafeInstructions; criteria?: { true?: TypesafeInstructions; false?: TypesafeInstructions } }
  | { type: 'choice'; instructions: TypesafeInstructions; criteria: Record<string, TypesafeInstructions | null> }
  | { type: 'score'; instructions: TypesafeInstructions; criteria: TypesafeInstructions[] };

export interface TypesafeNoulAnswer { type: 'noul'; noul: number }
export interface TypesafeChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface TypesafeScoreAnswer { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export type TypesafeAnswer = TypesafeNoulAnswer | TypesafeChoiceAnswer | TypesafeScoreAnswer;

export interface TypesafeRequest {
  state: unknown;
  questions: Record<string, TypesafeQuestion>;
  model?: string;
}

export interface TypesafeResponse {
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export interface TypesafeOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export class TypesafeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 0, code = 'error') {
    super(message);
    this.name = 'TypesafeError';
    this.status = status;
    this.code = code;
  }
}

export type JevProvider = 'openrouter' | 'typesafe';

export interface JevProviderConfig {
  provider: JevProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  configured: boolean;
}

function envIntBounded(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve the configured provider. JEV is available through OpenRouter's
 * System One API (POST https://openrouter.ai/api/v1/systemone) with an
 * OpenRouter key, or directly from TypeSafe (POST /v1/systemone).
 * The request body is identical; only base URL, key and model id differ.
 */
export function resolveJevProviderConfig(): JevProviderConfig {
  const rawProvider = (process.env.JEV_PROVIDER || 'openrouter').trim().toLowerCase();
  const provider: JevProvider = rawProvider === 'typesafe' ? 'typesafe' : 'openrouter';
  if (provider === 'openrouter') {
    const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
    const baseUrl = (process.env.JEV_OPENROUTER_BASE_URL || 'https://openrouter.ai/api').replace(/\/+$/, '');
    const model = (process.env.JEV_MODEL || 'typesafe/jev-1.14').trim();
    return { provider, apiKey, baseUrl, model, configured: apiKey.length > 0 };
  }
  const apiKey = (process.env.TYPESAFE_API_KEY || '').trim();
  const baseUrl = (process.env.TYPESAFE_BASE_URL || 'https://api.typesafe.ai').replace(/\/+$/, '');
  const model = (process.env.JEV_MODEL || 'jev-latest').trim();
  return { provider, apiKey, baseUrl, model, configured: apiKey.length > 0 };
}

export function isTypesafeConfigured(opts: TypesafeOptions = {}): boolean {
  if (opts.apiKey) return opts.apiKey.trim().length > 0;
  return resolveJevProviderConfig().configured;
}

function validateAnswers(raw: unknown): Record<string, TypesafeAnswer> {
  if (!raw || typeof raw !== 'object') throw new TypesafeError('response.answers missing', 0, 'bad_response');
  const answers = raw as Record<string, TypesafeAnswer>;
  for (const [id, answer] of Object.entries(answers)) {
    if (!answer || typeof answer !== 'object' || typeof (answer as { type?: unknown }).type !== 'string') {
      throw new TypesafeError('malformed answer for question ' + id, 0, 'bad_response');
    }
  }
  return answers;
}

/**
 * One System One call. Retries 429/529/5xx with exponential backoff (max 3
 * attempts by default). Never logs the API key or the request body.
 */
export async function systemOne(req: TypesafeRequest, opts: TypesafeOptions = {}): Promise<TypesafeResponse> {
  const providerCfg = resolveJevProviderConfig();
  const apiKey = ((opts.apiKey ?? providerCfg.apiKey) || '').trim();
  if (!apiKey) throw new TypesafeError('TYPESAFE_API_KEY is not set', 0, 'missing_key');
  if (!req || !req.questions || Object.keys(req.questions).length === 0) {
    throw new TypesafeError('questions must not be empty', 0, 'bad_request');
  }
  const baseUrl = ((opts.baseUrl ?? providerCfg.baseUrl) || '').replace(/\/+$/, '');
  const model = req.model || providerCfg.model;
  const timeoutMs = opts.timeoutMs ?? envIntBounded('JEV_TIMEOUT_MS', 8000, 1000, 30000);
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? 3, 5));
  const body = JSON.stringify({ state: req.state, model, questions: req.questions });
  const url = baseUrl + '/v1/systemone';
  let lastErr: TypesafeError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let code = 'http_' + res.status;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string }; code?: string };
          code = parsed.error?.code || parsed.code || code;
        } catch { /* non-JSON error body */ }
        const err = new TypesafeError('TypeSafe HTTP ' + res.status, res.status, code);
        const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          lastErr = err;
          const wait = Math.min(4000, 250 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 100);
          log.warn('TypeSafe ' + res.status + ' - retry ' + attempt + '/' + maxAttempts + ' in ' + wait + 'ms');
          await sleep(wait);
          continue;
        }
        throw err;
      }
      const json = await res.json() as { model?: string; answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
      const answers = validateAnswers(json.answers);
      const response: TypesafeResponse = { model: json.model || model, answers, usage: json.usage };
      log.info('JEV ' + response.model + ': ' + Object.keys(answers).length + ' answers, ' + (json.usage?.input_tokens ?? '?') + ' in/' + (json.usage?.output_tokens ?? '?') + ' out tokens, ' + (Date.now() - started) + 'ms');
      return response;
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err instanceof TypesafeError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new TypesafeError('TypeSafe request failed: ' + message, 0, 'network');
      if (attempt < maxAttempts) {
        lastErr = wrapped;
        const wait = Math.min(4000, 250 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 100);
        log.warn('TypeSafe ' + message + ' - retry ' + attempt + '/' + maxAttempts + ' in ' + wait + 'ms');
        await sleep(wait);
        continue;
      }
      throw wrapped;
    }
  }
  throw lastErr ?? new TypesafeError('TypeSafe request failed', 0, 'unknown');
}
