import React, { memo, useState, useCallback } from 'react';

const fmt = (n, d = 1) => n != null && Number.isFinite(n) ? n.toFixed(d) : '-';
const fmtAddr = (a) => a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-';

const TAB_STYLE = (active) => ({
  background: active ? 'var(--bg-elevated)' : 'transparent',
  border: `1px solid ${active ? 'var(--border-accent)' : 'var(--border-dim)'}`,
  color: active ? 'var(--text-primary)' : 'var(--text-dim)',
  padding: '3px 10px',
  borderRadius: 4,
  fontSize: '0.62rem',
  fontWeight: active ? 600 : 400,
  cursor: 'pointer',
});

function TraderDiscoveryPanel({ sendBotCommand }) {
  const [tab, setTab] = useState('discovered');
  const [scanning, setScanning] = useState(false);
  const [discovered, setDiscovered] = useState([]);
  const [tracked, setTracked] = useState([]);
  const [simResult, setSimResult] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [simAddress, setSimAddress] = useState('');

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await sendBotCommand('scanTraders');
      if (res?.traders) setDiscovered(res.traders);
    } finally {
      setScanning(false);
    }
  }, [sendBotCommand]);

  const handleRefreshTracked = useCallback(async () => {
    const res = await sendBotCommand('getTrackedTraders');
    if (res?.traders) setTracked(res.traders);
  }, [sendBotCommand]);

  const handleTrack = useCallback(async (address) => {
    await sendBotCommand('addTracker', { address });
    handleRefreshTracked();
  }, [sendBotCommand, handleRefreshTracked]);

  const handleUntrack = useCallback(async (address) => {
    await sendBotCommand('removeTracker', { address });
    handleRefreshTracked();
  }, [sendBotCommand, handleRefreshTracked]);

  const handleSimulate = useCallback(async (address) => {
    if (!address) return;
    setSimulating(true);
    setSimResult(null);
    try {
      const res = await sendBotCommand('simulateTrader', { address });
      setSimResult(res);
    } finally {
      setSimulating(false);
    }
  }, [sendBotCommand]);

  return (
    <div className="card span-2">
      <div className="card__header">
        <span className="card__title">TRADER DISCOVERY</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            onClick={handleScan}
            disabled={scanning}
            style={{
              background: scanning ? 'var(--bg-elevated)' : 'rgba(0,176,255,0.1)',
              border: '1px solid rgba(0,176,255,0.25)',
              color: 'var(--accent-cyan)',
              padding: '2px 10px',
              borderRadius: 4,
              fontSize: '0.62rem',
              fontWeight: 600,
              cursor: scanning ? 'wait' : 'pointer',
              opacity: scanning ? 0.5 : 1,
            }}
          >
            {scanning ? 'Scanning...' : 'Scan'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button style={TAB_STYLE(tab === 'discovered')} onClick={() => setTab('discovered')}>
          Discovered ({discovered.length})
        </button>
        <button style={TAB_STYLE(tab === 'tracked')} onClick={() => { setTab('tracked'); handleRefreshTracked(); }}>
          Tracked ({tracked.length})
        </button>
        <button style={TAB_STYLE(tab === 'simulate')} onClick={() => setTab('simulate')}>
          Simulate
        </button>
      </div>

      {/* Tab: Discovered */}
      {tab === 'discovered' && (
        discovered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '14px 0', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
            Click "Scan" to discover traders
          </div>
        ) : (
          <div style={{ overflowX: 'auto', maxHeight: 220, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.66rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)', fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Address</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Trades</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Volume</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Score</th>
                  <th style={{ textAlign: 'center', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}></th>
                </tr>
              </thead>
              <tbody>
                {discovered.slice(0, 25).map((t) => (
                  <tr key={t.address} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: '0.6rem' }}>{fmtAddr(t.address)}</td>
                    <td style={{ textAlign: 'right', padding: '4px 6px' }}>{t.trades}</td>
                    <td style={{ textAlign: 'right', padding: '4px 6px' }}>${fmt(t.volume, 0)}</td>
                    <td style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600, color: t.score > 0.5 ? 'var(--green-bright)' : 'var(--text-muted)' }}>
                      {fmt(t.score, 2)}
                    </td>
                    <td style={{ textAlign: 'center', padding: '4px 6px' }}>
                      <button
                        onClick={() => handleTrack(t.address)}
                        style={{
                          background: 'rgba(0,230,118,0.1)',
                          border: '1px solid rgba(0,230,118,0.2)',
                          color: 'var(--green-bright)',
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontSize: '0.56rem',
                          cursor: 'pointer',
                        }}
                      >
                        Track
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Tab: Tracked */}
      {tab === 'tracked' && (
        tracked.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '14px 0', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
            No tracked traders. Track traders from the Discovered tab.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: '0.66rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)', fontSize: '0.58rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Address</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Score</th>
                  <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}>Added</th>
                  <th style={{ textAlign: 'center', padding: '4px 6px', borderBottom: '1px solid var(--border-dim)' }}></th>
                </tr>
              </thead>
              <tbody>
                {tracked.map((t) => (
                  <tr key={t.address} style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: '0.6rem' }}>{fmtAddr(t.address)}</td>
                    <td style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>{fmt(t.score, 2)}</td>
                    <td style={{ textAlign: 'right', padding: '4px 6px', fontSize: '0.58rem', color: 'var(--text-dim)' }}>
                      {t.addedAt ? new Date(t.addedAt).toLocaleDateString() : '-'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '4px 6px', display: 'flex', gap: 4, justifyContent: 'center' }}>
                      <button
                        onClick={() => { setSimAddress(t.address); setTab('simulate'); handleSimulate(t.address); }}
                        style={{
                          background: 'rgba(0,176,255,0.1)',
                          border: '1px solid rgba(0,176,255,0.2)',
                          color: 'var(--accent-cyan)',
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontSize: '0.56rem',
                          cursor: 'pointer',
                        }}
                      >
                        Sim
                      </button>
                      <button
                        onClick={() => handleUntrack(t.address)}
                        style={{
                          background: 'rgba(255,82,82,0.1)',
                          border: '1px solid rgba(255,82,82,0.2)',
                          color: 'var(--red-bright)',
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontSize: '0.56rem',
                          cursor: 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Tab: Simulate */}
      {tab === 'simulate' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, alignItems: 'center' }}>
            <input
              type="text"
              value={simAddress}
              onChange={(e) => setSimAddress(e.target.value)}
              placeholder="0x... wallet address"
              style={{
                flex: 1,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-dim)',
                color: 'var(--text-primary)',
                padding: '4px 8px',
                borderRadius: 4,
                fontSize: '0.66rem',
                fontFamily: 'monospace',
              }}
            />
            <button
              onClick={() => handleSimulate(simAddress)}
              disabled={simulating || !simAddress}
              style={{
                background: simulating ? 'var(--bg-elevated)' : 'rgba(0,176,255,0.1)',
                border: '1px solid rgba(0,176,255,0.25)',
                color: 'var(--accent-cyan)',
                padding: '4px 12px',
                borderRadius: 4,
                fontSize: '0.62rem',
                fontWeight: 600,
                cursor: simulating ? 'wait' : 'pointer',
                opacity: (simulating || !simAddress) ? 0.5 : 1,
              }}
            >
              {simulating ? 'Running...' : 'Simulate'}
            </button>
          </div>

          {simResult && !simResult.error && (
            <div style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-dim)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
            }}>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                Simulation Results
              </div>
              <div className="data-row">
                <span className="data-row__label">Address</span>
                <span className="data-row__value" style={{ fontFamily: 'monospace', fontSize: '0.6rem' }}>{fmtAddr(simResult.address)}</span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Total Trades</span>
                <span className="data-row__value">{simResult.totalTrades}</span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Resolved</span>
                <span className="data-row__value">{simResult.resolvedTrades ?? '-'} ({simResult.wins ?? 0}W / {simResult.losses ?? 0}L)</span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Win Rate</span>
                <span className="data-row__value" style={{
                  fontWeight: 600,
                  color: simResult.winRate > 0.55 ? 'var(--green-bright)' : simResult.winRate < 0.45 ? 'var(--red-bright)' : 'var(--text-muted)',
                }}>
                  {(simResult.winRate * 100).toFixed(1)}%
                </span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Hypothetical P&L</span>
                <span className="data-row__value" style={{
                  fontWeight: 600,
                  color: simResult.pnl >= 0 ? 'var(--green-bright)' : 'var(--red-bright)',
                }}>
                  {simResult.pnl >= 0 ? '+' : ''}${fmt(simResult.pnl, 2)}
                </span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Avg Trade Size</span>
                <span className="data-row__value">${fmt(simResult.avgSize, 2)}</span>
              </div>
            </div>
          )}

          {simResult?.error && (
            <div style={{ color: 'var(--red-bright)', fontSize: '0.68rem', padding: '8px 0' }}>
              Error: {simResult.error}
            </div>
          )}

          {!simResult && !simulating && (
            <div style={{ textAlign: 'center', padding: '14px 0', color: 'var(--text-dim)', fontSize: '0.72rem' }}>
              Enter a wallet address and click Simulate to analyze a trader
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TraderDiscoveryPanel);
