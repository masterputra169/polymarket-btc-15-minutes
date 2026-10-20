#!/usr/bin/env node
/** Minimal dashboard auth gateway.
 *
 * Runs on loopback and is proxied by nginx. It owns the session cookie and
 * password check; nginx uses auth_request to protect /ws and /api/reports.
 * No dependency on the bot process, no secrets in the frontend.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.AUTH_PORT || 3102);
const BIND = process.env.AUTH_BIND || '127.0.0.1';
const COOKIE = process.env.AUTH_COOKIE_NAME || 'btc15_session';
const TTL = Math.max(300, Math.min(7 * 24 * 3600, Number(process.env.AUTH_TTL_SECONDS || 43200)));
const MAX_ATTEMPTS = Math.max(1, Math.min(50, Number(process.env.AUTH_MAX_ATTEMPTS || 8)));
const WINDOW_MS = Math.max(10_000, Number(process.env.AUTH_WINDOW_MS || 300_000));
const SECURE_COOKIE = process.env.AUTH_INSECURE_COOKIE !== 'true';
const PASSWORD_HASH = (process.env.DASHBOARD_PASSWORD_HASH || '').trim();
const SESSION_SECRET = (process.env.AUTH_SESSION_SECRET || '').trim();
const sessions = new Map();
const attempts = new Map();

if (!PASSWORD_HASH || !SESSION_SECRET) {
  console.error('dashboard-auth: DASHBOARD_PASSWORD_HASH and AUTH_SESSION_SECRET are required');
  process.exit(2);
}
if (SESSION_SECRET.length < 32) {
  console.error('dashboard-auth: AUTH_SESSION_SECRET must be at least 32 chars');
  process.exit(2);
}

function timingEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function parseHash(value) {
  const parts = value.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return null;
  return { salt: Buffer.from(parts[1], 'hex'), hash: Buffer.from(parts[2], 'hex') };
}
const HASH = parseHash(PASSWORD_HASH);
if (!HASH) { console.error('dashboard-auth: invalid DASHBOARD_PASSWORD_HASH'); process.exit(2); }

function verifyPassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > 256) return false;
  const candidate = crypto.scryptSync(password, HASH.salt, HASH.hash.length);
  return timingEqual(candidate, HASH.hash);
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || token.length > 2048) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!timingEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function clientIp(req) {
  // nginx sets X-Real-IP from $remote_addr; prefer it over a client-supplied
  // X-Forwarded-For first hop so login rate limiting cannot be spoofed.
  return String(req.headers['x-real-ip'] || '').trim() || String(req.headers['cf-connecting-ip'] || '').trim() || req.socket.remoteAddress || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.startedAt > WINDOW_MS) { attempts.set(ip, { count: 1, startedAt: now }); return false; }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}
function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(text);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > 4096) { reject(new Error('too large')); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function setCookie(res, token, maxAge) {
  const secure = SECURE_COOKIE ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE + '=' + encodeURIComponent(token) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + secure);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const ip = clientIp(req);
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (url.pathname === '/me' && req.method === 'GET') {
    const token = cookies(req)[COOKIE];
    const payload = verifyToken(token);
    if (!payload || !sessions.has(token)) return json(res, 401, { ok: false, error: 'unauthorized' });
    return json(res, 200, { ok: true, expiresAt: payload.exp });
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    if (rateLimited(ip)) return json(res, 429, { ok: false, error: 'too many attempts' });
    let body;
    try { body = await readJson(req); } catch { return json(res, 400, { ok: false, error: 'invalid request' }); }
    if (!verifyPassword(body.password)) return json(res, 401, { ok: false, error: 'invalid password' });
    attempts.delete(ip);
    const exp = Date.now() + TTL * 1000;
    const token = sign({ exp, v: 1 });
    sessions.set(token, exp);
    setCookie(res, token, TTL);
    return json(res, 200, { ok: true, expiresAt: exp });
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    const token = cookies(req)[COOKIE];
    if (token) sessions.delete(token);
    setCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, BIND, () => console.log('dashboard-auth listening on ' + BIND + ':' + PORT));
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of sessions) if (exp <= now) sessions.delete(token);
  for (const [ip, entry] of attempts) if (now - entry.startedAt > WINDOW_MS) attempts.delete(ip);
}, 60_000);
cleanup.unref();
function stop() { clearInterval(cleanup); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
