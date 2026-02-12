import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function FundingRateRow({ fundingRate }) {
  if (!fundingRate) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">Funding</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { ratePct, extreme, sentiment } = fundingRate;
  const narrative = sentiment === 'BULLISH' ? 'LONG' : sentiment === 'BEARISH' ? 'SHORT' : 'NEUTRAL';

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">
        Funding
        {extreme && (
          <span
            style={{
              marginLeft: 6,
              fontSize: '0.58rem',
              fontWeight: 700,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(255,82,82,0.12)',
              color: 'var(--red-bright)',
              border: '1px solid rgba(255,82,82,0.25)',
              letterSpacing: '0.04em',
            }}
          >
            EXTREME
          </span>
        )}
      </span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>
        {(ratePct ?? 0) >= 0 ? '+' : ''}{(ratePct ?? 0).toFixed(4)}%
        <span style={{ color: 'var(--text-dim)', marginLeft: 4, fontSize: '0.65rem' }}>
          ({(sentiment ?? 'NEUTRAL').toLowerCase()})
        </span>
      </span>
    </div>
  );
}
