import { describe, test, expect } from 'vitest';
import { polygonRpcUrl, PUBLIC_POLYGON_RPC } from '../polygonRpc.ts';

describe('polygonRpcUrl', () => {
  test('POLYGON_RPC_URL when set, a public keyless endpoint otherwise', () => {
    expect(polygonRpcUrl({ POLYGON_RPC_URL: ' https://example.invalid/rpc ' })).toBe('https://example.invalid/rpc');
    expect(polygonRpcUrl({})).toBe(PUBLIC_POLYGON_RPC);
    expect(polygonRpcUrl({ POLYGON_RPC_URL: '  ' })).toBe(PUBLIC_POLYGON_RPC);
    expect(PUBLIC_POLYGON_RPC).not.toMatch(/[0-9a-f]{24,}/); // no key in the default
  });
});
