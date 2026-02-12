#!/usr/bin/env node
/**
 * ================================================
 *  Binance API Proxy for Indonesia / Blocked Regions
 * ================================================
 *
 * Proxies BOTH spot (api) and futures (fapi) Binance endpoints.
 * No external dependencies - uses Node.js built-in modules only.
 *
 * Usage:
 *   node binanceProxy.mjs [--port 3456]
 *
 * Then run training with:
 *   runTraining.bat --days 365 --tune --deploy --proxy http://localhost:3456
 *
 * Supported routes:
 *   GET /api/v3/klines?...     -> https://data-api.binance.vision/api/v3/klines?...
 *   GET /fapi/v1/fundingRate?... -> https://fapi.binance.com/fapi/v1/fundingRate?...
 *   GET /fapi/v1/premiumIndex?... -> https://fapi.binance.com/fapi/v1/premiumIndex?...
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

// Parse port from args
const portArg = process.argv.indexOf('--port');
const PORT = portArg !== -1 ? parseInt(process.argv[portArg + 1]) : 3456;

// Target mapping: path prefix -> target host
// Multiple fallbacks for each to handle blocking
const TARGETS = {
  '/api/': [
    'data-api.binance.vision',
    'api1.binance.com',
    'api2.binance.com',
    'api3.binance.com',
    'api.binance.com',
  ],
  '/fapi/': [
    'fapi.binance.com',
    'fapi1.binance.com',
    'fapi2.binance.com',
    'fapi3.binance.com',
    'fapi4.binance.com',
  ],
};

// Track which hosts work (cache successful hosts)
const workingHosts = {};

function proxyRequest(targetHost, path, res) {
  return new Promise((resolve, reject) => {
    const url = `https://${targetHost}${path}`;
    const req = https.get(url, { timeout: 15000 }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        // Consume response body to free resources
        proxyRes.resume();
        reject(new Error(`HTTP ${proxyRes.statusCode}`));
        return;
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      proxyRes.pipe(res);
      resolve(targetHost);
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function handleRequest(req, res) {
  const path = req.url; // e.g., /api/v3/klines?symbol=BTCUSDT&...

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Allow-Headers': '*',
    });
    res.end();
    return;
  }

  // Find matching target group
  let targetGroup = null;
  let prefix = null;
  for (const [p, hosts] of Object.entries(TARGETS)) {
    if (path.startsWith(p)) {
      targetGroup = hosts;
      prefix = p;
      break;
    }
  }

  if (!targetGroup) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unknown path. Use /api/... or /fapi/...' }));
    return;
  }

  // Try cached working host first
  const cachedHost = workingHosts[prefix];
  if (cachedHost) {
    try {
      const host = await proxyRequest(cachedHost, path, res);
      return; // Success
    } catch {
      // Cached host failed, try others
      delete workingHosts[prefix];
    }
  }

  // Try each host in order
  for (const host of targetGroup) {
    if (host === cachedHost) continue; // Already tried
    try {
      await proxyRequest(host, path, res);
      workingHosts[prefix] = host; // Cache working host
      console.log(`  [OK] ${prefix} -> ${host}`);
      return;
    } catch (err) {
      console.log(`  [FAIL] ${host}: ${err.message}`);
    }
  }

  // All hosts failed
  res.writeHead(502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'All Binance endpoints failed',
    tried: targetGroup,
    tip: 'Try using a VPN or different network',
  }));
}

// Health check endpoint
function handleHealth(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      workingHosts,
      uptime: process.uptime(),
    }));
    return true;
  }
  return false;
}

const server = http.createServer((req, res) => {
  if (handleHealth(req, res)) return;
  handleRequest(req, res).catch(err => {
    console.error('Unhandled error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log();
  console.log('================================================');
  console.log('  Binance API Proxy Server');
  console.log('================================================');
  console.log(`  Port:     ${PORT}`);
  console.log(`  URL:      http://localhost:${PORT}`);
  console.log();
  console.log('  Spot API: /api/v3/klines, /api/v3/ticker/price, ...');
  console.log('  Futures:  /fapi/v1/fundingRate, /fapi/v1/premiumIndex, ...');
  console.log();
  console.log('  Fallback hosts per endpoint:');
  for (const [prefix, hosts] of Object.entries(TARGETS)) {
    console.log(`    ${prefix} -> ${hosts.join(', ')}`);
  }
  console.log();
  console.log('  Usage with training:');
  console.log(`    runTraining.bat --days 365 --tune --deploy --proxy http://localhost:${PORT}`);
  console.log();
  console.log('  Health check: http://localhost:' + PORT + '/health');
  console.log('================================================');
  console.log();
  console.log('  Waiting for requests... (Ctrl+C to stop)');
  console.log();
});
