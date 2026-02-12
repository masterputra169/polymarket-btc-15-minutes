import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function EmaCrossRow({ emaCross }) {
  if (!emaCross) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">EMA 8/21</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { distancePct, cross, bullish, crossBars } = emaCross;
  const narrative = bullish ? 'LONG' : 'SHORT';
  const hasCross = cross !== 'NONE';

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">
        EMA 8/21
        {hasCross && (
          <span
            style={{
              marginLeft: 6,
              fontSize: '0.58rem',
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: cross === 'BULL_CROSS' ? 'rgba(0,230,118,0.12)' : 'rgba(255,82,82,0.12)',
              color: cross === 'BULL_CROSS' ? 'var(--green-bright)' : 'var(--red-bright)',
              border: `1px solid ${cross === 'BULL_CROSS' ? 'rgba(0,230,118,0.25)' : 'rgba(255,82,82,0.25)'}`,
              letterSpacing: '0.04em',
            }}
          >
            {cross === 'BULL_CROSS' ? '\u2726 CROSS \u2191' : '\u2726 CROSS \u2193'}
          </span>
        )}
      </span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>
        {bullish ? '\u2191' : '\u2193'} {distancePct > 0 ? '+' : ''}{distancePct.toFixed(3)}%
        {crossBars < 5 && <span style={{ color: 'var(--text-dim)', marginLeft: 4, fontSize: '0.65rem' }}>({crossBars}b ago)</span>}
      </span>
    </div>
  );
}
