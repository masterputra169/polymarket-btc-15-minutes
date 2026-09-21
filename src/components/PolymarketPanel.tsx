import React, { memo } from 'react';
import { formatNumber, fmtTimeLeft } from '../utils.ts';
import { describeClobSource } from './clobSourceLabel.ts';

function PolymarketPanel({ data }) {
  if (!data) return null;

  const { poly, marketUp, marketDown, liquidity, settlementLeftMin } = data;
  const clob = describeClobSource(data);

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
          {/* Driven by the same verdict as the CLOB Source row below — the
              badge used to read raw socket-connected and could say WS LIVE
              while the row correctly said REST Poll. */}
          {clob.tone !== 'down' && (
            <span
              className="card__badge"
              style={{
                background: clob.tone === 'live' ? 'rgba(0, 229, 255, 0.08)' : 'rgba(255, 171, 0, 0.08)',
                color: clob.tone === 'live' ? 'var(--accent-cyan)' : 'var(--yellow-bright)',
                border: `1px solid ${clob.tone === 'live' ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 171, 0, 0.2)'}`,
                fontSize: '0.6rem',
              }}
            >
              {clob.tone === 'live' ? '⚡ WS LIVE' : '🟡 WS QUIET'}
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
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.7rem', marginLeft: 6 }}>
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
    // Quiet age is shown in whole seconds — only re-render when that changes.
    Math.round((a.clobQuietMs ?? 0) / 1000) === Math.round((b.clobQuietMs ?? 0) / 1000)
  );
});
