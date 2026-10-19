/**
 * Read-only PolyBolt smoke test — auth + subscribe the two channels this bot
 * needs, then report what arrives. Prints no credentials (never the frames it
 * sends); safe to run on the VPS while the bot is trading, it opens its own
 * sockets and touches no bot state.
 *
 *   node --env-file=./bot/.env bot/src/streams/polyboltProbe.mts
 *   node --env-file=./bot/.env bot/src/streams/polyboltProbe.mts --seconds 25
 *
 * Networks whose DNS blocks ws-live-v2.polymarket.com (e.g. some Indonesian
 * ISPs) can pass a real CloudFront address resolved over DoH; the TLS handshake
 * still uses the real hostname:
 *
 *   curl -s -H 'accept: application/dns-json' 'https://1.1.1.1/dns-query?name=ws-live-v2.polymarket.com&type=A'
 *   node --env-file=./bot/.env bot/src/streams/polyboltProbe.mts --host-ip 13.224.245.122
 *
 * Exit codes: 0 both channels delivered ticks, 2 missing/rejected credentials,
 * 1 timeout or a channel that never subscribed.
 */

import { WebSocket } from 'ws';
import {
  createPolyBoltFeed,
  pickCredentials,
  POLYBOLT_CRYPTO_CHANNEL,
  POLYBOLT_TWAP_CHANNEL,
  POLYBOLT_DEFAULT_URL,
  type PolyBoltFeed,
} from './polyboltWs.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const seconds = Number(arg('seconds', '20'));
const hostIp = arg('host-ip', '');
const url = POLYBOLT_DEFAULT_URL;

const creds = pickCredentials();
if (!creds) {
  console.error('FAIL: no CLOB L2 credentials in env (POLYMARKET_API_KEY/SECRET/PASSPHRASE).');
  process.exit(2);
}
console.log('credentials present (lengths)', creds.apiKey.length, creds.secret.length, creds.passphrase.length);

const makeSocket = hostIp
  ? (u: string) => new WebSocket(u, { lookup: (_h: string, opts: any, cb: any) => {
      if (opts && opts.all) cb(null, [{ address: hostIp, family: 4 }]);
      else cb(null, hostIp, 4);
    } } as any)
  : undefined;

function feedFor(name: string, channel: string, filter: Record<string, unknown>): PolyBoltFeed {
  return createPolyBoltFeed({
    name,
    channel,
    filter,
    keepMs: 5 * 60_000,
    ...(makeSocket ? { makeSocket } : {}),
  });
}

const twap = feedFor('PROBE-TWAP', POLYBOLT_TWAP_CHANNEL, { symbol: 'btcusd', window_seconds: 60 });
const spot = feedFor('PROBE-SPOT', POLYBOLT_CRYPTO_CHANNEL, { symbol: 'btcusd', provider: 'chainlink' });
const feeds: PolyBoltFeed[] = [twap, spot];
const startedAt = Date.now();

console.log('connecting to ' + url + (hostIp ? ' (pinned host ip ' + hostIp + ')' : ''));
for (const f of feeds) f.start();

const timer = setInterval(() => {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
  for (const f of feeds) {
    const h = f.health();
    const latest = h.lastTick;
    const latency = latest ? Date.now() - latest.ts : null;
    const line = [
      elapsed + 's',
      'connected=' + h.connected,
      'auth=' + h.authState,
      'subscribed=' + h.subscribed,
      'ticks=' + h.ticks,
      'snapshotPoints=' + h.snapshotPoints,
      'source=' + (h.source ?? '-'),
      'provider=' + (h.provider ?? '-'),
      'reconnects=' + h.reconnects,
    ];
    if (latest) line.push('latest=' + latest.ts + ':' + latest.value.toFixed(2), 'latencyMs=' + latency);
    if (h.lastCloseCode != null) line.push('lastClose=' + h.lastCloseCode);
    console.log((h.subscribed ? '[' + (h.provider ?? h.source ?? 'ok') + '] ' : '') + line.join(' '));
  }
}, 5_000);
timer.unref?.();

setTimeout(() => {
  clearInterval(timer);
  let ok = true;
  console.log('\n=== SUMMARY ===');
  for (const [label, f] of [['TWAP', twap], ['SPOT', spot]] as const) {
    const h = f.health();
    const recent = f.between(Date.now() - 60_000, Date.now()).length;
    const pass = h.authenticated && h.subscribed && h.ticks >= 5;
    ok = ok && pass;
    console.log(label + ': ' + (pass ? 'PASS' : 'FAIL') + ' auth=' + h.authState + ' subscribed=' + h.subscribed
      + ' ticks=' + h.ticks + ' snapshotPoints=' + h.snapshotPoints + ' last60s=' + recent
      + ' source=' + (h.source ?? '-') + ' provider=' + (h.provider ?? '-')
      + ' reconnects=' + h.reconnects + ' parseErrors=' + h.parseErrors + ' seqGaps=' + h.seqGaps
      + (h.lastTick ? ' latestTs=' + h.lastTick.ts + ' value=' + h.lastTick.value.toFixed(4) : ''));
    if (label === 'TWAP' && h.lastTick) {
      const lat = Date.now() - h.lastTick.ts;
      console.log('  TWAP latency (arrival - source second): ' + lat + 'ms');
    }
  }
  for (const f of feeds) f.stop();
  process.exit(ok ? 0 : 1);
}, Math.max(5, seconds) * 1000);
