import { describe, it, expect } from 'vitest';
import { describeTape, formatBytes, LIVE_BOOK_WARN_PCT, type TapeStatusMsg } from '../tapeStatusView.ts';

// The tape fails quietly: a dropped book still writes ok:0 snapshots, and a
// failing upload only fills the container's disk. Neither changes a trade, so
// the panel is the one place an operator sees it — these tests pin what it says.

function status(over: Partial<TapeStatusMsg> = {}): TapeStatusMsg {
  return {
    running: true, market: 'btc-updown-15m-1790222400', bookLive: true, buffered: 120,
    localFiles: 1, localBytes: 250_000, uploaded: 12, uploadedBytes: 5_400_000,
    lastUploadError: null, errors: 0, uploadsConfigured: true,
    hour: { hour: '2026-09-25T14', snapshots: 1800, liveBookPct: 99.8, trades: 640, resyncs: 0, decisions: 1800, entered: 1, stages: { wait: 1700, filtered: 98, entered: 1, pre: 1 } },
    lastHour: null,
    ...over,
  };
}

describe('describeTape', () => {
  it('reads a healthy recorder as RECORDING with no problem line', () => {
    const v = describeTape(status())!;
    expect(v.tone).toBe('ok');
    expect(v.badge).toBe('RECORDING');
    expect(v.problem).toBeNull();
    expect(v.storage).toBe('12 files · 5.1 MB uploaded this run');
    expect(v.local).toBe('1 files · 244.1 KB on disk · 120 lines buffered');
  });

  it('shows the hour with its live-book share and the stage mix, entries first', () => {
    const h = describeTape(status())!.hour!;
    expect(h.label).toBe('This hour · 14:00 UTC');
    expect(h.liveBook).toBe('99.8%');
    expect(h.liveBookTone).toBe('ok');
    expect(h.counts).toBe('1,800 snaps · 640 trades · 1,800 decisions (1 entered)');
    expect(h.stages).toEqual([
      { stage: 'entered', count: 1 }, { stage: 'filtered', count: 98 }, { stage: 'pre', count: 1 }, { stage: 'wait', count: 1700 },
    ]);
  });

  it('flags an hour with too few live-book seconds to be good training data', () => {
    const hour = { ...status().hour!, liveBookPct: LIVE_BOOK_WARN_PCT - 0.1, resyncs: 2 };
    const h = describeTape(status({ hour }))!.hour!;
    expect(h.liveBookTone).toBe('warn');
    expect(h.liveBook).toBe('94.9% (low, < 95%)');
    expect(h.counts).toContain('2 resyncs');
    const poor = describeTape(status({ hour: { ...hour, liveBookPct: 30 } }))!.hour!;
    expect(poor.liveBookTone).toBe('down');
    expect(poor.liveBook).toBe('30.0% (poor)');
  });

  it('puts a failing upload ahead of everything else a running recorder can report', () => {
    const v = describeTape(status({ lastUploadError: 'PUT <store> → HTTP 403 AccessDenied', bookLive: false }))!;
    expect(v.tone).toBe('warn');
    expect(v.badge).toBe('UPLOAD ERROR');
    expect(v.problem).toContain('HTTP 403');
  });

  it('names a missing book and a missing bucket', () => {
    expect(describeTape(status({ bookLive: false }))!.badge).toBe('NO BOOK');
    const local = describeTape(status({ uploadsConfigured: false }))!;
    expect(local.badge).toBe('LOCAL ONLY');
    expect(local.storage).toBe('local only');
  });

  it('shows a stopped recorder as OFF, and nothing at all for a bot without the field', () => {
    const v = describeTape(status({ running: false, hour: null }))!;
    expect(v.tone).toBe('down');
    expect(v.badge).toBe('OFF');
    expect(v.hour).toBeNull();
    expect(describeTape(undefined)).toBeNull();
    expect(describeTape(null)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('scales', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(11 * 1024 * 1024)).toBe('11.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
    expect(formatBytes(-1)).toBe('—');
  });
});

describe('TapePanel', () => {
  it('renders the badge, the problem line and both hours; nothing without a status', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { default: TapePanel } = await import('../TapePanel.tsx');
    const html = renderToStaticMarkup(createElement(TapePanel, {
      tape: status({ lastUploadError: 'HTTP 503', lastHour: { ...status().hour!, hour: '2026-09-25T13' } }),
    }));
    expect(html).toContain('Market Tape');
    expect(html).toContain('UPLOAD ERROR');
    expect(html).toContain('Upload failing: HTTP 503');
    expect(html).toContain('This hour · 14:00 UTC');
    expect(html).toContain('Last hour · 13:00 UTC');
    expect(renderToStaticMarkup(createElement(TapePanel, { tape: null }))).toBe('');
  });
});
