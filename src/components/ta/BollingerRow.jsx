import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function BollingerRow({ bb }) {
  if (!bb) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">BB</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { width, percentB, squeeze, squeezeIntensity } = bb;
  const narrative = percentB > 0.8 ? 'SHORT' : percentB < 0.2 ? 'LONG' : 'NEUTRAL';
  const widthPct = (width * 100).toFixed(2);
  const bPct = (percentB * 100).toFixed(0);

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">
        BB
        {squeeze && (
          <span
            style={{
              marginLeft: 6,
              fontSize: '0.58rem',
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(255,171,0,0.12)',
              color: 'var(--yellow-bright)',
              border: '1px solid rgba(255,171,0,0.25)',
              letterSpacing: '0.04em',
            }}
          >
            SQUEEZE {squeezeIntensity >= 0.5 ? '\uD83D\uDD25' : ''}
          </span>
        )}
      </span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>
        %B: {bPct}% | W: {widthPct}%
      </span>
    </div>
  );
}
