/**
 * WebSocket status broadcast server.
 * Sends bot state snapshots to connected dashboard clients.
 */

import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLogger } from './logger.ts';
import { setBankroll, getBankroll, acquireSellLock, releaseSellLock, settleTradeEarlyExit, earlyExitPnl, partialExit, getCurrentPosition, unwindPosition, settleTrade, setLastSettled } from './trading/positionTracker.ts';
import { computeSettlementPnl } from './engines/settlementMath.ts';
import { resetProfitTarget, getProfitTargetStatus } from './safety/dailyProfitTarget.ts';
import { writeJournalEntry, clearEntrySnapshot } from './trading/tradeJournal.ts';
import { resetCutLossState } from './trading/cutLoss.ts';
import { resetTakeProfitState } from './trading/takeProfit.ts';
import { recordLoss } from './safety/tradeFilters.ts';
import { forceUsdcSync } from './engines/usdcSync.ts';
import { maybeAnalyze, getLastAnalysis } from './ai/postTradeAnalyst.ts';
import { maybeOptimize, getOptimizerStatus } from './ai/selfOptimizer.ts';
import { cacheStatusSnapshot } from './services/runtimeIntegrations.ts';
import { isLocalBindHost } from './utils/net.ts';
import { parseClobAmount } from './utils/clobAmount.ts';

const log = createLogger('StatusWS');

const HEARTBEAT_MS = 15_000;             // W4: 30s→15s — faster zombie detection for trading bot
const SET_BANKROLL_COOLDOWN_MS = 5_000;  // rate limit: 1 setBankroll per 5s
const BOT_CONTROL_COOLDOWN_MS = 2_000;   // rate limit: 1 pause/resume per 2s
const BACKPRESSURE_MAX_BYTES = 64 * 1024; // W1: terminate clients with >64KB write backlog
const BROADCAST_THROTTLE_MS = 750;        // W9: max ~1.3 broadcasts/sec (500ms poll → skip every other)

let wss = null;
let heartbeatInterval = null;
let lastSnapshot = null;
let lastSetBankrollMs = 0;
let lastBotControlMs = 0;
let lastBroadcastMs = 0;

