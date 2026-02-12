import React, { memo } from 'react';
import { formatProbPct } from '../utils.js';
import { ML_CONFIDENCE } from '../config.js';

function PredictPanel({ data }) {
  if (!data) return null;

  const { pLong, pShort, regimeInfo, rec, ml } = data;

  const longPct = pLong !== null ? Math.round(pLong * 100) : 50;
  const shortPct = pShort !== null ? Math.round(pShort * 100) : 50;

  const predictNarrative =
    pLong !== null && pShort !== null
      ? pLong > pShort
        ? 'LONG'
        : pShort > pLong
          ? 'SHORT'
          : 'NEUTRAL'
      : 'NEUTRAL';

  const cardGlow =
    predictNarrative === 'LONG'
      ? 'card--glow-green'
      : predictNarrative === 'SHORT'
        ? 'card--glow-red'
        : '';

  const regimeColor =
    regimeInfo?.regime === 'TREND_UP'
      ? 'c-green'
      : regimeInfo?.regime === 'TREND_DOWN'
        ? 'c-red'
        : 'c-yellow';

  // Signal quality banner
  const isEnter = rec?.action === 'ENTER';
  const confidence = rec?.confidence ?? 'NONE';
  const isStrong = confidence === 'VERY_HIGH' || confidence === 'HIGH';
  const isModerate = confidence === 'MEDIUM';

  const bannerText = isEnter
    ? isStrong ? 'STRONG SIGNAL' : isModerate ? 'MODERATE SIGNAL' : 'WEAK SIGNAL'
    : 'NO TRADE';
  const bannerBg = isEnter
    ? isStrong
      ? 'linear-gradient(90deg, rgba(0,230,118,0.15), rgba(0,230,118,0.05))'
      : isModerate
        ? 'linear-gradient(90deg, rgba(255,193,7,0.15), rgba(255,193,7,0.05))'
        : 'linear-gradient(90deg, rgba(255,152,0,0.1), rgba(255,152,0,0.03))'
    : 'linear-gradient(90deg, rgba(150,150,150,0.08), rgba(150,150,150,0.02))';
  const bannerBorder = isEnter
    ? isStrong ? 'rgba(0,230,118,0.3)' : isModerate ? 'rgba(255,193,7,0.3)' : 'rgba(255,152,0,0.2)'
    : 'rgba(150,150,150,0.15)';
  const bannerColor = isEnter
    ? isStrong ? 'var(--green-bright)' : isModerate ? '#ffc107' : '#ff9800'
    : 'var(--text-dim)';

  const signalText =
    isEnter
      ? rec.side === 'UP'
        ? 'BUY UP'
        : 'BUY DOWN'
      : 'WAIT';
  const signalColor =
    isEnter
      ? rec.side === 'UP'
        ? 'c-green'
        : 'c-red'
      : 'c-muted';

  // ML confidence tier label
  const mlConf = ml?.confidence;
  const mlConfLabel = mlConf !== null && mlConf !== undefined
    ? mlConf >= ML_CONFIDENCE.HIGH ? 'HIGH' : mlConf >= ML_CONFIDENCE.MEDIUM ? 'MED' : 'LOW'
    : null;

  return (
    <div className={`card ${cardGlow}`} style={{ animationDelay: '0.15s' }}>
      <div className="card__header">
        <span className="card__title">🎯 Prediction</span>
        {isEnter && (
          <span
            className="card__badge"
            style={{
              background: rec.side === 'UP' ? 'var(--green-bg)' : 'var(--red-bg)',
              color: rec.side === 'UP' ? 'var(--green-bright)' : 'var(--red-bright)',
              border: `1px solid ${rec.side === 'UP' ? 'rgba(0,230,118,0.2)' : 'rgba(255,82,82,0.2)'}`,
            }}
          >
            {confidence}
          </span>
        )}
      </div>

      {/* Signal Quality Banner */}
      <div
        style={{
          background: bannerBg,
          border: `1px solid ${bannerBorder}`,
          borderRadius: 'var(--radius-sm)',
          padding: '8px 12px',
          marginBottom: 12,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: bannerColor, letterSpacing: '0.08em' }}>
          {bannerText}
        </div>
        {isEnter && (
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 3 }}>
            {rec.side} {mlConfLabel ? `· ML: ${mlConfLabel}` : ''}
          </div>
        )}
      </div>

      <div className="prob-bar-container">
        <div className="prob-bar">
          <div className="prob-bar__up" style={{ width: `${longPct}%` }}>
            ↑ {formatProbPct(pLong, 0)}
          </div>
          <div className="prob-bar__down" style={{ width: `${shortPct}%` }}>
            ↓ {formatProbPct(pShort, 0)}
          </div>
        </div>
        <div className="prob-labels">
          <span>LONG</span>
          <span>SHORT</span>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <div className="data-row">
          <span className="data-row__label">Regime</span>
          <span className={`data-row__value ${regimeColor}`}>
            {regimeInfo?.regime ?? '-'}
          </span>
        </div>
        <div className="data-row">
          <span className="data-row__label">Phase</span>
          <span className="data-row__value">{rec?.phase ?? '-'}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">Signal</span>
          <span className={`data-row__value ${signalColor}`} style={{ fontWeight: 600 }}>
            {signalText}
          </span>
        </div>
        {rec?.edge !== undefined && rec.edge !== null && (
          <div className="data-row">
            <span className="data-row__label">Edge</span>
            <span className="data-row__value">
              {(rec.edge * 100).toFixed(1)}%
            </span>
          </div>
        )}
        {!isEnter && rec?.reason && (
          <div className="data-row">
            <span className="data-row__label">Reason</span>
            <span className="data-row__value" style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
              {rec.reason}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Only re-render when prediction-specific fields change
export default memo(PredictPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.pLong === b.pLong &&
    a.pShort === b.pShort &&
    a.regimeInfo?.regime === b.regimeInfo?.regime &&
    a.rec?.action === b.rec?.action &&
    a.rec?.side === b.rec?.side &&
    a.rec?.confidence === b.rec?.confidence &&
    a.rec?.phase === b.rec?.phase &&
    a.rec?.edge === b.rec?.edge &&
    a.rec?.reason === b.rec?.reason &&
    a.ml?.confidence === b.ml?.confidence
  );
});
