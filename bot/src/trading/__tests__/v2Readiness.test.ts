/**
 * v2Readiness.ts — the live-startup gate for CLOB V2.
 *
 * Invariant: the bot trades live only when the funder holds pUSD, has approved
 * CTF Exchange V2 for pUSD (BUY) and for its outcome tokens (SELL), and the
 * CLOB order version is 2. USDC.e without pUSD is a problem with a wrap
 * instruction, not something the check fixes. Neg-risk approvals are notes.
 */

import { describe, test, expect } from 'vitest';
import { describeApprovals, evaluateV2Readiness } from '../v2Readiness.ts';
import type { V2WalletState } from '../v2Readiness.ts';
import { V2_CONTRACTS } from '../clobV2Config.ts';

const MAX = 1.157920892373162e71; // approve(…, MaxUint256) / 1e6
const FUNDER = '0x1111111111111111111111111111111111111111';

const READY: V2WalletState = {
  funder: FUNDER,
  orderVersion: 2,
  pusdBalance: 120,
  usdceBalance: 0,
  pusdAllowanceExchange: MAX,
  pusdAllowanceNegRiskExchange: MAX,
  ctfApprovedExchange: true,
  ctfApprovedNegRiskExchange: true,
};

describe('evaluateV2Readiness', () => {
  test('a funded, approved wallet is ready', () => {
    expect(evaluateV2Readiness(READY)).toEqual({ ok: true, problems: [], notes: [] });
  });

  test('USDC.e but no pUSD: fail closed with a wrap instruction, never a wrap', () => {
    const v = evaluateV2Readiness({ ...READY, pusdBalance: 0, usdceBalance: 50 });
    expect(v.ok).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toContain('50.00 USDC.e and no pUSD');
    expect(v.problems[0]).toContain(`CollateralOnramp ${V2_CONTRACTS.collateralOnramp}`);
    expect(v.problems[0]).toContain(`wrap(${V2_CONTRACTS.usdce}, ${FUNDER}, amount)`);
  });

  test('no collateral at all: fail closed', () => {
    const v = evaluateV2Readiness({ ...READY, pusdBalance: 0 });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/holds no pUSD/);
  });

  test('missing pUSD approval for CTF Exchange V2: fail closed, names both contracts', () => {
    const v = evaluateV2Readiness({ ...READY, pusdAllowanceExchange: 0 });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain(`pUSD(${V2_CONTRACTS.collateral}).approve(${V2_CONTRACTS.exchange}, MaxUint256)`);
  });

  test('missing outcome-token approval: fail closed (SELL / cut-loss needs it)', () => {
    const v = evaluateV2Readiness({ ...READY, ctfApprovedExchange: false });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain(`setApprovalForAll(${V2_CONTRACTS.exchange}, true)`);
  });

  test('an unknown or different order version fails closed', () => {
    expect(evaluateV2Readiness({ ...READY, orderVersion: null }).ok).toBe(false);
    const v3 = evaluateV2Readiness({ ...READY, orderVersion: 3 });
    expect(v3.ok).toBe(false);
    expect(v3.problems[0]).toMatch(/order version is 3/);
  });

  test('every problem is reported at once', () => {
    const v = evaluateV2Readiness({
      ...READY, orderVersion: 3, pusdBalance: 0, pusdAllowanceExchange: 0, ctfApprovedExchange: false,
    });
    expect(v.problems).toHaveLength(4);
  });

  test('notes do not block: leftover USDC.e, partial allowance, neg-risk approvals', () => {
    const v = evaluateV2Readiness({
      ...READY,
      usdceBalance: 3,
      pusdAllowanceExchange: 20,
      pusdAllowanceNegRiskExchange: 0,
      ctfApprovedNegRiskExchange: false,
    });
    expect(v.ok).toBe(true);
    expect(v.notes).toHaveLength(3);
    expect(v.notes.join('\n')).toMatch(/3\.00 USDC\.e/);
    expect(v.notes.join('\n')).toMatch(/allowance for CTF Exchange V2 is 20\.00/);
    expect(v.notes.join('\n')).toMatch(/not needed for BTC 15m/);
  });
});

describe('describeApprovals', () => {
  test('one log line per approval, max allowances shown as "max"', () => {
    const lines = describeApprovals(READY);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(`pUSD allowance -> CTF Exchange V2 ${V2_CONTRACTS.exchange}: max`);
    expect(lines[2]).toBe(`CTF setApprovalForAll -> CTF Exchange V2 ${V2_CONTRACTS.exchange}: yes`);
  });
});
