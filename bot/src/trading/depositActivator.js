/**
 * Deposit Activator -- auto-converts USDC.e in proxy wallet to pUSD
 * via Polymarket CollateralOnramp.wrap(). Mirrors the "Activate Funds"
 * button in Polymarket UI.
 *
 * Background:
 *   - User deposits go into Gnosis Safe proxy as USDC.e (legacy bridged token).
 *   - Polymarket trading uses pUSD (ERC-20 backed 1:1 by USDC, post-Apr 2026 upgrade).
 *   - "Activate Funds" in UI = approve + wrap on-chain.
 *
 * This module performs 2 Gnosis Safe execTransaction calls:
 *   1. USDC.e.approve(Onramp, MaxUint256)  -- one-time, idempotent
 *   2. Onramp.wrap(USDC.e, proxy, balance) -- converts proxy's USDC.e to pUSD
 *
 * Signed by EOA (sole owner of 1-of-1 Safe). Gas paid by EOA wallet.
 *
 * Safety:
 *   - Gated by AUTO_ACTIVATE_DEPOSITS env (default false)
 *   - Skips if DRY_RUN=true
 *   - Respects MIN_ACTIVATE_AMOUNT to avoid dust wraps
 *   - Idempotent: reads on-chain state before each step
 *   - Notification on success/failure
 *
 * Created 2026-05-14.
 */

import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { notify } from '../monitoring/notifier.js';
import { gasFeeOverrides } from './gasConfig.js';

const log = createLogger('Activator');

// ── Polygon mainnet contract addresses ──
const USDCE  = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee';
const PUSD   = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

// Reuse Chainstack endpoint from redeemer (shared dedicated node)
const CHAINSTACK_HTTP = 'https://polygon-mainnet.core.chainstack.com/af9ff560fda2d0cd33e2dc98b41748af';
const POLYGON_NETWORK = new ethers.Network('matic', 137);

// ── ABIs ──
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const ONRAMP_ABI = [
  'function wrap(address _asset, address _to, uint256 _amount) external',
];
const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
];

// ── EIP-712 typed data scaffolding for Safe tx ──
function buildSafeTxTypedData(safeAddr, to, callData, nonce) {
  return {
    domain: { chainId: 137, verifyingContract: safeAddr },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    value: {
      to,
      value: 0n,
      data: callData,
      operation: 0,                          // CALL
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ethers.ZeroAddress,
      refundReceiver: ethers.ZeroAddress,
      nonce,
    },
  };
}

/**
 * Send a single Safe.execTransaction: encode → sign → send.
 *
 * @param {object} ctx -- { provider, signer, safeAddr, label, targetAddr, callData, gasLimit }
 * @returns {Promise<ethers.TransactionResponse>}
 */
