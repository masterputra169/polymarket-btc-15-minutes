import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function VolumeDeltaRow({ volDelta }) {
  if (!volDelta) {
    return (
      <div className="ta-signal-row ta-signal-row--neutral">
        <span className="ta-signal-row__name">Vol Delta</span>
        <span className="ta-signal-row__value c-muted">-</span>
      </div>
    );
  }

  const { buyRatio, netDeltaPct, deltaAccel, buyDominant } = volDelta;
  const narrative = buyDominant ? 'LONG' : buyRatio < 0.48 ? 'SHORT' : 'NEUTRAL';

  const buyPct = (buyRatio * 100).toFixed(1);
  const accelArrow = deltaAccel > 0.02 ? ' \u2B06' : deltaAccel < -0.02 ? ' \u2B07' : '';

  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">Vol Delta</span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>
        Buy: {buyPct}% | Net: {netDeltaPct > 0 ? '+' : ''}{netDeltaPct.toFixed(1)}%{accelArrow}
      </span>
    </div>
  );
}
