/** Fixed-policy forward shadow for JEV (record-only).
 *
 * Policy (fixed, decided before data collection):
 *   confidence > minConfidence, ask <= maxAsk, pSide - ask >= minEdge.
 * One candidate per market is enforced by the caller's once-per-market guard.
 * The candidate is appended to data/jev_policy.jsonl; no order is placed.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('JEVPolicy');

export interface PolicySettings {
  minConfidence: number;
  maxAsk: number;
  minEdge: number;
}

export interface PolicyInput {
  slug: string | null;
  ts: number;
  iso: string;
  direction: 'UP' | 'DOWN' | 'NO_EDGE';
  directionConfidence: number;
  directionProbabilities: Record<string, number> | null | undefined;
  settleUpProbability: number | null | undefined;
  regime: string | null;
  marketUp: number | null;
  marketDown: number | null;
  timeLeftMin: number | null;
  rulesSide: string | null;
  rulesAction: string | null;
  callOn: string;
}

export interface PolicyCandidate {
  k: 'candidate';
  ts: number;
  iso: string;
  slug: string;
  direction: 'UP' | 'DOWN';
  confidence: number;
  pSide: number;
  ask: number;
  edge: number;
  settleUpProbability: number | null;
  regime: string | null;
  timeLeftMin: number | null;
  marketUp: number | null;
  marketDown: number | null;
  rulesSide: string | null;
  rulesAction: string | null;
  callOn: string;
  status: 'open';
}

export function evaluatePolicyCandidate(input: PolicyInput, settings: PolicySettings): PolicyCandidate | null {
  const dir = input.direction;
  if (dir !== 'UP' && dir !== 'DOWN') return null;
  if (!Number.isFinite(input.directionConfidence) || !(input.directionConfidence > settings.minConfidence)) return null;
  if (!input.slug) return null;
  const pSide = Number(input.directionProbabilities?.[dir]);
  const ask = Number(dir === 'UP' ? input.marketUp : input.marketDown);
  if (!Number.isFinite(pSide) || !Number.isFinite(ask)) return null;
  if (ask <= 0 || ask >= 1) return null;
  if (ask > settings.maxAsk) return null;
  const edge = pSide - ask;
  if (!(edge >= settings.minEdge)) return null;
  return {
    k: 'candidate',
    ts: input.ts,
    iso: input.iso,
    slug: input.slug,
    direction: dir,
    confidence: input.directionConfidence,
    pSide,
    ask,
    edge,
    settleUpProbability: Number.isFinite(Number(input.settleUpProbability)) ? Number(input.settleUpProbability) : null,
    regime: input.regime,
    timeLeftMin: input.timeLeftMin,
    marketUp: input.marketUp,
    marketDown: input.marketDown,
    rulesSide: input.rulesSide,
    rulesAction: input.rulesAction,
    callOn: input.callOn,
    status: 'open',
  };
}

/** Evaluate and append one candidate if the fixed policy passes. Never throws. */
export function maybeRecordPolicyCandidate(input: PolicyInput): PolicyCandidate | null {
  const cfg = BOT_CONFIG.jev;
  if (!cfg?.policyShadow) return null;
  const candidate = evaluatePolicyCandidate(input, {
    minConfidence: cfg.policyMinConfidence,
    maxAsk: cfg.policyMaxAsk,
    minEdge: cfg.policyMinEdge,
  });
  if (!candidate) return null;
  try {
    mkdirSync(dirname(cfg.policyFile), { recursive: true });
    appendFileSync(cfg.policyFile, JSON.stringify(candidate) + '\n', 'utf8');
    log.info('JEV policy candidate ' + candidate.slug + ': ' + candidate.direction + ' conf=' + Math.round(candidate.confidence * 100) + '% ask=' + candidate.ask.toFixed(3) + ' edge=' + candidate.edge.toFixed(3));
  } catch (err: unknown) {
    log.warn('JEV policy: cannot write candidate - ' + (err instanceof Error ? err.message : String(err)));
  }
  return candidate;
}
