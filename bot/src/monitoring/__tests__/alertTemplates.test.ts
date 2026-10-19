import { describe, it, expect } from 'vitest';
import { tradeEntryAlert, startupAlert, feedAlertMessage, escapeHtml, fmtUsd } from '../alertTemplates.ts';

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
});
