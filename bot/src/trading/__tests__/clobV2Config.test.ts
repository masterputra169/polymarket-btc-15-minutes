/**
 * clobV2Config.ts against the REAL @polymarket/clob-client-v2 (pinned 1.2.0).
 *
 * Everything here is local: orders are signed with a throwaway random key and
 * never posted; no request leaves the process (the host is unroutable).
 *
 * Invariants: orders are signed for EIP-712 domain version "2" and CTF
 * Exchange V2 (a V1-domain signature would not recover); the signed struct
 * carries timestamp / metadata / builder and no nonce / feeRateBps; the
 * contract addresses match docs.polymarket.com/resources/contracts; the SDK
 * still has the private hook skipSettlementWait() replaces.
 */

import { describe, test, expect } from 'vitest';
import { ClobClient, OrderType, Side, SignatureTypeV2, orderToJsonV2 } from '@polymarket/clob-client-v2';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  V2_CONTRACTS,
  buildClobClientOptions,
  createClobSigner,
  resolveSignatureType,
  skipSettlementWait,
} from '../clobV2Config.ts';

const ORDER_STRUCT = [
  { name: 'salt', type: 'uint256' },
  { name: 'maker', type: 'address' },
  { name: 'signer', type: 'address' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'makerAmount', type: 'uint256' },
  { name: 'takerAmount', type: 'uint256' },
  { name: 'side', type: 'uint8' },
  { name: 'signatureType', type: 'uint8' },
  { name: 'timestamp', type: 'uint256' },
  { name: 'metadata', type: 'bytes32' },
  { name: 'builder', type: 'bytes32' },
] as const;

const TOKEN_ID = '92935718247882580383279305666087350328204881390346834012671641552805834879362';
const UNROUTABLE_HOST = 'http://127.0.0.1:9';

function localClient() {
  const signer = createClobSigner(generatePrivateKey());
  const client = new ClobClient(buildClobClientOptions({
    host: UNROUTABLE_HOST, signer, signatureType: SignatureTypeV2.EOA,
  }));
  return { signer, client };
}

async function recover(order: any, version: string, verifyingContract: string) {
  return recoverTypedDataAddress({
    domain: { name: 'Polymarket CTF Exchange', version, chainId: 137, verifyingContract: verifyingContract as `0x${string}` },
    types: { Order: ORDER_STRUCT },
    primaryType: 'Order',
    message: {
      salt: BigInt(order.salt),
      maker: order.maker,
      signer: order.signer,
      tokenId: BigInt(order.tokenId),
      makerAmount: BigInt(order.makerAmount),
      takerAmount: BigInt(order.takerAmount),
      side: order.side === 'BUY' ? 0 : 1,
      signatureType: order.signatureType,
      timestamp: BigInt(order.timestamp),
      metadata: order.metadata,
      builder: order.builder,
    },
    signature: order.signature,
  });
}

