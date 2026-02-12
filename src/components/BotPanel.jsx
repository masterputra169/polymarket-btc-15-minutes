import React, { memo } from 'react';

/**
 * BotPanel — Full-width dashboard card showing real-time bot status.
 * 3-column layout: Decision | Analysis | Position.
 * Shows "Bot offline" when not connected.
 */

const fmt = (n, d = 1) => n != null && Number.isFinite(n) ? n.toFixed(d) : '-';
const fmtPct = (n, d = 1) => n != null && Number.isFinite(n) ? `${(n * 100).toFixed(d)}%` : '-';
const fmtUsd = (n, d = 2) => n != null && Number.isFinite(n) ? `$${n.toFixed(d)}` : '-';

const CONF_COLORS = {
  VERY_HIGH: 'var(--green-bright)',
  HIGH: 'var(--green-bright)',
  MEDIUM: '#ffc107',
  LOW: 'var(--red-bright)',
  NONE: 'var(--text-dim)',
};

const ACTION_STYLES = {
  ENTER: { bg: 'var(--green-bg)', color: 'var(--green-bright)', border: 'rgba(0,230,118,0.2)' },
  WAIT: { bg: 'var(--bg-elevated)', color: 'var(--text-dim)', border: 'var(--border-dim)' },
};

const REGIME_COLORS = {
  trending: 'var(--green-bright)',
  choppy: 'var(--red-bright)',
  mean_reverting: '#ffc107',
  moderate: 'var(--text-muted)',
};

// Column header style
const colHeaderStyle = {
  fontSize: '0.6rem',
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 8,
  fontWeight: 600,
};

