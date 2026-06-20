import { ClobClient, Chain, SignatureType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const POLYMARKET_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
type WalletCompat = Wallet & { _signTypedData?: Wallet['signTypedData'] };
const wallet = new Wallet(privateKey) as WalletCompat;

// Patch: ethers v6 compatibility - add _signTypedData alias
if (!wallet._signTypedData && wallet.signTypedData) {
  wallet._signTypedData = wallet.signTypedData.bind(wallet);
}

const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
const sigType = proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
const funder = proxyAddress || undefined;

console.log("Wallet Address:", wallet.address);
if (proxyAddress) {
  console.log("Proxy Address:", proxyAddress);
  console.log("SignatureType: POLY_GNOSIS_SAFE (2)");
} else {
  console.log("No proxy address set - using EOA signing");
}

const clobClient = new ClobClient(
  POLYMARKET_HOST,
  Chain.POLYGON,
  wallet as any,
  undefined,
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

console.log("\nDeriving API credentials...");
const creds = await clobClient.deriveApiKey();

console.log("\nCredentials derived successfully!\n");
console.log("=".repeat(50));
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
console.log("=".repeat(50));
console.log("\nRaw response:", JSON.stringify(creds, null, 2));
