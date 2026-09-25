import React, { memo } from 'react';
import { describeTape, type TapeHourView, type TapeStatusMsg, type TapeTone } from './tapeStatusView.ts';

const TONE_COLOR: Record<TapeTone, string> = {
  ok: 'var(--green-bright)',
  warn: 'var(--yellow-bright)',
  down: 'var(--red-bright)',
};

const TONE_BADGE: Record<TapeTone, React.CSSProperties> = {
  ok: {},
  warn: { background: 'rgba(255,171,0,0.08)', color: 'var(--yellow-bright)', border: '1px solid rgba(255,171,0,0.25)' },
  down: {},
};

function HourBlock({ h }: { h: TapeHourView }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
        <span className="data-row__label">{h.label}</span>
        <span className="data-row__value" style={{ color: TONE_COLOR[h.liveBookTone], fontWeight: 600 }}
          title="Share of 1 Hz snapshots taken with a live book on both tokens">
          live book {h.liveBook}
        </span>
      </div>
      <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)' }}>{h.counts}</div>
      {h.stages.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
          title="Decision lines by the furthest stage their poll reached (one sampled poll per second, every entry)">
          {h.stages.map(s => (
            <span key={s.stage} style={{
              fontSize: '0.6rem', padding: '1px 6px', borderRadius: 3,
              background: 'var(--bg-elevated)',
              color: s.stage === 'entered' ? 'var(--green-bright)' : 'var(--text-secondary)',
              fontWeight: s.stage === 'entered' ? 700 : 500,
            }}>
              {s.stage} {s.count.toLocaleString('en-US')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TapePanel({ tape }: { tape: TapeStatusMsg | null }) {
  const v = describeTape(tape);
  if (!v) return null; // bot build without the tape status

  return (
    <div className="card span-2" style={{ animationDelay: '0.3s' }}>
      <div className="card__header">
        <span className="card__title">Market Tape</span>
        <span className={`card__badge ${v.tone === 'ok' ? 'badge--live' : v.tone === 'down' ? 'badge--offline' : ''}`}
          style={TONE_BADGE[v.tone]}>
          {v.badge}
        </span>
        {tape?.market && (
          <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: 'var(--text-muted)' }}>{tape.market}</span>
        )}
      </div>

      {v.problem && (
        <div role="status" style={{
          fontSize: '0.68rem', color: TONE_COLOR[v.tone], marginBottom: 8,
          padding: '4px 8px', borderRadius: 4, background: 'var(--bg-elevated)',
        }}>
          {v.problem}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        {v.hour && <HourBlock h={v.hour} />}
        {v.lastHour && <HourBlock h={v.lastHour} />}
      </div>

      <div style={{ marginTop: 8 }}>
        <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
          <span className="data-row__label">Bucket</span>
          <span className="data-row__value">{v.storage}</span>
        </div>
        <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
          <span className="data-row__label">Container</span>
          <span className="data-row__value">{v.local}</span>
        </div>
      </div>
    </div>
  );
}

// ═══ React.memo ═══
// The slice in App.tsx already changes only when a shown field does; compare
// the same fields so a new-but-equal object from a broadcast does not repaint.
export default memo(TapePanel, (prev, next) => {
  const a = prev.tape;
  const b = next.tape;
  if (a === b) return true;
  if (!a || !b) return false;
  return a.running === b.running && a.bookLive === b.bookLive && a.market === b.market
    && a.localFiles === b.localFiles && a.localBytes === b.localBytes && a.buffered === b.buffered
    && a.uploaded === b.uploaded && a.lastUploadError === b.lastUploadError && a.errors === b.errors
    && a.uploadsConfigured === b.uploadsConfigured
    && a.hour?.hour === b.hour?.hour && a.hour?.snapshots === b.hour?.snapshots && a.hour?.decisions === b.hour?.decisions
    && a.hour?.trades === b.hour?.trades && a.hour?.resyncs === b.hour?.resyncs && a.hour?.entered === b.hour?.entered
    && a.lastHour?.hour === b.lastHour?.hour;
});
