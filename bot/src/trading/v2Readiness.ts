/**
 * Live-startup readiness check for CLOB V2: is the funder wallet able to trade?
 *
 * V2 trades pUSD, and the V2 exchange needs two approvals from the wallet that
 * holds the funds (docs.polymarket.com/trading/wallets-auth, "Set Up Trading
 * Approvals"):
 *   - pUSD `approve(CTF Exchange V2, max)`           — to BUY
 *   - Conditional Tokens `setApprovalForAll(CTF Exchange V2, true)` — to SELL
 *
 * This module only READS chain state. It sends no transaction and never wraps
 * USDC.e: when the wallet holds USDC.e but no pUSD it says how to wrap and the
 * bot refuses to trade live. `evaluateV2Readiness` is pure; `readWalletState`
 * does the RPC reads.
 */

import { ethers } from 'ethers';
import { SUPPORTED_ORDER_VERSION, V2_CONTRACTS } from './clobV2Config.ts';

export interface V2WalletState {
  readonly funder: string;
  /** Order version from the CLOB's /version, or null when it could not be read. */
  readonly orderVersion: number | null;
  /** Token amounts in whole units (6 decimals already applied). */
  readonly pusdBalance: number;
  readonly usdceBalance: number;
  readonly pusdAllowanceExchange: number;
  readonly pusdAllowanceNegRiskExchange: number;
  readonly ctfApprovedExchange: boolean;
  readonly ctfApprovedNegRiskExchange: boolean;
}

export interface ReadinessVerdict {
  readonly ok: boolean;
  /** Each one blocks live trading. */
  readonly problems: readonly string[];
  /** Informational. */
  readonly notes: readonly string[];
}

/** Above this an allowance is shown as "max" (approve(…, MaxUint256) reads back ~1.16e71). */
const EFFECTIVELY_UNLIMITED = 1e15;

function fmtAmount(n: number): string {
  return n >= EFFECTIVELY_UNLIMITED ? 'max' : n.toFixed(2);
}

/** Pure: what stands between this wallet and a live V2 order. */
export function evaluateV2Readiness(state: V2WalletState): ReadinessVerdict {
  const problems: string[] = [];
  const notes: string[] = [];
  const { funder } = state;
  const c = V2_CONTRACTS;

  if (state.orderVersion !== SUPPORTED_ORDER_VERSION) {
    problems.push(
      state.orderVersion == null
        ? 'could not read the CLOB order version (GET /version) — cannot tell which exchange the approvals must name'
        : `CLOB order version is ${state.orderVersion}; these checks cover version ${SUPPORTED_ORDER_VERSION} ` +
          `(CTF Exchange V2 ${c.exchange}) — review the approvals before trading`,
    );
  }

  if (!(state.pusdBalance > 0)) {
    if (state.usdceBalance > 0) {
      problems.push(
        `funder ${funder} holds ${state.usdceBalance.toFixed(2)} USDC.e and no pUSD. CLOB V2 trades pUSD only. ` +
        `Wrap it first: USDC.e.approve(CollateralOnramp ${c.collateralOnramp}, amount), then ` +
        `CollateralOnramp.wrap(${c.usdce}, ${funder}, amount) — or "Activate Funds" on polymarket.com. ` +
        'The bot does not wrap as part of this check.',
      );
    } else {
      problems.push(`funder ${funder} holds no pUSD (${c.collateral}) — fund the wallet with pUSD before trading live`);
    }
  } else if (state.usdceBalance > 0) {
    notes.push(`funder also holds ${state.usdceBalance.toFixed(2)} USDC.e, which is not tradable until wrapped into pUSD`);
  }

  if (!(state.pusdAllowanceExchange > 0)) {
    problems.push(
      `pUSD is not approved for CTF Exchange V2: from ${funder} call ` +
      `pUSD(${c.collateral}).approve(${c.exchange}, MaxUint256) — BUY orders fail without it`,
    );
  } else if (state.pusdAllowanceExchange < state.pusdBalance) {
    notes.push(
      `pUSD allowance for CTF Exchange V2 is ${fmtAmount(state.pusdAllowanceExchange)}, below the ` +
      `${state.pusdBalance.toFixed(2)} balance — orders above the allowance will be rejected`,
    );
  }

  if (!state.ctfApprovedExchange) {
    problems.push(
      `Conditional Tokens are not approved for CTF Exchange V2: from ${funder} call ` +
      `CTF(${c.conditionalTokens}).setApprovalForAll(${c.exchange}, true) — SELL orders (cut-loss) fail without it`,
    );
  }

  if (!(state.pusdAllowanceNegRiskExchange > 0) || !state.ctfApprovedNegRiskExchange) {
    notes.push(
      `Neg Risk Exchange V2 (${c.negRiskExchange}) approvals are incomplete — not needed for BTC 15m markets (neg_risk=false)`,
    );
  }

  return { ok: problems.length === 0, problems, notes };
}

