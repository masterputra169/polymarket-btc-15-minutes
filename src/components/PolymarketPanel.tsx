import React, { memo } from 'react';
import { formatNumber, fmtTimeLeft } from '../utils.ts';

function PolymarketPanel({ data, clobWsConnected }) {
  if (!data) return null;

  const { poly, marketUp, marketDown, liquidity, settlementLeftMin, clobSource } = data;

  const timeColor =
    settlementLeftMin !== null
      ? settlementLeftMin >= 10
        ? 'timer--safe'
        : settlementLeftMin >= 5
          ? 'timer--warn'
          : 'timer--danger'
      : '';

  return (
    <div className="card" style={{ animationDelay: '0.2s' }}>
      <div className="card__header">
        <span className="card__title">📈 Polymarket</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {clobWsConnected && (
            <span
              className="card__badge"
              style={{
                background: 'rgba(0, 229, 255, 0.08)',
                color: 'var(--accent-cyan)',
                border: '1px solid rgba(0, 229, 255, 0.2)',
                fontSize: '0.6rem',
              }}
            >
              ⚡ WS LIVE
            </span>
          )}
          <span className={`card__badge ${poly?.ok ? 'badge--live' : 'badge--offline'}`}>
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
              wordBreak: 'break-all',
            }}
          >
            {poly.market?.question ?? poly.market?.slug ?? '-'}
          </div>

          <div className="poly-prices">
            <div className="poly-price-box poly-price-box--up">
              <div className="poly-price-box__label c-green">↑ UP</div>
              <div className="poly-price-box__price c-green">
                {marketUp !== null ? `${Math.round(marketUp * 100)}¢` : '-'}
              </div>
            </div>
            <div className="poly-price-box poly-price-box--down">
              <div className="poly-price-box__label c-red">↓ DOWN</div>
              <div className="poly-price-box__price c-red">
                {marketDown !== null ? `${Math.round(marketDown * 100)}¢` : '-'}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
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
                style={{
                  color: clobSource === 'WebSocket' ? 'var(--accent-cyan)' : 'var(--text-muted)',
                }}
              >
                {clobSource === 'WebSocket' ? '⚡ WebSocket' : '🔄 REST Poll'}
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
    prev.clobWsConnected === next.clobWsConnected &&
    a.poly?.ok === b.poly?.ok &&
    a.poly?.reason === b.poly?.reason &&
    a.poly?.market?.question === b.poly?.market?.question &&
    a.poly?.market?.slug === b.poly?.market?.slug &&
    a.marketUp === b.marketUp &&
    a.marketDown === b.marketDown &&
    a.liquidity === b.liquidity &&
    a.settlementLeftMin === b.settlementLeftMin &&
    a.clobSource === b.clobSource
  );
});