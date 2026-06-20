import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const RPC = process.env.POLYGON_RPC_URL || 'https://polygon-mainnet.core.chainstack.com/af9ff560fda2d0cd33e2dc98b41748af';
const provider = new ethers.JsonRpcProvider(RPC, { name: 'matic', chainId: 137 }, { staticNetwork: true, batchMaxCount: 1 });
const TOKENS = {
  'USDC.e':      '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  'USDC native': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'pUSD':        '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
};
const erc20 = (addr) => new ethers.Contract(addr, ['function balanceOf(address) view returns (uint256)'], provider);
const wallet = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY);
const EOA = wallet.address;
const PROXY = process.env.POLYMARKET_PROXY_ADDRESS;
console.log('EOA:  ', EOA);
console.log('Proxy:', PROXY);
console.log('');
for (const [name, addr] of Object.entries(TOKENS)) {
  const c = erc20(addr);
  const [eoa, proxy] = await Promise.all([c.balanceOf(EOA), c.balanceOf(PROXY)]);
  console.log(`${name.padEnd(13)} EOA: ${(Number(eoa)/1e6).toFixed(4).padStart(12)}  Proxy: ${(Number(proxy)/1e6).toFixed(4).padStart(12)}`);
}
const [eoaMatic, proxyMatic] = await Promise.all([
  provider.getBalance(EOA),
  provider.getBalance(PROXY),
]);
console.log('');
console.log('MATIC EOA:  ', ethers.formatEther(eoaMatic));
console.log('MATIC Proxy:', ethers.formatEther(proxyMatic));
