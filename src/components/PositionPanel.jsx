import React, { memo, useState, useCallback } from 'react';

const fmt = (n, d = 2) => n != null && Number.isFinite(n) ? n.toFixed(d) : '-';
const fmtUsd = (n) => n != null && Number.isFinite(n) ? `$${n.toFixed(2)}` : '-';

function PositionPanel({ data, sendBotCommand }) {
  const [selling, setSelling] = useState(null); // tokenId being sold

  const positions = data?.positions?.list ?? [];
  const lastUpdate = data?.positions?.lastUpdate;

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

  return (
    <div className="card span-2">
      <div className="card__header">
        <span className="card__title">POSITIONS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="card__badge" style={{
            background: positions.length > 0 ? 'var(--green-bg)' : 'var(--bg-elevated)',
            color: positions.length > 0 ? 'var(--green-bright)' : 'var(--text-dim)',
            border: `1px solid ${positions.length > 0 ? 'rgba(0,230,118,0.2)' : 'var(--border-dim)'}`,
            fontSize: '0.58rem',
          }}>
            {positions.length}
          </span>
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

      {positions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '16px 0', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
          No open positions
          {lastUpdate && (
            <div style={{ marginTop: 4, fontSize: '0.6rem' }}>
              Last checked: {new Date(lastUpdate).toLocaleTimeString()}
            </div>
          )}
        </div>
      ) : (
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
          </div>
        </>
      )}
    </div>
  );
}

export default memo(PositionPanel, (prev, next) => {
  return (
    prev.data?.positions?.lastUpdate === next.data?.positions?.lastUpdate &&
    prev.data?.positions?.list?.length === next.data?.positions?.list?.length
  );
});
