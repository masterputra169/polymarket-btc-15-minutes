/**
 * CLOB V2 smoke test — places ONE real 5-share order through the bot's own
 * order functions. Spends real money in `fok` mode; run it by hand only,
 * after scripts/clobV2Preflight.mts passes. Never run by CI or the bot.
 *
 *   rest (default): a post-only GTD BUY of 5 shares at --price, which must sit
 *        BELOW the best ask so it rests; the script checks it is live, then
 *        cancels it. Nothing fills unless the market trades down to --price
 *        during the few seconds it rests (then you own 5 shares at --price).
 *   fok: a fill-or-kill BUY of 5 shares with --price as the maximum; fills at
 *        the ask if the ask is at or below --price. Costs ~5 × ask + taker fee.
 *
 * The UP token of the current BTC 15m market is used unless --token is given.
 *
 * Usage (from bot/):
 *   node --env-file=./.env scripts/clobV2SmokeOrder.mts --price 0.20 --confirm
 *   node --env-file=./.env scripts/clobV2SmokeOrder.mts --mode fok --price 0.60 --confirm
 * Guide: docs/CLOB_V2_MIGRATION.md
 */

import { CONFIG } from '../src/config.ts';
import { fetchJsonWithPolymarketDoh } from '../src/services/polymarketHttp.ts';
import {
  cancelOrder,
  getOrderStatus,
  initClobClient,
  placeBuyOrder,
  placeLimitBuyOrder,
  verifyClobV2Readiness,
} from '../src/trading/clobClient.ts';
import { parseOrderConstraints, recordOrderConstraints } from '../src/trading/orderConstraints.ts';

const SHARES = 5;
const REST_LIFETIME_SEC = 240; // CLOB V2 wants >= 180 s of GTD lead

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = arg('mode') ?? 'rest';
const price = Number(arg('price'));

if (!args.includes('--confirm')) {
  console.error('Refusing to place a real order without --confirm. Read the header of this file first.');
  process.exit(1);
}
if (mode !== 'rest' && mode !== 'fok') {
  console.error(`--mode must be rest or fok (got ${mode})`);
  process.exit(1);
}
if (!Number.isFinite(price) || price <= 0 || price >= 1) {
  console.error('--price is required: a probability in (0, 1)');
  process.exit(1);
}

async function currentUpToken(): Promise<{ tokenId: string; market: unknown }> {
  const start = Math.floor(Date.now() / 1000 / 900) * 900;
  const slug = `btc-updown-15m-${start}`;
  const market: any = await fetchJsonWithPolymarketDoh(`${CONFIG.gammaBaseUrl}/markets/slug/${slug}`, { timeoutMs: 10_000, label: 'Gamma market' });
  const ids = typeof market?.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market?.clobTokenIds;
  if (!Array.isArray(ids) || !ids[0]) throw new Error(`no token ids for ${slug}`);
  console.log(`Market ${slug} (UP token)`);
  return { tokenId: String(ids[0]), market };
}

const picked = arg('token') ? { tokenId: String(arg('token')), market: null } : await currentUpToken();
const tokenId = picked.tokenId;

const book: any = await fetchJsonWithPolymarketDoh(`${CONFIG.clobBaseUrl}/book?token_id=${tokenId}`, { timeoutMs: 10_000, label: 'CLOB book' });
const constraints = parseOrderConstraints(book, picked.market);
recordOrderConstraints(tokenId, constraints);
const asks = (book?.asks ?? []).map((l: any) => Number(l.price)).filter(Number.isFinite);
const bestAsk = asks.length ? Math.min(...asks) : null;
console.log(`Book: best ask ${bestAsk ?? 'none'} | tick ${constraints.tickSize} | min ${constraints.minOrderSize} shares`);

if (mode === 'rest' && bestAsk != null && price >= bestAsk) {
  console.error(`rest mode needs --price below the best ask (${bestAsk}) so the order rests instead of filling`);
  process.exit(1);
}

await initClobClient();
await verifyClobV2Readiness();

if (mode === 'rest') {
  const expiration = Math.floor(Date.now() / 1000) + REST_LIFETIME_SEC;
  const placed: any = await placeLimitBuyOrder({ tokenId, price, size: SHARES, expiration, postOnly: true });
  console.log(`Placed post-only GTD BUY ${SHARES} @ ${price}: orderId ${placed.orderId} status ${placed.status}`);
  const status: any = await getOrderStatus(placed.orderId);
  console.log(`Order status from CLOB: ${status?.status ?? 'unknown'}`);
  await cancelOrder(placed.orderId);
  const after: any = await getOrderStatus(placed.orderId);
  console.log(`After cancel: ${after?.status ?? 'unknown'} — expect a cancelled status. Signing, posting and cancelling work.`);
} else {
  const filled: any = await placeBuyOrder({ tokenId, price, size: SHARES });
  console.log(
    `FOK BUY ${SHARES} @ max ${price}: orderId ${filled.orderId} status ${filled.status} ` +
    `makingAmount ${filled.makingAmount} takingAmount ${filled.takingAmount}`,
  );
  console.log('Record makingAmount vs the pUSD balance change on-chain: it says whether the reported cost includes the taker fee.');
}
process.exit(0);
