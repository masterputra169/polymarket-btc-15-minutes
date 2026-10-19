/** Quick TypeSafe/JEV smoke test: one fixed call, prints answers and token usage.
 *
 *   node --env-file=bot/.env bot/scripts/jevSmokeTest.mts
 *
 * Exit codes: 0 ok, 2 missing key, 1 request failed. Never prints the key.
 */
import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { systemOne, isTypesafeConfigured, TypesafeError } from '../src/ai/typesafeClient.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });

if (!isTypesafeConfigured()) {
  console.error('TYPESAFE_API_KEY is not set (bot/.env). Create one at https://console.typesafe.ai/keys');
  process.exit(2);
}

try {
  const res = await systemOne({
    model: process.env.JEV_MODEL || 'jev-latest',
    state: {
      market: { asset: 'BTC/USD', venue: 'Polymarket 15m up/down', time_left_minutes: 7, price_to_beat: 81950, btc_price_now: 82000 },
      market_odds: { up: 0.56, down: 0.44 },
      momentum: { delta_1m_usd: 12, delta_3m_usd: 25 },
    },
    questions: {
      direction: { type: 'choice', instructions: 'Which side is more likely to settle above the price to beat?', criteria: { UP: 'above', DOWN: 'below', NO_EDGE: 'no edge' } },
      settle_above_ptb: { type: 'noul', instructions: 'Will BTC settle above the price to beat?' },
    },
  });
  console.log(JSON.stringify({ model: res.model, answers: res.answers, usage: res.usage }, null, 2));
} catch (err) {
  if (err instanceof TypesafeError) console.error('TypeSafe error: status=' + err.status + ' code=' + err.code + ' msg=' + err.message);
  else console.error('Error: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
