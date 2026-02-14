import React, { memo, useState, useCallback, useEffect } from 'react';

const fmt = (n, d = 2) => n != null && Number.isFinite(n) ? n.toFixed(d) : '-';
const fmtUsd = (n) => n != null && Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';

function CutLossBar({ cutLoss }) {
  if (!cutLoss?.active) return null;

  const { dropPct, threshold, ratio, holdSec, holdNeeded, holdMet, attempts, maxAttempts, fillConfirmed } = cutLoss;

  // Color transitions: green (safe) → yellow (warning) → red (danger)
  const barColor = ratio < 0.5 ? 'var(--green-bright)'
    : ratio < 0.8 ? '#ffab40'
    : 'var(--red-bright)';

  if (!fillConfirmed) {
    return (
      <div style={{ marginTop: 6, fontSize: '0.54rem', color: 'var(--text-dim)' }}>
        CL: waiting for fill confirmation
      </div>
    );
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: '0.54rem', color: 'var(--text-dim)', marginBottom: 2,
      }}>
        <span>
          CL: {dropPct.toFixed(1)}% / {threshold}%
          {!holdMet && <span style={{ color: '#ffab40' }}> | Hold: {holdSec}s/{holdNeeded}s</span>}
          {attempts > 0 && <span style={{ color: 'var(--red-bright)' }}> | Retry {attempts}/{maxAttempts}</span>}
        </span>
        <span style={{ color: barColor, fontWeight: 600 }}>
          {ratio >= 1 ? 'TRIGGERED' : `${(ratio * 100).toFixed(0)}%`}
        </span>
      </div>
      {/* Progress bar */}
      <div style={{
        height: 3, borderRadius: 2,
        background: 'rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', borderRadius: 2,
          width: `${Math.min(100, ratio * 100)}%`,
          background: barColor,
          transition: 'width 0.3s, background 0.3s',
        }} />
      </div>
    </div>
  );
}

