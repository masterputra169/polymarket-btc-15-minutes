import React, { memo, useEffect, useRef } from 'react';
import { formatNumber, fmtTimeLeft } from '../utils.js';

function CurrentPriceCard({
  chainlinkPrice,
  chainlinkPrevPrice,
  chainlinkConnected,
  chainlinkSource,
  binancePrice,
  binancePrevPrice,
  binanceConnected,
  timeLeftMin,
  priceToBeat,
}) {
  const priceRef = useRef(null);
  const prevRef = useRef(chainlinkPrice);

  useEffect(() => {
    if (chainlinkPrice !== null && prevRef.current !== null && chainlinkPrice !== prevRef.current) {
      const el = priceRef.current;
      if (!el) return;
      const cls = chainlinkPrice > prevRef.current ? 'flash-green' : 'flash-red';
      el.classList.remove('flash-green', 'flash-red');
      void el.offsetWidth;
      el.classList.add(cls);
    }
    prevRef.current = chainlinkPrice;
  }, [chainlinkPrice]);

  const displayPrice = chainlinkPrice ?? binancePrice;
  const prevDisplay = chainlinkPrevPrice ?? binancePrevPrice;

  let priceColor = '';
  let arrow = '';
  if (displayPrice !== null && prevDisplay !== null && displayPrice !== prevDisplay) {
    if (displayPrice > prevDisplay) {
      priceColor = 'c-green';
      arrow = ' ↑';
    } else {
      priceColor = 'c-red';
      arrow = ' ↓';
    }
  }

  // Diff between Binance and Chainlink
  let diffText = '';
  if (binancePrice && chainlinkPrice && chainlinkPrice !== 0) {
    const diffUsd = binancePrice - chainlinkPrice;
    const diffPct = (diffUsd / chainlinkPrice) * 100;
    const sign = diffUsd > 0 ? '+' : diffUsd < 0 ? '-' : '';
    diffText = `${sign}$${Math.abs(diffUsd).toFixed(2)} (${sign}${Math.abs(diffPct).toFixed(2)}%)`;
  }

  // ═══ Price to Beat vs Current Price comparison ═══
  let ptbDiffText = '';
  let ptbColor = '';
  if (priceToBeat !== null && displayPrice !== null) {
    const diff = displayPrice - priceToBeat;
    const diffPct = (diff / priceToBeat) * 100;
    const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
    ptbDiffText = `${sign}$${Math.abs(diff).toFixed(2)} (${sign}${Math.abs(diffPct).toFixed(3)}%)`;
    ptbColor = diff > 0 ? 'c-green' : diff < 0 ? 'c-red' : '';
  }

  const timeColor =
    timeLeftMin !== null
      ? timeLeftMin >= 10
        ? 'timer--safe'
        : timeLeftMin >= 5
          ? 'timer--warn'
          : 'timer--danger'
      : '';

  return (
    <div className="card span-2" style={{ animationDelay: '0.05s' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: 20,
        }}
      >
        {/* Chainlink / Current price */}
        <div ref={priceRef}>
          <div
            style={{
              fontSize: '0.68rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span
              className={`status-dot ${chainlinkConnected ? '' : 'status-dot--warning'}`}
              style={{ width: 5, height: 5 }}
            />
            Current Price ({chainlinkSource || 'Chainlink'})
          </div>
          <div className={`price-big ${priceColor}`}>
            {displayPrice !== null ? `$${formatNumber(displayPrice, 2)}` : '-'}
            {arrow && <span className="price-arrow">{arrow}</span>}
          </div>
        </div>

        {/* Timer */}
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 4,
            }}
          >
            ⏱ Time Left
          </div>
          <div className={`timer ${timeColor}`}>
            {timeLeftMin !== null ? fmtTimeLeft(timeLeftMin) : '--:--'}
          </div>
        </div>

        {/* Binance */}
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '0.68rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
            }}
          >
            BTC Binance Spot
            <span
              className={`status-dot ${binanceConnected ? '' : 'status-dot--error'}`}
              style={{ width: 5, height: 5 }}
            />
          </div>
          <div className="price-mid" style={{ color: 'var(--text-primary)' }}>
            {binancePrice !== null ? `$${formatNumber(binancePrice, 2)}` : '-'}
          </div>
          {diffText && (
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {diffText}
            </div>
          )}
        </div>
      </div>

      {/* ═══ Price to Beat Row ═══ */}
      {priceToBeat !== null && (
        <div
          style={{
            marginTop: 14,
            paddingTop: 12,
            borderTop: '1px solid var(--border-dim)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: '0.68rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              🎯 Price to Beat
            </span>
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: '1.15rem',
                color: 'var(--accent-cyan)',
              }}
            >
              ${formatNumber(priceToBeat, 2)}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {/* Distance from current price */}
            {ptbDiffText && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: '0.65rem',
                    color: 'var(--text-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                  }}
                >
                  Distance
                </span>
                <span
                  className={ptbColor}
                  style={{ fontWeight: 600, fontSize: '0.82rem' }}
                >
                  {ptbDiffText}
                </span>
              </div>
            )}

            {/* Direction indicator — prominent gradient badge */}
            {displayPrice !== null && (
              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '4px 14px',
                  borderRadius: '6px',
                  letterSpacing: '0.04em',
                  background:
                    displayPrice > priceToBeat
                      ? 'linear-gradient(135deg, rgba(0,230,118,0.15), rgba(0,230,118,0.06))'
                      : displayPrice < priceToBeat
                        ? 'linear-gradient(135deg, rgba(255,82,82,0.15), rgba(255,82,82,0.06))'
                        : 'rgba(255,171,0,0.06)',
                  color:
                    displayPrice > priceToBeat
                      ? 'var(--green-bright)'
                      : displayPrice < priceToBeat
                        ? 'var(--red-bright)'
                        : 'var(--yellow-bright)',
                  border: `1px solid ${
                    displayPrice > priceToBeat
                      ? 'rgba(0,230,118,0.3)'
                      : displayPrice < priceToBeat
                        ? 'rgba(255,82,82,0.3)'
                        : 'rgba(255,171,0,0.2)'
                  }`,
                  boxShadow:
                    displayPrice > priceToBeat
                      ? '0 0 10px rgba(0,230,118,0.1)'
                      : displayPrice < priceToBeat
                        ? '0 0 10px rgba(255,82,82,0.1)'
                        : 'none',
                }}
              >
                {displayPrice > priceToBeat
                  ? '\u2191 ABOVE'
                  : displayPrice < priceToBeat
                    ? '\u2193 BELOW'
                    : '= EXACT'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══ React.memo ═══
// Props are all primitives (number/bool/string/null), so shallow compare is sufficient.
// No custom comparator needed — React.memo's default === check works perfectly.
export default memo(CurrentPriceCard);