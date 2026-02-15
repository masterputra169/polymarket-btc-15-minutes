/**
 * Auto-Redeem Resolved Polymarket Positions.
 *
 * Runs every 1 hour, finds resolved positions with unredeemed conditional tokens
 * (ERC1155 on Gnosis CTF contract), and calls redeemPositions() on-chain to
 * convert winning tokens back to USDC.e.
 *
 * Supports two wallet modes:
 * 1. EOA mode (no POLYMARKET_PROXY_ADDRESS): tokens held by EOA, direct CTF call.
 * 2. Proxy mode (POLYMARKET_PROXY_ADDRESS set): tokens held by Gnosis Safe,
 *    CTF call routed through Safe.execTransaction() with EOA signature (1-of-1).
 *
 * Deduplication: in-memory Set persisted to disk + on-chain balanceOf check + CTF idempotency.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { ethers } from 'ethers';
import { BOT_CONFIG, CONFIG } from '../config.js';
import { createLogger } from '../logger.js';
import { getWalletAddress } from './clobClient.js';

const log = createLogger('Redeemer');

// ── Constants ──

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_RPC = 'https://polygon-rpc.com';
const DATA_API = 'https://data-api.polymarket.com';
const PARENT_COLLECTION_ID = '0x' + '0'.repeat(64);
const INDEX_SETS = [1, 2]; // outcome 0 + outcome 1 for binary markets

// Minimal ABIs (ethers v6 human-readable)
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function nonce() view returns (uint256)',
];

// ── Module state ──

let intervalId = null;
let provider = null;
let signer = null;
let redeemedSet = new Set(); // conditionIds already redeemed

// ── Provider / Wallet ──

function initProvider() {
  if (provider) return;
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  if (!pk) throw new Error('POLYMARKET_PRIVATE_KEY not set');

  provider = new ethers.JsonRpcProvider(POLYGON_RPC);
  signer = new ethers.Wallet(pk, provider);
  log.info(`Redeemer wallet: ${signer.address}`);
}

// ── MATIC balance check ──

async function checkMaticBalance() {
  try {
    const bal = await provider.getBalance(signer.address);
    const matic = Number(ethers.formatEther(bal));
    if (matic < 0.01) {
      log.warn(`Low MATIC balance: ${matic.toFixed(4)} MATIC — redemption txs may fail`);
    } else {
      log.debug(`MATIC balance: ${matic.toFixed(4)}`);
    }
  } catch (err) {
    log.warn(`MATIC balance check failed: ${err.message}`);
  }
}

// ── Find redeemable positions ──

/**
 * Fetch positions from Polymarket Data API for the holder address,
 * then check CLOB /markets/{conditionId} for closed + winner status.
 * Returns array of { conditionId, tokenId, size, side, winner }.
 */
async function findRedeemablePositions() {
  const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
  const holder = proxyAddr || getWalletAddress();
  if (!holder) {
    log.warn('No wallet address available — cannot query positions');
    return [];
  }

  // Fetch positions from Data API
  let positions;
  try {
    const url = `${DATA_API}/positions?user=${holder}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    positions = Array.isArray(raw) ? raw : [];
  } catch (err) {
    log.warn(`Failed to fetch positions: ${err.message}`);
    return [];
  }

  // Filter to non-zero positions not already redeemed
  const candidates = positions
    .map(p => ({
      conditionId: p.conditionId ?? p.condition_id ?? '',
      tokenId: p.tokenId ?? p.token_id ?? '',
      size: Number(p.size) || 0,
      side: p.outcome ?? p.side ?? '',
    }))
    .filter(p => p.size > 0 && p.conditionId && !redeemedSet.has(p.conditionId));

  if (candidates.length === 0) return [];

  log.info(`Checking ${candidates.length} position(s) for resolution...`);

  // Check each candidate against CLOB API for closed + winner
  const redeemable = [];
  // Deduplicate by conditionId (may have multiple tokenIds per condition)
  const seen = new Set();

  for (const pos of candidates) {
    if (seen.has(pos.conditionId)) continue;
    seen.add(pos.conditionId);

    try {
      const url = `${CONFIG.clobBaseUrl}/markets/${pos.conditionId}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;

      const market = await res.json();
      if (!market || market.closed !== true) continue;

      // Find winner token
      const tokens = Array.isArray(market.tokens) ? market.tokens : [];
      const winnerToken = tokens.find(t => t.winner === true);
      if (!winnerToken) continue; // Not yet resolved or no winner

      redeemable.push({
        conditionId: pos.conditionId,
        winner: winnerToken.outcome,
        question: market.question ?? '',
      });
    } catch {
      // Skip — will retry next cycle
    }
  }

  return redeemable;
}

// ── On-chain token balance query ──

/**
 * Query ERC1155 balanceOf on CTF contract via raw eth_call.
 * Returns balance as BigInt, or 0n on error.
 */
async function queryTokenBalance(tokenId, holder) {
  try {
    const addr = '000000000000000000000000' + holder.slice(2).toLowerCase();
    const id = BigInt(tokenId).toString(16).padStart(64, '0');
    const data = '0x00fdd58e' + addr + id; // balanceOf(address,uint256)

    const res = await fetch(POLYGON_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: CTF_ADDRESS, data }, 'latest'], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json();
    if (!json.result || json.result === '0x' || json.result === '0x0') return 0n;
    return BigInt(json.result);
  } catch (err) {
    log.warn(`Token balance query failed: ${err.message}`);
    return 0n;
  }
}

/**
 * Check if any outcome tokens for this condition have non-zero balance.
 * Queries both outcome token IDs derived from conditionId.
 */
