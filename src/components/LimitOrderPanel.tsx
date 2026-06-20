import React, { memo, useState, useEffect, useRef } from 'react';

const fmt = (n, d = 2) => n != null && Number.isFinite(n) ? n.toFixed(d) : '-';

/** Banner TTL — how long filled/cancelled banners stay visible */
const BANNER_TTL_SEC = 20;

function LimitOrderPanel({ data }) {
  const lo = data?.limitOrder;
  const marketUp = data?.marketUp;
  const marketDown = data?.marketDown;

  // Live elapsed timer (ticks every second when order is active)
  const [elapsed, setElapsed] = useState(0);
  const placedAtRef = useRef(null);
  placedAtRef.current = lo?.placedAt ?? null;

  useEffect(() => {
    if (!placedAtRef.current) { setElapsed(0); return; }
    const tick = () => {
      const pa = placedAtRef.current;
      if (!pa) { setElapsed(0); return; }
      setElapsed(Math.round((Date.now() - pa) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lo?.phase]); // restart timer when phase changes

  // IDLE + no recent event → hide panel entirely
  if (!lo || (lo.phase === 'IDLE' && !lo.lastEvent)) return null;

  // Transition banner (FILLED or CANCELLED while IDLE)
  if (lo.phase === 'IDLE' && lo.lastEvent) {
    const ev = lo.lastEvent;
    if (ev.ageSec > BANNER_TTL_SEC) return null; // expired

    const isFill = ev.type === 'FILLED';
    const bgColor = isFill ? 'rgba(0,230,118,0.08)' : 'rgba(255,82,82,0.08)';
    const borderColor = isFill ? 'rgba(0,230,118,0.25)' : 'rgba(255,82,82,0.25)';
    const textColor = isFill ? 'var(--green-bright)' : 'var(--red-bright)';
    const icon = isFill ? '\u2714' : '\u2716';
    const label = isFill ? 'FILLED' : 'CANCELLED';

    return (
      <div className="card span-2" style={{
        background: bgColor, border: `1px solid ${borderColor}`,
        transition: 'opacity 0.5s',
        opacity: ev.ageSec > BANNER_TTL_SEC - 3 ? 0.5 : 1,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '2px 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.75rem' }}>{icon}</span>
            <span style={{
              fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.05em',
              color: textColor,
            }}>
              LIMIT {label}
            </span>
            {ev.side && (
              <span style={{
                fontSize: '0.6rem', fontWeight: 700,
                padding: '1px 6px', borderRadius: 3,
                background: ev.side === 'UP' ? 'rgba(0,230,118,0.12)' : 'rgba(255,82,82,0.12)',
                color: ev.side === 'UP' ? 'var(--green-bright)' : 'var(--red-bright)',
              }}>
                {ev.side}
              </span>
            )}
            {ev.size != null && (
              <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                {fmt(ev.size, 1)} @ {fmt(ev.price * 100, 1)}c
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {ev.reason && (
              <span style={{ fontSize: '0.56rem', color: 'var(--text-dim)' }}>
                {ev.reason}
              </span>
            )}
            <span style={{ fontSize: '0.54rem', color: 'var(--text-dim)' }}>
              {ev.ageSec}s ago
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Active order: MONITORING or PLACED
  const sideColor = lo.side === 'UP' ? 'var(--green-bright)' : 'var(--red-bright)';
  const sideBg = lo.side === 'UP' ? 'rgba(0,230,118,0.12)' : 'rgba(255,82,82,0.12)';
  const currentMarketPrice = lo.side === 'UP' ? marketUp : lo.side === 'DOWN' ? marketDown : null;
  const targetCents = lo.targetPrice != null ? lo.targetPrice * 100 : null;
  const marketCents = currentMarketPrice != null ? currentMarketPrice * 100 : null;
  const discountPct = (targetCents != null && marketCents != null && marketCents > 0)
    ? ((marketCents - targetCents) / marketCents * 100)
    : null;
  const cost = (lo.targetPrice != null && lo.size != null)
    ? lo.targetPrice * lo.size
    : null;

  // Progress bar: elapsed / cancelAfterMin
  const cancelAfterSec = lo.cancelAfterMin != null ? lo.cancelAfterMin * 60 : null;
  const progressPct = (cancelAfterSec != null && cancelAfterSec > 0)
    ? Math.min(100, (elapsed / cancelAfterSec) * 100)
    : null;
  const progressColor = progressPct != null
    ? (progressPct < 60 ? 'var(--blue-bright, #42a5f5)' : progressPct < 85 ? '#ffab40' : 'var(--red-bright)')
    : 'var(--blue-bright, #42a5f5)';

  const elapsedText = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const cancelText = cancelAfterSec != null
    ? (cancelAfterSec < 60 ? `${cancelAfterSec}s` : `${Math.floor(cancelAfterSec / 60)}m`)
    : null;

  return (
    <div className="card span-2">
      <div className="card__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="card__title">LIMIT ORDER</span>
          <span style={{
            fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.04em',
            padding: '1px 6px', borderRadius: 3,
            background: lo.phase === 'PLACED' ? 'rgba(66,165,245,0.15)' : 'rgba(255,171,64,0.15)',
            color: lo.phase === 'PLACED' ? 'var(--blue-bright, #42a5f5)' : '#ffab40',
            border: `1px solid ${lo.phase === 'PLACED' ? 'rgba(66,165,245,0.3)' : 'rgba(255,171,64,0.3)'}`,
          }}>
            {lo.phase}
          </span>
          <span style={{
            fontSize: '0.6rem', fontWeight: 700,
            padding: '1px 6px', borderRadius: 3,
            background: sideBg, color: sideColor,
          }}>
            {lo.side}
          </span>
          {/* Pulsing dot */}
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: lo.phase === 'PLACED' ? 'var(--blue-bright, #42a5f5)' : '#ffab40',
            animation: 'pulse 2s ease-in-out infinite',
          }} />
        </div>
        <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>
          {elapsedText}{cancelText ? ` / ${cancelText}` : ''}
        </span>
      </div>

      {/* Stats grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6,
        fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: 6,
      }}>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Target</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {targetCents != null ? `${fmt(targetCents, 1)}c` : '-'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Market</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {marketCents != null ? `${fmt(marketCents, 1)}c` : '-'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Discount</div>
          <div style={{ color: discountPct != null && discountPct > 0 ? 'var(--green-bright)' : 'var(--text-primary)', fontWeight: 600 }}>
            {discountPct != null ? `${fmt(discountPct, 1)}%` : '-'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Size</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {lo.size != null ? fmt(lo.size, 1) : '-'}
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Cost</div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
            {cost != null ? `$${fmt(cost, 2)}` : '-'}
          </div>
        </div>
      </div>

      {/* ML confidence at placement */}
      {lo.mlConfAtPlacement != null && (
        <div style={{
          marginTop: 6, fontSize: '0.56rem', color: 'var(--text-dim)',
        }}>
          ML conf at placement: <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
            {(lo.mlConfAtPlacement * 100).toFixed(1)}%
          </span>
        </div>
      )}

      {/* Progress bar: elapsed / cancelAfterMin */}
      {progressPct != null && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: '0.54rem', color: 'var(--text-dim)', marginBottom: 2,
          }}>
            <span>Time elapsed</span>
            <span style={{ color: progressColor, fontWeight: 600 }}>
              {fmt(progressPct, 0)}%
            </span>
          </div>
          <div style={{
            height: 3, borderRadius: 2,
            background: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 2,
              width: `${progressPct}%`,
              background: progressColor,
              transition: 'width 0.3s, background 0.3s',
            }} />
          </div>
        </div>
      )}

      {/* Cancel reason if any */}
      {lo.cancelReason && (
        <div style={{
          marginTop: 6, fontSize: '0.56rem',
          color: 'var(--red-bright)', opacity: 0.85,
        }}>
          Cancel pending: {lo.cancelReason}
        </div>
      )}
    </div>
  );
}

export default memo(LimitOrderPanel, (prev, next) => {
  const plo = prev.data?.limitOrder;
  const nlo = next.data?.limitOrder;
  // Always re-render when phase/side/price change or lastEvent updates
  return (
    plo?.phase === nlo?.phase &&
    plo?.side === nlo?.side &&
    plo?.targetPrice === nlo?.targetPrice &&
    plo?.size === nlo?.size &&
    plo?.placedAt === nlo?.placedAt &&
    plo?.cancelReason === nlo?.cancelReason &&
    plo?.lastEvent?.type === nlo?.lastEvent?.type &&
    plo?.lastEvent?.ageSec === nlo?.lastEvent?.ageSec &&
    prev.data?.marketUp === next.data?.marketUp &&
    prev.data?.marketDown === next.data?.marketDown
  );
});
