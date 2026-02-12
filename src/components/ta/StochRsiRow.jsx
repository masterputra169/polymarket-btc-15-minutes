import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function StochRsiRow({ stochRsi }) {
  if (!stochRsi) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">StochRSI</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { k, d, cross, overbought, oversold, signal } = stochRsi;
  const narrative = overbought ? 'SHORT' : oversold ? 'LONG' : signal;

  const zoneLabel = overbought ? ' OB' : oversold ? ' OS' : '';
  const crossLabel = cross === 'BULL_CROSS' ? ' \u2191X' : cross === 'BEAR_CROSS' ? ' \u2193X' : '';

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">StochRSI</span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>
        K: {(k ?? 0).toFixed(0)} | D: {(d ?? 0).toFixed(0)}{zoneLabel}{crossLabel}
      </span>
    </div>
  );
}
