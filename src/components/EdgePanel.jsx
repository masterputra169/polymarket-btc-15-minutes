import React, { memo } from 'react';
import { formatProbPct, getSessionName } from '../utils.js';
import { ML_CONFIDENCE } from '../config.js';

function EdgePanel({ data }) {
  if (!data) return null;

  const { edge, pLong, pShort, ruleUp, marketUp, marketDown, rec, ml, arbitrage } = data;

  const edgeUpPct = edge?.edgeUp != null ? (edge.edgeUp * 100).toFixed(1) : '-';
  const edgeDownPct = edge?.edgeDown != null ? (edge.edgeDown * 100).toFixed(1) : '-';

  // Quality gates
  const isEnter = rec?.action === 'ENTER';
  const confidence = rec?.confidence ?? 'NONE';
  const phase = rec?.phase ?? '-';

  // ML confidence
  const mlConf = ml?.confidence;
  const mlConfPct = mlConf !== null && mlConf !== undefined ? (mlConf * 100).toFixed(1) : null;
  // L3: !== null misses undefined → shows red instead of muted. Use != null (loose).
  const mlConfColor = mlConf != null
    ? mlConf >= ML_CONFIDENCE.HIGH ? 'c-green' : mlConf >= ML_CONFIDENCE.MEDIUM ? 'c-yellow' : 'c-red'
    : 'c-muted';

  // Gate indicators — thresholds mirror edge.js decide() exactly
  const bestEdge = edge?.bestEdge ?? 0;
  const bestProb = Math.max(pLong ?? 0, pShort ?? 0);
  const baseEdge = phase === 'EARLY' ? 0.08 : phase === 'MID' ? 0.10 : phase === 'LATE' ? 0.12 : 0.15;
  const baseProb = phase === 'EARLY' ? 0.60 : phase === 'MID' ? 0.58 : phase === 'LATE' ? 0.57 : 0.56;
  let edgePassThreshold = baseEdge;
  let probPassThreshold = baseProb;
  const gateMlConf = mlConf != null && mlConf >= ML_CONFIDENCE.HIGH;

  // Regime-adaptive adjustments (same logic as edge.js decide)
  const regime = data.regimeInfo;
  if (regime?.regime) {
    const scale = Math.min(regime.confidence ?? 0.5, 0.85);
    if (regime.regime === 'trending') {
      edgePassThreshold = Math.min(edgePassThreshold + 0.02 * scale, 0.25);
      probPassThreshold = Math.min(probPassThreshold + 0.02 * scale, 0.70);
    } else if (regime.regime === 'choppy') {
      edgePassThreshold = Math.min(edgePassThreshold + 0.03 * scale, 0.25);
      probPassThreshold = Math.min(probPassThreshold + 0.03 * scale, 0.70);
    } else if (regime.regime === 'mean_reverting') {
      edgePassThreshold = Math.min(edgePassThreshold + 0.01 * scale, 0.20);
    }
  }

  // M6: Session-adaptive thresholds (matching edge.js decide)
  const session = getSessionName();
  const SESSION_ADJ = {
    'Asia': { edgeAdj: +0.02, probAdj: +0.02 },
    'US': { edgeAdj: -0.01, probAdj: -0.01 },
    'EU/US Overlap': { edgeAdj: -0.02, probAdj: -0.01 },
    'Europe': { edgeAdj: 0, probAdj: 0 },
    'Off-hours': { edgeAdj: +0.03, probAdj: +0.02 },
  };
  const adj = SESSION_ADJ[session];
  if (adj) {
    edgePassThreshold = Math.max(edgePassThreshold + adj.edgeAdj, 0.04);
    probPassThreshold = Math.max(Math.min(probPassThreshold + adj.probAdj, 0.70), 0.52);
  }

  // M6: Cap combined regime+session penalty (max +3% above base)
  const MAX_COMBINED_PENALTY = 0.03;
  if (edgePassThreshold > baseEdge + MAX_COMBINED_PENALTY) edgePassThreshold = baseEdge + MAX_COMBINED_PENALTY;
  if (probPassThreshold > baseProb + MAX_COMBINED_PENALTY) probPassThreshold = baseProb + MAX_COMBINED_PENALTY;

  // ML high-conf relaxation
  const ruleSide = (ruleUp ?? pLong ?? 0) >= 0.5 ? 'UP' : 'DOWN';
  const mlAgreesHere = gateMlConf && ml?.side === ruleSide;
  if (mlAgreesHere) {
    edgePassThreshold = Math.max(edgePassThreshold - 0.02, 0.04);
    probPassThreshold = Math.max(probPassThreshold - 0.02, 0.52);
  }

  // M6: Side bias (matching edge.js — UP +2% harder, DOWN -1% easier)
  const bestSide = edge?.bestSide ?? (bestProb === (pLong ?? 0) ? 'UP' : 'DOWN');
  if (bestSide === 'UP') {
    edgePassThreshold = Math.min(edgePassThreshold + 0.02, 0.25);
    probPassThreshold = Math.min(probPassThreshold + 0.02, 0.70);
  } else if (bestSide === 'DOWN') {
    edgePassThreshold = Math.max(edgePassThreshold - 0.01, 0.04);
    probPassThreshold = Math.max(probPassThreshold - 0.01, 0.52);
  }

  const gateEdge = bestEdge >= edgePassThreshold;
  const gateProb = bestProb >= probPassThreshold;

  return (
    <div className="card" style={{ animationDelay: '0.25s' }}>
      <div className="card__header">
        <span className="card__title">⚖️ Edge Analysis</span>
        {isEnter && (
          <span
            className="card__badge"
            style={{
              background: confidence === 'VERY_HIGH' || confidence === 'HIGH' ? 'var(--green-bg)' : 'var(--yellow-bg, rgba(255,193,7,0.1))',
              color: confidence === 'VERY_HIGH' || confidence === 'HIGH' ? 'var(--green-bright)' : '#ffc107',
              border: `1px solid ${confidence === 'VERY_HIGH' || confidence === 'HIGH' ? 'rgba(0,230,118,0.2)' : 'rgba(255,193,7,0.2)'}`,
            }}
          >
            {confidence}
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
            Ensemble
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <span className="c-green" style={{ fontWeight: 600 }}>
              ↑ {formatProbPct(pLong, 1)}
            </span>
            <span className="c-red" style={{ fontWeight: 600 }}>
              ↓ {formatProbPct(pShort, 1)}
            </span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>
            Market
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <span className="c-green" style={{ fontWeight: 600 }}>
              ↑ {marketUp !== null ? `${Math.round(marketUp * 100)}¢` : '-'}
            </span>
            <span className="c-red" style={{ fontWeight: 600 }}>
              ↓ {marketDown !== null ? `${Math.round(marketDown * 100)}¢` : '-'}
            </span>
          </div>
        </div>
      </div>

      <div className="data-row">
        <span className="data-row__label">Edge UP</span>
        <span className={`data-row__value ${edge?.edgeUp > 0 ? 'c-green' : edge?.edgeUp < 0 ? 'c-red' : ''}`}>
          {edgeUpPct !== '-' ? `${edge.edgeUp > 0 ? '+' : ''}${edgeUpPct}%` : '-'}
        </span>
      </div>
      <div className="data-row">
        <span className="data-row__label">Edge DOWN</span>
        <span className={`data-row__value ${edge?.edgeDown > 0 ? 'c-green' : edge?.edgeDown < 0 ? 'c-red' : ''}`}>
          {edgeDownPct !== '-' ? `${edge.edgeDown > 0 ? '+' : ''}${edgeDownPct}%` : '-'}
        </span>
      </div>

      {/* Spread penalties */}
      {(edge?.spreadPenaltyUp > 0 || edge?.spreadPenaltyDown > 0) && (
        <div className="data-row">
          <span className="data-row__label">Spread Cost</span>
          <span className="data-row__value c-yellow" style={{ fontSize: '0.7rem' }}>
            {edge.spreadPenaltyUp > 0 ? `UP -${(edge.spreadPenaltyUp * 100).toFixed(1)}%` : ''}
            {edge.spreadPenaltyUp > 0 && edge.spreadPenaltyDown > 0 ? ' | ' : ''}
            {edge.spreadPenaltyDown > 0 ? `DN -${(edge.spreadPenaltyDown * 100).toFixed(1)}%` : ''}
          </span>
        </div>
      )}

      {/* Arbitrage */}
      {arbitrage && (
        <div className="data-row">
          <span className="data-row__label">Arbitrage</span>
          <span className={`data-row__value ${arbitrage.found ? 'c-green' : 'c-muted'}`} style={{ fontWeight: arbitrage.found ? 700 : 400 }}>
            {arbitrage.found
              ? `${arbitrage.profitPct?.toFixed(1) ?? '?'}% profit ($${arbitrage.netProfit?.toFixed(3) ?? '?'})${!arbitrage.spreadHealthy ? ' [wide spread]' : ''}`
              : `No (cost $${arbitrage.totalCost?.toFixed(3) ?? '?'})`}
          </span>
        </div>
      )}

      {/* ML Confidence */}
      <div className="data-row">
        <span className="data-row__label">ML Confidence</span>
        <span className={`data-row__value ${mlConfColor}`} style={{ fontWeight: 600 }}>
          {mlConfPct !== null ? `${mlConfPct}%` : 'N/A'}
        </span>
      </div>

      {/* Quality Gates */}
      <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-dim)' }}>
        <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Quality Gates ({phase})
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: '0.7rem' }}>
          <span style={{ color: gateEdge ? 'var(--green-bright)' : 'var(--red-bright)' }}>
            {gateEdge ? '✓' : '✗'} Edge≥{(edgePassThreshold * 100).toFixed(0)}%
          </span>
          <span style={{ color: gateProb ? 'var(--green-bright)' : 'var(--red-bright)' }}>
            {gateProb ? '✓' : '✗'} Prob≥{(probPassThreshold * 100).toFixed(0)}%
          </span>
          <span style={{ color: gateMlConf ? 'var(--green-bright)' : 'var(--text-dim)' }}>
            {gateMlConf ? '✓' : '○'} ML HiConf
          </span>
        </div>
      </div>

      {/* Recommendation */}
      {rec?.reason && (
        <div style={{ marginTop: 8, fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          {rec.reason}
        </div>
      )}
    </div>
  );
}

// Only re-render when edge-specific fields change
export default memo(EdgePanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.edge?.edgeUp === b.edge?.edgeUp &&
    a.edge?.edgeDown === b.edge?.edgeDown &&
    a.edge?.spreadPenaltyUp === b.edge?.spreadPenaltyUp &&
    a.edge?.spreadPenaltyDown === b.edge?.spreadPenaltyDown &&
    a.pLong === b.pLong &&
    a.pShort === b.pShort &&
    a.marketUp === b.marketUp &&
    a.marketDown === b.marketDown &&
    a.rec?.action === b.rec?.action &&
    a.rec?.confidence === b.rec?.confidence &&
    a.rec?.phase === b.rec?.phase &&
    a.rec?.reason === b.rec?.reason &&
    a.ml?.confidence === b.ml?.confidence &&
    a.ruleUp === b.ruleUp &&
    a.regimeInfo?.regime === b.regimeInfo?.regime &&
    a.regimeInfo?.confidence === b.regimeInfo?.confidence &&
    a.arbitrage?.found === b.arbitrage?.found &&
    a.arbitrage?.netProfit === b.arbitrage?.netProfit &&
    a.arbitrage?.profitPct === b.arbitrage?.profitPct &&
    a.arbitrage?.spreadHealthy === b.arbitrage?.spreadHealthy
  );
});
