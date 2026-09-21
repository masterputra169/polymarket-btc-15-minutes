import { describe, it, expect } from 'vitest';
import { describeClobSource } from '../clobSourceLabel.ts';

// The panel used to show two states, WebSocket or REST Poll, derived from a
// rule that called a quiet book stale. So an operator watching the dashboard
// saw "🔄 REST Poll" flicker in and out with no way to tell whether the stream
// had actually broken or the 15-minute market simply had nothing trading.
//
// Three states answer that: live, quiet-but-proven-alive, and genuinely down.
// A `down` label now means something is wrong and is worth acting on.

describe('describeClobSource', () => {
  it('shows a live feed as WebSocket', () => {
    const label = describeClobSource({ clobStatus: 'live', clobQuietMs: 300 });
    expect(label.text).toBe('⚡ WebSocket');
    expect(label.tone).toBe('live');
  });

  it('shows a quiet feed as alive, with how long the book has not moved', () => {
    const label = describeClobSource({ clobStatus: 'quiet', clobQuietMs: 22_400 });
    expect(label.text).toBe('🟡 WebSocket · quiet 22s');
    expect(label.tone, 'quiet is not a fallback — it is still the live book').toBe('quiet');
  });

  it('shows a down feed as the REST fallback it actually is', () => {
    const label = describeClobSource({ clobStatus: 'down', clobQuietMs: null });
    expect(label.text).toBe('🔄 REST Poll');
    expect(label.tone).toBe('down');
  });

  it('names the reason a down feed is down when the bot reports one', () => {
    // 'no_book' during a rollover and 'link_silent' on a broken stream are very
    // different problems; the panel should not make the operator guess.
    expect(describeClobSource({ clobStatus: 'down', clobDownReason: 'no_book' }).detail)
      .toBe('waiting for book');
    expect(describeClobSource({ clobStatus: 'down', clobDownReason: 'link_silent' }).detail)
      .toBe('stream silent');
  });

  it('omits the quiet duration rather than inventing one', () => {
    const label = describeClobSource({ clobStatus: 'quiet', clobQuietMs: null });
    expect(label.text).toBe('🟡 WebSocket');
  });

  it('gives the header pill a short label and a matching dot', () => {
    // The header pill and the panel row were reading different signals: the
    // pill showed raw socket-connected, so it stayed green during `no_book`
    // right after a rollover while the panel correctly said REST Poll. One
    // formatter, one verdict, so the two can no longer contradict each other.
    const live = describeClobSource({ clobStatus: 'live' });
    expect(live.short).toBe('CLOB WS');
    expect(live.dotClass).toBe('');

    const quiet = describeClobSource({ clobStatus: 'quiet', clobQuietMs: 30_000 });
    expect(quiet.short).toBe('CLOB WS·q');
    expect(quiet.dotClass).toBe('status-dot--warning');

    const down = describeClobSource({ clobStatus: 'down' });
    expect(down.short).toBe('CLOB REST');
    expect(down.dotClass).toBe('status-dot--error');
  });

  it('falls back to the old two-state field when the bot predates clobStatus', () => {
    // A dashboard build can reach a bot that has not been redeployed yet.
    expect(describeClobSource({ clobSource: 'WebSocket' }).tone).toBe('live');
    expect(describeClobSource({ clobSource: 'REST' }).tone).toBe('down');
    expect(describeClobSource({}).tone).toBe('down');
  });
});
