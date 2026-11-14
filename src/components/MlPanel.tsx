import React, { memo } from 'react';
import { formatProbPct } from '../utils.ts';
import { ML_CONFIDENCE } from '../config.ts';

function MLPanel({ data }) {
  if (!data) return null;

  const { ml, pLong, pShort, rawUp, ruleUp } = data;
  const mlReady = ml?.status === 'ready';

  // ML values
  const mlProbUp = ml?.probUp;
  const mlConfidence = ml?.confidence;
  const mlSide = ml?.side;
  const ensembleProbUp = ml?.ensembleProbUp;
  const alpha = ml?.alpha;
  const source = ml?.source;

  // Rule-based values (use ruleUp, NOT pLong which is now ensemble)
  const ruleProbUp = ruleUp ?? pLong;

  // Ensemble direction
  const ensembleSide = ensembleProbUp !== null && ensembleProbUp !== undefined
    ? ensembleProbUp >= 0.5 ? 'UP' : 'DOWN'
    : null;

  // Agreement check
  const ruleAgreesWithMl =
    mlSide && ruleProbUp !== null
      ? (mlSide === 'UP' && ruleProbUp >= 0.5) || (mlSide === 'DOWN' && ruleProbUp < 0.5)
      : null;

  // Confidence tier
  const getConfTier = (conf) => {
    if (conf === null || conf === undefined) return { label: '-', color: 'c-muted' };
    if (conf >= ML_CONFIDENCE.HIGH) return { label: 'HIGH', color: 'c-green' };
    if (conf >= ML_CONFIDENCE.MEDIUM) return { label: 'MEDIUM', color: 'c-yellow' };
    return { label: 'LOW', color: 'c-red' };
  };

  const mlConfTier = getConfTier(mlConfidence);
  const isHighConfidence = mlConfidence !== null && mlConfidence >= ML_CONFIDENCE.HIGH;

  // Alpha bar width (use != null to catch both null and undefined)
  const alphaBarPct = alpha != null ? Math.round(alpha * 100) : 0;

  // Status badge
  const statusBadge = mlReady
    ? { text: 'ACTIVE', cls: 'badge--live' }
    : ml?.status === 'loading'
      ? { text: 'LOADING', cls: 'badge--loading' }
      : ml?.status === 'error'
        ? { text: 'ERROR', cls: 'badge--offline' }
        : { text: 'OFF', cls: 'badge--offline' };

  return (
    <div
      className={`card${mlReady && isHighConfidence ? ' card--glow-cyan' : ''}`}
      style={{ animationDelay: '0.28s' }}
    >
      <div className="card__header">
        <span className="card__title">🧠 ML Engine</span>
        <span className={`card__badge ${statusBadge.cls}`}>
          {statusBadge.text}
        </span>
      </div>

      {mlReady && isHighConfidence && (
        <div className="ml-high-conf-banner" style={{ marginBottom: 10 }}>
          HIGH CONFIDENCE — {mlSide === 'UP' ? '\u2191 LONG' : '\u2193 SHORT'}
        </div>
      )}

      {!mlReady && (
        <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-dim)' }}>
          {ml?.status === 'loading' ? (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>⏳</div>
              Loading XGBoost model...
            </>
          ) : ml?.status === 'error' ? (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>⚠️</div>
              Model load failed
              <br />
              <span style={{ fontSize: '0.68rem' }}>Running rule-based only</span>
            </>
          ) : (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>📦</div>
              ML model not loaded
              <br />
              <span style={{ fontSize: '0.68rem' }}>Place model files in /public/ml/</span>
            </>
          )}
        </div>
      )}

      {mlReady && (
        <>
          {/* ML Prediction vs Ensemble Stat Boxes */}
          <div className="qt-stat-grid" style={{ marginBottom: 12 }}>
            <div className="qt-stat-box" style={{ textAlign: 'center', alignItems: 'center' }}>
              <span className="qt-stat-box__label">ML P(UP)</span>
              <span
                className={`qt-stat-box__val ${mlSide === 'UP' ? 'c-green' : mlSide === 'DOWN' ? 'c-red' : ''}`}
                style={{ fontSize: '1.15rem', marginTop: 2 }}
              >
                {formatProbPct(mlProbUp, 1)}
              </span>
              <span className={`qt-badge ${mlSide === 'UP' ? 'qt-badge--green' : mlSide === 'DOWN' ? 'qt-badge--red' : 'qt-badge--muted'}`} style={{ marginTop: 3 }}>
                {mlSide === 'UP' ? '↑ LONG' : mlSide === 'DOWN' ? '↓ SHORT' : 'NEUTRAL'}
              </span>
            </div>

            <div
              className="qt-stat-box"
              style={{
                textAlign: 'center',
                alignItems: 'center',
                borderColor: ensembleSide === 'UP'
                  ? 'rgba(52, 211, 153, 0.28)'
                  : ensembleSide === 'DOWN'
                    ? 'rgba(251, 113, 133, 0.28)'
                    : undefined,
              }}
            >
              <span className="qt-stat-box__label">Ensemble Blend</span>
              <span
                className={`qt-stat-box__val ${ensembleSide === 'UP' ? 'c-green' : ensembleSide === 'DOWN' ? 'c-red' : ''}`}
                style={{ fontSize: '1.15rem', marginTop: 2 }}
              >
                {formatProbPct(ensembleProbUp, 1)}
              </span>
              <span className={`qt-badge ${ensembleSide === 'UP' ? 'qt-badge--green' : ensembleSide === 'DOWN' ? 'qt-badge--red' : 'qt-badge--muted'}`} style={{ marginTop: 3 }}>
                {ensembleSide === 'UP' ? '↑ LONG' : ensembleSide === 'DOWN' ? '↓ SHORT' : 'NEUTRAL'}
              </span>
            </div>
          </div>

          {/* Rule vs ML Comparison Section */}
          <div className="qt-panel-section qt-panel-section--accent" style={{ marginBottom: 10 }}>
            <div className="qt-kicker" style={{ marginBottom: 7 }}>
              Rule vs ML Distribution
            </div>

            {/* Rule bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', width: 34, flexShrink: 0, fontWeight: 600 }}>
                Rule
              </span>
              <div
                style={{
                  flex: 1,
                  height: 15,
                  background: 'rgba(4, 8, 16, 0.72)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                  border: '1px solid var(--border-dim)',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.round((ruleProbUp ?? 0.5) * 100)}%`,
                    background: (ruleProbUp ?? 0.5) >= 0.5
                      ? 'linear-gradient(90deg, rgba(16,185,129,0.45), rgba(52,211,153,0.75))'
                      : 'linear-gradient(90deg, rgba(244,63,94,0.45), rgba(251,113,133,0.75))',
                    transition: 'width 0.5s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    color: '#fff',
                    zIndex: 1,
                  }}
                >
                  {formatProbPct(ruleProbUp, 1)}
                </span>
              </div>
            </div>

            {/* ML bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.66rem', color: 'var(--accent-cyan)', width: 34, flexShrink: 0, fontWeight: 700 }}>
                ML
              </span>
              <div
                style={{
                  flex: 1,
                  height: 15,
                  background: 'rgba(4, 8, 16, 0.72)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                  border: '1px solid var(--border-dim)',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.round((mlProbUp ?? 0.5) * 100)}%`,
                    background: (mlProbUp ?? 0.5) >= 0.5
                      ? 'linear-gradient(90deg, rgba(6,182,212,0.4), rgba(34,211,238,0.8))'
                      : 'linear-gradient(90deg, rgba(139,92,246,0.4), rgba(167,139,250,0.8))',
                    transition: 'width 0.5s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    color: '#fff',
                    zIndex: 1,
                  }}
                >
                  {formatProbPct(mlProbUp, 1)}
                </span>
              </div>
            </div>
          </div>

          {/* Model Telemetry Rows */}
          <div className="qt-panel-section">
            <div className="data-row">
              <span className="data-row__label">ML Confidence</span>
              <span className={`data-row__value ${mlConfTier.color}`} style={{ fontWeight: 600 }}>
                {mlConfidence != null ? `${(mlConfidence * 100).toFixed(1)}%` : '-'}{' '}
                <span className={`qt-badge ${mlConfTier.label === 'HIGH' ? 'qt-badge--green' : mlConfTier.label === 'MEDIUM' ? 'qt-badge--amber' : 'qt-badge--muted'}`}>
                  {mlConfTier.label}
                </span>
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Agreement</span>
              <span
                className={`data-row__value ${
                  ruleAgreesWithMl === true
                    ? 'c-green'
                    : ruleAgreesWithMl === false
                      ? 'c-red'
                      : 'c-muted'
                }`}
                style={{ fontWeight: 600 }}
              >
                {ruleAgreesWithMl === true
                  ? '✓ Rule + ML Agree'
                  : ruleAgreesWithMl === false
                    ? '✗ Conflict'
                    : '-'}
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Blend Weight (α)</span>
              <span className="data-row__value">
                <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>
                  ML {alphaBarPct}%
                </span>
                <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>|</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Rule {100 - alphaBarPct}%
                </span>
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Strategy</span>
              <span className="data-row__value" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {source ?? '-'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══ React.memo with custom comparator ═══
// Only re-render when ML-specific fields change
export default memo(MLPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.ml?.probUp === b.ml?.probUp &&
    a.ml?.confidence === b.ml?.confidence &&
    a.ml?.side === b.ml?.side &&
    a.ml?.ensembleProbUp === b.ml?.ensembleProbUp &&
    a.ml?.alpha === b.ml?.alpha &&
    a.ml?.source === b.ml?.source &&
    a.ml?.status === b.ml?.status &&
    a.pLong === b.pLong &&
    a.pShort === b.pShort &&
    a.ruleUp === b.ruleUp
  );
});