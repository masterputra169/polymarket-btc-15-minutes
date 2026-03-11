/**
 * OpenRouter API client — supports Claude, Gemini, GPT, etc. via single API.
 *
 * Pattern: lazy init, rate limiting, response cache, graceful null fallback.
 * All errors return null — never blocks bot loop.
 */

import { createLogger } from '../logger.js';

const log = createLogger('OpenRouter');

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

let _cfg = null;
let _rateBucket = [];  // timestamps of recent calls
let _cache = new Map(); // prompt hash → { result, ts }
let _stats = { calls: 0, cacheHits: 0, errors: 0, totalLatencyMs: 0, lastCallMs: 0 };

/**
 * Initialize OpenRouter client.
 * @param {{ apiKey: string, model: string, maxTokens: number, timeoutMs: number, rateLimitPerMin: number }} cfg
 */
export function initOpenRouter(cfg) {
  // Read API key directly from process.env (ES module hoisting defense)
  const apiKey = process.env.OPENROUTER_API_KEY || cfg.apiKey || '';
  if (!apiKey) {
    log.warn('No OPENROUTER_API_KEY — AI features disabled');
    _cfg = null;
    return;
  }
  _cfg = { ...cfg, apiKey };
  log.info(`OpenRouter initialized: model=${_cfg.model}, rateLimit=${_cfg.rateLimitPerMin}/min`);
}

/**
 * Send a chat completion request to OpenRouter.
 * @param {{ system: string, user: string, temperature?: number, maxTokens?: number }} params
 * @returns {Promise<{ content: string, usage: object, model: string, cached: boolean } | null>}
 */
export async function chatCompletion({ system, user, temperature = 0.3, maxTokens }) {
  if (!_cfg) return null;

  // Rate limiting (token bucket)
  const now = Date.now();
  _rateBucket = _rateBucket.filter(t => now - t < 60_000);
  if (_rateBucket.length >= _cfg.rateLimitPerMin) {
    log.debug(`Rate limited: ${_rateBucket.length}/${_cfg.rateLimitPerMin} calls in last minute`);
    return null;
  }

  // Cache check (5-minute TTL)
  const cacheKey = simpleHash(system + user);
  const cached = _cache.get(cacheKey);
  if (cached && (now - cached.ts) < 300_000) {
    _stats.cacheHits++;
    return { ...cached.result, cached: true };
  }

  // Make request
  _rateBucket.push(now);
  _stats.calls++;
  _stats.lastCallMs = now;

  const startMs = now;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), _cfg.timeoutMs || 30000);

    const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${_cfg.apiKey}`,
        'HTTP-Referer': 'https://github.com/polymarket-bot',
        'X-Title': 'Polymarket Trading Bot',
      },
      body: JSON.stringify({
        model: _cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        max_tokens: maxTokens || _cfg.maxTokens || 2000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
      _stats.errors++;
      return null;
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const usage = data.usage ?? {};

    const result = { content, usage, model: data.model ?? _cfg.model, cached: false };
    _stats.totalLatencyMs += Date.now() - startMs;

    // Cache result
    _cache.set(cacheKey, { result, ts: Date.now() });
    // Evict old cache entries (keep max 20)
    if (_cache.size > 20) {
      const oldest = _cache.keys().next().value;
      _cache.delete(oldest);
    }

    log.info(`OpenRouter OK: ${content.length} chars, ${usage.total_tokens ?? '?'} tokens, ${Date.now() - startMs}ms`);
    return result;
  } catch (err) {
    _stats.errors++;
    if (err.name === 'AbortError') {
      log.warn(`OpenRouter timeout (${_cfg.timeoutMs}ms)`);
    } else {
      log.warn(`OpenRouter error: ${err.message}`);
    }
    return null;
  }
}

/** Get client statistics. */
export function getOpenRouterStats() {
  return {
    ..._stats,
    avgLatencyMs: _stats.calls > 0 ? Math.round(_stats.totalLatencyMs / _stats.calls) : 0,
    configured: _cfg !== null,
  };
}

/** Simple hash for cache key. */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