/** One line per approval, for the startup log. */
export function describeApprovals(state: V2WalletState): string[] {
  const c = V2_CONTRACTS;
  return [
    `pUSD ${c.collateral}: balance ${state.pusdBalance.toFixed(2)} | USDC.e ${state.usdceBalance.toFixed(2)} (funder ${state.funder})`,
    `pUSD allowance -> CTF Exchange V2 ${c.exchange}: ${fmtAmount(state.pusdAllowanceExchange)}`,
    `CTF setApprovalForAll -> CTF Exchange V2 ${c.exchange}: ${state.ctfApprovedExchange ? 'yes' : 'NO'}`,
    `pUSD allowance -> Neg Risk Exchange V2 ${c.negRiskExchange}: ${fmtAmount(state.pusdAllowanceNegRiskExchange)} | ` +
      `CTF approval: ${state.ctfApprovedNegRiskExchange ? 'yes' : 'no'} (unused by BTC 15m)`,
  ];
}

const ERC20_READ_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];
const ERC1155_READ_ABI = ['function isApprovedForAll(address account, address operator) view returns (bool)'];

const TOKEN_DECIMALS = 1e6;

function toUnits(raw: bigint): number {
  return Number(raw) / TOKEN_DECIMALS;
}

/**
 * Read the funder's balances and approvals from Polygon. View calls only.
 * Throws when the RPC cannot answer; the caller treats that as not ready.
 */
export async function readWalletState(
  provider: ethers.Provider,
  funder: string,
  orderVersion: number | null,
): Promise<V2WalletState> {
  const c = V2_CONTRACTS;
  const pusd = new ethers.Contract(c.collateral, ERC20_READ_ABI, provider);
  const usdce = new ethers.Contract(c.usdce, ERC20_READ_ABI, provider);
  const ctf = new ethers.Contract(c.conditionalTokens, ERC1155_READ_ABI, provider);

  const [pusdBal, usdceBal, allowEx, allowNr, ctfEx, ctfNr] = await Promise.all([
    pusd.balanceOf(funder) as Promise<bigint>,
    usdce.balanceOf(funder) as Promise<bigint>,
    pusd.allowance(funder, c.exchange) as Promise<bigint>,
    pusd.allowance(funder, c.negRiskExchange) as Promise<bigint>,
    ctf.isApprovedForAll(funder, c.exchange) as Promise<boolean>,
    ctf.isApprovedForAll(funder, c.negRiskExchange) as Promise<boolean>,
  ]);

  return {
    funder,
    orderVersion,
    pusdBalance: toUnits(pusdBal),
    usdceBalance: toUnits(usdceBal),
    pusdAllowanceExchange: toUnits(allowEx),
    pusdAllowanceNegRiskExchange: toUnits(allowNr),
    ctfApprovedExchange: Boolean(ctfEx),
    ctfApprovedNegRiskExchange: Boolean(ctfNr),
  };
}