function PositionPanel({ data, sendBotCommand }) {
  const [selling, setSelling] = useState(null);
  const [agoText, setAgoText] = useState('');

  const positions = data?.positions?.list ?? [];
  const lastUpdate = data?.positions?.lastUpdate;
  const botPosition = data?.positions?.botPosition ?? null;
  const bankroll = data?.bankroll;
  const cutLoss = data?.cutLoss ?? null;

  // Auto-updating "Xs ago" timer
  useEffect(() => {
    if (!lastUpdate) { setAgoText(''); return; }
    const tick = () => {
      const s = Math.round((Date.now() - lastUpdate) / 1000);
      setAgoText(s < 2 ? 'just now' : `${s}s ago`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastUpdate]);

  const handleRefresh = useCallback(() => {
    sendBotCommand('getPositions');
  }, [sendBotCommand]);

  const handleSell = useCallback(async (pos) => {
    if (selling) return;
    setSelling(pos.tokenId);
    try {
      await sendBotCommand('sellPosition', {
        tokenId: pos.tokenId,
        size: pos.size,
        price: pos.currentPrice,
      });
    } finally {
      setSelling(null);
    }
  }, [sendBotCommand, selling]);

  const totalValue = positions.reduce((sum, p) => sum + p.size * p.currentPrice, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);

  // Time held for bot position
  const timeHeld = botPosition?.enteredAt
    ? Math.round((Date.now() - botPosition.enteredAt) / 1000)
    : null;
  const timeHeldText = timeHeld != null
    ? (timeHeld < 60 ? `${timeHeld}s` : `${Math.floor(timeHeld / 60)}m ${timeHeld % 60}s`)
    : null;

  return (
    <div className="card span-2">
      <div className="card__header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="card__title">POSITIONS</span>
          <span className="card__badge" style={{
            background: positions.length > 0 ? 'var(--green-bg)' : 'var(--bg-elevated)',
            color: positions.length > 0 ? 'var(--green-bright)' : 'var(--text-dim)',
            border: `1px solid ${positions.length > 0 ? 'rgba(0,230,118,0.2)' : 'var(--border-dim)'}`,
            fontSize: '0.58rem',
          }}>
            {positions.length}
          </span>
          {/* Live indicator */}
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: '0.58rem', color: 'var(--green-bright)', opacity: 0.85,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--green-bright)',
              animation: 'pulse 2s ease-in-out infinite',
            }} />
            Live
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {agoText && (
            <span style={{ fontSize: '0.58rem', color: 'var(--text-dim)' }}>
              Updated {agoText}
            </span>
          )}
          <button
            onClick={handleRefresh}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-dim)',
              color: 'var(--text-muted)',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: '0.62rem',
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Bot Position Card */}
      {botPosition && (
        <div style={{
          background: 'rgba(0,230,118,0.04)',
          border: '1px solid rgba(0,230,118,0.15)',
          borderRadius: 6,
          padding: '8px 10px',
          marginBottom: 8,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.05em',
                padding: '1px 6px', borderRadius: 3,
                background: 'rgba(0,230,118,0.12)',
                color: 'var(--green-bright)',
                border: '1px solid rgba(0,230,118,0.2)',
              }}>BOT</span>
              <span style={{
                fontSize: '0.72rem', fontWeight: 700,
                color: botPosition.side === 'UP' ? 'var(--green-bright)' : 'var(--red-bright)',
              }}>
                {botPosition.side}
              </span>
            </div>
            {/* Fill status */}
            <span style={{
              fontSize: '0.58rem', fontWeight: 600,
              color: botPosition.fillConfirmed ? 'var(--green-bright)' : '#ffab40',
              ...(botPosition.fillConfirmed ? {} : { animation: 'pulse 1.5s ease-in-out infinite' }),
            }}>
              {botPosition.fillConfirmed ? 'Confirmed' : 'Pending fill...'}
            </span>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6,
            fontSize: '0.62rem', color: 'var(--text-muted)',
          }}>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Size</div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmt(botPosition.size, 1)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Entry</div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>${fmt(botPosition.price, 3)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Cost</div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmtUsd(botPosition.cost)}</div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '0.54rem', textTransform: 'uppercase' }}>Held</div>
              <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{timeHeldText ?? '-'}</div>
            </div>
          </div>
          <CutLossBar cutLoss={cutLoss} />
          {botPosition.marketSlug && (
            <div style={{
              marginTop: 4, fontSize: '0.54rem', color: 'var(--text-dim)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {botPosition.marketSlug}
            </div>
          )}
        </div>
      )}

      {positions.length === 0 && !botPosition ? (
        <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
          No open positions
        </div>
      ) : positions.length > 0 && (
        <>
          {/* Position table */}
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.68rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Market</th>
                  <th style={{ textAlign: 'center', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Side</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Size</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Avg</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Curr</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>P&L</th>
                  <th style={{ textAlign: 'center', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((pos) => {
                  const pnlPct = pos.avgPrice > 0 ? ((pos.currentPrice - pos.avgPrice) / pos.avgPrice * 100) : 0;
                  const pnlColor = pos.pnl >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
                  const sideColor = (pos.side ?? '').toUpperCase().includes('UP') || (pos.side ?? '').toUpperCase() === 'YES'
                    ? 'var(--green-bright)' : 'var(--red-bright)';

                  return (
                    <tr key={pos.tokenId} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                      <td style={{ padding: '5px 6px', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {pos.market || pos.conditionId?.slice(0, 12) + '...'}
                        {pos.botTracked && (
                          <span style={{
                            marginLeft: 4, fontSize: '0.5rem', fontWeight: 700,
                            padding: '0 3px', borderRadius: 2,
                            background: 'rgba(0,230,118,0.12)',
                            color: 'var(--green-bright)',
                            verticalAlign: 'middle',
                          }}>BOT</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'center', padding: '5px 6px', color: sideColor, fontWeight: 600 }}>
                        {(pos.side || '-').toUpperCase()}
                      </td>
                      <td style={{ textAlign: 'right', padding: '5px 6px' }}>{fmt(pos.size, 1)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px' }}>{fmt(pos.avgPrice, 3)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px' }}>{fmt(pos.currentPrice, 3)}</td>
                      <td style={{ textAlign: 'right', padding: '5px 6px', color: pnlColor, fontWeight: 600 }}>
                        {fmtUsd(pos.pnl)} <span style={{ fontSize: '0.58rem', opacity: 0.7 }}>({pnlPct >= 0 ? '+' : ''}{fmt(pnlPct, 1)}%)</span>
                      </td>
                      <td style={{ textAlign: 'center', padding: '5px 6px' }}>
                        <button
                          onClick={() => handleSell(pos)}
                          disabled={selling === pos.tokenId}
                          style={{
                            background: 'rgba(255,82,82,0.12)',
                            border: '1px solid rgba(255,82,82,0.25)',
                            color: 'var(--red-bright)',
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: '0.6rem',
                            fontWeight: 600,
                            cursor: selling === pos.tokenId ? 'wait' : 'pointer',
                            opacity: selling === pos.tokenId ? 0.5 : 1,
                          }}
                        >
                          {selling === pos.tokenId ? '...' : 'SELL'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer: totals */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            paddingTop: 8,
            marginTop: 4,
            borderTop: '1px solid var(--border-dim)',
            fontSize: '0.65rem',
            color: 'var(--text-muted)',
          }}>
            <span>Portfolio: <b style={{ color: 'var(--text-primary)' }}>{fmtUsd(totalValue)}</b></span>
            <span>
              Unrealized P&L: <b style={{ color: totalPnl >= 0 ? 'var(--green-bright)' : 'var(--red-bright)' }}>
                {totalPnl >= 0 ? '+' : ''}{fmtUsd(totalPnl)}
              </b>
            </span>
            {bankroll != null && (
              <span>Bankroll: <b style={{ color: 'var(--text-primary)' }}>{fmtUsd(bankroll)}</b></span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default memo(PositionPanel, (prev, next) => {
  const pp = prev.data?.positions;
  const np = next.data?.positions;
  return (
    pp?.lastUpdate === np?.lastUpdate &&
    pp?.list?.length === np?.list?.length &&
    pp?.botPosition?.side === np?.botPosition?.side &&
    pp?.botPosition?.size === np?.botPosition?.size &&
    pp?.botPosition?.fillConfirmed === np?.botPosition?.fillConfirmed &&
    prev.data?.bankroll === next.data?.bankroll &&
    prev.data?.cutLoss?.dropPct === next.data?.cutLoss?.dropPct &&
    prev.data?.cutLoss?.attempts === next.data?.cutLoss?.attempts
  );
});
