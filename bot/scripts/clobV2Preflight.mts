/**
 * Read-only CLOB V2 preflight — run it before the first live start.
 *
 * Checks, with the same code the live bot runs:
 *   1. the API key in bot/.env authenticates against CLOB V2 (L2 auth);
 *   2. the account is not in closed-only mode;
 *   3. the CLOB order version is 2;
 *   4. the funder holds pUSD and has approved CTF Exchange V2 for pUSD and its
 *      outcome tokens (verifyClobV2Readiness — Polygon view calls).
 *
 * It places no order, sends no transaction, and does not create or derive an
 * API key (it refuses to run without one). Nothing secret is printed.
 *
 * Usage: cd bot && node --env-file=./.env scripts/clobV2Preflight.mts
 * Guide: docs/CLOB_V2_MIGRATION.md
 */

import {
  getOpenOrders,
  getProxyAddress,
  getUsdcBalance,
  getWalletAddress,
  initClobClient,
  verifyClobV2Readiness,
} from '../src/trading/clobClient.ts';

const REQUIRED = ['POLYMARKET_PRIVATE_KEY', 'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_API_PASSPHRASE'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')}. Derive the API key first: cd bot && node --env-file=./.env derive-credentials.ts`);
  process.exit(1);
}

let failures = 0;
function fail(msg: string) {
  failures++;
  console.error(`FAIL  ${msg}`);
}

const client = await initClobClient();
console.log(`Signer ${getWalletAddress()} | funder ${getProxyAddress()}`);

try {
  const keys: any = await client.getApiKeys();
  const list: unknown[] = Array.isArray(keys?.apiKeys) ? keys.apiKeys : [];
  const ours = process.env.POLYMARKET_API_KEY;
  const listed = list.some((k: any) => (typeof k === 'string' ? k : k?.key ?? k?.apiKey) === ours);
  console.log(`OK    L2 auth: API key accepted by CLOB V2 (${list.length} key(s) on the account${listed ? ', this one listed' : ''})`);
} catch (err) {
  fail(`L2 auth: the API key was not accepted — ${(err as Error).message}`);
}

try {
  const ban: any = await client.getClosedOnlyMode();
  if (ban?.closed_only) fail('account is in closed-only mode: it can close positions but not open them');
  else console.log('OK    account is not in closed-only mode');
} catch (err) {
  fail(`closed-only check failed — ${(err as Error).message}`);
}

try {
  const open = await getOpenOrders();
  console.log(`OK    open orders: ${open.length}`);
} catch (err) {
  fail(`open orders — ${(err as Error).message}`);
}

const bal = await getUsdcBalance();
console.log(bal ? `INFO  CLOB view: balance $${bal.balance.toFixed(2)} (pUSD, plus any USDC.e) | allowance ${bal.allowance}` : 'INFO  CLOB balance unavailable');

try {
  await verifyClobV2Readiness();
  console.log('OK    wallet ready (pUSD funded, CTF Exchange V2 approved)');
} catch (err) {
  fail(`readiness — ${(err as Error).message}`);
}

console.log(failures === 0 ? '\nPreflight passed. Next: the 5-share smoke test in docs/CLOB_V2_MIGRATION.md.' : `\nPreflight failed (${failures}).`);
process.exit(failures === 0 ? 0 : 1);
