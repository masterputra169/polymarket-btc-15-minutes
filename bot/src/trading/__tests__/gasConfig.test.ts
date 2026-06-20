/**
 * Gas fee cap (gasConfig.js).
 *
 * Bug: redeemer.js / depositActivator.js submit on-chain txs with only
 * { gasLimit: 500_000n } and NO fee fields → ethers v6 auto-fetches Polygon
 * fee data (inflated) → required balance = gasLimit × maxFeePerGas blew up to
 * ~3 POL → INSUFFICIENT_FUNDS even though real cost is cents. Capping
 * maxFeePerGas to a sane Polygon ceiling bounds the reservation (and protects
 * against gas-price spikes).
 *
 * Invariant: gasFeeOverrides() returns BigInt wei {maxFeePerGas,
 * maxPriorityFeePerGas}, env-tunable with safe defaults, priority never
 * exceeds maxFee, and the worst-case reservation (×500k gasLimit) stays small.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { gasFeeOverrides } from '../gasConfig.ts';

const GWEI = 1_000_000_000n;
const ENV_KEYS = ['GAS_MAX_FEE_GWEI', 'GAS_PRIORITY_GWEI'];
let saved;

beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('gasFeeOverrides — Polygon fee cap', () => {
  test('defaults: 300 Gwei maxFee / 40 Gwei priority, as BigInt wei', () => {
    const o = gasFeeOverrides();
    expect(typeof o.maxFeePerGas).toBe('bigint');
    expect(typeof o.maxPriorityFeePerGas).toBe('bigint');
    expect(o.maxFeePerGas).toBe(300n * GWEI);
    expect(o.maxPriorityFeePerGas).toBe(40n * GWEI);
  });

  test('env overrides are honored', () => {
    process.env.GAS_MAX_FEE_GWEI = '150';
    process.env.GAS_PRIORITY_GWEI = '25';
    const o = gasFeeOverrides();
    expect(o.maxFeePerGas).toBe(150n * GWEI);
    expect(o.maxPriorityFeePerGas).toBe(25n * GWEI);
  });

  test('priority is clamped to never exceed maxFee', () => {
    process.env.GAS_MAX_FEE_GWEI = '50';
    process.env.GAS_PRIORITY_GWEI = '200';
    const o = gasFeeOverrides();
    expect(o.maxPriorityFeePerGas).toBeLessThanOrEqual(o.maxFeePerGas);
    expect(o.maxFeePerGas).toBe(50n * GWEI);
  });

  test('invalid / non-positive env falls back to safe defaults', () => {
    for (const bad of ['abc', '0', '-10', '']) {
      process.env.GAS_MAX_FEE_GWEI = bad;
      expect(gasFeeOverrides().maxFeePerGas).toBe(300n * GWEI);
    }
  });

  test('absurd env values are bounded (anti-footgun)', () => {
    process.env.GAS_MAX_FEE_GWEI = '9999999';
    expect(gasFeeOverrides().maxFeePerGas).toBeLessThanOrEqual(3000n * GWEI);
  });

  test('worst-case reservation with 500k gasLimit stays well under 0.2 POL (the bug)', () => {
    const { maxFeePerGas } = gasFeeOverrides();
    const reservationWei = maxFeePerGas * 500_000n;
    // 0.2 POL = 2e17 wei. Old auto-fee blew this to ~3e18 (3 POL).
    expect(reservationWei).toBeLessThan(200_000_000_000_000_000n);
  });
});
