/**
 * Minimal S3-compatible object store client: PUT, GET, LIST.
 *
 * Works against Cloudflare R2, Backblaze B2, AWS S3 and MinIO — only the
 * endpoint and region differ. Signing is aws4fetch (SigV4); requests are
 * path-style (`<endpoint>/<bucket>/<key>`), which all four accept.
 *
 * Credentials come from TAPE_S3_* env vars and are never logged or put into
 * BOT_CONFIG (which the status server can broadcast).
 */

import { createHash } from 'crypto';
import { AwsClient } from 'aws4fetch';

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket, always '' or ending in '/'. */
  prefix: string;
}

export interface S3Object { key: string; size: number }

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_RE = /^[A-Za-z0-9._\/-]{1,1024}$/;
const PREFIX_RE = /^([A-Za-z0-9._-]+\/)*$/;

/** Only allowed characters, and no `.` / `..` segments. */
function safePath(s: string, re: RegExp): boolean {
  return re.test(s) && !s.split('/').some(seg => seg === '.' || seg === '..');
}

type Env = Record<string, string | undefined>;

/**
 * Read the store config. Returns `config: null` with no problem when nothing is
 * set (local-only mode), and with a problem when it is half-configured — which
 * is worth a loud warning, because it means someone meant to upload.
 */
export function readS3Config(env: Env): { config: S3Config | null; problem: string | null } {
  const endpoint = env.TAPE_S3_ENDPOINT?.trim() ?? '';
  const bucket = env.TAPE_S3_BUCKET?.trim() ?? '';
  const accessKeyId = env.TAPE_S3_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.TAPE_S3_SECRET_ACCESS_KEY?.trim() ?? '';
  const region = env.TAPE_S3_REGION?.trim() || 'auto';
  let prefix = env.TAPE_S3_PREFIX?.trim() ?? 'btc15/tape/';
  if (prefix !== '' && !prefix.endsWith('/')) prefix += '/';

  const given = { endpoint, bucket, accessKeyId, secretAccessKey };
  const missing = Object.entries(given).filter(([, v]) => v === '').map(([k]) => k);
  if (missing.length === 4) return { config: null, problem: null };
  if (missing.length > 0) return { config: null, problem: `incomplete — missing ${missing.join(', ')}` };

  let url: URL;
  try { url = new URL(endpoint); } catch { return { config: null, problem: 'TAPE_S3_ENDPOINT is not a URL' }; }
  if (url.protocol !== 'https:') return { config: null, problem: 'TAPE_S3_ENDPOINT must be https' };
  if (url.pathname !== '/' && url.pathname !== '') return { config: null, problem: 'TAPE_S3_ENDPOINT must not include a path (put the bucket in TAPE_S3_BUCKET)' };
  if (!BUCKET_RE.test(bucket)) return { config: null, problem: 'TAPE_S3_BUCKET is not a valid bucket name' };
  if (!safePath(prefix, PREFIX_RE)) return { config: null, problem: 'TAPE_S3_PREFIX may only contain letters, digits, . _ - and /' };

  return {
    config: { endpoint: url.origin, bucket, region, accessKeyId, secretAccessKey, prefix },
    problem: null,
  };
}

/** Human description of where uploads go, without credentials. */
export function describeStore(cfg: S3Config): string {
  return `${new URL(cfg.endpoint).host}/${cfg.bucket}/${cfg.prefix}`;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Parse one ListObjectsV2 page. Exported for tests. */
export function parseListPage(xml: string): { objects: S3Object[]; next: string | null } {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(m[1])?.[1];
    if (key !== undefined) objects.push({ key: decodeXml(key), size: size ? Number(size) : 0 });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = truncated ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
  return { objects, next: next ? decodeXml(next) : null };
}

export interface S3Store {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<S3Object[]>;
}

export function createS3Store(cfg: S3Config, fetchImpl: typeof fetch = fetch): S3Store {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: cfg.region,
  });
  const base = `${cfg.endpoint}/${cfg.bucket}`;

  function objectUrl(key: string): string {
    if (!safePath(key, KEY_RE)) throw new Error(`refusing object key ${JSON.stringify(key)}`);
    return `${base}/${key}`;
  }

  async function send(url: string, init: RequestInit): Promise<Response> {
    const signed = await client.sign(url, init);
    return fetchImpl(signed);
  }

  async function failure(res: Response, what: string): Promise<Error> {
    const body = await res.text().catch(() => '');
    const code = /<Code>([^<]{1,80})<\/Code>/.exec(body)?.[1];
    return new Error(`${what} → HTTP ${res.status}${code ? ` ${code}` : ''}`);
  }

  return {
    async put(key, body, contentType = 'application/gzip') {
      // Signing the payload hash (instead of UNSIGNED-PAYLOAD) makes the store
      // reject a body that was corrupted on the way.
      const sha = createHash('sha256').update(body).digest('hex');
      const res = await send(objectUrl(key), {
        method: 'PUT',
        body,
        headers: { 'content-type': contentType, 'x-amz-content-sha256': sha },
      });
      if (!res.ok) throw await failure(res, `PUT ${key}`);
      await res.arrayBuffer().catch(() => undefined);
    },

    async get(key) {
      const res = await send(objectUrl(key), { method: 'GET' });
      if (!res.ok) throw await failure(res, `GET ${key}`);
      return new Uint8Array(await res.arrayBuffer());
    },

    async list(prefix) {
      if (!safePath(prefix, PREFIX_RE)) throw new Error(`refusing list prefix ${JSON.stringify(prefix)}`);
      const out: S3Object[] = [];
      let token: string | null = null;
      for (let page = 0; page < 10_000; page++) {
        const q = new URLSearchParams({ 'list-type': '2', prefix });
        if (token) q.set('continuation-token', token);
        const res = await send(`${base}?${q.toString()}`, { method: 'GET' });
        if (!res.ok) throw await failure(res, `LIST ${prefix}`);
        const { objects, next } = parseListPage(await res.text());
        out.push(...objects);
        if (!next) break;
        token = next;
      }
      return out;
    },
  };
}
