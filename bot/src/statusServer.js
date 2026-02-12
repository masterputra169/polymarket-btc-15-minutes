/**
 * WebSocket status broadcast server.
 * Sends bot state snapshots to connected dashboard clients.
 */

import { WebSocketServer } from 'ws';
import { createLogger } from './logger.js';
import { setBankroll } from './trading/positionTracker.js';

const log = createLogger('StatusWS');

const STATUS_PORT = parseInt(process.env.STATUS_PORT || '3099', 10);
const HEARTBEAT_MS = 30_000;

let wss = null;
let heartbeatInterval = null;
let lastSnapshot = null;

/**
 * Start the status WebSocket server.
 */
export function startStatusServer() {
  if (wss) return;

  wss = new WebSocketServer({ port: STATUS_PORT });

  wss.on('listening', () => {
    log.info(`Status server listening on :${STATUS_PORT}`);
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => { /* swallow */ });

    // Bidirectional: handle messages from dashboard
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'setBankroll' && typeof msg.value === 'number' && msg.value > 0) {
          setBankroll(msg.value);
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

  // Heartbeat: ping clients every 30s, terminate dead ones
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
  lastSnapshot = json;

  for (const ws of wss.clients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try { ws.send(json); } catch (_e) { /* */ }
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
