import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'crypto';
import { createS3Store, describeStore, parseListPage, readS3Config } from '../s3Store.ts';

const FULL = {
  TAPE_S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
  TAPE_S3_BUCKET: 'polybtc15-tape',
  TAPE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  TAPE_S3_SECRET_ACCESS_KEY: 'secret/EXAMPLE+key',
};

describe('readS3Config', () => {
  test('nothing set → local-only, no complaint', () => {
    expect(readS3Config({})).toEqual({ config: null, problem: null });
  });

  test('half set → local-only, and says what is missing (never the values)', () => {
    const r = readS3Config({ TAPE_S3_ENDPOINT: FULL.TAPE_S3_ENDPOINT, TAPE_S3_ACCESS_KEY_ID: 'AKID' });
    expect(r.config).toBeNull();
    expect(r.problem).toBe('incomplete — missing bucket, secretAccessKey');
  });

  test('full config: defaults region auto and prefix btc15/tape/', () => {
    const r = readS3Config(FULL);
    expect(r.problem).toBeNull();
    expect(r.config).toMatchObject({ endpoint: FULL.TAPE_S3_ENDPOINT, bucket: 'polybtc15-tape', region: 'auto', prefix: 'btc15/tape/' });
    expect(describeStore(r.config!)).toBe('abc123.r2.cloudflarestorage.com/polybtc15-tape/btc15/tape/');
    expect(describeStore(r.config!)).not.toContain('secret');
  });

  test('prefix gets a trailing slash; empty prefix is allowed', () => {
    expect(readS3Config({ ...FULL, TAPE_S3_PREFIX: 'raw' }).config!.prefix).toBe('raw/');
    expect(readS3Config({ ...FULL, TAPE_S3_PREFIX: '' }).config!.prefix).toBe('');
  });

  test.each([
    [{ TAPE_S3_ENDPOINT: 'http://abc.r2.cloudflarestorage.com' }, 'must be https'],
    [{ TAPE_S3_ENDPOINT: 'not a url' }, 'not a URL'],
    [{ TAPE_S3_ENDPOINT: 'https://abc.r2.cloudflarestorage.com/polybtc15-tape' }, 'must not include a path'],
    [{ TAPE_S3_BUCKET: 'Bad_Bucket' }, 'not a valid bucket'],
    [{ TAPE_S3_PREFIX: '../x/' }, 'may only contain'],
  ])('rejects %o', (over, msg) => {
    const r = readS3Config({ ...FULL, ...over });
    expect(r.config).toBeNull();
    expect(r.problem).toContain(msg);
  });
});

describe('parseListPage', () => {
  test('reads keys, sizes and the continuation token', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>btc15/tape/2026-09-24/03-a.jsonl.gz</Key><Size>123</Size></Contents>
      <Contents><Key>btc15/tape/a&amp;b</Key><Size>7</Size></Contents>
      <NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
    expect(parseListPage(xml)).toEqual({
      objects: [{ key: 'btc15/tape/2026-09-24/03-a.jsonl.gz', size: 123 }, { key: 'btc15/tape/a&b', size: 7 }],
      next: 'tok&1',
    });
  });

  test('a final page has no next token', () => {
    expect(parseListPage('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ objects: [], next: null });
  });
});

describe('createS3Store', () => {
  const cfg = readS3Config(FULL).config!;

  test('PUT is path-style, SigV4-signed, and signs the real payload hash', async () => {
    const fetchImpl = vi.fn(async (_req: Request) => new Response('', { status: 200 }));
    const store = createS3Store(cfg, fetchImpl as unknown as typeof fetch);
    const body = new Uint8Array([1, 2, 3]);
    await store.put('btc15/tape/2026-09-24/03-a.jsonl.gz', body);

    const req = fetchImpl.mock.calls[0][0];
    expect(req.method).toBe('PUT');
    expect(req.url).toBe('https://abc123.r2.cloudflarestorage.com/polybtc15-tape/btc15/tape/2026-09-24/03-a.jsonl.gz');
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
    expect(req.headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update(body).digest('hex'));
    expect(req.headers.get('content-type')).toBe('application/gzip');
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(body);
  });

  test('a failed PUT throws with the HTTP status and S3 error code', async () => {
    const fetchImpl = vi.fn(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));
    const store = createS3Store(cfg, fetchImpl as unknown as typeof fetch);
    await expect(store.put('btc15/x.jsonl.gz', new Uint8Array(1))).rejects.toThrow('HTTP 403 AccessDenied');
  });

  test('refuses keys that could escape the prefix', async () => {
    const fetchImpl = vi.fn();
    const store = createS3Store(cfg, fetchImpl as unknown as typeof fetch);
    await expect(store.put('btc15/../other/x', new Uint8Array(1))).rejects.toThrow('refusing');
    await expect(store.get('a b')).rejects.toThrow('refusing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('list follows continuation tokens', async () => {
    const pages = [
      '<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>p/a</Key><Size>1</Size></Contents><NextContinuationToken>T2</NextContinuationToken></ListBucketResult>',
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/b</Key><Size>2</Size></Contents></ListBucketResult>',
    ];
    const fetchImpl = vi.fn(async (_req: Request) => new Response(pages.shift()!, { status: 200 }));
    const store = createS3Store(cfg, fetchImpl as unknown as typeof fetch);
    expect(await store.list('p/')).toEqual([{ key: 'p/a', size: 1 }, { key: 'p/b', size: 2 }]);
    const second = new URL(fetchImpl.mock.calls[1][0].url);
    expect(second.searchParams.get('continuation-token')).toBe('T2');
    expect(second.searchParams.get('list-type')).toBe('2');
  });
});
