/**
 * clobClient.ts on CLOB V2, with the SDK's ClobClient replaced by a recorder.
 * Nothing is signed for real and nothing leaves the process.
 *
 * Invariants:
 *  - the client is built from an options object (`chain`, not positional args);
 *  - orders go out with the V2 argument order: (userOrder, { tickSize }, orderType[, postOnly]);
 *  - no order carries nonce / feeRateBps / taker;
 *  - prices are tick-rounded inward, and an order under the market minimum is
 *    refused before the SDK is called — never upsized;
 *  - before initClobClient() (the dry-run path) every order function throws
 *    'CLOB client not initialized', as before;
 *  - the post-order settlement wait is disabled, or init refuses to go live.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const sdk = vi.hoisted(() => ({
  instances: [] as any[],
  omitSettlementHook: false,
  nextResponse: null as any,
}));

vi.mock('@polymarket/clob-client-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@polymarket/clob-client-v2')>();
  class RecordingClobClient {
    options: any;
    calls: any[] = [];
    constructor(options: any) {
      this.options = options;
      if (sdk.omitSettlementHook) (this as any).resolveTransactionsHashes = undefined;
      sdk.instances.push(this);
    }
    async resolveTransactionsHashes(): Promise<never> { throw new Error('settlement wait must be bypassed'); }
    async createOrDeriveApiKey() { return { key: 'derived-key', secret: 'derived-secret', passphrase: 'derived-pass' }; }
    async getVersion() { return 2; }
    async updateBalanceAllowance(params: any) { this.calls.push(['updateBalanceAllowance', params]); }
    async createAndPostMarketOrder(...args: any[]) {
      this.calls.push(['createAndPostMarketOrder', ...args]);
      return sdk.nextResponse ?? { success: true, errorMsg: '', orderID: '0xmkt', status: 'matched', makingAmount: '2.7', takingAmount: '5' };
    }
    async createAndPostOrder(...args: any[]) {
      this.calls.push(['createAndPostOrder', ...args]);
      return sdk.nextResponse ?? { success: true, errorMsg: '', orderID: '0xlim', status: 'live', makingAmount: '', takingAmount: '' };
    }
  }
  return { ...actual, ClobClient: RecordingClobClient };
});

// The first import of clobClient.ts (config, viem, SDK) is slow on a cold transform cache.
vi.setConfig({ testTimeout: 30_000 });

const ENV_KEYS = [
  'POLYMARKET_PRIVATE_KEY', 'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET',
  'POLYMARKET_API_PASSPHRASE', 'POLYMARKET_PROXY_ADDRESS', 'POLYMARKET_SIGNATURE_TYPE',
];
const TOKEN = '92935718247882580383279305666087350328204881390346834012671641552805834879362';
let savedEnv: Record<string, string | undefined>;
let testKey: `0x${string}`;

async function loadModules() {
  vi.resetModules();
  const clob = await import('../clobClient.ts');
  const constraints = await import('../orderConstraints.ts');
  constraints.clearOrderConstraints();
  return { clob, constraints };
}

function lastInstance() {
  return sdk.instances[sdk.instances.length - 1];
}

function orderCalls() {
  return lastInstance().calls.filter((c: any[]) => c[0] !== 'updateBalanceAllowance');
}

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  testKey = generatePrivateKey(); // throwaway, never a real wallet
  process.env.POLYMARKET_PRIVATE_KEY = testKey;
  process.env.POLYMARKET_API_KEY = 'test-key';
  process.env.POLYMARKET_API_SECRET = 'test-secret';
  process.env.POLYMARKET_API_PASSPHRASE = 'test-pass';
  sdk.instances.length = 0;
  sdk.omitSettlementHook = false;
  sdk.nextResponse = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
});

describe('before initClobClient (the dry-run path)', () => {
  test('order functions throw exactly as before and touch no SDK client', async () => {
    const { clob } = await loadModules();
    await expect(clob.placeBuyOrder({ tokenId: TOKEN, price: 0.5, size: 5 })).rejects.toThrow('CLOB client not initialized');
    await expect(clob.placeSellOrder({ tokenId: TOKEN, price: 0.5, size: 5 })).rejects.toThrow('CLOB client not initialized');
    await expect(clob.placeLimitBuyOrder({ tokenId: TOKEN, price: 0.5, size: 5, expiration: 9_999_999_999 }))
      .rejects.toThrow('CLOB client not initialized');
    expect(clob.isClientReady()).toBe(false);
    expect(sdk.instances).toHaveLength(0);
  });
});

describe('initClobClient', () => {
  test('builds the V2 client from an options object (EOA, provided creds)', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    const { options } = lastInstance();
    expect(options).toMatchObject({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signatureType: 0,
      useServerTime: true,
      retryOnError: false,
      throwOnError: true,
      creds: { key: 'test-key', secret: 'test-secret', passphrase: 'test-pass' },
    });
    expect(options).not.toHaveProperty('funderAddress');
    expect(options.signer.account.address).toBe(privateKeyToAccount(testKey).address);
    expect(clob.getWalletAddress()).toBe(privateKeyToAccount(testKey).address);
    expect(clob.isClientReady()).toBe(true);
    // Startup allowance-cache sync for pUSD (no transaction).
    expect(lastInstance().calls).toContainEqual(['updateBalanceAllowance', { asset_type: 'COLLATERAL' }]);
  });

  test('a proxy address makes the Safe the funder (POLY_GNOSIS_SAFE)', async () => {
    process.env.POLYMARKET_PROXY_ADDRESS = '0x2222222222222222222222222222222222222222';
    const { clob } = await loadModules();
    await clob.initClobClient();
    expect(lastInstance().options).toMatchObject({
      signatureType: 2,
      funderAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(clob.getProxyAddress()).toBe('0x2222222222222222222222222222222222222222');
  });

  test('without API creds it derives them (L1), then builds the L2 client', async () => {
    delete process.env.POLYMARKET_API_KEY;
    const { clob } = await loadModules();
    await clob.initClobClient();
    expect(sdk.instances).toHaveLength(2);
    expect(sdk.instances[0].options).not.toHaveProperty('creds');
    expect(lastInstance().options.creds).toEqual({ key: 'derived-key', secret: 'derived-secret', passphrase: 'derived-pass' });
  });

  test('disables the post-order settlement wait', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    const response = { success: true, orderID: '0x1', tradeIDs: ['t'] };
    expect(await lastInstance().resolveTransactionsHashes(response)).toBe(response);
  });

  test('refuses to go live when the SDK no longer has the settlement hook', async () => {
    sdk.omitSettlementHook = true;
    const { clob } = await loadModules();
    await expect(clob.initClobClient()).rejects.toThrow(/resolveTransactionsHashes/);
    expect(clob.isClientReady()).toBe(false);
  });
});

describe('orders (V2 argument order)', () => {
  test('FOK BUY: market order, dollar amount, price rounded down to the tick', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    const result = await clob.placeBuyOrder({ tokenId: TOKEN, price: 0.547, size: 5 });

    expect(orderCalls()).toEqual([[
      'createAndPostMarketOrder',
      { tokenID: TOKEN, price: 0.54, amount: 2.7, side: 'BUY', orderType: 'FOK' },
      { tickSize: '0.01' },
      'FOK',
    ]]);
    const [, userOrder] = orderCalls()[0];
    for (const gone of ['nonce', 'feeRateBps', 'taker']) expect(userOrder).not.toHaveProperty(gone);
    expect(result).toMatchObject({ orderId: '0xmkt', makingAmount: '2.7', takingAmount: '5' });
  });

  test('FOK SELL: amount is shares, price rounded up to the tick', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    await clob.placeSellOrder({ tokenId: TOKEN, price: 0.301, size: 7.883 });
    expect(orderCalls()).toEqual([[
      'createAndPostMarketOrder',
      { tokenID: TOKEN, price: 0.31, amount: 7.88, side: 'SELL', orderType: 'FOK' },
      { tickSize: '0.01' },
      'FOK',
    ]]);
  });

  test('GTD limit BUY: postOnly is the 4th argument (default false)', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    const expiration = Math.floor(Date.now() / 1000) + 600;

    await clob.placeLimitBuyOrder({ tokenId: TOKEN, price: 0.553, size: 6, expiration });
    await clob.placeLimitBuyOrder({ tokenId: TOKEN, price: 0.55, size: 6, expiration, postOnly: true });

    expect(orderCalls()).toEqual([
      ['createAndPostOrder', { tokenID: TOKEN, price: 0.55, side: 'BUY', size: 6, expiration }, { tickSize: '0.01' }, 'GTD', false],
      ['createAndPostOrder', { tokenID: TOKEN, price: 0.55, side: 'BUY', size: 6, expiration }, { tickSize: '0.01' }, 'GTD', true],
    ]);
  });

  test('uses the tick recorded for the token', async () => {
    const { clob, constraints } = await loadModules();
    await clob.initClobClient();
    constraints.recordOrderConstraints(TOKEN, constraints.parseOrderConstraints({ tick_size: '0.001', min_order_size: '5' }));
    await clob.placeBuyOrder({ tokenId: TOKEN, price: 0.9876, size: 6 });
    const [, userOrder, options] = orderCalls()[0];
    expect(userOrder.price).toBe(0.987);
    expect(userOrder.amount).toBe(5.92); // dollars round down to cents: 5.92 / 0.987 = 5.998 shares
    expect(options).toEqual({ tickSize: '0.001' });
  });
});

describe('minimum order size', () => {
  test('a 2-share BUY is refused before the SDK is called — not upsized', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    await expect(clob.placeBuyOrder({ tokenId: TOKEN, price: 0.6, size: 2 }))
      .rejects.toThrow(/BUY rejected: size 2 shares is below the market minimum of 5 \(default\)/);
    expect(orderCalls()).toHaveLength(0);
    const logged = (console.log as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(logged).toMatch(/BUY rejected before signing: size 2 shares is below the market minimum of 5/);
  });

  test('the book minimum applies to sells and limit orders too', async () => {
    const { clob, constraints } = await loadModules();
    await clob.initClobClient();
    constraints.recordOrderConstraints(TOKEN, constraints.parseOrderConstraints({ tick_size: '0.01', min_order_size: '10' }));
    await expect(clob.placeSellOrder({ tokenId: TOKEN, price: 0.3, size: 8 })).rejects.toThrow(/minimum of 10 \(book\)/);
    const expiration = Math.floor(Date.now() / 1000) + 600;
    await expect(clob.placeLimitBuyOrder({ tokenId: TOKEN, price: 0.5, size: 9, expiration })).rejects.toThrow(/minimum of 10/);
    expect(orderCalls()).toHaveLength(0);
  });

  test('a GTD expiring in under 3 minutes is refused before signing', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    const expiration = Math.floor(Date.now() / 1000) + 90;
    await expect(clob.placeLimitBuyOrder({ tokenId: TOKEN, price: 0.5, size: 6, expiration }))
      .rejects.toThrow(/LIMIT_BUY rejected: GTD expiration is \d+s ahead; CLOB V2 requires at least 180s/);
    expect(orderCalls()).toHaveLength(0);
  });
});

describe('responses', () => {
  test('a matching-engine rejection (HTTP 200, success:false) still throws', async () => {
    const { clob } = await loadModules();
    await clob.initClobClient();
    sdk.nextResponse = { success: false, errorMsg: 'not enough balance / allowance', orderID: '' };
    await expect(clob.placeBuyOrder({ tokenId: TOKEN, price: 0.5, size: 5 }))
      .rejects.toThrow('BUY: order rejected: not enough balance / allowance');
  });

  test('readAllowance reads the V2 per-spender map and the V1 field', async () => {
    const { clob } = await loadModules();
    const exchange = '0xE111180000d2663C0091e4f400237545B87B996B';
    expect(clob.readAllowance({ balance: '1', allowances: { [exchange.toLowerCase()]: '5000000' } }, exchange)).toBe(5_000_000);
    expect(clob.readAllowance({ balance: '1', allowances: { '0xother': '1' } }, exchange)).toBeNull();
    expect(clob.readAllowance({ balance: '1', allowance: '42' }, exchange)).toBe(42);
    expect(clob.readAllowance(null, exchange)).toBeNull();
  });
});
