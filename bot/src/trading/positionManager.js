/**
 * Position Manager — Fetches real on-chain positions from Polymarket Data API.
 * Provides close/sell operations and JSON persistence.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { createLogger } from '../logger.js';
import { BOT_CONFIG } from '../config.js';
import { placeSellOrder, getWalletAddress, getConditionalTokenBalance, updateConditionalApproval } from './clobClient.js';

const log = createLogger('Positions');

const CACHE_TTL_MS = 15_000; // Cache positions for 15s
const DATA_API = 'https://data-api.polymarket.com';

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const POLYGON_RPC = 'https://polygon-rpc.com';

let cachedPositions = [];
let lastFetchMs = 0;
let pollTimer = null;

/**
 * Fetch positions from Polymarket Data API.
 * @param {string} walletAddress - Wallet address to query
 * @returns {Array} Parsed position objects
 */
export async function fetchPositions(walletAddress) {
  if (!walletAddress) return [];

  const url = `${DATA_API}/positions?user=${walletAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Positions API ${res.status}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) return [];

  return raw.map(p => ({
    conditionId: p.conditionId ?? p.condition_id ?? '',
    tokenId: p.tokenId ?? p.token_id ?? '',
    size: Number(p.size) || 0,
    avgPrice: Number(p.avgPrice ?? p.avg_price) || 0,
    currentPrice: Number(p.curPrice ?? p.current_price ?? p.price) || 0,
    pnl: Number(p.pnl) || 0,
    market: p.title ?? p.market ?? '',
    side: p.outcome ?? p.side ?? '',
    asset: p.asset ?? '',
  })).filter(p => p.size > 0);
}

/**
 * Query actual on-chain CTF token balance for the proxy wallet.
 * Returns balance in decimal (e.g. 7.883), or null on error.
 */
async function queryOnChainTokenBalance(tokenId) {
  try {
    const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS || getWalletAddress();
    if (!proxyAddress) return null;

    // ERC1155 balanceOf(address, uint256)
    const addr = '000000000000000000000000' + proxyAddress.slice(2).toLowerCase();
    // C6 FIX: Validate tokenId before BigInt conversion — invalid values throw synchronous error
    // which propagates out of try/catch in some JS engines. Catch explicitly.
    let bigId;
    try { bigId = BigInt(tokenId); } catch {
      log.warn(`On-chain balance query skipped: invalid tokenId format (${String(tokenId).slice(0, 20)})`);
      return null;
    }
    const id = bigId.toString(16).padStart(64, '0');
    const data = '0x00fdd58e' + addr + id;

    const res = await fetch(POLYGON_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: CTF_ADDRESS, data }, 'latest'], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = await res.json();
    if (!json.result) return null;
    return Number(BigInt(json.result)) / 1e6;
  } catch (err) {
    log.warn(`On-chain balance query failed: ${err.message}`);
    return null;
  }
}

/**
 * Close a position by placing a FOK sell order.
 * If sell fails due to balance mismatch (recorded size > actual on-chain tokens),
 * retries with the actual on-chain balance.
 */
export async function closePosition(tokenId, size, price) {
  if (BOT_CONFIG.dryRun) {
    log.info(`[DRY RUN] Would SELL ${size} @ ${price} | token=${tokenId.slice(0, 12)}...`);
    return { dryRun: true };
  }
  try {
    return await placeSellOrder({ tokenId, price, size });
  } catch (err) {
    if (!err.message.includes('not enough balance')) throw err;

    log.warn(`SELL balance mismatch for ${tokenId.slice(0, 12)}... recorded=${size} — checking actual balance`);

    // ── Step 1: CLOB API balance + allowance check (primary — most reliable, no RPC blocks) ──
    const clobInfo = await getConditionalTokenBalance(tokenId);
    if (clobInfo !== null) {
      const { balance: clobBalance, allowance: clobAllowance } = clobInfo;

      if (clobBalance <= 0) {
        // Confirmed phantom: no tokens in wallet — position was never really filled or already redeemed
        log.error(`SELL ABORTED — CLOB shows 0 tokens for ${tokenId.slice(0, 12)}... (recorded size=${size}). Phantom position or already settled.`);
        throw new Error('no_tokens_on_chain');
      }

      // Check ERC1155 allowance: 0 = exchange not approved to transfer tokens
      // Fix: trigger Polymarket's gasless approval relay, then retry sell.
      if (clobAllowance === 0) {
        log.warn(`SELL: ERC1155 approval missing for ${tokenId.slice(0, 12)}... — triggering gasless approval via CLOB API`);
        await updateConditionalApproval(tokenId);
        // Wait for approval to propagate on-chain (Polygon ~2s block time)
        await new Promise(r => setTimeout(r, 4000));
        log.info(`Retrying sell after approval update (balance=${clobBalance.toFixed(6)}, size=${size})`);
        const sellSize = clobBalance < size
          ? Math.floor(clobBalance * 1e6) / 1e6
          : size;
        return await placeSellOrder({ tokenId, price, size: sellSize });
      }

      if (clobBalance < size) {
        const correctedSize = Math.floor(clobBalance * 1e6) / 1e6;
        log.warn(`CLOB balance ${clobBalance.toFixed(6)} < recorded ${size} — retrying sell with ${correctedSize}`);
        return await placeSellOrder({ tokenId, price, size: correctedSize });
      }

      // Balance + allowance both sufficient, but order still rejected.
      // Try one more time after re-triggering approval (may fix stale approval state).
      log.warn(
        `SELL FAILED — CLOB balance (${clobBalance.toFixed(6)}) >= size (${size}) and allowance=${clobAllowance}. ` +
        `Re-triggering approval and retrying once...`
      );
      await updateConditionalApproval(tokenId);
      await new Promise(r => setTimeout(r, 4000));
      try {
        return await placeSellOrder({ tokenId, price, size });
      } catch (retryErr) {
        log.error(
          `SELL FAILED after approval retry — balance OK, allowance OK, order still rejected. ` +
          `Possible missing CTF ERC1155 approval on proxy. Re-approve via Polymarket UI. Error: ${retryErr.message}`
        );
        throw retryErr;
      }
    }

    // ── Step 2: Fallback — Polygon RPC on-chain balance ──
    const onChainBalance = await queryOnChainTokenBalance(tokenId);
    if (onChainBalance !== null) {
      if (onChainBalance <= 0) {
        log.error(`SELL ABORTED — on-chain balance = 0 for ${tokenId.slice(0, 12)}... Phantom position.`);
        throw new Error('no_tokens_on_chain');
      }
      if (onChainBalance < size) {
        const correctedSize = Math.floor(onChainBalance * 1e6) / 1e6;
        log.warn(`On-chain balance ${onChainBalance.toFixed(6)} < recorded ${size} — retrying with ${correctedSize}`);
        // Also try approval in case that's the issue
        await updateConditionalApproval(tokenId);
        await new Promise(r => setTimeout(r, 2000));
        return await placeSellOrder({ tokenId, price, size: correctedSize });
      }
      // Balance sufficient — try approval fix
      log.warn(`On-chain balance ${onChainBalance.toFixed(6)} >= ${size} but rejected — trying approval fix`);
      await updateConditionalApproval(tokenId);
      await new Promise(r => setTimeout(r, 4000));
      try {
        return await placeSellOrder({ tokenId, price, size });
      } catch (retryErr) {
        log.error(
          `SELL FAILED — on-chain balance OK but order rejected after approval fix. ` +
          `Re-approve via Polymarket UI. Error: ${retryErr.message}`
        );
        throw retryErr;
      }
    }

    // ── Step 3: Both APIs unavailable — try approval fix + safe-size fallback ──
    // First try approval in case that's the issue
    log.warn(`Balance APIs unavailable — trying approval fix before safe-size fallback`);
    await updateConditionalApproval(tokenId);
    await new Promise(r => setTimeout(r, 3000));
    try {
      return await placeSellOrder({ tokenId, price, size });
    } catch (_approvalRetryErr) {
      // Approval didn't help — try safe-size (covers tiny rounding mismatches)
    }

    const microSize = Math.round(size * 1e6);
    const safeSize  = Math.floor((microSize - 1) / 1000) * 1000 / 1e6;
    if (safeSize > 0 && safeSize < size) {
      log.warn(`Retrying with safe size ${safeSize} (was ${size}, -1 microshare)`);
      return await placeSellOrder({ tokenId, price, size: safeSize });
    }

    throw err;
  }
}

/**
 * Get cached positions + last update timestamp.
 */
export function getPositionsSummary() {
  return {
    list: cachedPositions,
    lastUpdate: lastFetchMs || null,
  };
}

/**
 * Get positions merged with bot's local position tracking.
 * Returns API positions augmented with the bot's local position
 * (which is available instantly, before the API catches up).
 */
export function getMergedPositions(localPosition) {
  const merged = [...cachedPositions];

  if (localPosition && !localPosition.settled && localPosition.size > 0) {
    const matchIdx = merged.findIndex(p => p.tokenId === localPosition.tokenId);
    if (matchIdx >= 0) {
      merged[matchIdx] = { ...merged[matchIdx], botTracked: true, botSide: localPosition.side };
    } else {
      merged.push({
        conditionId: '',
        tokenId: localPosition.tokenId,
        size: localPosition.size,
        avgPrice: localPosition.price,
        currentPrice: localPosition.price,
        pnl: 0,
        market: localPosition.marketSlug ?? '',
        side: localPosition.side,
        asset: '',
        botTracked: true,
        botSide: localPosition.side,
        enteredAt: localPosition.enteredAt,
        fillConfirmed: localPosition.fillConfirmed ?? false,
      });
    }
  }

  return {
    list: merged,
    lastUpdate: lastFetchMs || Date.now(),
    botPosition: localPosition && !localPosition.settled ? {
      side: localPosition.side,
      tokenId: localPosition.tokenId ?? null,
      size: localPosition.size,
      price: localPosition.price,
      cost: localPosition.cost,
      marketSlug: localPosition.marketSlug,
      enteredAt: localPosition.enteredAt,
      fillConfirmed: localPosition.fillConfirmed ?? false,
      settled: localPosition.settled,
    } : null,
  };
}

/**
 * Poll positions — fetch + cache + persist to disk.
 */
export async function pollPositions() {
  const now = Date.now();
  if (now - lastFetchMs < CACHE_TTL_MS) return;

  const addr = getWalletAddress();
  if (!addr) return;

  try {
    cachedPositions = await fetchPositions(addr);
    lastFetchMs = now;
    savePositions();
    log.debug(`Fetched ${cachedPositions.length} positions`);
  } catch (err) {
    log.warn(`Position fetch failed: ${err.message}`);
    lastFetchMs = now; // Prevent retry storm
  }
}

/**
 * Start periodic position polling.
 */
export function startPolling(intervalMs = BOT_CONFIG.positionPollIntervalMs ?? 60_000) {
  if (pollTimer) return;
  pollPositions().catch(err => log.warn(`Initial position poll failed: ${err.message}`)); // M6: catch initial poll errors
  pollTimer = setInterval(pollPositions, intervalMs);
  log.info(`Position polling started (every ${intervalMs / 1000}s)`);
}

/**
 * Stop position polling.
 */
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Save positions snapshot to disk.
 */
function savePositions() {
  try {
    const filePath = BOT_CONFIG.positionsFile;
    mkdirSync(dirname(filePath), { recursive: true });
    // M5: Atomic write — write to temp then rename to prevent corruption on crash
    const tmpPath = filePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify({
      lastUpdate: lastFetchMs,
      positions: cachedPositions,
    }, null, 2));
    try {
      renameSync(tmpPath, filePath);
    } catch (renameErr) {
      log.debug(`Rename failed (${renameErr.message}) — direct write`);
      writeFileSync(filePath, JSON.stringify({
        lastUpdate: lastFetchMs,
        positions: cachedPositions,
      }, null, 2));
    }
  } catch (err) {
    log.warn(`Failed to save positions: ${err.message}`);
  }
}

/**
 * Load positions from disk (on startup).
 */
export function loadPositions() {
  try {
    const raw = readFileSync(BOT_CONFIG.positionsFile, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.positions)) {
      cachedPositions = data.positions;
      lastFetchMs = data.lastUpdate || 0;
      log.info(`Loaded ${cachedPositions.length} positions from disk`);
    }
  } catch (err) {
    log.debug(`No saved positions to load: ${err.message}`);
  }
}
