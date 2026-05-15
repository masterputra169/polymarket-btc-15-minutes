#!/usr/bin/env node
/**
 * Chainlink Data Streams setup helper for Polymarket BTC 15-min bot.
 *
 * Two modes:
 *   --guide       → walkthrough pendaftaran + cara dapat API key
 *   --validate    → test API key yang sudah dipaste, lalu update .env otomatis
 *
 * Usage:
 *   node setup-chainlink-ds.mjs --guide
 *   node setup-chainlink-ds.mjs --validate
 *   node setup-chainlink-ds.mjs                 # default: --guide
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '.env');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

function header(text) {
  const bar = '═'.repeat(Math.max(60, text.length + 4));
  console.log('\n' + c('cyan', bar));
  console.log(c('cyan', '  ' + c('bold', text)));
  console.log(c('cyan', bar));
}

function step(num, title) {
  console.log('\n' + c('green', `[Step ${num}]`) + ' ' + c('bold', title));
}

function info(text) {
  console.log('  ' + text);
}

function warn(text) {
  console.log('  ' + c('yellow', '⚠ ' + text));
}

function success(text) {
  console.log('  ' + c('green', '✓ ' + text));
}

function error(text) {
  console.log('  ' + c('red', '✗ ' + text));
}

// ─── Mode: Guide ────────────────────────────────────────────────────────────

function showGuide() {
  header('Chainlink Data Streams — Setup Guide');

  console.log(`
Bot Anda sudah memiliki kode integrasi Chainlink Data Streams (di
${c('cyan', 'bot/src/adapters/chainlinkDataStreams.js')}). Yang dibutuhkan
hanya 2 environment variable: ${c('bold', 'CHAINLINK_DS_API_KEY')} dan
${c('bold', 'CHAINLINK_DS_USER_SECRET')}.

Sekali aktif, PTB (Price To Beat) bot akan upgrade dari sumber approximate
(chainlink_round / polymarket_page) → ${c('green', 'data_streams (exact oracle)')}.
Per riset oracle-lag-sniper: WR meningkat ke ~60-61% dari window 55-detik
oracle-lead vs CLOB repricing.
`);

  step(1, 'Buka halaman pendaftaran Polymarket-sponsored');
  info('URL: ' + c('blue', 'https://pm-ds-request.streams.chain.link'));
  info('Pendaftaran ini ' + c('green', 'GRATIS') + ' karena disponsori Polymarket untuk');
  info('prediction-market traders. Tidak perlu staking LINK.');

  step(2, 'Isi form pendaftaran');
  info('Field yang biasanya diminta:');
  info('  • Email (untuk delivery API key)');
  info('  • Nama / Project name (bebas, contoh: "PolymarketBTC15mAssistant")');
  info('  • Use case ringkas (contoh: "Personal BTC 15-min prediction trading bot")');
  info('  • Wallet address (opsional — bisa pakai EOA Anda):');
  info('    ' + c('cyan', '0xe5172F78f890A902A2724665bAe9B19b05C80491'));

  step(3, 'Verifikasi email');
  info('Cek inbox + spam folder. Email konfirmasi datang dari');
  info(c('cyan', 'noreply@chain.link') + ' biasanya dalam 5-15 menit.');

  step(4, 'Tunggu approval Polymarket whitelist');
  info('Bisa instant atau hingga 24 jam. Anda akan dapat email kedua dengan:');
  info('  • ' + c('bold', 'API Key') + ' (UUID format, contoh: ' + c('cyan', 'abcd1234-...') + ')');
  info('  • ' + c('bold', 'User Secret') + ' (long random string, ' + c('cyan', 'never share!') + ')');

  step(5, 'Validate + install ke bot');
  info('Setelah dapat keys, jalankan:');
  info('  ' + c('green', 'node setup-chainlink-ds.mjs --validate'));
  info('Skrip akan:');
  info('  1. Tanya Anda paste API key + User secret');
  info('  2. Test koneksi ke Chainlink Data Streams API');
  info('  3. Test fetch BTC price feed');
  info('  4. Auto-uncomment + isi 2 baris di ' + c('cyan', 'bot/.env'));
  info('  5. Restart bot otomatis (jika PM2 tersedia)');

  step(6, 'Aktivasi Late Sniper (optional, 1-2 hari setelah Step 5)');
  info('Setelah confirm Data Streams jalan stable, uncomment di .env:');
  info('  ' + c('green', 'LATE_SNIPER_ENABLED=true'));
  info('Ini aktifin Opsi 3 (oracle-lag bypass filter) — relax ML threshold 75%');
  info('saat conditions match (≥5min, ≤62c, BTC ≥0.07% delta).');

  console.log('');
  header('Quick links');
  console.log(`  Pendaftaran:  ${c('blue', 'https://pm-ds-request.streams.chain.link')}`);
  console.log(`  Docs:         ${c('blue', 'https://docs.chain.link/data-streams')}`);
  console.log(`  Polymarket:   ${c('blue', 'https://docs.polymarket.com')}`);
  console.log('');
  console.log('Setelah dapat keys → ' + c('green', 'node setup-chainlink-ds.mjs --validate'));
  console.log('');
}

// ─── Mode: Validate ─────────────────────────────────────────────────────────

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  return new Promise(r => rl.question(question, ans => { rl.close(); r(ans.trim()); }));
}

async function validateKey(apiKey, userSecret) {
  // Test the keys by fetching the report list endpoint
  // Chainlink Data Streams uses HMAC auth — we just check if the key format is right
  // and the API is reachable. Real auth happens inside the bot's adapter.

  if (!apiKey || apiKey.length < 8) {
    return { ok: false, reason: 'API key terlalu pendek — periksa lagi' };
  }
  if (!userSecret || userSecret.length < 16) {
    return { ok: false, reason: 'User secret terlalu pendek — periksa lagi' };
  }

  // Try to import bot's existing adapter and test it
  try {
    process.env.CHAINLINK_DS_API_KEY = apiKey;
    process.env.CHAINLINK_DS_USER_SECRET = userSecret;
    process.env.CHAINLINK_DS_BTC_FEED_ID =
      process.env.CHAINLINK_DS_BTC_FEED_ID
      || '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';

    const adapter = await import('./src/adapters/chainlinkDataStreams.js');
    if (typeof adapter.fetchBTCPrice !== 'function' && typeof adapter.getBTCPrice !== 'function') {
      // Try common function names
      const fns = Object.keys(adapter).filter(k => typeof adapter[k] === 'function');
      return { ok: false, reason: `Adapter tidak punya fetchBTCPrice/getBTCPrice. Tersedia: ${fns.join(', ')}` };
    }

    const fetchFn = adapter.fetchBTCPrice || adapter.getBTCPrice;
    const result = await Promise.race([
      fetchFn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 15s')), 15_000)),
    ]);

    if (result?.price && Number.isFinite(result.price)) {
      return { ok: true, price: result.price, raw: result };
    }
    return { ok: false, reason: `Adapter response invalid: ${JSON.stringify(result).slice(0, 200)}` };
  } catch (err) {
    return { ok: false, reason: `Adapter error: ${err.message}` };
  }
}

function updateEnvFile(apiKey, userSecret) {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env tidak ditemukan: ${ENV_PATH}`);
  }

  // Backup
  const backupPath = ENV_PATH + '.backup-' + Date.now();
  const original = readFileSync(ENV_PATH, 'utf-8');
  writeFileSync(backupPath, original, 'utf-8');

  let content = original;

  // Replace commented lines (# CHAINLINK_DS_API_KEY=...) or insert if missing
  const apiKeyLine = `CHAINLINK_DS_API_KEY=${apiKey}`;
  const userSecretLine = `CHAINLINK_DS_USER_SECRET=${userSecret}`;

  if (/^# *CHAINLINK_DS_API_KEY=/m.test(content)) {
    content = content.replace(/^# *CHAINLINK_DS_API_KEY=.*$/m, apiKeyLine);
  } else if (/^CHAINLINK_DS_API_KEY=/m.test(content)) {
    content = content.replace(/^CHAINLINK_DS_API_KEY=.*$/m, apiKeyLine);
  } else {
    content += `\n# Chainlink Data Streams (added by setup-chainlink-ds.mjs)\n${apiKeyLine}\n`;
  }

  if (/^# *CHAINLINK_DS_USER_SECRET=/m.test(content)) {
    content = content.replace(/^# *CHAINLINK_DS_USER_SECRET=.*$/m, userSecretLine);
  } else if (/^CHAINLINK_DS_USER_SECRET=/m.test(content)) {
    content = content.replace(/^CHAINLINK_DS_USER_SECRET=.*$/m, userSecretLine);
  } else {
    content += `${userSecretLine}\n`;
  }

  writeFileSync(ENV_PATH, content, 'utf-8');
  return backupPath;
}

async function tryRestartBot() {
  try {
    const { execSync } = await import('child_process');
    execSync('pm2 restart polymarket-bot --update-env', { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch (err) {
    return false;
  }
}

async function runValidate() {
  header('Chainlink Data Streams — Validate & Install');

  console.log('');
  info('Paste API key + User secret yang Anda terima dari Chainlink.');
  info('Skrip akan:');
  info('  1. Validate keys (panjang format)');
  info('  2. Test fetch BTC price live');
  info('  3. Update bot/.env (auto-uncomment + isi)');
  info('  4. Restart bot via PM2 (jika tersedia)');
  console.log('');
  warn('JANGAN paste keys ini ke chat publik atau commit ke git.');
  console.log('');

  const apiKey = await prompt(c('bold', 'CHAINLINK_DS_API_KEY: '));
  if (!apiKey) {
    error('Cancelled (API key kosong)');
    process.exit(1);
  }

  const userSecret = await prompt(c('bold', 'CHAINLINK_DS_USER_SECRET: '));
  if (!userSecret) {
    error('Cancelled (User secret kosong)');
    process.exit(1);
  }

  console.log('');
  info('Testing keys terhadap Chainlink Data Streams API...');
  const result = await validateKey(apiKey, userSecret);

  if (!result.ok) {
    error('Validation FAILED: ' + result.reason);
    console.log('');
    warn('Periksa kembali keys dari email Chainlink.');
    warn('Jika baru saja dapat keys, tunggu 1-2 menit untuk propagate.');
    process.exit(1);
  }

  success(`BTC price fetched: $${result.price.toFixed(2)}`);
  if (result.raw?.timestamp) {
    info(`Timestamp: ${new Date(result.raw.timestamp).toISOString()}`);
  }

  console.log('');
  info('Updating bot/.env...');
  const backupPath = updateEnvFile(apiKey, userSecret);
  success(`Updated ${ENV_PATH}`);
  info(`Backup: ${backupPath}`);

  console.log('');
  info('Restarting bot via PM2...');
  const restarted = await tryRestartBot();
  if (restarted) {
    success('Bot restarted with new env');
  } else {
    warn('PM2 not found atau restart failed — restart manual:');
    warn('  pm2 restart polymarket-bot --update-env');
  }

  console.log('');
  header('Setup Complete');
  console.log('');
  success('Chainlink Data Streams aktif');
  console.log('');
  info('Verifikasi log bot dalam 1-2 menit:');
  info('  ' + c('cyan', 'pm2 logs polymarket-bot | grep -i "data_streams"'));
  console.log('');
  info('Anda akan lihat baris seperti:');
  info(c('green', '  [Loop] PTB: $76123.45 → $76125.10 (data_streams, exact)'));
  console.log('');
  info('Setelah confirm stable 1-2 hari, aktifin Opsi 3:');
  info('  Edit bot/.env, uncomment: ' + c('green', 'LATE_SNIPER_ENABLED=true'));
  info('  Lalu restart: ' + c('cyan', 'pm2 restart polymarket-bot --update-env'));
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────

const mode = process.argv[2] || '--guide';

if (mode === '--guide' || mode === '-g') {
  showGuide();
} else if (mode === '--validate' || mode === '-v') {
  runValidate().catch(err => {
    error('Fatal: ' + err.message);
    process.exit(1);
  });
} else {
  console.log('Unknown mode: ' + mode);
  console.log('Usage:');
  console.log('  node setup-chainlink-ds.mjs --guide      # walkthrough pendaftaran');
  console.log('  node setup-chainlink-ds.mjs --validate   # validate keys + install ke .env');
  process.exit(1);
}
