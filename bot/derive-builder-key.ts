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
 */

import { ClobClient, Chain, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";

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

type WalletCompat = Wallet & { _signTypedData?: Wallet['signTypedData'] };
const wallet = new Wallet(privateKey) as WalletCompat;
// Ethers v6 compat shim for @polymarket SDK
if (!wallet._signTypedData && wallet.signTypedData) {
  wallet._signTypedData = wallet.signTypedData.bind(wallet);
}

const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
const sigType = proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
const funder = proxyAddress || undefined;

console.log("Wallet:", wallet.address);
if (proxyAddress) console.log("Proxy:", proxyAddress);

const client = new ClobClient(
  POLYMARKET_HOST,
  Chain.POLYGON,
  wallet as any,
  { key: apiKey, secret: apiSecret, passphrase: apiPassphrase },
  sigType,
  funder,
  undefined,
  true,
  undefined,
  undefined,
  false,
  undefined,
  true,
);

console.log("\nRequesting builder API key...");
try {
  const builderKey = await client.createBuilderApiKey();
  console.log("\n✓ Builder API key created\n");
  console.log("=".repeat(60));
  console.log("Add these to bot/.env:");
  console.log("=".repeat(60));
  console.log(JSON.stringify(builderKey, null, 2));
  console.log("=".repeat(60));
  console.log("\nNote: Bot does NOT auto-use this yet. To attach builderCode to");
  console.log("orders, edit clobClient.ts placeBuyOrder/placeLimitBuyOrder and pass");
  console.log("`builderCode` in the userOrder object.");
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
