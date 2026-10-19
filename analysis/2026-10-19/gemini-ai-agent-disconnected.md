# Gemini / OpenRouter AI agent — disconnected 2026-10-19

## What it was

`AI_AGENT_ENABLED=true` + `AI_MODEL=google/gemini-3-flash-preview` initialised `openrouterClient.ts`
and ran a 4-hourly **post-trade journal analysis** (`postTradeAnalyst.maybeAnalyze`): it sent the
last 48 h of trades to Gemini through OpenRouter, wrote the result to `bot/data/ai_analysis.json`
and exposed it over the status WebSocket. It never placed orders and never changed parameters:
`AI_AUTO_OPTIMIZE=false` and `LLM_REGIME_ENABLED=false` (the LLM regime classifier was already off).

Evidence on the VPS before the change: 9 `OpenRouter OK` calls in 24 h (~3k tokens each), plus an
`OpenRouter initialized: model=google/gemini-3-flash-preview` line on every restart, and earlier 402s.

## Why it was redundant

- It was advisory only; the dashboard does not render the analysis anywhere.
- Auto-optimization was off, so recommendations were never applied.
- The LLM regime classifier that used the same client was already disabled.
- JEV (`typesafe/jev-1.14` via OpenRouter System One) replaced the LLM decision layer and does NOT use Gemini.

## Change

- VPS + local `AI_AGENT_ENABLED=false`; the OpenRouter chat client is not initialised.
- Hard guards: `maybeAnalyze()` / `maybeOptimize()` return immediately when the AI agent is disabled.
- Dashboard commands `analyzeNow` / `optimizeNow` respond `{ ok:false, error:"ai_disabled" }`.
- **`OPENROUTER_API_KEY` is kept**: JEV uses it for the System One endpoint; removing the key would break JEV.

## Verification

- Restart log: `AI Agent: disabled (set AI_AGENT_ENABLED=true to enable)`; no `OpenRouter initialized`.
- 0 `OpenRouter OK` lines after restart; JEV call still succeeds (`typesafe/jev-1.14`, ~$0.000066).
- Bot stays DRY RUN; alerts and PolyBolt unaffected.

## Re-enable (only if wanted)

Set `AI_AGENT_ENABLED=true` and restart. It will resume spending a few thousand Gemini tokens every
4 hours for (currently unused) journal analysis; JEV is unaffected either way.
