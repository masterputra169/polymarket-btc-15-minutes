/**
 * Polygon JSON-RPC endpoint for the live on-chain paths (balances, redeem,
 * deposit activation). Read from POLYGON_RPC_URL; without it, a public keyless
 * endpoint. A keyed provider URL must never be written into the source — the
 * repo is public, and one was, from 2026-06 to 2026-09-27.
 */
export const PUBLIC_POLYGON_RPC = 'https://polygon-rpc.com';

export function polygonRpcUrl(env: Record<string, string | undefined> = process.env): string {
  const v = env.POLYGON_RPC_URL?.trim();
  return v ? v : PUBLIC_POLYGON_RPC;
}