async function hasRedeemableBalance(conditionId, holder) {
  // Get token IDs for each outcome index from CLOB market info
  try {
    const url = `${CONFIG.clobBaseUrl}/markets/${conditionId}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return false;

    const market = await res.json();
    const tokens = Array.isArray(market.tokens) ? market.tokens : [];

    for (const token of tokens) {
      const tokenId = token.token_id;
      if (!tokenId) continue;
      const bal = await queryTokenBalance(tokenId, holder);
      if (bal > 0n) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Redemption methods ──

/**
 * EOA mode: call CTF.redeemPositions() directly from signer.
 */
async function redeemDirect(conditionId) {
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, signer);
  const tx = await ctf.redeemPositions(USDC_E, PARENT_COLLECTION_ID, conditionId, INDEX_SETS);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Proxy mode: encode CTF call → Safe.execTransaction() with EOA signature.
 * Assumes EOA is the sole 1-of-1 owner of the Safe.
 */
async function redeemViaSafe(conditionId, safeAddr) {
  const ctfIface = new ethers.Interface(CTF_ABI);
  const callData = ctfIface.encodeFunctionData('redeemPositions', [
    USDC_E, PARENT_COLLECTION_ID, conditionId, INDEX_SETS,
  ]);

  const safe = new ethers.Contract(safeAddr, SAFE_ABI, signer);
  const nonce = await safe.nonce();

  // Build Safe transaction hash for signing
  // operation=0 (CALL), no gas token/refund
  const safeTxGas = 0n;
  const baseGas = 0n;
  const gasPrice = 0n;
  const gasToken = ethers.ZeroAddress;
  const refundReceiver = ethers.ZeroAddress;

  // EIP-712 domain + typed data for Safe tx signing
  const domain = {
    chainId: 137,
    verifyingContract: safeAddr,
  };
  const types = {
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
  };
  const value = {
    to: CTF_ADDRESS,
    value: 0n,
    data: callData,
    operation: 0, // CALL
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce,
  };

  // Sign with EOA (sole owner)
  const sig = await signer.signTypedData(domain, types, value);

  const tx = await safe.execTransaction(
    CTF_ADDRESS,
    0, // value
    callData,
    0, // operation = CALL
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    sig,
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Route redemption to direct or Safe mode based on proxy config.
 */
async function redeemPosition(conditionId) {
  const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
  if (proxyAddr) {
    return redeemViaSafe(conditionId, proxyAddr);
  }
  return redeemDirect(conditionId);
}

// ── Persistence ──

function loadRedeemedSet() {
  try {
    const filePath = BOT_CONFIG.redeemedFile;
    if (!existsSync(filePath)) return;
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (Array.isArray(data)) {
      redeemedSet = new Set(data);
      log.info(`Loaded ${redeemedSet.size} redeemed conditionId(s) from disk`);
    }
  } catch {
    // Fresh start
  }
}

function saveRedeemedSet() {
  try {
    const filePath = BOT_CONFIG.redeemedFile;
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = JSON.stringify([...redeemedSet], null, 2);
    // Atomic write
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, data);
    try {
      renameSync(tmpPath, filePath);
    } catch {
      writeFileSync(filePath, data);
    }
  } catch (err) {
    log.warn(`Failed to save redeemed set: ${err.message}`);
  }
}

// ── Main cycle ──

async function redeemCycle() {
  log.info('Starting redemption cycle...');

  try {
    await checkMaticBalance();
  } catch {
    // Non-fatal
  }

  const redeemable = await findRedeemablePositions();
  if (redeemable.length === 0) {
    log.info('No redeemable positions found');
    return;
  }

  log.info(`Found ${redeemable.length} redeemable position(s)`);

  const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
  const holder = proxyAddr || getWalletAddress();

  let redeemed = 0;
  let failed = 0;

  for (const pos of redeemable) {
    const short = pos.conditionId.slice(0, 16);

    // Check on-chain balance before attempting redemption
    const hasBal = await hasRedeemableBalance(pos.conditionId, holder);
    if (!hasBal) {
      log.debug(`No token balance for ${short}... — already redeemed or zero`);
      redeemedSet.add(pos.conditionId);
      continue;
    }

    try {
      log.info(`Redeeming ${short}... | winner=${pos.winner} | ${pos.question.slice(0, 60)}`);
      const txHash = await redeemPosition(pos.conditionId);
      log.info(`Redeemed conditionId=${short}... | tx=${txHash}`);
      redeemedSet.add(pos.conditionId);
      redeemed++;
    } catch (err) {
      log.warn(`Redeem failed for ${short}...: ${err.message}`);
      failed++;
    }

    // Sleep 2s between positions to avoid rate limits
    if (redeemable.indexOf(pos) < redeemable.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  saveRedeemedSet();

  log.info(`Redemption cycle complete: ${redeemed} redeemed, ${failed} failed, ${redeemable.length - redeemed - failed} skipped`);
}

// ── Lifecycle ──

export function startRedeemer() {
  try {
    initProvider();
  } catch (err) {
    log.error(`Cannot start redeemer: ${err.message}`);
    return;
  }

  loadRedeemedSet();

  // Initial cycle (delayed 10s to let other services start)
  setTimeout(() => {
    redeemCycle().catch(err => log.warn(`Initial redeem cycle failed: ${err.message}`));
  }, 10_000);

  const ms = BOT_CONFIG.redeemIntervalMs;
  intervalId = setInterval(() => {
    redeemCycle().catch(err => log.warn(`Redeem cycle failed: ${err.message}`));
  }, ms);

  log.info(`Redeemer started (every ${Math.round(ms / 60000)} min)`);
}

export function stopRedeemer() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Redeemer stopped');
  }
}