describe('V2 contract addresses', () => {
  test('match docs.polymarket.com/resources/contracts', () => {
    expect(V2_CONTRACTS.exchange).toBe('0xE111180000d2663C0091e4f400237545B87B996B');
    expect(V2_CONTRACTS.negRiskExchange).toBe('0xe2222d279d744050d28e00520010520000310F59');
    expect(V2_CONTRACTS.collateral).toBe('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
    expect(V2_CONTRACTS.conditionalTokens).toBe('0x4D97DCd97eC945f40cF65F87097ACe5EA0476045');
    expect(V2_CONTRACTS.collateralOnramp).toBe('0x93070a847efEf7F70739046A929D47a521F5B8ee');
  });
});

describe('signing with the real SDK (local only)', () => {
  test('a GTD limit BUY is signed for domain "2" and CTF Exchange V2', async () => {
    const { signer, client } = localClient();
    const order: any = await client.orderBuilder.buildOrder(
      { tokenID: TOKEN_ID, price: 0.54, size: 5, side: Side.BUY, expiration: 1_790_000_000 },
      { tickSize: '0.01', negRisk: false },
      2,
    );

    expect(order.makerAmount).toBe('2700000');   // 5 × 0.54 pUSD, 6 decimals
    expect(order.takerAmount).toBe('5000000');   // 5 shares
    expect(order.signatureType).toBe(0);
    expect(order.timestamp).toMatch(/^\d{13}$/); // milliseconds
    expect(order.metadata).toBe(`0x${'0'.repeat(64)}`);
    expect(order.builder).toBe(`0x${'0'.repeat(64)}`);
    for (const gone of ['nonce', 'feeRateBps', 'taker']) expect(order).not.toHaveProperty(gone);

    expect(await recover(order, '2', V2_CONTRACTS.exchange)).toBe(signer.account.address);
    // Neither the V1 domain nor the V1 exchange recovers the signer.
    expect(await recover(order, '1', V2_CONTRACTS.exchange)).not.toBe(signer.account.address);
    expect(await recover(order, '2', '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E')).not.toBe(signer.account.address);
  });

  test('a market BUY of exactly 5 shares at 0.57 stays 5 shares after SDK rounding', async () => {
    const { client } = localClient();
    const order: any = await client.orderBuilder.buildMarketOrder(
      { tokenID: TOKEN_ID, price: 0.57, amount: 2.85, side: Side.BUY, orderType: OrderType.FOK },
      { tickSize: '0.01', negRisk: false },
      2,
    );
    expect(order.makerAmount).toBe('2850000');
    expect(order.takerAmount).toBe('5000000');
    expect(order.expiration).toBe('0');
  });

  test('the wire body carries postOnly and no V1 fields', async () => {
    const { client } = localClient();
    const order: any = await client.orderBuilder.buildOrder(
      { tokenID: TOKEN_ID, price: 0.55, size: 5, side: Side.BUY, expiration: 1_790_000_000 },
      { tickSize: '0.01', negRisk: false },
      2,
    );
    const body: any = orderToJsonV2(order, 'api-key', OrderType.GTD, true, false);
    expect(body).toMatchObject({ orderType: 'GTD', postOnly: true, deferExec: false, owner: 'api-key' });
    expect(body.order.expiration).toBe('1790000000');
    for (const gone of ['nonce', 'feeRateBps']) expect(body.order).not.toHaveProperty(gone);
  });
});

describe('client options', () => {
  test('options object replaces the V1 positional call', () => {
    const signer = createClobSigner(generatePrivateKey());
    const creds = { key: 'k', secret: 's', passphrase: 'p' };
    const opts = buildClobClientOptions({
      host: 'https://clob.polymarket.com', signer, creds,
      signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE, funderAddress: '0xF00',
    });
    expect(opts).toEqual({
      host: 'https://clob.polymarket.com', chain: 137, signer, creds,
      signatureType: 2, funderAddress: '0xF00',
      useServerTime: true, retryOnError: false, throwOnError: true,
    });
    expect(opts).not.toHaveProperty('builderConfig');
  });

  test('signature type: default from the proxy address, validated override', () => {
    expect(resolveSignatureType(undefined, undefined)).toBe(SignatureTypeV2.EOA);
    expect(resolveSignatureType('0xproxy', undefined)).toBe(SignatureTypeV2.POLY_GNOSIS_SAFE);
    expect(resolveSignatureType('0xproxy', '3')).toBe(SignatureTypeV2.POLY_1271);
    expect(resolveSignatureType('0xproxy', ' ')).toBe(SignatureTypeV2.POLY_GNOSIS_SAFE);
    expect(() => resolveSignatureType('0xproxy', '4')).toThrow(/must be 0, 1, 2 or 3/);
    expect(() => resolveSignatureType(undefined, '2')).toThrow(/needs POLYMARKET_PROXY_ADDRESS/);
  });

  test('a bad private key fails without echoing it', () => {
    const bad = '0x1234not-a-key';
    let message = '';
    try { createClobSigner(bad); } catch (err) { message = (err as Error).message; }
    expect(message).toBe('POLYMARKET_PRIVATE_KEY is not a valid 32-byte hex private key');
    expect(message).not.toContain('1234');
  });
});

describe('skipSettlementWait', () => {
  test('the pinned SDK still has the hook it replaces', () => {
    expect(typeof (ClobClient.prototype as any).resolveTransactionsHashes).toBe('function');
  });

  test('postOrder returns the CLOB answer without polling getTrades', async () => {
    const { client } = localClient();
    expect(skipSettlementWait(client)).toBe(true);
    const matched = { success: true, orderID: '0xabc', status: 'matched', tradeIDs: ['t1'], transactionsHashes: [] };
    const hooked = client as any;
    hooked.getTrades = () => { throw new Error('must not poll trades'); };
    expect(await hooked.resolveTransactionsHashes(matched)).toBe(matched);
  });

  test('reports a client without the hook', () => {
    expect(skipSettlementWait({} as any)).toBe(false);
  });
});
