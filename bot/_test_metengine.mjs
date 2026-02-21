/**
 * MetEngine API test v5 — fix: use ExactSvmScheme directly with custom RPC URL.
 *
 * Root cause: registerExactSvmScheme() does NOT pass rpcUrl to ExactSvmScheme
 * constructor — library bug. Workaround: instantiate ExactSvmScheme directly.
 *
 * Also fixes:
 * - Use POST (not GET) for /api/v1/markets/intelligence
 * - encodePaymentSignatureHeader returns object {header: value}, not string
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '.env') });

const BASE = 'https://agent.metengine.xyz';
const KEY  = process.env.SOLANA_PRIVATE_KEY || '';
const PATH = '/api/v1/markets/intelligence';

// Custom Solana RPC — publicnode.com free public RPC (avoids 403 on mainnet-beta)
const CUSTOM_RPC = 'https://solana-rpc.publicnode.com';

// Test body — use a dummy conditionId; goal is to confirm payment flow works
const TEST_BODY = JSON.stringify({ condition_id: 'test_btc_btc15m', top_n_wallets: 50 });

async function main() {
  console.log('MetEngine x402 debug v5 — direct ExactSvmScheme\n');
  console.log('Key:', KEY ? KEY.slice(0,10)+'…' : 'MISSING');
  console.log('Custom RPC:', CUSTOM_RPC);

  // ── Step 1: POST to get 402 ──
  console.log('\n[Step 1] POST →', BASE + PATH);
  const r1 = await fetch(BASE + PATH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: TEST_BODY,
  });
  console.log('Status:', r1.status);

  const payHdrRaw = r1.headers.get('PAYMENT-REQUIRED') || r1.headers.get('payment-required');
  if (!payHdrRaw) {
    const body = await r1.text();
    console.log('No PAYMENT-REQUIRED header! Body:', body.slice(0, 500));
    return;
  }

  const paymentRequired = JSON.parse(Buffer.from(payHdrRaw, 'base64').toString('utf8'));
  console.log('\nPaymentRequired:');
  console.log(JSON.stringify(paymentRequired, null, 2));

  if (!KEY) { console.log('\nNo key — stop.'); return; }

  // ── Step 2: Setup x402 — ExactSvmScheme directly (bypass registerExactSvmScheme bug) ──
  console.log('\n[Step 2] Setup x402 with custom RPC...');
  const { x402Client, x402HTTPClient } = await import('@x402/core/client');
  const { ExactSvmScheme }             = await import('@x402/svm/exact/client');
  const { toClientSvmSigner }          = await import('@x402/svm');
  const { getBase58Encoder, createKeyPairSignerFromBytes } = await import('@solana/kit');

  const bytes = getBase58Encoder().encode(KEY);
  console.log('Key bytes length:', bytes.length, '(expect 64)');

  const signer = await createKeyPairSignerFromBytes(bytes);
  console.log('Signer address:', signer.address);

  const client = new x402Client();

  // FIX: use ExactSvmScheme directly with rpcUrl — registerExactSvmScheme never passes rpcUrl
  const scheme = new ExactSvmScheme(toClientSvmSigner(signer), { rpcUrl: CUSTOM_RPC });
  client.register('solana:*', scheme);

  const httpClient = new x402HTTPClient(client);
  console.log('x402 client ready (custom RPC:', CUSTOM_RPC, ')');

  // ── Step 3: Create payment payload ──
  console.log('\n[Step 3] Creating payment payload...');
  let payload;
  try {
    payload = await httpClient.createPaymentPayload(paymentRequired);
    console.log('Payload created ✓');
  } catch(e) {
    console.log('Error creating payload:', e.message);
    if (e.stack) console.log(e.stack.split('\n').slice(0,5).join('\n'));
    return;
  }

  // FIX: encodePaymentSignatureHeader returns object {header: value}, not string
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
  console.log('Payment headers keys:', Object.keys(paymentHeaders));
  const sigHdrVal = Object.values(paymentHeaders)[0] || '';
  console.log('Header preview:', sigHdrVal.slice(0, 80) + '…');

  // ── Step 4: Re-send POST with payment headers ──
  console.log('\n[Step 4] Re-sending POST with payment headers...');
  const r2 = await fetch(BASE + PATH, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...paymentHeaders,
    },
    body: TEST_BODY,
    signal: AbortSignal.timeout(15000),
  });
  const body2 = await r2.text();
  console.log('Status:', r2.status);

  const settle = r2.headers.get('PAYMENT-RESPONSE') || r2.headers.get('payment-response');
  if (settle) console.log('PAYMENT-RESPONSE:', settle.slice(0, 200));

  console.log('Response body:', body2.slice(0, 1000));
}

main().catch(e => console.error('FATAL:', e.message, e.stack?.split('\n').slice(0,3).join('\n')));
