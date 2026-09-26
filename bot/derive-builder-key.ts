/**
 * One-time script: create builder API key for Polymarket.
 *
 * Builder keys enable tracking of order attribution and may unlock builder-specific
 * rewards/programs in the future. Run ONCE and save the output to .env.
 *
 * Usage:
 *   cd bot && node --env-file=./.env derive-builder-key.ts
 *
 * After running, copy the printed values to bot/.env:
 *   POLYMARKET_BUILDER_KEY=...
 *   POLYMARKET_BUILDER_SECRET=...
 *   POLYMARKET_BUILDER_PASSPHRASE=...
 *
 * NOTE: This is a one-time setup. The bot does NOT need this to function — it's
 * additive for builder rewards tracking.
 *
 * CLOB V2: order attribution no longer uses these HMAC keys — it is a public
 * `builderCode` (bytes32) from the Builder Profile, attached per order. The
 * HMAC builder key still authenticates the Relayer (gasless transactions).
 * The bot attaches no builder code (docs.polymarket.com/v2-migration).
 */

import { ClobClient } from "@polymarket/clob-client-v2";
import {
  buildClobClientOptions,
  createClobSigner,
  resolveSignatureType,
} from "./src/trading/clobV2Config.ts";

const POLYMARKET_HOST = "https://clob.polymarket.com";

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("ERROR: POLYMARKET_PRIVATE_KEY not set in .env");
  process.exit(1);
}

const apiKey = process.env.POLYMARKET_API_KEY;
const apiSecret = process.env.POLYMARKET_API_SECRET;
const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE;
if (!apiKey || !apiSecret || !apiPassphrase) {
  console.error("ERROR: Existing API credentials required (POLYMARKET_API_KEY/SECRET/PASSPHRASE).");
  console.error("Run derive-credentials.ts first to obtain L2 creds.");
  process.exit(1);
}

const signer = createClobSigner(privateKey);

const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || undefined;
const sigType = resolveSignatureType(proxyAddress, process.env.POLYMARKET_SIGNATURE_TYPE);

console.log("Wallet:", signer.account.address);
if (proxyAddress) console.log("Proxy:", proxyAddress);

const client = new ClobClient(buildClobClientOptions({
  host: POLYMARKET_HOST,
  signer,
  creds: { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
  signatureType: sigType,
  funderAddress: proxyAddress,
}));

console.log("\nRequesting builder API key...");
try {
  const builderKey = await client.createBuilderApiKey();
  console.log("\n✓ Builder API key created\n");
  console.log("=".repeat(60));
  console.log("Add these to bot/.env:");
  console.log("=".repeat(60));
  console.log(JSON.stringify(builderKey, null, 2));
  console.log("=".repeat(60));
  console.log("\nNote: in CLOB V2 order attribution uses the builderCode from your");
  console.log("Builder Profile, not this key. The bot attaches no builder code.");
} catch (err) {
  console.error("\n✗ Failed:", err.message);
  if (err.message.includes("already exists") || err.message.includes("duplicate")) {
    console.log("\nFetching existing builder keys instead...");
    try {
      const existing = await client.getBuilderApiKeys();
      console.log(JSON.stringify(existing, null, 2));
    } catch (e2) {
      console.error("Could not fetch existing keys:", e2.message);
    }
  }
  process.exit(1);
}
