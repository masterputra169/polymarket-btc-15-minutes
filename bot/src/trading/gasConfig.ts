/**
 * Polygon gas fee cap for on-chain tx submission (redeem / Safe execTransaction).
 *
 * Problem: ethers v6 auto-populates maxFeePerGas from provider.getFeeData(),
 * which on Polygon is heavily inflated. Required balance = gasLimit ×
 * maxFeePerGas, so a 500k-gas redeem demanded ~3 POL of *reserved* balance
 * (actual cost is cents) → spurious INSUFFICIENT_FUNDS.
 *
 * Fix: pass an explicit, env-tunable maxFeePerGas / maxPriorityFeePerGas
 * ceiling. This bounds the reservation AND caps spend during gas-price spikes
 * (redeem is hourly / non-latency-critical — a sane ceiling is safe).
 *
 * Polygon norm is ~30-150 Gwei; default cap 300 Gwei is generous headroom.
 * Override via GAS_MAX_FEE_GWEI / GAS_PRIORITY_GWEI in bot/.env if needed.
 */

const WEI_PER_GWEI = 1e9;

/** Parse a positive numeric env var (Gwei), clamped to [lo, hi]; else default. */
function envGwei(name, def, lo, hi) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * @returns {{ maxFeePerGas: bigint, maxPriorityFeePerGas: bigint }} wei overrides
 */
export function gasFeeOverrides() {
  const maxFeeGwei = envGwei('GAS_MAX_FEE_GWEI', 300, 25, 3000);
  let prioGwei = envGwei('GAS_PRIORITY_GWEI', 40, 1, 1000);
  // A priority fee above the max fee is invalid — clamp it down.
  if (prioGwei > maxFeeGwei) prioGwei = maxFeeGwei;
  return {
    maxFeePerGas: BigInt(Math.round(maxFeeGwei * WEI_PER_GWEI)),
    maxPriorityFeePerGas: BigInt(Math.round(prioGwei * WEI_PER_GWEI)),
  };
}