function BotPanel({ connected, data }) {
  // Offline state
  if (!connected || !data) {
    return (
      <div className="card span-2" style={{ opacity: 0.5 }}>
        <div className="card__header">
          <span className="card__title">BOT STATUS</span>
          <span className="card__badge" style={{
            background: 'var(--bg-elevated)',
            color: 'var(--text-dim)',
            border: '1px solid var(--border-dim)',
          }}>
            OFFLINE
          </span>
        </div>
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-dim)', fontSize: '0.75rem' }}>
          Bot not running. Start with: cd bot && node index.js
        </div>
      </div>
    );
  }

  const { rec, ml, betSizing, stats, indicators, regime, regimeConfidence } = data;
  const action = rec?.action ?? 'WAIT';
  const actionStyle = ACTION_STYLES[action] || ACTION_STYLES.WAIT;
  const confidence = rec?.confidence ?? 'NONE';
  const confColor = CONF_COLORS[confidence] || 'var(--text-dim)';
  const regimeColor = REGIME_COLORS[regime] || 'var(--text-muted)';

  const mlConfLabel = ml?.confidence != null
    ? ml.confidence >= 0.40 ? 'HI' : ml.confidence >= 0.20 ? 'MED' : 'LO'
    : '-';

  const winRate = stats?.totalTrades > 0
    ? `${(stats.winRate * 100).toFixed(0)}%`
    : '-';

  // getStats() only tracks consecutiveLosses, not consecutive wins
  const streak = stats?.consecutiveLosses > 0
    ? `L${stats.consecutiveLosses}`
    : '-';

  const ageSec = data.ts ? ((Date.now() - data.ts) / 1000).toFixed(1) : '-';

  return (
    <div className="card span-2">
      {/* Header */}
      <div className="card__header">
        <span className="card__title">BOT STATUS</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {data.dryRun && (
            <span className="card__badge" style={{
              background: 'rgba(255,193,7,0.1)',
              color: '#ffc107',
              border: '1px solid rgba(255,193,7,0.2)',
              fontSize: '0.58rem',
            }}>
              DRY RUN
            </span>
          )}
          <span className="card__badge" style={{
            background: 'var(--green-bg)',
            color: 'var(--green-bright)',
            border: '1px solid rgba(0,230,118,0.2)',
            fontSize: '0.58rem',
          }}>
            CONNECTED
          </span>
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
            Poll #{data.pollCounter ?? '-'} | {ageSec}s ago
          </span>
        </div>
      </div>

      {/* 3-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 10 }}>

        {/* Column 1: Decision */}
        <div style={{ padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-dim)' }}>
          <div style={colHeaderStyle}>Decision</div>

          {/* Action badge */}
          <div style={{ marginBottom: 6 }}>
            <span style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: '0.72rem',
              fontWeight: 700,
              background: actionStyle.bg,
              color: actionStyle.color,
              border: `1px solid ${actionStyle.border}`,
            }}>
              {action === 'ENTER' ? `ENTER ${rec?.side ?? ''}` : 'WAIT'}
            </span>
          </div>

          <div className="data-row">
            <span className="data-row__label">Edge</span>
            <span className={`data-row__value ${data.edge?.bestEdge != null ? (data.edge.bestEdge > 0 ? 'c-green' : 'c-red') : ''}`}>
              {data.edge?.bestEdge != null ? `${(data.edge.bestEdge * 100).toFixed(1)}%` : '-'}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Conf</span>
            <span className="data-row__value" style={{ color: confColor, fontWeight: 600 }}>
              {confidence}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Phase</span>
            <span className="data-row__value">{rec?.phase ?? '-'}</span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Regime</span>
            <span className="data-row__value" style={{ color: regimeColor, fontWeight: 600 }}>
              {regime ? regime.toUpperCase() : '-'}
            </span>
          </div>
          {betSizing?.shouldBet && (
            <div className="data-row">
              <span className="data-row__label">Bet</span>
              <span className="data-row__value c-green" style={{ fontWeight: 600 }}>
                {fmtUsd(betSizing.betAmount)}
              </span>
            </div>
          )}
        </div>

        {/* Column 2: Analysis */}
        <div style={{ padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-dim)' }}>
          <div style={colHeaderStyle}>Analysis</div>

          <div className="data-row">
            <span className="data-row__label">Prob</span>
            <span className="data-row__value" style={{ fontWeight: 600 }}>
              {fmtPct(data.ensembleUp)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">ML</span>
            <span className={`data-row__value ${ml?.side === 'UP' ? 'c-green' : ml?.side === 'DOWN' ? 'c-red' : ''}`}
              style={{ fontWeight: 600 }}>
              {ml?.available ? `${fmtPct(ml.probUp)} (${mlConfLabel})` : 'OFF'}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Rule</span>
            <span className="data-row__value">
              {fmtPct(data.ruleUp)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">RSI</span>
            <span className="data-row__value">{fmt(indicators?.rsi)}</span>
          </div>
          <div className="data-row">
            <span className="data-row__label">MACD</span>
            <span className={`data-row__value ${indicators?.macd > 0 ? 'c-green' : indicators?.macd < 0 ? 'c-red' : ''}`}>
              {indicators?.macd != null ? (indicators.macd > 0 ? '+' : '') + fmt(indicators.macd, 2) : '-'}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">VWAP</span>
            <span className={`data-row__value ${indicators?.vwapDist > 0 ? 'c-green' : indicators?.vwapDist < 0 ? 'c-red' : ''}`}>
              {indicators?.vwapDist != null ? `${indicators.vwapDist > 0 ? '+' : ''}${fmt(indicators.vwapDist)}%` : '-'}
            </span>
          </div>
        </div>

        {/* Column 3: Position */}
        <div style={{ padding: '8px 10px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-dim)' }}>
          <div style={colHeaderStyle}>Position</div>

          <div className="data-row">
            <span className="data-row__label">Bankroll</span>
            <span className="data-row__value" style={{ fontWeight: 600 }}>
              {fmtUsd(data.bankroll, 0)}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Daily</span>
            <span className={`data-row__value ${stats?.dailyPnL > 0 ? 'c-green' : stats?.dailyPnL < 0 ? 'c-red' : ''}`}
              style={{ fontWeight: 600 }}>
              {stats?.dailyPnL != null ? `${stats.dailyPnL >= 0 ? '+' : ''}${fmtUsd(stats.dailyPnL)}` : '-'}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Trades</span>
            <span className="data-row__value">
              {stats ? `${stats.wins}W/${stats.losses}L` : '-'}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">W/R</span>
            <span className="data-row__value" style={{ fontWeight: 600 }}>
              {winRate}
            </span>
          </div>
          <div className="data-row">
            <span className="data-row__label">Streak</span>
            <span className={`data-row__value ${stats?.consecutiveLosses > 0 ? 'c-red' : 'c-green'}`}>
              {streak}
            </span>
          </div>
        </div>
      </div>

      {/* Bottom status bar */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 14px',
        fontSize: '0.65rem',
        color: 'var(--text-muted)',
        paddingTop: 6,
        borderTop: '1px solid var(--border-dim)',
      }}>
        <span>BTC <b style={{ color: 'var(--text-primary)' }}>${fmt(data.btcPrice, 0)}</b></span>
        <span>PTB <b style={{ color: 'var(--text-primary)' }}>${fmt(data.priceToBeat, 0)}</b></span>
        <span>T:<b style={{ color: 'var(--text-primary)' }}>{fmt(data.timeLeftMin)}m</b></span>
        <span>Mkt UP:<b className="c-green">{fmt(data.marketUp, 2)}</b></span>
        <span>DN:<b className="c-red">{fmt(data.marketDown, 2)}</b></span>
        {data.arbitrage && (
          <span style={{ color: data.arbitrage.found ? 'var(--green-bright)' : 'var(--text-dim)', fontWeight: data.arbitrage.found ? 700 : 400 }}>
            ARB:{data.arbitrage.found ? `${data.arbitrage.profitPct?.toFixed(1) ?? '?'}%` : 'no'}
          </span>
        )}
        {data.fillTracker && data.fillTracker.fillRate != null && (
          <span>
            Fill:{(data.fillTracker.fillRate * 100).toFixed(0)}%
            {data.fillTracker.pending && <b style={{ color: '#ffc107' }}> [pending]</b>}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          {data.sources?.binanceWs ? 'BinWS' : 'BinREST'}+{data.sources?.clobWs ? 'ClobWS' : 'ClobREST'}
        </span>
      </div>
    </div>
  );
}

export default memo(BotPanel, (prev, next) => {
  return (
    prev.connected === next.connected &&
    prev.data?.ts === next.data?.ts &&
    prev.data?.pollCounter === next.data?.pollCounter
  );
});
