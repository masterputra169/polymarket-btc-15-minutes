import { describe, it, expect } from 'vitest';
import { tradeEntryAlert, startupAlert, feedAlertMessage, entryAnomalyAlert, escapeHtml, fmtUsd } from '../alertTemplates.ts';

describe('alert templates', () => {
  it('escapes HTML in dynamic values', () => {
    expect(escapeHtml('<b>x & y</b>')).toBe('&lt;b&gt;x &amp; y&lt;/b&gt;');
    expect(fmtUsd(-12.5)).toBe('-$12.50');
  });

  it('formats a dry trade entry with all context and a market link', () => {
    const text = tradeEntryAlert({
      dryRun: true, side: 'DOWN', price: 0.63, shares: 5, cost: 3.15,
      edge: 0.08, mlConfidence: 0.72, mlSide: 'DOWN',
      jevSummary: 'JEV: DOWN 70% | settle 30% | trending_down',
      bankroll: 25.36, phase: 'MID', timeLeftMin: 7.5, regime: 'trending',
      smartFlow: 'SELL', marketSlug: 'btc-updown-15m-1',
    });
    expect(text).toContain('DRY ENTRY');
    expect(text).toContain('DOWN');
    expect(text).toContain('63.0c');
    expect(text).toContain('5 shares');
    expect(text).toContain('JEV: DOWN 70%');
    expect(text).toContain('MID');
    expect(text).toContain('View Market');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('₿ BTC');
  });

  it('includes BTC price, PTB, and signed delta when provided', () => {
    const withPtb = tradeEntryAlert({
      dryRun: true, side: 'UP', price: 0.60, shares: 5, cost: 3.00,
      btcPrice: 63_873.00, priceToBeat: 63_672.88,
      edge: 0.291, mlConfidence: 0.86, mlSide: 'UP',
      jevSummary: null, bankroll: 105.93, marketSlug: 'btc-updown-15m-1',
    });
    expect(withPtb).toContain('₿ BTC <b>$63,873.00</b> (PTB $63,672.88, +$200.12)');

    const withoutPtb = tradeEntryAlert({
      dryRun: false, side: 'DOWN', price: 0.62, shares: 5, cost: 3.10,
      btcPrice: 63_500.50, priceToBeat: null,
      edge: 0.08, mlConfidence: 0.70, mlSide: 'DOWN',
      jevSummary: null, bankroll: 100, marketSlug: null,
    });
    expect(withoutPtb).toContain('₿ BTC <b>$63,500.50</b>');
    expect(withoutPtb).not.toContain('PTB ');
  });

  it('formats a live entry without dry prefix', () => {
    const text = tradeEntryAlert({
      dryRun: false, side: 'UP', price: 0.55, shares: 5, cost: 2.75,
      edge: null, mlConfidence: null, mlSide: null, jevSummary: null,
      bankroll: 25, marketSlug: null,
    });
    expect(text).toContain('ENTRY');
    expect(text).not.toContain('DRY');
    expect(text).toContain('ML off');
  });

  it('formats startup and feed alerts', () => {
    const start = startupAlert({
      dryRun: true, bankroll: 25.36, jevMode: 'veto', jevProvider: 'openrouter',
      twapMode: 'polybolt', clobV2: false, modelId: '20260924-p2-0d88d4',
    });
    expect(start).toContain('DRY RUN');
    expect(start).toContain('veto');
    expect(start).toContain('polybolt');
    expect(feedAlertMessage({ kind: 'twap', level: 'warn', detail: 'disconnected', slug: 'm1' }))
      .toContain('Chainlink TWAP feed');
    expect(feedAlertMessage({ kind: 'ptb', level: 'info', detail: 'exact', slug: 'm1' }))
      .toContain('recovered');
  });

  it('formats entry anomaly alerts with escaped HTML and BTC/PTB context', () => {
    const msg = entryAnomalyAlert({
      dryRun: false,
      code: 'extreme_z_cheap_price',
      side: 'UP',
      price: 0.60,
      reason: 'z >= 4.0 & stale <book>',
      btcPrice: 63_873,
      priceToBeat: 63_672.88,
      marketSlug: 'btc-updown-15m-1795095900',
    });
    expect(msg).toContain('ENTRY BLOCKED (INVARIANT)');
    expect(msg).toContain('[LIVE]');
    expect(msg).toContain('extreme_z_cheap_price');
    expect(msg).toContain('60.0c');
    expect(msg).toContain('z &gt;= 4.0 &amp; stale &lt;book&gt;');
    expect(msg).toContain('₿ BTC <b>$63,873.00</b> (PTB $63,672.88, +$200.12)');
    expect(msg).toContain('View Market');
  });

  it('shows maker fill wait, decision-time ML, and fill-time ML drift only when >= 5pp', () => {
    const drifted = tradeEntryAlert({
      dryRun: true, side: 'UP', price: 0.64, shares: 5, cost: 3.20,
      edge: 0.141, mlConfidence: 0.32, mlSide: 'UP', fillMlConfidence: 0.18,
      fillModel: 'maker_join', timeToFillMs: 6400,
      jevSummary: 'JEV: DOWN 82% | settle 42% | mean_reverting | risk 68% [veto off: brierGuard] (61s ago)',
      bankroll: 112.90, phase: 'EARLY', timeLeftMin: 13.2, regime: 'trending',
    });
    expect(drifted).toContain('5 shares</b> · $3.20 · maker 6.4s');
    expect(drifted).toContain('🤖 ML <b>32%</b> (UP) (fill 18%)');
    expect(drifted).toContain('[veto off: brierGuard] (61s ago)');

    const steady = tradeEntryAlert({
      dryRun: true, side: 'UP', price: 0.64, shares: 5, cost: 3.20,
      edge: 0.14, mlConfidence: 0.32, mlSide: 'UP', fillMlConfidence: 0.30,
      fillModel: 'maker_join', timeToFillMs: 2500, jevSummary: null, bankroll: 112.90,
    });
    expect(steady).toContain('maker 2.5s');
    expect(steady).not.toContain('(fill ');
  });
});
