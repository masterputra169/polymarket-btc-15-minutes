import React, { memo } from 'react';
import { formatProbPct } from '../utils.ts';
import { ML_CONFIDENCE } from '../config.ts';

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
    regimeInfo?.regime === 'trending'
      ? regimeInfo?.label?.includes('UP') ? 'c-green' : 'c-red'
      : regimeInfo?.regime === 'choppy'
        ? 'c-red'
        : regimeInfo?.regime === 'moderate'
          ? 'c-green'
          : 'c-yellow';

  // Signal quality banner
  const isEnter = rec?.action === 'ENTER';
  const confidence = rec?.confidence ?? 'NONE';
  const isStrong = confidence === 'VERY_HIGH' || confidence === 'HIGH';
  const isModerate = confidence === 'MEDIUM';

  const bannerText = isEnter
    ? isStrong ? 'STRONG SIGNAL' : isModerate ? 'MODERATE SIGNAL' : 'WEAK SIGNAL'
    : 'NO TRADE';
  const bannerVariant = !isEnter
    ? ''
    : rec?.side === 'DOWN'
      ? 'qt-banner--down'
      : isStrong
        ? 'qt-banner--up'
        : 'qt-banner--warn';
  const bannerColor = !isEnter
    ? 'var(--text-dim)'
    : rec?.side === 'DOWN'
      ? 'var(--red-bright)'
      : isStrong
        ? 'var(--green-bright)'
        : 'var(--yellow-bright)';

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

  const hurst = regimeInfo?.hurst;
  const halfLife = regimeInfo?.halfLife;
  const hurstColor = hurst != null
    ? hurst >= 0.55 ? 'var(--green-bright)' : hurst <= 0.45 ? 'var(--yellow-bright)' : 'var(--accent-cyan)'
    : 'var(--text-dim)';

  return (
    <div className={`card ${cardGlow}`} style={{ animationDelay: '0.15s' }}>
      <div className="card__header">
        <span className="card__title">🎯 Prediction</span>
        {isEnter && (
          <span className={`qt-badge ${rec.side === 'UP' ? 'qt-badge--green' : 'qt-badge--red'}`}>
            {confidence}
          </span>
        )}
      </div>

      {/* Signal Quality Banner */}
      <div
        className={`qt-banner ${bannerVariant}`}
        style={{
          marginBottom: 12,
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 3,
        }}
      >
        <div style={{ fontSize: '0.84rem', fontWeight: 700, color: bannerColor, letterSpacing: '0.08em' }}>
          {bannerText}
        </div>
        {isEnter && (
          <div className="qt-kicker" style={{ color: 'var(--text-muted)' }}>
            {rec.side} {mlConfLabel ? `· ML ${mlConfLabel}` : ''}
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

      {/* Quant Regime Telemetry */}
      <div className="qt-stat-grid" style={{ marginTop: 12, marginBottom: 10 }}>
        <div className="qt-stat-box">
          <span className="qt-stat-box__label">Regime</span>
          <span className={`qt-stat-box__val ${regimeColor}`} style={{ fontSize: '0.78rem', textTransform: 'uppercase' }}>
            {regimeInfo?.regime ?? '-'}
          </span>
          <span className="qt-stat-box__sub">{regimeInfo?.confidence != null ? `${Math.round(regimeInfo.confidence * 100)}% conf` : '—'}</span>
        </div>
        <div className="qt-stat-box">
          <span className="qt-stat-box__label">Hurst H</span>
          <span className="qt-stat-box__val" style={{ color: hurstColor, fontSize: '0.84rem' }}>
            {hurst != null && Number.isFinite(hurst) ? hurst.toFixed(2) : '-'}
          </span>
          <span className="qt-stat-box__sub">
            {hurst == null ? '—' : hurst >= 0.55 ? 'persistent' : hurst <= 0.45 ? 'mean-rev' : 'random'}
          </span>
        </div>
        <div className="qt-stat-box">
          <span className="qt-stat-box__label">Half-Life t½</span>
          <span className="qt-stat-box__val" style={{ fontSize: '0.84rem', color: 'var(--accent-cyan)' }}>
            {halfLife != null ? (Number.isFinite(halfLife) ? halfLife.toFixed(1) : '∞') : '-'}
          </span>
          <span className="qt-stat-box__sub">OU reversion</span>
        </div>
      </div>

      <div className="qt-panel-section">
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
    a.regimeInfo?.label === b.regimeInfo?.label &&
    a.regimeInfo?.hurst === b.regimeInfo?.hurst &&
    a.regimeInfo?.halfLife === b.regimeInfo?.halfLife &&
    a.rec?.action === b.rec?.action &&
    a.rec?.side === b.rec?.side &&
    a.rec?.confidence === b.rec?.confidence &&
    a.rec?.phase === b.rec?.phase &&
    a.rec?.edge === b.rec?.edge &&
    a.rec?.reason === b.rec?.reason &&
    a.ml?.confidence === b.ml?.confidence
  );
});
