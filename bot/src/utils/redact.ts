/**
 * Keep credentials out of logs and chat alerts.
 *
 * Error messages routinely echo the request that failed — ethers prints the whole RPC URL
 * (`url=https://…/<api key>`), fetch errors and DB drivers print connection strings — and both
 * the console (Railway/PM2 logs) and Telegram/Discord alerts are less private than .env.
 *
 * Two layers: (1) the VALUES of secret-looking env vars (and the credential parts of URL-valued
 * ones) are replaced wherever they appear; (2) generic shapes are masked even when the value is
 * not in this process's env: `user:password@` in a URL, a Telegram bot token, a Discord webhook
 * secret, a 32-byte hex private key.
 */

const SECRET_NAME_RE = /(PRIVATE_KEY|API_KEY|API_SECRET|PASSPHRASE|SECRET|TOKEN|PASSWORD|WEBHOOK|DATABASE_URL|REDIS_URL|RPC_URL|ACCESS_KEY)/i;
/** Env vars that match the pattern above but hold no secret. */
const NOT_SECRET = new Set(['STATUS_BIND_HOST', 'STATUS_ALLOWED_ORIGINS', 'TELEGRAM_NOTIFY_TRADES']);
const MIN_SECRET_LEN = 8;

let cache: { key: string; values: string[]; at: number } | null = null;
/** process.env is a slow native getter and this runs on every log line: re-read it at most this often. */
const ENV_REREAD_MS = 5_000;

function secretValues(env: Record<string, string | undefined>): string[] {
  if (env === process.env && cache && Date.now() - cache.at < ENV_REREAD_MS) return cache.values;
  const names = Object.keys(env).filter(k => SECRET_NAME_RE.test(k) && !NOT_SECRET.has(k) && (env[k] ?? '').length >= MIN_SECRET_LEN);
  const key = names.map(k => `${k}=${env[k]}`).join('\n');
  if (cache && cache.key === key) { cache.at = Date.now(); return cache.values; }
  const out = new Set<string>();
  for (const k of names) {
    const v = (env[k] as string).trim();
    if (v.length < MIN_SECRET_LEN) continue;
    // A URL-valued secret: the whole value, plus its path segments and query values (the API key
    // is usually one of them) and password, in case a message quotes only a part.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      out.add(v);
      try {
        const u = new URL(v);
        if (u.password) out.add(decodeURIComponent(u.password));
        for (const seg of u.pathname.split('/')) if (seg.length >= 16) out.add(seg);
        for (const [, qv] of u.searchParams) if (qv.length >= 16) out.add(qv);
      } catch { /* not a parsable URL: the whole value is still covered */ }
    } else {
      out.add(v);
    }
  }
  // Longest first so a value containing another is masked whole.
  const values = [...out].sort((a, b) => b.length - a.length);
  cache = { key, values, at: Date.now() };
  return values;
}

const GENERIC: Array<[RegExp, string]> = [
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@'],                       // user:pass@host
  [/\/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, '/bot[REDACTED]'],                  // Telegram bot API path
  [/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/gi, '$1[REDACTED]'],
  [/\b0x[a-fA-F0-9]{64}\b(?!\w)/g, '[REDACTED-HEX32]'],                    // a private key (or a tx hash — masking a hash is harmless)
];

export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  if (!text) return text;
  let out = text;
  for (const v of secretValues(env)) {
    if (out.includes(v)) out = out.split(v).join('[REDACTED]');
  }
  for (const [re, rep] of GENERIC) out = out.replace(re, rep);
  return out;
}