async function execSafeTx({ provider, signer, safeAddr, label, targetAddr, callData, gasLimit = 500_000n }) {
  const safeRead = new ethers.Contract(safeAddr, SAFE_ABI, provider);
  const nonce = await safeRead.nonce();
  log.info(`${label}: Safe nonce ${nonce}`);

  const { domain, types, value } = buildSafeTxTypedData(safeAddr, targetAddr, callData, nonce);
  const sig = await signer.signTypedData(domain, types, value);

  const safe = new ethers.Contract(safeAddr, SAFE_ABI, signer);
  const tx = await safe.execTransaction(
    targetAddr, 0n, callData, 0,           // to, value, data, operation
    0n, 0n, 0n,                            // safeTxGas, baseGas, gasPrice
    ethers.ZeroAddress, ethers.ZeroAddress, // gasToken, refundReceiver
    sig,
    { gasLimit, ...gasFeeOverrides() },
  );
  log.info(`${label}: tx submitted ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label}: tx reverted ${tx.hash}`);
  }
  log.info(`${label}: confirmed block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);
  return receipt;
}

/**
 * Inspect on-chain state to decide what (if anything) to do.
 *
 * @param {ethers.Provider} provider
 * @param {string} eoa
 * @param {string} safeAddr
 * @returns {Promise<{ usdceBalance: bigint, allowance: bigint, eoaGas: bigint, safeOwners: string[] }>}
 */
async function inspectState(provider, eoa, safeAddr) {
  const usdce = new ethers.Contract(USDCE, ERC20_ABI, provider);
  const safe  = new ethers.Contract(safeAddr, SAFE_ABI, provider);
  const [usdceBalance, allowance, eoaGas, safeOwners, safeThresh] = await Promise.all([
    usdce.balanceOf(safeAddr),
    usdce.allowance(safeAddr, ONRAMP),
    provider.getBalance(eoa),
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  if (Number(safeThresh) !== 1) {
    throw new Error(`Safe threshold is ${safeThresh}, expected 1 (1-of-1 setup required)`);
  }
  const ownerSet = new Set(safeOwners.map(o => o.toLowerCase()));
  if (!ownerSet.has(eoa.toLowerCase())) {
    throw new Error(`EOA ${eoa} is not an owner of Safe ${safeAddr}`);
  }
  return { usdceBalance, allowance, eoaGas, safeOwners };
}

/**
 * Main entry: detect USDC.e in proxy and wrap to pUSD via Safe.execTransaction.
 *
 * @param {object} opts
 * @param {bigint} [opts.minAmount=1_000_000n]  -- Minimum USDC.e to wrap (default 1 USDC.e). Below this, skip.
 * @param {boolean} [opts.dryRun=false]         -- If true, only print plan without executing.
 * @returns {Promise<{ executed: boolean, txs: string[], pusdAdded: number, reason?: string }>}
 */
export async function activateDeposit({ minAmount = 1_000_000n, dryRun = false } = {}) {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set');
  if (!proxyAddr) throw new Error('POLYMARKET_PROXY_ADDRESS not set');

  const provider = new ethers.JsonRpcProvider(CHAINSTACK_HTTP, POLYGON_NETWORK, { staticNetwork: true, batchMaxCount: 1 });
  const signer = new ethers.Wallet(pk, provider);
  const eoa = signer.address;

  log.info(`Activator start | EOA=${eoa} | Safe=${proxyAddr}`);

  const state = await inspectState(provider, eoa, proxyAddr);
  log.info(
    `State: USDC.e=${(Number(state.usdceBalance)/1e6).toFixed(4)} | ` +
    `allowance=${(Number(state.allowance)/1e6).toFixed(4)} | ` +
    `gas=${ethers.formatEther(state.eoaGas)} MATIC`
  );

  // Early exits (idempotent skip)
  if (state.usdceBalance < minAmount) {
    const reason = `USDC.e balance ${(Number(state.usdceBalance)/1e6).toFixed(4)} below minAmount ${(Number(minAmount)/1e6).toFixed(4)} -- nothing to wrap`;
    log.info(reason);
    return { executed: false, txs: [], pusdAdded: 0, reason };
  }
  if (state.eoaGas < ethers.parseEther('0.02')) {
    const reason = `EOA gas too low (${ethers.formatEther(state.eoaGas)} MATIC) -- need ≥0.02 for 2 txs`;
    log.error(reason);
    return { executed: false, txs: [], pusdAdded: 0, reason };
  }

  const erc20Iface  = new ethers.Interface(ERC20_ABI);
  const onrampIface = new ethers.Interface(ONRAMP_ABI);
  const txs = [];

  // Step 1: approve (if needed)
  if (state.allowance < state.usdceBalance) {
    const approveData = erc20Iface.encodeFunctionData('approve', [ONRAMP, ethers.MaxUint256]);
    if (dryRun) {
      log.info(`[DRY] Would execTransaction → USDC.e.approve(${ONRAMP}, MaxUint256)`);
    } else {
      const r = await execSafeTx({
        provider, signer, safeAddr: proxyAddr,
        label: 'Approve USDC.e→Onramp',
        targetAddr: USDCE, callData: approveData,
        gasLimit: 200_000n,
      });
      txs.push(r.hash);
    }
  } else {
    log.info('Approval already sufficient -- skipping approve step');
  }

  // Step 2: wrap
  const wrapAmount = state.usdceBalance;
  const wrapData = onrampIface.encodeFunctionData('wrap', [USDCE, proxyAddr, wrapAmount]);
  if (dryRun) {
    log.info(`[DRY] Would execTransaction → Onramp.wrap(USDC.e, ${proxyAddr}, ${wrapAmount})`);
    return { executed: false, txs, pusdAdded: 0, reason: 'dry-run' };
  }

  // Snapshot pre-wrap pUSD for delta reporting
  const pusd = new ethers.Contract(PUSD, ERC20_ABI, provider);
  const pusdBefore = await pusd.balanceOf(proxyAddr);

  const r2 = await execSafeTx({
    provider, signer, safeAddr: proxyAddr,
    label: `Wrap USDC.e→pUSD (${(Number(wrapAmount)/1e6).toFixed(4)})`,
    targetAddr: ONRAMP, callData: wrapData,
    gasLimit: 250_000n,
  });
  txs.push(r2.hash);

  const pusdAfter = await pusd.balanceOf(proxyAddr);
  const pusdAddedRaw = pusdAfter - pusdBefore;
  const pusdAdded = Number(pusdAddedRaw) / 1e6;

  log.info(`Activator DONE: ${(Number(wrapAmount)/1e6).toFixed(4)} USDC.e → ${pusdAdded.toFixed(4)} pUSD`);
  await notify('info', `Auto-activate: ${(Number(wrapAmount)/1e6).toFixed(4)} USDC.e wrapped → ${pusdAdded.toFixed(4)} pUSD. New pUSD balance: ${(Number(pusdAfter)/1e6).toFixed(4)}`);

  return { executed: true, txs, pusdAdded };
}

/**
 * Convenience wrapper: respects DRY_RUN + AUTO_ACTIVATE_DEPOSITS env flags.
 * Called from bot startup.
 */
export async function autoActivateOnStartup() {
  const enabled = process.env.AUTO_ACTIVATE_DEPOSITS === 'true';
  if (!enabled) {
    log.debug('Auto-activate disabled (AUTO_ACTIVATE_DEPOSITS != true)');
    return { executed: false, reason: 'disabled' };
  }
  const dryRun = process.env.DRY_RUN === 'true';
  const minAmountUsd = parseFloat(process.env.MIN_ACTIVATE_AMOUNT ?? '1');
  const minAmount = BigInt(Math.round(minAmountUsd * 1e6));

  try {
    return await activateDeposit({ minAmount, dryRun });
  } catch (err) {
    log.error(`Auto-activate failed: ${err.message}`);
    await notify('warn', `Auto-activate failed: ${err.message}`);
    return { executed: false, txs: [], pusdAdded: 0, reason: err.message };
  }
}
