import React, { useState } from 'react';

export default function HiddenFeatures({ data }) {
  const [expanded, setExpanded] = useState(false);

  const {
    volumeRatio, vwapCrossCount, multiTfConfirm,
    failedVwapReclaim, regimeInfo, realizedVol,
  } = data;

  const volRatioColor = (volumeRatio ?? 1) > 1.5 ? 'c-green' : (volumeRatio ?? 1) < 0.6 ? 'c-red' : 'c-muted';
  const volRatioLabel = (volumeRatio ?? 1) > 1.5 ? 'HIGH' : (volumeRatio ?? 1) < 0.6 ? 'LOW' : 'NORMAL';

  const mtfLabel = multiTfConfirm?.agreement
    ? `\u2713 ${multiTfConfirm.direction?.toUpperCase() || 'AGREE'}`
    : '\u2717 DISAGREE';
  const mtfColor = multiTfConfirm?.agreement ? 'c-green' : 'c-red';

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 4, paddingTop: 4 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '2px 0',
          fontSize: '0.65rem',
          color: 'var(--text-dim)',
          userSelect: 'none',
        }}
      >
        <span>\uD83D\uDD0D Hidden Features</span>
        <span style={{ fontSize: '0.6rem' }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div style={{ fontSize: '0.65rem', lineHeight: 1.8 }}>
          <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
            <span className="ta-signal-row__name">Vol Ratio</span>
            <span className={`ta-signal-row__value ${volRatioColor}`} style={{ fontSize: '0.65rem' }}>
              {volumeRatio?.toFixed(2) ?? '-'}x ({volRatioLabel})
            </span>
          </div>

          <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
            <span className="ta-signal-row__name">VWAP Crosses</span>
            <span className="ta-signal-row__value c-muted" style={{ fontSize: '0.65rem' }}>
              {vwapCrossCount ?? '-'} (20b)
              {(vwapCrossCount ?? 0) >= 6 &&
                <span style={{ color: 'var(--yellow-bright)', marginLeft: 4 }}>CHOPPY</span>
              }
            </span>
          </div>

          <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
            <span className="ta-signal-row__name">Multi-TF</span>
            <span className={`ta-signal-row__value ${mtfColor}`} style={{ fontSize: '0.65rem' }}>
              {mtfLabel}
              {multiTfConfirm?.score !== undefined &&
                <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>
                  ({multiTfConfirm.score}/5)
                </span>
              }
            </span>
          </div>

          <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
            <span className="ta-signal-row__name">VWAP Reclaim</span>
            <span className={`ta-signal-row__value ${failedVwapReclaim ? 'c-red' : 'c-muted'}`} style={{ fontSize: '0.65rem' }}>
              {failedVwapReclaim ? '\u2717 FAILED' : '\u2014'}
            </span>
          </div>

          <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
            <span className="ta-signal-row__name">Regime</span>
            <span className="ta-signal-row__value" style={{ fontSize: '0.65rem', color: 'var(--cyan-bright)' }}>
              {regimeInfo?.regime?.toUpperCase() ?? '-'}
              {regimeInfo?.confidence !== undefined &&
                <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>
                  ({(regimeInfo.confidence * 100).toFixed(0)}%)
                </span>
              }
            </span>
          </div>

          {realizedVol !== null && realizedVol !== undefined && (
            <div className="ta-signal-row ta-signal-row--neutral" style={{ padding: '1px 8px' }}>
              <span className="ta-signal-row__name">Realized Vol</span>
              <span className="ta-signal-row__value c-muted" style={{ fontSize: '0.65rem' }}>
                {(realizedVol * 100).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
