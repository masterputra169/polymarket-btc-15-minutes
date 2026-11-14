import React, { memo } from 'react';
import { formatNumber, fmtTimeLeft } from '../utils.ts';
import { describeClobSource } from './clobSourceLabel.ts';

function PolymarketPanel({ data }) {
  if (!data) return null;

  const { poly, marketUp, marketDown, liquidity, settlementLeftMin, orderbookSignal, orderbookUp, orderbookDown } = data;
  const clob = describeClobSource(data);

  const timeColor =
    settlementLeftMin !== null
      ? settlementLeftMin >= 10
        ? 'timer--safe'
        : settlementLeftMin >= 5
          ? 'timer--warn'
          : 'timer--danger'
      : '';

  const upPct = marketUp != null ? Math.max(0, Math.min(100, marketUp * 100)) : 50;
  const downPct = marketDown != null ? Math.max(0, Math.min(100, marketDown * 100)) : 50;
  const upMicro = orderbookSignal?.upMicroprice;
  const downMicro = orderbookSignal?.downMicroprice;
  const imb = orderbookSignal?.imbalance;
  const spreadHealth = orderbookSignal?.spreadHealth ?? 'unknown';
  const avgSpreadCents = orderbookUp?.spread != null && orderbookDown?.spread != null
    ? (((orderbookUp.spread + orderbookDown.spread) / 2) * 100).toFixed(1)
    : orderbookUp?.spread != null
      ? (orderbookUp.spread * 100).toFixed(1)
      : null;

  return (
    <div className="card" style={{ animationDelay: '0.2s' }}>
      <div className="card__header">
        <span className="card__title">📈 Polymarket</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {clob.tone !== 'down' && (
            <span className={`qt-badge ${clob.tone === 'live' ? 'qt-badge--cyan' : 'qt-badge--amber'}`}>
              {clob.tone === 'live' ? '⚡ WS LIVE' : '🟡 WS QUIET'}
            </span>
          )}
          <span className={`qt-badge ${poly?.ok ? 'qt-badge--green' : 'qt-badge--red'}`}>
            {poly?.ok ? 'CONNECTED' : 'OFFLINE'}
          </span>
        </div>
      </div>

      {poly?.ok && (
        <>
          <div
            style={{
              fontSize: '0.72rem',
              color: 'var(--text-muted)',
              marginBottom: 10,
              lineHeight: 1.4,
              wordBreak: 'break-word',
            }}
          >
            {poly.market?.question ?? poly.market?.slug ?? '-'}
          </div>

          <div className="qt-stat-grid" style={{ marginBottom: 10 }}>
            {/* UP Contract */}
            <div className="qt-stat-box" style={{ borderColor: 'rgba(52, 211, 153, 0.28)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="qt-stat-box__label c-green">↑ UP CONTRACT</span>
                {upMicro != null && (
                  <span className="qt-badge qt-badge--green" title="Volume-weighted microprice P_micro">
                    μ {(upMicro * 100).toFixed(1)}¢
                  </span>
                )}
              </div>
              <div className="qt-stat-box__val c-green" style={{ fontSize: '1.25rem', margin: '3px 0 4px' }}>
                {marketUp !== null ? `${Math.round(marketUp * 100)}¢` : '-'}
              </div>
              <div className="qt-progress">
                <div className="qt-progress__bar" style={{ width: `${upPct}%`, background: 'var(--green-bright)' }} />
              </div>
            </div>

            {/* DOWN Contract */}
            <div className="qt-stat-box" style={{ borderColor: 'rgba(251, 113, 133, 0.28)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="qt-stat-box__label c-red">↓ DOWN CONTRACT</span>
                {downMicro != null && (
                  <span className="qt-badge qt-badge--red" title="Volume-weighted microprice P_micro">
                    μ {(downMicro * 100).toFixed(1)}¢
                  </span>
                )}
              </div>
              <div className="qt-stat-box__val c-red" style={{ fontSize: '1.25rem', margin: '3px 0 4px' }}>
                {marketDown !== null ? `${Math.round(marketDown * 100)}¢` : '-'}
              </div>
              <div className="qt-progress">
                <div className="qt-progress__bar" style={{ width: `${downPct}%`, background: 'var(--red-bright)' }} />
              </div>
            </div>
          </div>

          <div className="qt-panel-section qt-panel-section--accent">
            <div className="qt-kicker" style={{ marginBottom: 6 }}>Orderbook Microstructure</div>
            <div className="data-row">
              <span className="data-row__label">Book Imbalance</span>
              <span className={`data-row__value ${imb != null ? (imb > 0.05 ? 'c-green' : imb < -0.05 ? 'c-red' : '') : ''}`}>
                {imb != null ? `${imb >= 0 ? '+' : ''}${(imb * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <div className="data-row">
              <span className="data-row__label">Spread Health</span>
              <span className="data-row__value">
                <span className={`qt-badge ${spreadHealth === 'tight' ? 'qt-badge--green' : spreadHealth === 'normal' ? 'qt-badge--cyan' : spreadHealth === 'wide' ? 'qt-badge--red' : 'qt-badge--muted'}`}>
                  {spreadHealth.toUpperCase()}
                </span>
                {avgSpreadCents && (
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.66rem', marginLeft: 6 }}>
                    ({avgSpreadCents}¢)
                  </span>
                )}
              </span>
            </div>
            {liquidity !== null && (
              <div className="data-row">
                <span className="data-row__label">Liquidity</span>
                <span className="data-row__value">${formatNumber(liquidity, 0)}</span>
              </div>
            )}
            {settlementLeftMin !== null && (
              <div className="data-row">
                <span className="data-row__label">Settlement in</span>
                <span className={`data-row__value ${timeColor}`}>
                  {fmtTimeLeft(settlementLeftMin)}
                </span>
              </div>
            )}
            <div className="data-row">
              <span className="data-row__label">CLOB Source</span>
              <span
                className="data-row__value"
                title={clob.detail ?? undefined}
                style={{
                  color:
                    clob.tone === 'live' ? 'var(--accent-cyan)'
                      : clob.tone === 'quiet' ? 'var(--yellow-bright)'
                        : 'var(--text-muted)',
                }}
              >
                {clob.text}
                {clob.detail && (
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.68rem', marginLeft: 6 }}>
                    {clob.detail}
                  </span>
                )}
              </span>
            </div>
          </div>
        </>
      )}

      {!poly?.ok && (
        <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-dim)' }}>
          No active market found
          <br />
          <span style={{ fontSize: '0.7rem' }}>{poly?.reason ?? ''}</span>
        </div>
      )}
    </div>
  );
}

// ═══ React.memo with custom comparator ═══
// Only re-render when Polymarket-specific fields change
export default memo(PolymarketPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.poly?.ok === b.poly?.ok &&
    a.poly?.reason === b.poly?.reason &&
    a.poly?.market?.question === b.poly?.market?.question &&
    a.poly?.market?.slug === b.poly?.market?.slug &&
    a.marketUp === b.marketUp &&
    a.marketDown === b.marketDown &&
    a.liquidity === b.liquidity &&
    a.settlementLeftMin === b.settlementLeftMin &&
    a.clobSource === b.clobSource &&
    a.clobStatus === b.clobStatus &&
    a.clobDownReason === b.clobDownReason &&
    a.orderbookSignal?.upMicroprice === b.orderbookSignal?.upMicroprice &&
    a.orderbookSignal?.downMicroprice === b.orderbookSignal?.downMicroprice &&
    a.orderbookSignal?.imbalance === b.orderbookSignal?.imbalance &&
    a.orderbookSignal?.spreadHealth === b.orderbookSignal?.spreadHealth &&
    a.orderbookUp?.spread === b.orderbookUp?.spread &&
    a.orderbookDown?.spread === b.orderbookDown?.spread &&
    // Quiet age is shown in whole seconds — only re-render when that changes.
    Math.round((a.clobQuietMs ?? 0) / 1000) === Math.round((b.clobQuietMs ?? 0) / 1000)
  );
});
