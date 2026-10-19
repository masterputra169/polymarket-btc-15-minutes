import { describe, it, expect } from 'vitest';
import { emptyFeedGuardState, evaluateFeedTransitions, type FeedInput } from '../feedGuard.ts';

const base: FeedInput = {
  now: 1_000_000, slug: 'm1', marketAgeSec: 30, ptbExact: true, ptbSource: 'chainlink_twap',
  twapMode: 'polybolt', twapConnected: true, twapLastTickAgeMs: 1_000, clobStatus: 'live',
};

describe('evaluateFeedTransitions', () => {
  it('alerts once after 120s + a 20s observation window', () => {
    let s = emptyFeedGuardState();
    let r = evaluateFeedTransitions(s, { ...base, now: 1_000_000, marketAgeSec: 60, ptbExact: false, slug: 'm1' });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_025_000, marketAgeSec: 125, ptbExact: false, slug: 'm1' });
    expect(r.alerts.map(a => a.kind)).toEqual(['ptb']);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_030_000, marketAgeSec: 130, ptbExact: false, slug: 'm1' });
    expect(r.alerts).toHaveLength(0);
  });

  it('does not alert on a mid-market restart before the observation window', () => {
    let s = emptyFeedGuardState();
    let r = evaluateFeedTransitions(s, { ...base, now: 1_000_000, marketAgeSec: 400, ptbExact: false, slug: 'm1' });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_010_000, marketAgeSec: 410, ptbExact: false, slug: 'm1' });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_021_000, marketAgeSec: 421, ptbExact: false, slug: 'm1' });
    expect(r.alerts.map(a => a.kind)).toEqual(['ptb']);
  });

  it('emits a recovery message after a PTB alert', () => {
    let s = emptyFeedGuardState();
    let r = evaluateFeedTransitions(s, { ...base, now: 1_000_000, marketAgeSec: 125, ptbExact: false });
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_021_000, marketAgeSec: 146, ptbExact: false });
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 1_022_000, marketAgeSec: 147, ptbExact: true });
    expect(r.alerts[0]).toMatchObject({ kind: 'ptb', level: 'info' });
  });

  it('resets the PTB alert when the market changes', () => {
    let s = evaluateFeedTransitions(emptyFeedGuardState(), { ...base, slug: 'm1', marketAgeSec: 125, ptbExact: false }).state;
    const r = evaluateFeedTransitions(s, { ...base, slug: 'm2', marketAgeSec: 5, ptbExact: false });
    expect(r.alerts).toHaveLength(0);
  });

  it('waits 60s before alerting on a disconnected PolyBolt feed, then recovers', () => {
    let s = emptyFeedGuardState();
    let r = evaluateFeedTransitions(s, { ...base, now: 10_000, twapConnected: false });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 40_000, twapConnected: false });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 71_000, twapConnected: false });
    expect(r.alerts[0]).toMatchObject({ kind: 'twap', level: 'warn' });
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, now: 80_000, twapConnected: true });
    expect(r.alerts[0]).toMatchObject({ kind: 'twap', level: 'info' });
  });

  it('treats a stale tick as bad even while connected', () => {
    const r = evaluateFeedTransitions(emptyFeedGuardState(), { ...base, twapLastTickAgeMs: 95_000, now: 10_000 });
    expect(r.alerts).toHaveLength(0);
    const r2 = evaluateFeedTransitions(r.state, { ...base, twapLastTickAgeMs: 95_000, now: 80_000 });
    expect(r2.alerts[0]).toMatchObject({ kind: 'twap', level: 'warn' });
  });

  it('alerts on a CLOB book down >60s and ignores quiet', () => {
    let s = emptyFeedGuardState();
    let r = evaluateFeedTransitions(s, { ...base, clobStatus: 'quiet', now: 5_000 });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, clobStatus: 'down', now: 10_000 });
    expect(r.alerts).toHaveLength(0);
    s = r.state;
    r = evaluateFeedTransitions(s, { ...base, clobStatus: 'down', now: 80_000 });
    expect(r.alerts[0]).toMatchObject({ kind: 'clob', level: 'warn' });
  });
});
