/**
 * One-off: derive the CLOB L2 API credentials for POLYMARKET_PRIVATE_KEY.
 *
 * CLOB V2 left L1/L2 authentication unchanged (docs.polymarket.com/v2-migration),
 * so credentials derived before the V2 cutover still work and this prints the
 * same key. Output is secret: paste it into bot/.env, never into a commit.
 *
 * Usage: cd bot && node --env-file=./.env derive-credentials.ts
 */

import { ClobClient } from "@polymarket/clob-client-v2";
import dotenv from "dotenv";
import {
  buildClobClientOptions,
  createClobSigner,
  resolveSignatureType,
  signatureTypeName,
} from "./src/trading/clobV2Config.ts";

dotenv.config();

const POLYMARKET_HOST = "https://clob.polymarket.com";

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  console.error("ERROR: POLYMARKET_PRIVATE_KEY not set in .env");
  process.exit(1);
}
const signer = createClobSigner(privateKey);

const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || undefined;
const sigType = resolveSignatureType(proxyAddress, process.env.POLYMARKET_SIGNATURE_TYPE);

console.log("Wallet Address:", signer.account.address);
if (proxyAddress) {
  console.log("Proxy Address:", proxyAddress);
  console.log(`SignatureType: ${signatureTypeName(sigType)} (${sigType})`);
} else {
  console.log("No proxy address set - using EOA signing");
}

const clobClient = new ClobClient(buildClobClientOptions({
  host: POLYMARKET_HOST,
  signer,
  signatureType: sigType,
  funderAddress: proxyAddress,
}));

console.log("\nDeriving API credentials...");
const creds = await clobClient.deriveApiKey();

console.log("\nCredentials derived successfully!\n");
console.log("=".repeat(50));
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
console.log("=".repeat(50));
