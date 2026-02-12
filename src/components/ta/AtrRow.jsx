import React from 'react';
import { rowClass } from './signalUtils.js';
import { formatNumber } from '../../utils.js';

export default function AtrRow({ atr }) {
  if (!atr) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">ATR</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { atr: atrVal, atrPct, atrRatio, expanding } = atr;
  const ratio = atrRatio ?? 1;
  const narrative = expanding ? 'SHORT' : ratio < 0.8 ? 'LONG' : 'NEUTRAL';

  const ratioLabel = ratio > 1.2
    ? '\u2191 HIGH'
    : ratio < 0.8
      ? '\u2193 LOW'
      : '\u2192 NORMAL';

  const ratioColor = ratio > 1.2
    ? 'c-red'
    : ratio < 0.8
      ? 'c-cyan'
      : 'c-muted';

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">ATR</span>
      <span className="ta-signal-row__value">
        <span style={{ color: 'var(--text-primary)' }}>
          ${formatNumber(atrVal, 0)}
        </span>
        <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>
          ({(atrPct ?? 0).toFixed(2)}%)
        </span>
        <span className={ratioColor} style={{ fontWeight: 600, fontSize: '0.68rem' }}>
          {ratioLabel}
        </span>
      </span>
    </div>
  );
}
