import { ClobClient, Chain } from "@polymarket/clob-client-v2";
import { Wallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const POLYMARKET_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

// SignatureType: 0 = EOA, 1 = POLY_PROXY
const SIGNATURE_TYPE_EOA = 0;
const SIGNATURE_TYPE_POLY_PROXY = 1;

const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
type WalletCompat = Wallet & { _signTypedData?: Wallet['signTypedData'] };
const wallet = new Wallet(privateKey) as WalletCompat;

// Patch: ethers v6 compatibility - add _signTypedData alias
if (!wallet._signTypedData && wallet.signTypedData) {
  wallet._signTypedData = wallet.signTypedData.bind(wallet);
}

const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;
const sigType = proxyAddress ? SIGNATURE_TYPE_POLY_PROXY : SIGNATURE_TYPE_EOA;
const funder = proxyAddress || undefined;

console.log("Wallet Address:", wallet.address);
if (proxyAddress) {
  console.log("Proxy Address:", proxyAddress);
  console.log("SignatureType: POLY_PROXY (1)");
} else {
  console.log("No proxy address set - using EOA signing");
}

const clobClient = new ClobClient({
  host: POLYMARKET_HOST,
  chain: Chain.POLYGON,
  signer: wallet as any,
  signatureType: sigType,
  funderAddress: funder,
  useServerTime: true,
  throwOnError: true,
});

console.log("\nDeriving API credentials...");
const creds = await clobClient.deriveApiKey();

console.log("\nCredentials derived successfully!\n");
console.log("=".repeat(50));
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
console.log("=".repeat(50));
console.log("\nRaw response:", JSON.stringify(creds, null, 2));
