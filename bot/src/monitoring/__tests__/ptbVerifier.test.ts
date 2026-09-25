/**
 * The post-close check that turns "is our PTB right?" into a measured number:
 * the PTB the bot used against Gamma's published one, a few minutes after close.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

process.env.PTB_HEALTH_PATH = join(mkdtempSync(join(tmpdir(), 'ptbverify-')), 'ptb_health.jsonl');
const { verifyPtb, fetchOfficialPtb, VERIFY_DELAYS_MS } = await import('../ptbVerifier.ts');
const { getPendingVerification, _reset } = await import('../ptbHealth.ts');

const OFFICIAL = 83743.8965356868;
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

beforeEach(() => { _reset(); sleeps.length = 0; });

describe('verifyPtb', () => {
  test('waits for Gamma to publish, then records an exact match', async () => {
    const fetchOfficial = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(OFFICIAL);
    expect(await verifyPtb({ slug: 's', used: OFFICIAL, usedSource: 'chainlink_twap' }, { fetchOfficial, sleep })).toBe(0);
    expect(sleeps).toEqual([VERIFY_DELAYS_MS[0], VERIFY_DELAYS_MS[1] - VERIFY_DELAYS_MS[0]]);
    expect(getPendingVerification()).toMatchObject({ checked: 1, exact: 1, mismatch: 0 });
  });

  test('records a mismatch with its size; gives up quietly if Gamma never answers', async () => {
    expect(await verifyPtb({ slug: 's', used: 83778.83461303619, usedSource: 'scheduled_ws' }, { fetchOfficial: async () => OFFICIAL, sleep })).toBeCloseTo(34.938, 2);
    expect(await verifyPtb({ slug: 's', used: 1, usedSource: 'x' }, { fetchOfficial: async () => { throw new Error('down'); }, sleep })).toBeNull();
    expect(getPendingVerification()).toMatchObject({ checked: 1, mismatch: 1 });
  });

  test('reads eventMetadata.priceToBeat and nothing else', async () => {
    expect(await fetchOfficialPtb('btc-updown-15m-1', async () => ({ eventMetadata: { priceToBeat: OFFICIAL, finalPrice: 1 } }))).toBe(OFFICIAL);
    expect(await fetchOfficialPtb('btc-updown-15m-1', async () => ({ eventMetadata: null }))).toBeNull();
  });
});
