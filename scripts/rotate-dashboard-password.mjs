#!/usr/bin/env node
/**
 * Daily dashboard password rotation.
 *
 * - generates a new random password and scrypt hash;
 * - writes the hash atomically to the auth server's hot-reload file;
 * - keeps the env hash in sync for service-restart fallback;
 * - writes a root-only recovery copy;
 * - sends the new password to Telegram once per day;
 * - deletes the previous Telegram password message when possible.
 *
 * The auth server reads the hash file on every login, so existing sessions are
 * not invalidated by rotation; the new password applies to the next login.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const AUTH_ENV = '/opt/polybtc15/auth.env';
const HASH_FILE = '/opt/polybtc15/dashboard-password.hash';
const BOT_ENV = '/opt/polybtc15/bot/.env';
const FALLBACK = '/root/.poly15-dashboard-password-latest';
const STATE = '/root/.poly15-password-message.json';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const testNotify = args.has('--test-notify');

function readEnv(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* caller reports missing config */ }
  return out;
}

function generatePassword() {
  let p = 'Poly15-';
  for (let i = 0; i < 20; i++) p += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return p;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

function chownUbuntu(file) {
  try { execFileSync('chown', ['ubuntu:ubuntu', file]); } catch { /* service runs as ubuntu; hash may still be root-readable if needed */ }
}

function atomicWrite(file, content, mode) {
  const dir = file.slice(0, file.lastIndexOf('/')) || '.';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
  chmodSync(file, mode);
}

function updateAuthEnv(hash) {
  let text = '';
  try { text = readFileSync(AUTH_ENV, 'utf8'); } catch { return; }
  const next = text.split('\n').map(line => line.startsWith('DASHBOARD_PASSWORD_HASH=')
    ? 'DASHBOARD_PASSWORD_HASH=' + hash
    : line).join('\n');
  atomicWrite(AUTH_ENV, next, 0o600);
  chownUbuntu(AUTH_ENV);
}

async function telegram(method, token, payload) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendTelegram(text) {
  const env = readEnv(BOT_ENV);
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing');
  if (testNotify) {
    const r = await telegram('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.status !== 200 || r.body?.ok !== true) throw new Error('Telegram test notify failed: ' + r.status);
    return null;
  }
  let lastId = null;
  try { lastId = JSON.parse(readFileSync(STATE, 'utf8')).message_id ?? null; } catch { /* none */ }
  let lastResponse = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await telegram('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (r.status === 200 && r.body?.ok === true) {
      lastResponse = r.body.result;
      break;
    }
    if (attempt === 3) throw new Error('Telegram send failed: ' + r.status);
    await new Promise(resolve => setTimeout(resolve, attempt * 2000));
  }
  if (!lastResponse) throw new Error('Telegram send returned no message');
  // Keep only the latest password message in the chat when possible.
  if (lastId && lastId !== lastResponse.message_id) {
    await telegram('deleteMessage', token, { chat_id: chatId, message_id: lastId }).catch(() => {});
  }
  atomicWrite(STATE, JSON.stringify({ message_id: lastResponse.message_id, sentAt: new Date().toISOString() }) + '\n', 0o600);
  return lastResponse.message_id;
}

async function main() {
  if (testNotify) {
    await sendTelegram('🔐 <b>POLY//15</b>\nNotifikasi rotasi password harian aktif. Password baru dikirim setiap hari pukul 07:00 WIB.');
    console.log('test notification sent');
    return;
  }

  const password = generatePassword();
  const hash = hashPassword(password);
  if (dryRun) {
    if (!hash.startsWith('scrypt$')) throw new Error('hash generation failed');
    console.log('dry run ok');
    return;
  }

  atomicWrite(HASH_FILE, hash + '\n', 0o600);
  chownUbuntu(HASH_FILE);
  updateAuthEnv(hash);
  atomicWrite(FALLBACK, password + '\n', 0o600);

  const now = new Date();
  const text = [
    '🔐 <b>POLY//15 — password harian</b>',
    '',
    'Password baru: <code>' + escapeHtml(password) + '</code>',
    '',
    'Berlaku sampai rotasi berikutnya (besok 07:00 WIB).',
    'Login: https://poly15.dollarkilat.xyz/',
    '',
    '<i>Pesan password sebelumnya dihapus otomatis bila memungkinkan.</i>',
  ].join('\n');
  const messageId = await sendTelegram(text);
  console.log('rotated at ' + now.toISOString() + ' message_id=' + messageId);
}

main().catch(err => {
  console.error('password rotation failed: ' + (err?.message ?? String(err)));
  process.exit(1);
});
