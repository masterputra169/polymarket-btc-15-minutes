/**
 * Step-Compounding bet cap with automatic High-Water Mark drawdown step-down.
 *
 * Keeps bet size flat within each bankroll tier (e.g. $100-$149 -> $2.10,
 * $150-$199 -> $3.00, $200-$249 -> $3.90) instead of resizing every trade,
 * and drops tiers automatically when peak-to-trough drawdown crosses the guard.
 */

export interface StepCompoundingConfig {
  enabled: boolean;
  baseBankroll: number;
  stepBankroll: number;
  baseBetUsd: number;
  stepBetUsd: number;
  maxBetUsd: number;
  drawdownStepDownPct: number;
}

export interface StepCompoundingResult {
  enabled: boolean;
  rawTier: number;
  effectiveTier: number;
  drawdownPct: number;
  steppedDown: boolean;
  capUsd: number;
}

export function computeStepCompoundingCap(
  bankroll: number,
  peakBankroll: number,
  cfg: StepCompoundingConfig,
): StepCompoundingResult {
  const safeBankroll = Number.isFinite(bankroll) && bankroll > 0 ? bankroll : 0;
  const safePeak = Number.isFinite(peakBankroll) && peakBankroll > safeBankroll ? peakBankroll : safeBankroll;
  const stepBankroll = Math.max(1, Number.isFinite(cfg.stepBankroll) ? cfg.stepBankroll : 50);
  const baseBankroll = Math.max(0, Number.isFinite(cfg.baseBankroll) ? cfg.baseBankroll : 100);
  const baseBetUsd = Math.max(1, Number.isFinite(cfg.baseBetUsd) ? cfg.baseBetUsd : 2.10);
  const stepBetUsd = Math.max(0, Number.isFinite(cfg.stepBetUsd) ? cfg.stepBetUsd : 0.90);
  const maxBetUsd = Math.max(baseBetUsd, Number.isFinite(cfg.maxBetUsd) ? cfg.maxBetUsd : 25.0);
  const ddThresh = Math.max(1, Number.isFinite(cfg.drawdownStepDownPct) ? cfg.drawdownStepDownPct : 15);

  const rawTier = safeBankroll <= baseBankroll
    ? 0
    : Math.floor((safeBankroll - baseBankroll) / stepBankroll);

  const drawdownPct = safePeak > 0
    ? Math.max(0, ((safePeak - safeBankroll) / safePeak) * 100)
    : 0;

  let effectiveTier = rawTier;
  if (drawdownPct >= ddThresh * 2) {
    effectiveTier = 0;
  } else if (drawdownPct >= ddThresh) {
    effectiveTier = Math.max(0, rawTier - 1);
  }

  const steppedDown = drawdownPct >= ddThresh;
  const rawCap = Math.round((baseBetUsd + effectiveTier * stepBetUsd) * 100) / 100;
  const capUsd = Math.min(maxBetUsd, Math.max(baseBetUsd, rawCap));

  return {
    enabled: cfg.enabled,
    rawTier,
    effectiveTier,
    drawdownPct: Math.round(drawdownPct * 100) / 100,
    steppedDown,
    capUsd,
  };
}
