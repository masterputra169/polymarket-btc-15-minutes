/**
 * CLOB V2 client configuration shared by the bot and its one-off scripts.
 *
 * CLOB V2 went live on 2026-04-28 and does not accept V1-signed orders
 * (docs.polymarket.com/v2-migration). What changed for this bot:
 *   - SDK: `@polymarket/clob-client-v2`; the constructor takes an options
 *     object and `chainId` became `chain`.
 *   - Orders are signed for EIP-712 domain version "2" against the V2 exchange.
 *     `nonce`, `feeRateBps` and `taker` are gone; `timestamp`, `metadata` and
 *     `builder` are new, all filled by the SDK. Fees are charged at match.
 *   - Collateral is pUSD, not USDC.e. L1/L2 API auth is unchanged, so existing
 *     API keys keep working.
 *
 * The signer is a viem wallet client (the SDK's documented signer). With an
 * ethers v6 wallet the SDK would need the old `_signTypedData` shim.
 */

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { Chain, SignatureTypeV2, getContractConfig } from '@polymarket/clob-client-v2';
import type { ApiKeyCreds, ClobClient, ClobClientOptions, OrderResponse } from '@polymarket/clob-client-v2';

export const CLOB_CHAIN = Chain.POLYGON;

const POLYGON_CONTRACTS = getContractConfig(Chain.POLYGON);

/**
 * Polygon mainnet addresses the live path signs for and needs approvals on
 * (docs.polymarket.com/resources/contracts; the exchange / collateral / CTF
 * values are the SDK's own, so they always match what it signs against).
 */
export const V2_CONTRACTS = Object.freeze({
  /** CTF Exchange V2 — the EIP-712 verifying contract for standard markets (BTC 15m). */
  exchange: POLYGON_CONTRACTS.exchangeV2,
  /** Neg Risk CTF Exchange V2 — only for neg-risk markets; BTC 15m markets are not. */
  negRiskExchange: POLYGON_CONTRACTS.negRiskExchangeV2,
  /** pUSD, the V2 collateral token (ERC-20, 6 decimals). */
  collateral: POLYGON_CONTRACTS.collateral,
  /** Conditional Tokens (ERC-1155 outcome shares). */
  conditionalTokens: POLYGON_CONTRACTS.conditionalTokens,
  /** CollateralOnramp: `wrap(USDC.e, to, amount)` turns USDC.e into pUSD. */
  collateralOnramp: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
  /** USDC.e, the V1 collateral. Not tradable on V2 until wrapped. */
  usdce: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
});

/** The order version whose approvals `v2Readiness.ts` checks. */
export const SUPPORTED_ORDER_VERSION = 2;

/**
 * Signature type for the account. Default: a proxy address means a Gnosis Safe
 * funder (2, the wallets polymarket.com created for external signers), none
 * means the EOA trades for itself (0). POLYMARKET_SIGNATURE_TYPE overrides it:
 * 1 = Polymarket proxy (Magic/Google accounts), 3 = Deposit Wallet (POLY_1271,
 * accounts created on or after 2026-05-04).
 */
export function resolveSignatureType(proxyAddress: string | undefined, override: string | undefined): SignatureTypeV2 {
  if (override != null && override.trim() !== '') {
    const n = Number(override.trim());
    if (!Number.isInteger(n) || n < 0 || n > 3) {
      throw new Error(`POLYMARKET_SIGNATURE_TYPE must be 0, 1, 2 or 3 (got "${override}")`);
    }
    if (n !== SignatureTypeV2.EOA && !proxyAddress) {
      throw new Error(`POLYMARKET_SIGNATURE_TYPE=${n} needs POLYMARKET_PROXY_ADDRESS (the wallet that holds the funds)`);
    }
    return n as SignatureTypeV2;
  }
  return proxyAddress ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.EOA;
}

export function signatureTypeName(sigType: SignatureTypeV2): string {
  switch (sigType) {
    case SignatureTypeV2.EOA: return 'EOA';
    case SignatureTypeV2.POLY_PROXY: return 'POLY_PROXY';
    case SignatureTypeV2.POLY_GNOSIS_SAFE: return 'POLY_GNOSIS_SAFE';
    case SignatureTypeV2.POLY_1271: return 'POLY_1271';
    default: return `unknown(${String(sigType)})`;
  }
}

/**
 * A viem wallet client for the private key. Signing is local; the transport is
 * never used for it. The key never appears in an error message.
 */
export function createClobSigner(privateKey: string) {
  const trimmed = privateKey.trim();
  const hex = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`;
  let account;
  try {
    account = privateKeyToAccount(hex);
  } catch {
    throw new Error('POLYMARKET_PRIVATE_KEY is not a valid 32-byte hex private key');
  }
  return createWalletClient({ account, chain: polygon, transport: http() });
}

export interface ClobClientOptionsInput {
  host: string;
  signer: ClobClientOptions['signer'];
  creds?: ApiKeyCreds;
  signatureType: SignatureTypeV2;
  funderAddress?: string;
}

/**
 * The options object for `new ClobClient(...)`. Same settings as the V1
 * positional call it replaces: server time for auth headers, no transport
 * retry, throw on API errors. No builder code: attaching one can add a
 * builder taker fee to every order.
 */
export function buildClobClientOptions(input: ClobClientOptionsInput): ClobClientOptions {
  const options: ClobClientOptions = {
    host: input.host,
    chain: CLOB_CHAIN,
    signer: input.signer,
    signatureType: input.signatureType,
    useServerTime: true,
    retryOnError: false,
    throwOnError: true,
  };
  if (input.creds) options.creds = input.creds;
  if (input.funderAddress) options.funderAddress = input.funderAddress;
  return options;
}

type SettlementWaitHook = { resolveTransactionsHashes?: (response: OrderResponse) => Promise<OrderResponse> };

/**
 * Make `postOrder` return as soon as the CLOB answers.
 *
 * clob-client-v2 1.2.0 `postOrder` then polls `getTrades` every 250 ms for up
 * to 30 s until each fill has a settlement transaction hash. The bot's order
 * timeout is 15 s, so a FOK that filled could be reported as a timeout and go
 * unrecorded. The bot does not need the hashes at order time: fills are read
 * from `makingAmount` / `takingAmount` and verified later from trade history
 * (fillTracker, journalReconciler).
 *
 * The hook is a private SDK method, hence the pinned SDK version and a test
 * against the installed prototype. Returns false when the method is missing,
 * and the caller then refuses to trade live.
 */
export function skipSettlementWait(client: ClobClient): boolean {
  const hook = client as unknown as SettlementWaitHook;
  if (typeof hook.resolveTransactionsHashes !== 'function') return false;
  hook.resolveTransactionsHashes = async (response: OrderResponse) => response;
  return true;
}
