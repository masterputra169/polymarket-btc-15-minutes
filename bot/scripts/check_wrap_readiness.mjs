/**
 * Pre-flight check for auto-activate (USDC.e → pUSD wrap).
 * Reports: balances, allowance, gas, and Safe owner setup.
 */
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-mainnet.core.chainstack.com/af9ff560fda2d0cd33e2dc98b41748af';
const provider = new ethers.JsonRpcProvider(RPC, { name: 'matic', chainId: 137 }, { staticNetwork: true, batchMaxCount: 1 });

const USDCE  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';
const PUSD   = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

const wallet = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
const EOA = wallet.address;
const PROXY = process.env.POLYMARKET_PROXY_ADDRESS;

const ERC20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const SAFE = new ethers.Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
]);

async function main() {
  console.log('═══ Pre-flight check: auto-activate USDC.e → pUSD ═══\n');
  console.log('EOA:  ', EOA);
  console.log('Proxy:', PROXY);
  console.log('Onramp:', ONRAMP);
  console.log();

  // Balances
  const usdce = new ethers.Contract(USDCE, ERC20, provider);
  const [usdceProxy, usdceEoa, allowance] = await Promise.all([
    usdce.balanceOf(PROXY),
    usdce.balanceOf(EOA),
    usdce.allowance(PROXY, ONRAMP),  // proxy is owner since it holds tokens
  ]);
  console.log('USDC.e balances:');
  console.log(`  Proxy:           ${(Number(usdceProxy)/1e6).toFixed(4)} USDC.e`);
  console.log(`  EOA:             ${(Number(usdceEoa)/1e6).toFixed(4)} USDC.e`);
  console.log(`  Proxy→Onramp allowance: ${(Number(allowance)/1e6).toFixed(4)} USDC.e`);
  const needApproval = allowance < usdceProxy;
  console.log(`  Approval needed: ${needApproval ? 'YES (need Safe.execTransaction → USDCE.approve)' : 'NO'}`);
  console.log();

  // pUSD balance (sanity)
  const pusd = new ethers.Contract(PUSD, ERC20, provider);
  const pusdProxy = await pusd.balanceOf(PROXY);
  console.log(`pUSD balance (proxy): ${(Number(pusdProxy)/1e6).toFixed(4)} pUSD`);
  console.log();

  // Gas
  const eoaGas = await provider.getBalance(EOA);
  console.log(`MATIC gas (EOA): ${ethers.formatEther(eoaGas)} MATIC`);
  const minGas = ethers.parseEther('0.05');
  console.log(`  Sufficient for ~2 Safe txs (~0.02-0.05 each)? ${eoaGas >= minGas ? 'YES' : 'NO'}`);
  console.log();

  // Safe inspection
  try {
    const safe = new ethers.Contract(PROXY, SAFE, provider);
    const [owners, threshold, nonce] = await Promise.all([
      safe.getOwners(),
      safe.getThreshold(),
      safe.nonce(),
    ]);
    console.log('Gnosis Safe state:');
    console.log(`  Owners:    ${owners.join(', ')}`);
    console.log(`  Threshold: ${threshold} (sole owner = 1-of-1)`);
    console.log(`  Nonce:     ${nonce}`);
    const isOwner = owners.map(o => o.toLowerCase()).includes(EOA.toLowerCase());
    console.log(`  EOA is owner: ${isOwner ? 'YES' : 'NO (CRITICAL — cannot execTransaction!)'}`);
  } catch (e) {
    console.log('Safe inspection failed:', e.message);
  }
  console.log();

  // Verdict
  console.log('═══ Verdict ═══');
  if (usdceProxy === 0n) {
    console.log('  Nothing to wrap (USDC.e proxy balance is 0).');
    return;
  }
  if (eoaGas < ethers.parseEther('0.02')) {
    console.log('  [WARN] EOA gas too low. Top up MATIC before running activator.');
  }
  console.log('  Wrap will require:');
  if (needApproval) console.log('    1) Safe.execTransaction → USDC.e.approve(Onramp, MaxUint256)');
  console.log(`    ${needApproval ? '2' : '1'}) Safe.execTransaction → Onramp.wrap(USDC.e, ${PROXY}, ${(Number(usdceProxy)/1e6).toFixed(4)}e6)`);
  console.log('  Both signed by EOA, gas paid by EOA wallet.');
}

main().catch(err => { console.error(err); process.exit(1); });
