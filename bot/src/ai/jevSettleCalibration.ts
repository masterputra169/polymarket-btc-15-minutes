/**
 * JEV settle-probability calibration.
 *
 * The model's raw settle_above_ptb output was badly overconfident on the
 * 2026-10-19..25 shadow sample:
 *   raw Brier 0.3331, isotonic-calibrated Brier 0.2437 (time-split test).
 * It is still worse than the market (0.228), so calibrated values are for
 * diagnostics/record-keeping only and never promote JEV to a gate.
 *
 * Mapping was fitted with monotone (PAVA) calibration on the first 70% of
 * markets by time and evaluated on the last 30%; it is deliberately coarse.
 * Version bump whenever the mapping changes.
 */
export const JEV_SETTLE_CALIBRATION_VERSION = '2026-10-26-pava-70';

type Block = { lo: number; hi: number; mean: number };
const BLOCKS: Block[] = [
  { lo: 0.040, hi: 0.040, mean: 0.0000 },
  { lo: 0.050, hi: 0.050, mean: 0.0000 },
  { lo: 0.060, hi: 0.070, mean: 0.2727 },
  { lo: 0.080, hi: 0.860, mean: 0.4462 },
  { lo: 0.870, hi: 0.890, mean: 0.4545 },
  { lo: 0.900, hi: 0.900, mean: 0.5333 },
  { lo: 0.910, hi: 0.910, mean: 0.6351 },
  { lo: 0.920, hi: 0.930, mean: 0.6712 },
];

export function calibrateJevSettleUp(raw: number): number {
  if (!Number.isFinite(raw)) return Number.NaN;
  if (raw <= BLOCKS[0].lo) return BLOCKS[0].mean;
  let value = BLOCKS[0].mean;
  for (const b of BLOCKS) {
    if (raw >= b.lo) value = b.mean;
    else break;
  }
  return value;
}

export function getJevCalibrationBlocks(): Block[] {
  return BLOCKS.map((b) => ({ ...b }));
}