// Commands that spend money (LLM calls, third-party API sweeps) or write files are
// rate limited per command so one client cannot loop them.
const EXPENSIVE_COMMAND_COOLDOWN_MS = 10_000;
const lastCommandMs = new Map();
function commandThrottled(cmd, cooldownMs = EXPENSIVE_COMMAND_COOLDOWN_MS) {
  const now = Date.now();
  if (now - (lastCommandMs.get(cmd) ?? 0) < cooldownMs) return true;
  lastCommandMs.set(cmd, now);
  return false;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Bot control callbacks — set via registerBotControl() to avoid circular imports
let _pauseBot = null;
let _resumeBot = null;
let _resetDailyBaseline = null; // operator: lift a daily-loss halt caused by a stale baseline
let _resetEntryRegime = null;

// Position manager callbacks
let _getPositions = null;
let _closePosition = null;

// USDC sync callback — set via registerUsdcSync() to avoid circular imports
let _fetchUsdcBalance = null;
let lastForceSyncMs = 0;

// Trader discovery callbacks
let _scanTraders = null;
let _getTrackedTraders = null;
let _getDiscoveredTraders = null;
let _addTracker = null;
let _removeTracker = null;
let _simulateTrader = null;

function getStatusConfig() {
  const port = parseInt(process.env.STATUS_PORT || '3099', 10);
  const bindHost = (process.env.STATUS_BIND_HOST || process.env.STATUS_HOST || '127.0.0.1').trim();
  const authToken = (
    process.env.STATUS_AUTH_TOKEN ||
    process.env.STATUS_CONTROL_TOKEN ||
    process.env.BOT_STATUS_TOKEN ||
    ''
  ).trim();
  return {
    port,
    bindHost,
    authToken,
    authRequired: authToken.length > 0,
  };
}

function tokenMatches(candidate) {
  const { authToken, authRequired } = getStatusConfig();
  if (!authRequired || !candidate) return false;
  const expected = Buffer.from(authToken);
  const actual = Buffer.from(String(candidate));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requestToken(req) {
  try {
    const { bindHost, port } = getStatusConfig();
    const host = req?.headers?.host || `${bindHost}:${port}`;
    const url = new URL(req?.url || '/', `ws://${host}`);
    return url.searchParams.get('token') || '';
  } catch (_e) {
    return '';
  }
}

/**
 * Cross-site WebSocket hijacking guard. Browsers do not apply the same-origin
 * policy to WebSockets, so with no token configured any web page the operator
 * opens could connect to ws://127.0.0.1:3099 and issue sellPosition / setBankroll /
 * forceSettle. Without a token, a loopback-bound server therefore only serves
 * non-browser clients (no Origin header), loopback origins (the local dashboard)
 * and origins listed in STATUS_ALLOWED_ORIGINS. A DNS-rebinding page arrives with
 * its own hostname as Origin and is refused as well.
 * With a token the token is the credential (a foreign page cannot read it), and
 * an explicit off-host unauthenticated bind is the operator's stated choice.
 */
export function originAllowed(origin, { authRequired, bindHost, allowed = process.env.STATUS_ALLOWED_ORIGINS || '' }) {
  if (authRequired || !isLocalBindHost(bindHost)) return true;
  if (!origin) return true;
  const list = String(allowed).split(',').map(o => o.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean);
  if (list.includes(String(origin).toLowerCase().replace(/\/$/, ''))) return true;
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (_e) {
    return false;
  }
}

/**
 * Register pause/resume callbacks from loop.ts (called by index.ts).
 */
export function registerBotControl(pauseFn, resumeFn, resetEntryRegimeFn, resetDailyBaselineFn = null) {
  _pauseBot = pauseFn;
  _resumeBot = resumeFn;
  _resetEntryRegime = resetEntryRegimeFn ?? null;
  _resetDailyBaseline = resetDailyBaselineFn ?? null;
}

/**
 * Register position manager callbacks.
 */
export function registerPositionManager({ getPositions, closePosition }) {
  _getPositions = getPositions;
  _closePosition = closePosition;
}

/**
 * Register USDC balance fetch function for forceSync command.
 */
export function registerUsdcSync(fetchBalanceFn) {
  _fetchUsdcBalance = fetchBalanceFn;
}

/**
 * Register trader discovery callbacks.
 */
export function registerTraderDiscovery({ scan, getTracked, getDiscovered, addTracker, removeTracker, simulate }) {
  _scanTraders = scan;
  _getTrackedTraders = getTracked;
  _getDiscoveredTraders = getDiscovered;
  _addTracker = addTracker;
  _removeTracker = removeTracker;
  _simulateTrader = simulate;
}

/**
 * Start the status WebSocket server.
 */
export function startStatusServer() {
  if (wss) return;
  const { port, bindHost, authRequired } = getStatusConfig();

  // Fail closed: an off-host bind without a token exposes bankroll control
  // (setBankroll, sellPosition, forceSettle) to the network. Loopback binds
  // without a token keep working unchanged (local PM2 dev flow).
  if (!authRequired && !isLocalBindHost(bindHost)) {
    if (process.env.ALLOW_UNAUTHENTICATED_STATUS === 'true') {
      log.warn('SECURITY: status server bound to non-loopback host WITHOUT auth token — explicitly allowed via ALLOW_UNAUTHENTICATED_STATUS=true. Anyone who can reach this port can control the bot.');
    } else {
      throw new Error(
        `Status server refuses to bind ${bindHost}:${port} without auth: set STATUS_AUTH_TOKEN, bind to 127.0.0.1, or set ALLOW_UNAUTHENTICATED_STATUS=true to override.`
      );
    }
  }

  // W5: Catch port-in-use and other startup errors
  try {
    wss = new WebSocketServer({ host: bindHost, port, maxPayload: 16384 });
  } catch (err) {
    log.error(`Failed to create WS server on ${bindHost}:${port}: ${err.message}`);
    wss = null;
    return;
  }

  wss.on('listening', () => {
    log.info(`Status server listening on ${bindHost}:${port}${authRequired ? ' (auth required)' : ''}`);
    if (!authRequired && !isLocalBindHost(bindHost)) {
      log.warn('Status server is reachable off-host without STATUS_AUTH_TOKEN. Set STATUS_AUTH_TOKEN or bind to 127.0.0.1.');
    }
  });

  wss.on('connection', (ws, req) => {
    const cfg = getStatusConfig();
    if (!originAllowed(req?.headers?.origin, cfg)) {
      log.warn(`Rejected status WS connection from foreign origin ${String(req?.headers?.origin).slice(0, 100)}`);
      try { ws.close(1008, 'origin not allowed'); } catch (_e) { /* */ }
      return;
    }
    if (cfg.authRequired && !tokenMatches(requestToken(req))) {
      log.warn(`Rejected unauthorized status WS connection from ${req?.socket?.remoteAddress || 'unknown'}`);
      try { ws.close(1008, 'unauthorized'); } catch (_e) { /* */ }
      return;
    }

    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (err) => { log.debug(`Client error: ${err.message}`); });

    // Bidirectional: handle messages from dashboard (rate-limited + validated)
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        // Helper: send response back to requesting client only
        const respond = (cmd, data) => {
          try { ws.send(JSON.stringify({ type: 'response', cmd, data })); } catch (_e) { /* */ }
        };

        if (msg.type === 'setBankroll' && typeof msg.value === 'number' &&
            Number.isFinite(msg.value) && msg.value > 0 && msg.value <= 1_000_000) {
          const now = Date.now();
          if (now - lastSetBankrollMs < SET_BANKROLL_COOLDOWN_MS) {
            log.debug('setBankroll rate-limited');
            respond('setBankroll', { ok: false, error: 'rate_limited' }); // W11
            return;
          }
          lastSetBankrollMs = now;
          setBankroll(msg.value);
        } else if (msg.type === 'botPause' && _pauseBot) {
          const now = Date.now();
          if (now - lastBotControlMs < BOT_CONTROL_COOLDOWN_MS) return;
          lastBotControlMs = now;
          _pauseBot();
        } else if (msg.type === 'botResume' && _resumeBot) {
          const now = Date.now();
          if (now - lastBotControlMs < BOT_CONTROL_COOLDOWN_MS) return;
          lastBotControlMs = now;
          _resumeBot();
        } else if (msg.type === 'resetDailyBaseline') {
          // Operator escape hatch for a daily-loss halt whose baseline is wrong
          // (e.g. a corrected settlement from a previous day). Token-gated like
          // every control command; the loop lifts the halt on its next poll.
          const now = Date.now();
          if (now - lastBotControlMs < BOT_CONTROL_COOLDOWN_MS) { respond('resetDailyBaseline', { ok: false, error: 'rate_limited' }); return; }
          lastBotControlMs = now;
          if (!_resetDailyBaseline) { respond('resetDailyBaseline', { ok: false, error: 'not_registered' }); return; }
          log.warn(`Operator reset of the daily baseline requested from ${req?.socket?.remoteAddress || 'unknown'}`);
          _resetDailyBaseline();
          respond('resetDailyBaseline', { ok: true });

        // ── Position Manager commands ──
        } else if (msg.type === 'getPositions' && _getPositions) {
          respond('getPositions', _getPositions());
        } else if (msg.type === 'sellPosition') {
          if (!_closePosition) {
            respond('sellPosition', { ok: false, error: 'position_manager_not_ready' });
          } else {
            const { tokenId, size, price } = msg;
            if (typeof tokenId !== 'string' || tokenId.length === 0) {
              respond('sellPosition', { ok: false, error: 'invalid_tokenId' });
            } else if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
              respond('sellPosition', { ok: false, error: 'invalid_size' });
            } else if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1) {
              respond('sellPosition', { ok: false, error: `invalid_price: ${price}` });
            } else if (!acquireSellLock('dashboard_sell')) {
              // Sell lock: prevent dashboard sell and loop cut-loss from racing
              respond('sellPosition', { ok: false, error: 'sell_in_progress' });
            } else {
              const sellPos = getCurrentPosition();
              _closePosition(tokenId, size, price)
                .then(result => {
                  // H1: Settle the position with recovered USDC (dashboard sell was missing this)
                  const recovered = parseClobAmount(result?.takingAmount, price * size);
                  // Only touch the tracked position when the sold token IS that position's token.
                  // The dashboard can also sell holdings the tracker does not know about (getPositions
                  // merges on-chain positions); settling the tracked position for those would book
                  // the wrong cost and close a position that is still open.
                  const owns = !!sellPos && !sellPos.settled && sellPos.tokenId === tokenId;
                  const soldAll = owns && size >= sellPos.size - 1e-6;
                  let settled = false;
                  if (owns && soldAll) {
                    // Net of the entry fee, like the tracker's own booking (settleTradeEarlyExit).
                    const cutPnl = earlyExitPnl(sellPos, recovered);
                    settled = settleTradeEarlyExit(recovered);
                    if (settled) {
                      writeJournalEntry({ outcome: 'CUT_LOSS', pnl: cutPnl, exitData: { source: 'dashboard_sell', recovered } });
                      clearEntrySnapshot();
                      resetCutLossState();
                      resetTakeProfitState();
                      if (_resetEntryRegime) _resetEntryRegime(); // Prevent stale regime leaking into next trade's cut-loss
                      if (cutPnl < 0) recordLoss();
                    }
                  } else if (owns) {
                    // Partial sell: the tracker keeps the rest of the position riding to settlement.
                    settled = partialExit(size, recovered);
                    if (settled) writeJournalEntry({ outcome: 'SELL_ORPHAN', pnl: 0, exitData: { source: 'dashboard_sell', note: 'partial_sell', recovered, size } });
                  }
                  // M8: Write journal entry even when nothing was settled (audit trail for the CLOB sell)
                  if (!settled) {
                    writeJournalEntry({ outcome: 'SELL_ORPHAN', pnl: 0, exitData: { source: 'dashboard_sell', note: owns ? 'position_settled_elsewhere' : 'token_not_tracked_position', recovered } });
                  }
                  releaseSellLock();
                  respond('sellPosition', { ok: owns ? settled : true, result, ...(owns && !settled ? { error: 'position_settled_elsewhere' } : {}), ...(owns ? {} : { note: 'sold_untracked_token' }) });
                })
                .catch(err => { releaseSellLock(); respond('sellPosition', { ok: false, error: err.message }); });
            }
          }

        // ── Force Settle (stuck positions from expired markets) ──
        } else if (msg.type === 'forceSettle') {
          const pos = getCurrentPosition();
          if (!pos || pos.settled) {
            respond('forceSettle', { ok: false, error: 'no_open_position' });
          } else if (!['WIN', 'LOSS', 'UNWIND'].includes(msg.outcome)) {
            respond('forceSettle', { ok: false, error: `invalid outcome: ${msg.outcome} (must be WIN/LOSS/UNWIND)` });
          } else if (!acquireSellLock('force_settle')) {
            respond('forceSettle', { ok: false, error: 'sell_in_progress' });
          } else if (msg.outcome === 'UNWIND') {
            unwindPosition();
            writeJournalEntry({ outcome: 'UNWIND', pnl: 0, exitData: { source: 'forceSettle' } });
            clearEntrySnapshot();
            resetCutLossState();
            resetTakeProfitState();
            if (_resetEntryRegime) _resetEntryRegime();
            setLastSettled(pos.marketSlug, Date.now());
            releaseSellLock();
            log.info(`Force UNWIND: returned $${pos.cost.toFixed(2)} to bankroll`);
            respond('forceSettle', { ok: true, action: 'unwind', returned: pos.cost });
          } else {
            const won = msg.outcome === 'WIN';
            // Net of the taker entry fee — the same number settleTrade books to the bankroll.
            const pnl = computeSettlementPnl({ won, size: pos.size, cost: pos.cost, price: pos.price });
            if (!settleTrade(won)) {
              releaseSellLock();
              respond('forceSettle', { ok: false, error: 'settle_failed' });
              return;
            }
            writeJournalEntry({ outcome: won ? 'WIN' : 'LOSS', pnl, exitData: { source: 'forceSettle' } });
            clearEntrySnapshot();
            resetCutLossState();
            resetTakeProfitState();
            if (_resetEntryRegime) _resetEntryRegime();
            if (!won) recordLoss();
            setLastSettled(pos.marketSlug, Date.now());
            releaseSellLock();
            log.info(`Force SETTLE: ${won ? 'WIN' : 'LOSS'} | side=${pos.side} cost=$${pos.cost.toFixed(2)} pnl=$${pnl.toFixed(2)}`);
            respond('forceSettle', { ok: true, action: 'settle', won, side: pos.side, pnl });
          }

        // ── Force USDC Sync (manual bankroll reconciliation) ──
        } else if (msg.type === 'forceSync') {
          if (!_fetchUsdcBalance) {
            respond('forceSync', { ok: false, error: 'usdc_sync_not_registered' });
          } else {
            const now = Date.now();
            if (now - lastForceSyncMs < SET_BANKROLL_COOLDOWN_MS) {
              respond('forceSync', { ok: false, error: 'rate_limited' });
            } else {
              lastForceSyncMs = now;
              forceUsdcSync(_fetchUsdcBalance, getBankroll, setBankroll)
                .then(result => respond('forceSync', result))
                .catch(err => respond('forceSync', { ok: false, error: err.message }));
            }
          }

        // ── Trader Discovery commands ──
        } else if (msg.type === 'scanTraders' && _scanTraders) {
          if (commandThrottled('scanTraders', 30_000)) { respond('scanTraders', { error: 'rate_limited' }); return; }
          _scanTraders()
            .then(traders => respond('scanTraders', { traders }))
            .catch(err => respond('scanTraders', { error: err.message }));
        } else if (msg.type === 'getTrackedTraders' && _getTrackedTraders) {
          respond('getTrackedTraders', { traders: _getTrackedTraders() });
        } else if (msg.type === 'getDiscoveredTraders' && _getDiscoveredTraders) {
          respond('getDiscoveredTraders', { traders: _getDiscoveredTraders() });
        } else if (msg.type === 'addTracker' && _addTracker && typeof msg.address === 'string' && EVM_ADDRESS_RE.test(msg.address)) {
          const ok = _addTracker(msg.address);
          respond('addTracker', { ok, address: msg.address });
        } else if (msg.type === 'removeTracker' && _removeTracker && typeof msg.address === 'string' && EVM_ADDRESS_RE.test(msg.address)) {
          const ok = _removeTracker(msg.address);
          respond('removeTracker', { ok, address: msg.address });
        // ── Profit Target reset ──
        } else if (msg.type === 'resetProfitTarget') {
          resetProfitTarget();
          if (_resumeBot) _resumeBot('profitTargetReset');
          respond('resetProfitTarget', { ok: true, status: getProfitTargetStatus() });

        // ── AI Agent commands ──
        } else if (msg.type === 'analyzeNow') {
          if (commandThrottled('analyzeNow', 30_000)) { respond('analyzeNow', { ok: false, error: 'rate_limited' }); return; }
          maybeAnalyze(0)
            .then(() => respond('analyzeNow', { ok: true, analysis: getLastAnalysis() }))
            .catch(err => respond('analyzeNow', { ok: false, error: err.message }));
        } else if (msg.type === 'optimizeNow') {
          if (commandThrottled('optimizeNow', 30_000)) { respond('optimizeNow', { ok: false, error: 'rate_limited' }); return; }
          maybeOptimize()
            .then(() => respond('optimizeNow', { ok: true, status: getOptimizerStatus() }))
            .catch(err => respond('optimizeNow', { ok: false, error: err.message }));

        } else if (msg.type === 'simulateTrader' && _simulateTrader && typeof msg.address === 'string' && EVM_ADDRESS_RE.test(msg.address)) {
          if (commandThrottled('simulateTrader', 2_000)) { respond('simulateTrader', { error: 'rate_limited' }); return; }
          _simulateTrader(msg.address)
            .then(result => respond('simulateTrader', result))
            .catch(err => respond('simulateTrader', { error: err.message }));
        }
      } catch (err) { log.debug(`Malformed client message: ${err.message}`); }
    });

    // Send cached snapshot immediately so new clients get current state
    if (lastSnapshot) {
      try { ws.send(lastSnapshot); } catch (_e) { /* */ }
    }
  });

  // M11: Handle async server errors (EADDRINUSE, etc.)
  wss.on('error', (err) => {
    log.error(`Status server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${port} already in use — stopping status server`);
      if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
      wss.close();
      wss = null;
    }
  });

  // Heartbeat: ping clients every 15s, terminate dead ones
  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
}

