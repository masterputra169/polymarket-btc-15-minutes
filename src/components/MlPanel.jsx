import React, { memo } from 'react';
import { formatProbPct } from '../utils.js';
import { ML_CONFIDENCE } from '../config.js';

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
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(0,229,255,0.12), rgba(0,229,255,0.03))',
            border: '1px solid rgba(0,229,255,0.25)',
            borderRadius: 'var(--radius-sm)',
            padding: '6px 10px',
            marginBottom: 10,
            textAlign: 'center',
            fontSize: '0.72rem',
            fontWeight: 700,
            color: 'var(--accent-cyan)',
            letterSpacing: '0.08em',
          }}
        >
          HIGH CONFIDENCE — {mlSide === 'UP' ? '↑ LONG' : '↓ SHORT'}
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
          {/* ═══ ML Prediction ═══ */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 10,
              marginBottom: 12,
            }}
          >
            {/* ML Prob */}
            <div
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: '0.62rem',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 5,
                }}
              >
                ML P(UP)
              </div>
              <div
                className={mlSide === 'UP' ? 'c-green' : mlSide === 'DOWN' ? 'c-red' : ''}
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: '1.25rem',
                }}
              >
                {formatProbPct(mlProbUp, 1)}
              </div>
              <div
                style={{
                  fontSize: '0.65rem',
                  marginTop: 3,
                  fontWeight: 600,
                }}
                className={mlSide === 'UP' ? 'c-green' : mlSide === 'DOWN' ? 'c-red' : 'c-muted'}
              >
                {mlSide === 'UP' ? '↑ LONG' : mlSide === 'DOWN' ? '↓ SHORT' : '-'}
              </div>
            </div>

            {/* Ensemble */}
            <div
              style={{
                background: 'var(--bg-elevated)',
                border: `1px solid ${
                  ensembleSide === 'UP'
                    ? 'rgba(0,230,118,0.2)'
                    : ensembleSide === 'DOWN'
                      ? 'rgba(255,82,82,0.2)'
                      : 'var(--border-dim)'
                }`,
                borderRadius: 'var(--radius-sm)',
                padding: '10px 12px',
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontSize: '0.62rem',
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 5,
                }}
              >
                Ensemble
              </div>
              <div
                className={ensembleSide === 'UP' ? 'c-green' : ensembleSide === 'DOWN' ? 'c-red' : ''}
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: '1.25rem',
                }}
              >
                {formatProbPct(ensembleProbUp, 1)}
              </div>
              <div
                style={{
                  fontSize: '0.65rem',
                  marginTop: 3,
                  fontWeight: 600,
                }}
                className={ensembleSide === 'UP' ? 'c-green' : ensembleSide === 'DOWN' ? 'c-red' : 'c-muted'}
              >
                {ensembleSide === 'UP' ? '↑ LONG' : ensembleSide === 'DOWN' ? '↓ SHORT' : '-'}
              </div>
            </div>
          </div>

          {/* ═══ Rule vs ML Comparison Bar ═══ */}
          <div style={{ marginBottom: 12 }}>
            <div
              style={{
                fontSize: '0.62rem',
                color: 'var(--text-dim)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: 6,
              }}
            >
              Rule vs ML Comparison
            </div>

            {/* Rule bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span
                style={{
                  fontSize: '0.68rem',
                  color: 'var(--text-muted)',
                  width: 36,
                  flexShrink: 0,
                }}
              >
                Rule
              </span>
              <div
                style={{
                  flex: 1,
                  height: 16,
                  background: 'var(--bg-elevated)',
                  borderRadius: 3,
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
                      ? 'linear-gradient(90deg, var(--green-dim), var(--green-mid))'
                      : 'linear-gradient(90deg, var(--red-mid), var(--red-dim))',
                    transition: 'width 0.6s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.62rem',
                    fontWeight: 600,
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
              <span
                style={{
                  fontSize: '0.68rem',
                  color: 'var(--accent-cyan)',
                  width: 36,
                  flexShrink: 0,
                  fontWeight: 500,
                }}
              >
                ML
              </span>
              <div
                style={{
                  flex: 1,
                  height: 16,
                  background: 'var(--bg-elevated)',
                  borderRadius: 3,
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
                      ? 'linear-gradient(90deg, rgba(0,229,255,0.3), rgba(0,229,255,0.7))'
                      : 'linear-gradient(90deg, rgba(179,136,255,0.7), rgba(179,136,255,0.3))',
                    transition: 'width 0.6s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.62rem',
                    fontWeight: 600,
                    color: '#fff',
                    zIndex: 1,
                  }}
                >
                  {formatProbPct(mlProbUp, 1)}
                </span>
              </div>
            </div>
          </div>

          {/* ═══ Data Rows ═══ */}
          <div className="data-row">
            <span className="data-row__label">ML Confidence</span>
            <span className={`data-row__value ${mlConfTier.color}`} style={{ fontWeight: 600 }}>
              {mlConfidence != null ? `${(mlConfidence * 100).toFixed(1)}%` : '-'}
              {' '}
              <span style={{ fontSize: '0.68rem' }}>({mlConfTier.label})</span>
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
            <span className="data-row__label">Blend (α)</span>
            <span className="data-row__value">
              <span style={{ color: 'var(--accent-cyan)', fontWeight: 600 }}>
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
            <span className="data-row__value" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {source ?? '-'}
            </span>
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