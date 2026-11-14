import React, { memo, useEffect, useRef } from 'react';
import { formatNumber, fmtTimeLeft } from '../utils.ts';

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
  ptbExact = null,
  ptbSource = null,
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

  const oracleLabel = chainlinkSource === 'polymarket_ws' ? 'POLYBOLT'
    : chainlinkSource === 'chainlink_wss' ? 'CL WSS'
      : chainlinkSource === 'RPC' ? 'RPC' : 'CHAINLINK';
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

  let diffText = '';
  let diffColor = 'var(--text-muted)';
  if (binancePrice && chainlinkPrice && chainlinkPrice !== 0) {
    const diffUsd = binancePrice - chainlinkPrice;
    const diffPct = (diffUsd / chainlinkPrice) * 100;
    const sign = diffUsd > 0 ? '+' : diffUsd < 0 ? '-' : '';
    diffText = `${sign}$${Math.abs(diffUsd).toFixed(2)} (${sign}${Math.abs(diffPct).toFixed(2)}%)`;
    diffColor = Math.abs(diffUsd) > 60 ? 'var(--yellow-bright)' : 'var(--text-muted)';
  }

  let ptbDiff = 0;
  let ptbDiffText = '';
  let ptbColor = '';
  if (priceToBeat !== null && displayPrice !== null) {
    ptbDiff = displayPrice - priceToBeat;
    const diffPct = priceToBeat !== 0 ? (ptbDiff / priceToBeat) * 100 : 0;
    const sign = ptbDiff > 0 ? '+' : ptbDiff < 0 ? '-' : '';
    ptbDiffText = `${sign}$${Math.abs(ptbDiff).toFixed(2)} (${sign}${Math.abs(diffPct).toFixed(3)}%)`;
    ptbColor = ptbDiff > 0 ? 'c-green' : ptbDiff < 0 ? 'c-red' : '';
  }

  const timeColor =
    timeLeftMin !== null
      ? timeLeftMin >= 10
        ? 'timer--safe'
        : timeLeftMin >= 5
          ? 'timer--warn'
          : 'timer--danger'
      : '';

  const phaseTag = timeLeftMin == null ? null
    : timeLeftMin >= 10 ? { text: 'EARLY', cls: 'qt-badge--cyan' }
      : timeLeftMin >= 5 ? { text: 'MID', cls: 'qt-badge--amber' }
        : { text: 'LATE', cls: 'qt-badge--red' };

  const elapsedPct = timeLeftMin == null
    ? 0
    : Math.max(0, Math.min(100, ((15 - timeLeftMin) / 15) * 100));

  const ptbBannerCls = priceToBeat != null && displayPrice != null
    ? displayPrice > priceToBeat ? 'qt-banner--up'
      : displayPrice < priceToBeat ? 'qt-banner--down' : ''
    : '';

  return (
    <div className="card span-2" style={{ animationDelay: '0.05s', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        className="qt-panel-section qt-panel-section--accent price-card-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          gap: 18,
          padding: '12px 14px',
        }}
      >
        {/* Oracle Price */}
        <div ref={priceRef} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div
            title={`Chainlink via ${oracleLabel}`}
            className="qt-kicker"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              className={`status-dot ${chainlinkConnected ? '' : 'status-dot--warning'}`}
              style={{ width: 6, height: 6 }}
            />
            ORACLE · {oracleLabel}
          </div>
          <div className={`price-big ${priceColor}`} style={{ lineHeight: 1.05 }}>
            {displayPrice !== null ? `$${formatNumber(displayPrice, 2)}` : '-'}
            {arrow && <span className="price-arrow">{arrow}</span>}
          </div>
          {priceToBeat !== null && displayPrice !== null && (
            <div style={{ marginTop: 2 }}>
              <span className={`qt-badge ${ptbDiff > 0 ? 'qt-badge--green' : ptbDiff < 0 ? 'qt-badge--red' : 'qt-badge--amber'}`}>
                {ptbDiff > 0 ? '↑ ABOVE PTB' : ptbDiff < 0 ? '↓ BELOW PTB' : '= AT PTB'}
              </span>
            </div>
          )}
        </div>

        {/* Window Clock + Progress */}
        <div style={{ textAlign: 'center', minWidth: 132, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="qt-kicker">15M WINDOW</span>
            {phaseTag && <span className={`qt-badge ${phaseTag.cls}`}>{phaseTag.text}</span>}
          </div>
          <div className={`timer ${timeColor}`} style={{ lineHeight: 1 }}>
            {timeLeftMin !== null ? fmtTimeLeft(timeLeftMin) : '--:--'}
          </div>
          <div className="qt-progress" title={`Window elapsed: ${elapsedPct.toFixed(0)}%`}>
            <div
              className="qt-progress__bar"
              style={{
                width: `${elapsedPct}%`,
                background: timeLeftMin != null && timeLeftMin < 5
                  ? 'linear-gradient(90deg, var(--yellow-bright), var(--red-bright))'
                  : 'linear-gradient(90deg, var(--accent-cyan), var(--green-bright))',
              }}
            />
          </div>
        </div>

        {/* Binance Spot + Basis */}
        <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div className="qt-kicker" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            BINANCE SPOT
            <span
              className={`status-dot ${binanceConnected ? '' : 'status-dot--error'}`}
              style={{ width: 6, height: 6 }}
            />
          </div>
          <div className="price-mid" style={{ color: 'var(--text-primary)', lineHeight: 1.05 }}>
            {binancePrice !== null ? `$${formatNumber(binancePrice, 2)}` : '-'}
          </div>
          {diffText ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.66rem', color: diffColor }}>
              BASIS {diffText}
            </div>
          ) : (
            <div style={{ fontSize: '0.64rem', color: 'var(--text-dim)' }}>BASIS —</div>
          )}
        </div>
      </div>

      {/* Price to Beat TWAP Lock Strip */}
      {priceToBeat !== null && (
        <div className={`qt-banner ${ptbBannerCls}`} style={{ flexWrap: 'wrap', padding: '9px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="qt-kicker">PRICE TO BEAT</span>
            {ptbExact !== null && (
              <span
                className={`qt-badge ${ptbExact ? 'qt-badge--green' : 'qt-badge--amber'}`}
                title={ptbExact
                  ? `Chainlink 60s TWAP at window open (${ptbSource}) — Polymarket settlement reference`
                  : `Approximation (${ptbSource ?? 'none'}) — entries wait for exact TWAP value`}
              >
                {ptbExact ? '✓ TWAP EXACT' : '≈ APPROX'}
              </span>
            )}
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                fontSize: '1.08rem',
                color: 'var(--accent-cyan)',
              }}
            >
              ${formatNumber(priceToBeat, 2)}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {ptbDiffText && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="qt-kicker">Δ ORACLE</span>
                <span className={ptbColor} style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '0.84rem' }}>
                  {ptbDiffText}
                </span>
              </div>
            )}
            {displayPrice !== null && (
              <span className={`qt-badge ${ptbDiff > 0 ? 'qt-badge--green' : ptbDiff < 0 ? 'qt-badge--red' : 'qt-badge--amber'}`}>
                {ptbDiff > 0 ? 'UP LEADS' : ptbDiff < 0 ? 'DOWN LEADS' : 'AT STRIKE'}
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