/**
 * Broadcast a state snapshot to all connected clients.
 * @param {object} stateObj - Bot state to broadcast
 */
export function broadcast(stateObj) {
  if (!wss) return;

  const json = JSON.stringify(stateObj);
  lastSnapshot = json; // Always update for new clients connecting

  // W9: Throttle broadcasts — skip if less than 750ms since last send
  const now = Date.now();
  if (now - lastBroadcastMs < BROADCAST_THROTTLE_MS) return;
  lastBroadcastMs = now;

  // Redis mirror rides the same throttle — a SET every ~500ms poll tick was
  // pure churn for a cache with a 120s TTL
  void cacheStatusSnapshot(stateObj);

  for (const ws of wss.clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      // W1: Backpressure check — terminate clients with large write backlogs
      if (ws.bufferedAmount > BACKPRESSURE_MAX_BYTES) {
        log.debug(`Client backlog ${(ws.bufferedAmount / 1024).toFixed(0)}KB — terminating`);
        ws.terminate();
        continue;
      }
      try { ws.send(json); } catch (_e) { ws.terminate(); }
    }
  }
}

/**
 * Stop the status server.
 */
export function stopStatusServer() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (wss) {
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch (_e) { /* */ }
    }
    wss.close();
    wss = null;
    log.info('Status server stopped');
  }
  lastSnapshot = null;
}
