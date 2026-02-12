import React from 'react';
import { rowClass, colorClass } from './signalUtils.js';

export default function SignalRow({ name, value, narrative }) {
  return (
    <div className={`ta-signal-row ${rowClass(narrative)}`}>
      <span className="ta-signal-row__name">{name}</span>
      <span className={`ta-signal-row__value ${colorClass(narrative)}`}>{value}</span>
    </div>
  );
}
