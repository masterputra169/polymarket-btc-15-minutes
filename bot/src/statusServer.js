/**
 * WebSocket status broadcast server.
 * Sends bot state snapshots to connected dashboard clients.
 */

import { WebSocketServer } from 'ws';
import { createLogger } from './logger.js';
import { setBankroll, acquireSellLock, releaseSellLock } from './trading/positionTracker.js';

const log = createLogger('StatusWS');

const STATUS_PORT = parseInt(process.env.STATUS_PORT || '3099', 10);
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

// Bot control callbacks — set via registerBotControl() to avoid circular imports
let _pauseBot = null;
let _resumeBot = null;

// Position manager callbacks
let _getPositions = null;
let _closePosition = null;

// Trader discovery callbacks
let _scanTraders = null;
let _getTrackedTraders = null;
let _getDiscoveredTraders = null;
let _addTracker = null;
let _removeTracker = null;
let _simulateTrader = null;

/**
 * Register pause/resume callbacks from loop.js (called by index.js).
 */
export function registerBotControl(pauseFn, resumeFn) {
  _pauseBot = pauseFn;
  _resumeBot = resumeFn;
}

/**
 * Register position manager callbacks.
 */
export function registerPositionManager({ getPositions, closePosition }) {
  _getPositions = getPositions;
  _closePosition = closePosition;
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

  // W5: Catch port-in-use and other startup errors
  try {
    wss = new WebSocketServer({ port: STATUS_PORT });
  } catch (err) {
    log.error(`Failed to create WS server on :${STATUS_PORT}: ${err.message}`);
    wss = null;
    return;
  }

  wss.on('listening', () => {
    log.info(`Status server listening on :${STATUS_PORT}`);
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* swallow */ });

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

        // ── Position Manager commands ──
        } else if (msg.type === 'getPositions' && _getPositions) {
          respond('getPositions', _getPositions());
        } else if (msg.type === 'sellPosition' && _closePosition) {
          const { tokenId, size, price } = msg;
          if (typeof tokenId === 'string' && tokenId.length > 0 &&
              typeof size === 'number' && Number.isFinite(size) && size > 0 &&
              typeof price === 'number' && Number.isFinite(price) && price > 0 && price <= 1) {
            // Sell lock: prevent dashboard sell and loop cut-loss from racing
            if (!acquireSellLock()) {
              respond('sellPosition', { ok: false, error: 'sell_in_progress' });
            } else {
              _closePosition(tokenId, size, price)
                .then(result => { releaseSellLock(); respond('sellPosition', { ok: true, result }); })
                .catch(err => { releaseSellLock(); respond('sellPosition', { ok: false, error: err.message }); });
            }
          }

        // ── Trader Discovery commands ──
        } else if (msg.type === 'scanTraders' && _scanTraders) {
          _scanTraders()
            .then(traders => respond('scanTraders', { traders }))
            .catch(err => respond('scanTraders', { error: err.message }));
        } else if (msg.type === 'getTrackedTraders' && _getTrackedTraders) {
          respond('getTrackedTraders', { traders: _getTrackedTraders() });
        } else if (msg.type === 'getDiscoveredTraders' && _getDiscoveredTraders) {
          respond('getDiscoveredTraders', { traders: _getDiscoveredTraders() });
        } else if (msg.type === 'addTracker' && _addTracker && msg.address) {
          const ok = _addTracker(msg.address);
          respond('addTracker', { ok, address: msg.address });
        } else if (msg.type === 'removeTracker' && _removeTracker && msg.address) {
          const ok = _removeTracker(msg.address);
          respond('removeTracker', { ok, address: msg.address });
        } else if (msg.type === 'simulateTrader' && _simulateTrader && msg.address) {
          _simulateTrader(msg.address)
            .then(result => respond('simulateTrader', result))
            .catch(err => respond('simulateTrader', { error: err.message }));
        }
      } catch (_e) { /* ignore malformed */ }
    });

    // Send cached snapshot immediately so new clients get current state
    if (lastSnapshot) {
      try { ws.send(lastSnapshot); } catch (_e) { /* */ }
    }
  });

  wss.on('error', (err) => {
    log.error(`Status server error: ${err.message}`);
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
