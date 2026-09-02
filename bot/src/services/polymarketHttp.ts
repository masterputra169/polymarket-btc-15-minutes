import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { createLogger } from '../logger.ts';
import { envInt } from '../utils/env.ts';

const log = createLogger('PolyHTTP');

type LookupAddress = { address: string; family: 4 | 6 };
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

type RequestOptions = {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Endpoint label for error messages, e.g. "Gamma events" → "Gamma events: HTTP 503" */
  label?: string;
};

const POLYMARKET_HOST_RE = /(^|\.)polymarket\.com$/i;
const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DEFAULT_TTL_MS = 5 * 60_000;

const dnsCache = new Map<string, { addresses: LookupAddress[]; expiresAt: number }>();

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function isPolymarketHost(hostname: string): boolean {
  return POLYMARKET_HOST_RE.test(hostname);
}

async function resolvePolymarketHost(hostname: string): Promise<LookupAddress[]> {
  const cached = dnsCache.get(hostname);
  const now = Date.now();
  if (cached && cached.expiresAt > now && cached.addresses.length) {
    return cached.addresses;
  }

  const dohUrl = process.env.POLYMARKET_DOH_URL || DEFAULT_DOH_URL;
  const url = `${dohUrl}?name=${encodeURIComponent(hostname)}&type=A`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(envInt(process.env.POLYMARKET_DOH_TIMEOUT_MS, 5000, 100, 120_000)),
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);

  const data = await res.json() as {
    Answer?: Array<{ type?: number; data?: string; TTL?: number }>;
  };
  const addresses = (data.Answer || [])
    .filter((answer) => answer.type === 1 && typeof answer.data === 'string')
    .map((answer) => ({ address: answer.data as string, family: 4 as const }));

  if (!addresses.length) throw new Error(`DoH returned no A records for ${hostname}`);

  const ttlMs = Math.max(
    30_000,
    Math.min(
      DEFAULT_TTL_MS,
      Math.min(...(data.Answer || []).map((answer) => Number(answer.TTL || 300))) * 1000,
    ),
  );
  dnsCache.set(hostname, { addresses, expiresAt: now + ttlMs });
  return addresses;
}

function polymarketLookup(hostname: string, options: unknown, callback?: LookupCallback) {
  let cb = callback;
  let opts = options as { all?: boolean } | undefined;
  if (typeof options === 'function') {
    cb = options as LookupCallback;
    opts = undefined;
  }
  if (!cb) return;

  resolvePolymarketHost(hostname)
    .then((addresses) => {
      if (opts?.all) {
        cb(null, addresses);
        return;
      }
      const first = addresses[0];
      cb(null, first.address, first.family);
    })
    .catch((err) => cb(err, '', 4));
}

function requestText(url: string, options: RequestOptions = {}, redirectCount = 0): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const parsed = new URL(url);
  const useDoh = envFlag('POLYMARKET_DOH_ENABLED', true) && isPolymarketHost(parsed.hostname);
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      servername: parsed.hostname,
      lookup: useDoh ? polymarketLookup : undefined,
      headers: {
        Host: parsed.hostname,
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'identity',
        'User-Agent': process.env.POLYMARKET_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...options.headers,
      },
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      const maxRedirects = options.maxRedirects ?? 3;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirectCount < maxRedirects) {
        res.resume();
        const redirected = new URL(location, parsed);
        // Same allow-list as the DoH bypass: only follow redirects that stay on
        // polymarket.com or a subdomain — never off-host (open-redirect guard)
        if (!isPolymarketHost(redirected.hostname)) {
          reject(new Error(`Refusing redirect to non-Polymarket host ${redirected.hostname} (from ${parsed.hostname})`));
          return;
        }
        resolve(requestText(redirected.toString(), options, redirectCount + 1));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status, body, headers: res.headers }));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchTextWithPolymarketDoh(url: string, options: RequestOptions = {}): Promise<string> {
  const res = await requestText(url, options);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${options.label ? `${options.label}: ` : ''}HTTP ${res.status}`);
  }
  return res.body;
}

export async function fetchJsonWithPolymarketDoh<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
  const body = await fetchTextWithPolymarketDoh(url, options);
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    log.warn(`Invalid JSON from ${new URL(url).hostname}: ${(err as Error).message}`);
    throw err;
  }
}
