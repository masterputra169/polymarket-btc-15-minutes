/**
 * Feed-health guard — alerts when the bot is pricing off a degraded feed.
 *
 * Rules (all rate-limited and transition-based, never per poll):
 *   - PTB not exact 120 s into a market        -> warn once per market
 *   - PolyBolt TWAP disconnected/lagging 60 s  -> warn, then info on recovery
 *   - CLOB book down 60 s                      -> warn, then info on recovery
 *
 * `checkFeedAlerts` is total: it must never throw into the poll loop.
 */

import { notify } from './notifier.ts';
import { feedAlertMessage } from './alertTemplates.ts';

export type FeedKind = 'ptb' | 'twap' | 'clob';

interface WatchState {
  active: boolean;
  badSince: number | null;
  alerted: boolean;
  slug?: string | null;
}

export interface FeedGuardState {
  ptb: WatchState;
  twap: WatchState;
  clob: WatchState;
}

export interface FeedInput {
  now: number;
  slug: string | null;
  marketAgeSec: number | null;
  ptbExact: boolean;
  ptbSource: string | null;
  twapMode: string | null;
  twapConnected: boolean;
  twapLastTickAgeMs: number | null;
  clobStatus: 'live' | 'quiet' | 'down';
}

export interface FeedAlertTransition {
  kind: FeedKind;
  level: 'warn' | 'info';
  detail: string;
  slug: string | null;
}

const PTB_GRACE_SEC = 120;
const PTB_OBSERVE_MS = 20_000; // avoid alerting on the first seconds after a restart
const TWAP_BAD_MS = 60_000;
const TWAP_STALE_MS = 90_000;
const CLOB_BAD_MS = 60_000;

export function emptyFeedGuardState(): FeedGuardState {
  return {
    ptb: { active: false, badSince: null, alerted: false },
    twap: { active: false, badSince: null, alerted: false },
    clob: { active: false, badSince: null, alerted: false },
  };
}

function transition(
  watch: WatchState,
  bad: boolean,
  thresholdMs: number,
  now: number,
  onWarn: () => FeedAlertTransition,
  onRecover: () => FeedAlertTransition,
): FeedAlertTransition | null {
  if (bad) {
    if (!watch.active) { watch.active = true; watch.badSince = now; watch.alerted = false; return null; }
    if (!watch.alerted && now - (watch.badSince ?? now) >= thresholdMs) {
      watch.alerted = true;
      return onWarn();
    }
    return null;
  }
  if (watch.active) {
    const wasAlerted = watch.alerted;
    watch.active = false; watch.badSince = null; watch.alerted = false;
    return wasAlerted ? onRecover() : null;
  }
  return null;
}

/** Pure transition logic (unit-tested). */
export function evaluateFeedTransitions(
  prev: FeedGuardState,
  input: FeedInput,
): { state: FeedGuardState; alerts: FeedAlertTransition[] } {
  // Structured clone so callers can keep the old state for assertions.
  const state: FeedGuardState = {
    ptb: { ...prev.ptb },
    twap: { ...prev.twap },
    clob: { ...prev.clob },
  };
  const alerts: FeedAlertTransition[] = [];

  // PTB: once per market, after the grace period.
  if (state.ptb.slug !== input.slug) {
    state.ptb = { active: false, badSince: null, alerted: false, slug: input.slug };
  }
  const ptbBad = !input.ptbExact;
  const ptbLate = input.marketAgeSec != null && input.marketAgeSec >= PTB_GRACE_SEC;
  if (ptbBad) {
    // Observe for PTB_OBSERVE_MS before alerting: a restart mid-market sees
    // 'pending' for a few seconds and must not page the operator for that.
    if (!state.ptb.active) {
      state.ptb.active = true;
      state.ptb.badSince = input.now;
    } else if (!state.ptb.alerted && ptbLate && input.now - (state.ptb.badSince ?? input.now) >= PTB_OBSERVE_MS) {
      state.ptb.alerted = true;
      alerts.push({
        kind: 'ptb', level: 'warn', slug: input.slug,
        detail: 'not exact after ' + Math.round(input.marketAgeSec ?? 0) + 's (source: ' + (input.ptbSource ?? 'pending') + ')',
      });
    }
  } else {
    if (state.ptb.alerted) {
      alerts.push({ kind: 'ptb', level: 'info', slug: input.slug, detail: 'exact (' + (input.ptbSource ?? 'unknown') + ')' });
    }
    state.ptb.active = false; state.ptb.badSince = null; state.ptb.alerted = false;
  }

  // PolyBolt TWAP: alert after 60 s disconnected or >90 s without a tick.
  const twapBad = input.twapMode === 'polybolt' && (
    !input.twapConnected || (input.twapLastTickAgeMs != null && input.twapLastTickAgeMs > TWAP_STALE_MS)
  );
  const twapAlert = transition(state.twap, twapBad, TWAP_BAD_MS, input.now,
    () => ({ kind: 'twap', level: 'warn', slug: input.slug, detail: !input.twapConnected ? 'PolyBolt disconnected' : 'no tick for ' + Math.round((input.twapLastTickAgeMs ?? 0) / 1000) + 's' }),
    () => ({ kind: 'twap', level: 'info', slug: input.slug, detail: 'PolyBolt recovered' }));
  if (twapAlert) alerts.push(twapAlert);

  // CLOB book: alert after 60 s down.
  const clobBad = input.clobStatus === 'down';
  const clobAlert = transition(state.clob, clobBad, CLOB_BAD_MS, input.now,
    () => ({ kind: 'clob', level: 'warn', slug: input.slug, detail: 'order book down >60s' }),
    () => ({ kind: 'clob', level: 'info', slug: input.slug, detail: 'order book recovered' }));
  if (clobAlert) alerts.push(clobAlert);

  return { state, alerts };
}

let _state = emptyFeedGuardState();

/** Called from the poll loop; total (never throws). */
export function checkFeedAlerts(input: FeedInput): void {
  try {
    const { state, alerts } = evaluateFeedTransitions(_state, input);
    _state = state;
    for (const a of alerts) {
      void notify(a.level, feedAlertMessage(a), { key: 'feed:' + a.kind }).catch(() => {});
    }
  } catch {
    // A notification must never take the bot down.
  }
}

export function resetFeedGuardForTests(): void {
  _state = emptyFeedGuardState();
}
