import React, { memo, useState, useEffect } from 'react';
import { ML_CONFIDENCE } from '../config.js';

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
  ENTER: { bg: 'linear-gradient(135deg, rgba(0,230,118,0.15), rgba(0,230,118,0.06))', color: 'var(--green-bright)', border: 'rgba(0,230,118,0.3)', shadow: '0 0 12px rgba(0,230,118,0.15)' },
  WAIT: { bg: 'var(--bg-elevated)', color: 'var(--text-dim)', border: 'var(--border-dim)', shadow: 'none' },
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
  // Local 2s ticker for "Xs ago" and MetEngine age — avoids re-render every 50ms poll
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

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
  const isEnter = action === 'ENTER';
  const isPaused = data.paused === true;

  // RL Agent status
  const rl = data.rlAgent ?? null;
  const rlLoaded = rl?.loaded === true;
  const rlShadow = rl?.shadowMode !== false;
  const rlScalar = rl?.currentScalar;

  const mlConfLabel = ml?.confidence != null
    ? ml.confidence >= ML_CONFIDENCE.HIGH ? 'HI' : ml.confidence >= ML_CONFIDENCE.MEDIUM ? 'MED' : 'LO'
    : '-';

  // MetEngine smart money state
  const me = data.metEngine;
  const meLast   = me?.last;
  const meEnabled  = me?.enabled === true;
  const meIsBlock  = meLast?.blocked === true;
  const meIsBoost  = meLast?.boost === true;
  const meAgeSec   = meLast?.ts ? Math.round((now - meLast.ts) / 1000) : null;
  const meStale    = meAgeSec != null && meAgeSec > 120;

  const winRate = stats?.totalTrades > 0 && stats?.winRate != null
    ? `${(stats.winRate * 100).toFixed(0)}%`
    : '-';

  // Portfolio — active bot position real-time value
  const botPosition = data.positions?.botPosition ?? null;
  const rtCurrentPrice = botPosition?.side === 'UP' ? data.marketUp
    : botPosition?.side === 'DOWN' ? data.marketDown : null;
  const rtPositionValue = (rtCurrentPrice != null && botPosition?.size > 0)
    ? rtCurrentPrice * botPosition.size : null;
  const rtPnl = (rtPositionValue != null && botPosition?.cost > 0)
    ? rtPositionValue - botPosition.cost : null;
  const portfolioTotal = data.bankroll != null
    ? data.bankroll + (rtPositionValue ?? botPosition?.cost ?? 0) : null;

  // Profit target
  const pt = data.profitTarget ?? null;
  const ptEnabled = pt?.enabled === true && pt?.target > 0;
  const ptReached = pt?.targetReached === true;
  const ptProfit = pt?.profit ?? 0;
  const ptTarget = pt?.target ?? 0;
  const ptPct = ptEnabled && ptTarget > 0 ? Math.min(ptProfit / ptTarget, 1) : 0;

  // Limit order status
  const limitOrder = data.limitOrder ?? null;
  const limActive = limitOrder?.phase === 'MONITORING' || limitOrder?.phase === 'PLACED';
  const limElapsedSec = limActive && limitOrder?.elapsedMs ? Math.round(limitOrder.elapsedMs / 1000) : 0;
  const limEvent = limitOrder?.lastEvent;  // Recent fill/cancel event (persists ~20s)
  const limFilled = limEvent?.type === 'FILLED';
  const limCancelled = limEvent?.type === 'CANCELLED';

  // getStats() only tracks consecutiveLosses, not consecutive wins
  const streak = stats?.consecutiveLosses > 0
    ? `L${stats.consecutiveLosses}`
    : '-';

  const ageSec = data.ts ? ((now - data.ts) / 1000).toFixed(1) : '-';

  // Card glow: green on ENTER, dim otherwise
  const cardGlow = isPaused ? '' : isEnter ? ' card--glow-green' : '';

  return (
    <div className={`card span-2${cardGlow}`}>
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
          {rlLoaded && (
            <span className="card__badge" style={{
              background: rlShadow ? 'rgba(100,100,255,0.1)' : 'rgba(0,230,118,0.1)',
              color: rlShadow ? '#aaaaff' : 'var(--green-bright)',
              border: `1px solid ${rlShadow ? 'rgba(100,100,255,0.25)' : 'rgba(0,230,118,0.2)'}`,
              fontSize: '0.58rem',
            }}>
              {rlShadow ? 'RL SHADOW' : 'RL LIVE'}
            </span>
          )}
          {isPaused ? (
            <span className="card__badge" style={{
              background: 'rgba(255,171,0,0.1)',
              color: 'var(--yellow-bright)',
              border: '1px solid rgba(255,171,0,0.25)',
              fontSize: '0.58rem',
            }}>
              PAUSED
            </span>
          ) : (
            <span className="card__badge" style={{
              background: 'var(--green-bg)',
              color: 'var(--green-bright)',
              border: '1px solid rgba(0,230,118,0.2)',
              fontSize: '0.58rem',
            }}>
              CONNECTED
            </span>
          )}
          <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
            Poll #{data.pollCounter ?? '-'} | {ageSec}s ago
          </span>
        </div>
      </div>

      {/* 3-column grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 10 }}>

        {/* Column 1: Decision */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-dim)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Gradient top accent */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 2,
            background: isEnter
              ? 'linear-gradient(90deg, transparent, var(--green-bright), transparent)'
              : 'linear-gradient(90deg, transparent, var(--border-accent), transparent)',
            opacity: isEnter ? 0.8 : 0.3,
          }} />
          <div style={colHeaderStyle}>Decision</div>

          {/* Action badge */}
          <div style={{ marginBottom: 6 }}>
            <span style={{
              display: 'inline-block',
              padding: '3px 12px',
              borderRadius: 6,
              fontSize: '0.74rem',
              fontWeight: 700,
              background: actionStyle.bg,
              color: actionStyle.color,
              border: `1px solid ${actionStyle.border}`,
              boxShadow: actionStyle.shadow,
              ...(isEnter ? { animation: 'glowPulse 2s ease-in-out infinite' } : {}),
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
          {rlLoaded && !rlShadow && rlScalar != null && (
            <div className="data-row">
              <span className="data-row__label" style={{ color: 'var(--text-dim)' }}>RL</span>
              <span className="data-row__value" style={{
                fontWeight: 600,
                color: rlScalar > 1 ? 'var(--green-bright)' : rlScalar < 1 ? 'var(--red-bright)' : 'var(--text-muted)',
              }}>
                ×{rlScalar}
              </span>
            </div>
          )}
        </div>

        {/* Column 2: Analysis */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-dim)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 2,
            background: 'linear-gradient(90deg, transparent, var(--accent-cyan), transparent)',
            opacity: 0.3,
          }} />
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

          {/* MetEngine smart money status — always visible */}
          <div style={{ borderTop: '1px solid var(--border-dim)', margin: '5px 0 4px' }} />
          <div className="data-row">
            <span className="data-row__label" style={{ color: 'var(--text-dim)' }}>Smart$</span>
            <span className="data-row__value" style={{
              color: !meEnabled ? 'var(--text-dim)'
                : !me?.configured ? 'var(--text-dim)'
                : meIsBlock ? 'var(--red-bright)'
                : meIsBoost ? 'var(--green-bright)'
                : meLast    ? 'var(--text-muted)'
                : 'var(--text-dim)',
              fontWeight: meIsBlock || meIsBoost ? 700 : 400,
              opacity: !meEnabled ? 0.45 : meStale ? 0.55 : 1,
            }}>
              {!meEnabled ? 'off'
                : !me?.configured ? 'no key'
                : meIsBlock ? `\u2297 ${meLast.direction ?? ''}`.trim()
                : meIsBoost ? `\u2191 ${meLast.direction ?? ''}`.trim()
                : meLast    ? `\u2013 ${meLast.direction ?? ''}`.trim()
                : '\u2013'}
              {meEnabled && meLast?.consensusStrength > 0 && ` ${(meLast.consensusStrength * 100).toFixed(0)}%`}
            </span>
          </div>
          {meEnabled && meLast?.insiderScore > 0 && (
            <div className="data-row">
              <span className="data-row__label" style={{ color: 'var(--text-dim)' }}>Insider</span>
              <span className="data-row__value" style={{
                color: meLast.insiderScore >= 90 ? 'var(--green-bright)'
                  : meLast.insiderScore >= 70 ? '#ffc107'
                  : 'var(--text-muted)',
                fontWeight: meLast.insiderScore >= 70 ? 600 : 400,
              }}>
                {meLast.insiderScore}
                {meStale && <span style={{ fontSize: '0.75em', marginLeft: 4, opacity: 0.6 }}>{meAgeSec}s</span>}
              </span>
            </div>
          )}
        </div>

        {/* Column 3: Position */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-dim)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 2,
            background: 'linear-gradient(90deg, transparent, var(--accent-purple), transparent)',
            opacity: 0.3,
          }} />
          <div style={colHeaderStyle}>Position</div>

          {data.usdcBalance && (
            <div className="data-row">
              <span className="data-row__label">On-chain</span>
              <span className="data-row__value" style={{
                fontWeight: 600,
                color: data.usdcBalance.drift > 1.0 ? 'var(--red)' : 'var(--text-secondary)',
              }}>
                {fmtUsd(data.usdcBalance.balance, 2)}
                {data.usdcBalance.drift > 1.0 && (
                  <span style={{ fontSize: '0.75em', marginLeft: 4 }}>
                    ({data.usdcBalance.drift > 0 ? '+' : ''}{(data.usdcBalance.balance - data.bankroll).toFixed(2)})
                  </span>
                )}
              </span>
            </div>
          )}
          <div className="data-row">
            <span className="data-row__label">Daily</span>
            <span className={`data-row__value ${stats?.dailyPnL > 0 ? 'c-green' : stats?.dailyPnL < 0 ? 'c-red' : ''}`}
              style={{ fontWeight: 600 }}>
              {stats?.dailyPnL != null ? `${stats.dailyPnL >= 0 ? '+' : ''}${fmtUsd(stats.dailyPnL)}` : '-'}
            </span>
          </div>
          {ptEnabled && (
            <div style={{ marginBottom: 4 }}>
              <div className="data-row" style={{ marginBottom: 2 }}>
                <span className="data-row__label" style={{ color: ptReached ? '#ffc107' : 'var(--text-dim)' }}>
                  Target
                </span>
                <span className="data-row__value" style={{
                  fontWeight: 700,
                  color: ptReached ? '#ffc107' : ptProfit > 0 ? 'var(--green-bright)' : 'var(--text-muted)',
                }}>
                  {ptProfit >= 0 ? '+' : ''}{fmtUsd(ptProfit)} / {fmtUsd(ptTarget)}
                  {ptReached && <span style={{ marginLeft: 4, fontSize: '0.7em' }}>✓</span>}
                </span>
              </div>
              <div style={{
                height: 3, borderRadius: 2,
                background: 'var(--bg-surface)',
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: 2,
                  width: `${(ptPct * 100).toFixed(1)}%`,
                  background: ptReached
                    ? 'linear-gradient(90deg, #ffc107, #ff9800)'
                    : ptPct > 0.7
                      ? 'linear-gradient(90deg, var(--green-bright), #00c853)'
                      : 'linear-gradient(90deg, var(--accent-cyan), var(--green-bright))',
                  transition: 'width 0.5s ease',
                }} />
              </div>
            </div>
          )}
          <div className="data-row">
            <span className="data-row__label">Trades</span>
            <span className="data-row__value">
              {stats ? `${stats.wins ?? 0}W/${stats.losses ?? 0}L` : '-'}
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

          {/* Portfolio — always visible */}
          <div style={{ borderTop: '1px solid var(--border-dim)', margin: '6px 0 5px' }} />
          <div style={{
            fontSize: '0.54rem', color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: '0.07em',
            marginBottom: 4,
          }}>
            Portfolio
          </div>
          {/* Active limit order — waiting for fill */}
          {limActive && (
            <div style={{
              padding: '4px 8px',
              marginBottom: 6,
              borderRadius: 4,
              background: 'rgba(255,193,7,0.08)',
              border: '1px solid rgba(255,193,7,0.25)',
              fontSize: '0.72rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#ffc107' }}>
                  LIMIT {limitOrder.side === 'UP' ? '↑' : '↓'} {limitOrder.side}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                  {limElapsedSec}s
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, color: 'var(--text-secondary)' }}>
                <span>{limitOrder.size} @ {(limitOrder.targetPrice * 100).toFixed(1)}¢</span>
                <span>${(limitOrder.targetPrice * limitOrder.size).toFixed(2)}</span>
              </div>
              <div style={{ fontSize: '0.6rem', color: '#ffc107', opacity: 0.8, marginTop: 2 }}>
                Waiting for fill...
              </div>
            </div>
          )}
          {/* Limit order filled — transition banner (persists ~20s) */}
          {!limActive && limFilled && (
            <div style={{
              padding: '4px 8px',
              marginBottom: 6,
              borderRadius: 4,
              background: 'rgba(76,175,80,0.12)',
              border: '1px solid rgba(76,175,80,0.35)',
              fontSize: '0.72rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#4caf50' }}>
                  FILLED {limEvent.side === 'UP' ? '↑' : '↓'} {limEvent.side}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                  {limEvent.ageSec}s ago
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, color: 'var(--text-secondary)' }}>
                <span>{limEvent.size} @ {(limEvent.price * 100).toFixed(1)}¢</span>
                <span>${(limEvent.price * limEvent.size).toFixed(2)}</span>
              </div>
            </div>
          )}
          {/* Limit order cancelled — transition banner (persists ~20s) */}
          {!limActive && limCancelled && (
            <div style={{
              padding: '4px 8px',
              marginBottom: 6,
              borderRadius: 4,
              background: 'rgba(244,67,54,0.08)',
              border: '1px solid rgba(244,67,54,0.25)',
              fontSize: '0.72rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#f44336' }}>
                  CANCELLED {limEvent.side === 'UP' ? '↑' : '↓'} {limEvent.side}
                </span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                  {limEvent.ageSec}s ago
                </span>
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: 2 }}>
                {limEvent.reason?.replace(/_/g, ' ') ?? 'unknown'}
              </div>
            </div>
          )}
          {botPosition ? (
            <>
              <div className="data-row">
                <span className="data-row__label">
                  {botPosition.side === 'UP' ? '↑ UP' : '↓ DOWN'}
                </span>
                <span className="data-row__value" style={{
                  fontWeight: 600,
                  color: rtPnl != null && rtPnl >= 0 ? 'var(--green-bright)' : rtPnl != null ? 'var(--red-bright)' : 'var(--text-primary)',
                }}>
                  {rtPositionValue != null ? fmtUsd(rtPositionValue) : fmtUsd(botPosition.cost)}
                  {rtPnl != null && (
                    <span style={{ fontSize: '0.75em', marginLeft: 3, opacity: 0.8 }}>
                      ({rtPnl >= 0 ? '+' : ''}{fmtUsd(rtPnl)})
                    </span>
                  )}
                </span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Bankroll</span>
                <span className="data-row__value" style={{ fontWeight: 600 }}>
                  {fmtUsd(data.bankroll, 0)}
                </span>
              </div>
              <div className="data-row">
                <span className="data-row__label">Total</span>
                <span className="data-row__value" style={{
                  fontWeight: 700,
                  color: rtPnl != null && rtPnl >= 0 ? 'var(--green-bright)' : rtPnl != null ? 'var(--red-bright)' : 'var(--text-primary)',
                }}>
                  {portfolioTotal != null ? fmtUsd(portfolioTotal) : '-'}
                </span>
              </div>
            </>
          ) : (
            <div className="data-row">
              <span className="data-row__label">Bankroll</span>
              <span className="data-row__value" style={{ fontWeight: 600 }}>
                {fmtUsd(data.bankroll, 0)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* RL Narrative — LLM insight on agent behavior (shows when loaded + narrative available) */}
      {rlLoaded && data.rlAgent?.narrative && (
        <div style={{
          marginBottom: 8,
          padding: '5px 10px',
          borderRadius: 'var(--radius-sm)',
          background: 'rgba(100,100,255,0.06)',
          border: '1px solid rgba(100,100,255,0.18)',
          fontSize: '0.65rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
        }}>
          <span style={{
            color: '#aaaaff',
            fontWeight: 600,
            fontSize: '0.56rem',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            marginRight: 6,
          }}>RL Insight</span>
          {data.rlAgent.narrative}
        </div>
      )}

      {/* Bottom status bar — pill-shaped tags */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 8px',
        fontSize: '0.65rem',
        color: 'var(--text-muted)',
        paddingTop: 8,
        borderTop: '1px solid var(--border-dim)',
      }}>
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
          BTC <b style={{ color: 'var(--text-primary)' }}>${fmt(data.btcPrice, 0)}</b>
        </span>
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
          PTB <b style={{ color: 'var(--text-primary)' }}>${fmt(data.priceToBeat, 0)}</b>
        </span>
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
          T:<b style={{ color: 'var(--text-primary)' }}>{fmt(data.timeLeftMin)}m</b>
        </span>
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
          UP:<b className="c-green">{fmt(data.marketUp, 2)}</b>
        </span>
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
          DN:<b className="c-red">{fmt(data.marketDown, 2)}</b>
        </span>
        {data.arbitrage && (
          <span className="status-pill" style={{
            padding: '2px 8px', fontSize: '0.62rem',
            color: data.arbitrage.found ? 'var(--green-bright)' : 'var(--text-dim)',
            fontWeight: data.arbitrage.found ? 700 : 400,
            borderColor: data.arbitrage.found ? 'rgba(0,230,118,0.2)' : undefined,
          }}>
            ARB:{data.arbitrage.found ? `${data.arbitrage.profitPct?.toFixed(1) ?? '?'}%` : 'no'}
          </span>
        )}
        {data.fillTracker && data.fillTracker.fillRate != null && (
          <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem' }}>
            Fill:{(data.fillTracker.fillRate * 100).toFixed(0)}%
            {data.fillTracker.pending && <b style={{ color: '#ffc107' }}> [pending]</b>}
          </span>
        )}
        {limitOrder?.enabled && (
          <span className="status-pill" style={{
            padding: '2px 8px', fontSize: '0.62rem',
            color: limActive ? '#ffc107' : limFilled ? '#4caf50' : limCancelled ? '#f44336' : 'var(--text-dim)',
            fontWeight: limActive || limFilled ? 700 : 400,
            borderColor: limActive ? 'rgba(255,193,7,0.3)' : limFilled ? 'rgba(76,175,80,0.3)' : limCancelled ? 'rgba(244,67,54,0.3)' : undefined,
          }}>
            LIM:{limActive
              ? `${limitOrder.side}@${(limitOrder.targetPrice * 100).toFixed(0)}¢`
              : limFilled
                ? `FILLED ${limEvent.side}@${(limEvent.price * 100).toFixed(0)}¢`
                : limCancelled
                  ? `X:${(limEvent.reason ?? '').replace(/_/g, ' ').slice(0, 15)}`
                  : 'idle'}
          </span>
        )}
        {data.signalStability && (
          <span className="status-pill" style={{
            padding: '2px 8px', fontSize: '0.62rem',
            color: data.signalStability.stable ? 'var(--green-bright)' : data.signalStability.recentFlips > 3 ? 'var(--red-bright)' : '#ffc107',
            fontWeight: 600,
            borderColor: data.signalStability.stable ? 'rgba(0,230,118,0.2)' : data.signalStability.recentFlips > 3 ? 'rgba(255,82,82,0.2)' : 'rgba(255,193,7,0.2)',
          }}>
            Stab:{data.signalStability.confirmCount}/{data.signalStability.confirmNeeded}
            {data.signalStability.recentFlips > 0 && ` F${data.signalStability.recentFlips}`}
            {data.signalStability.stable && ' \u2713'}
          </span>
        )}
        {/* MetEngine smart money gate status */}
        {data.metEngine?.enabled && (() => {
          const me = data.metEngine;
          const last = me.last;
          const isBlocked = last?.blocked === true;
          const isBoost   = last?.boost === true;
          const ageSec    = last?.ts ? Math.round((now - last.ts) / 1000) : null;
          const stale     = ageSec != null && ageSec > 120; // >2min stale
          const color     = !me.configured ? 'var(--text-dim)'
            : isBlocked ? 'var(--red-bright)'
            : isBoost   ? 'var(--green-bright)'
            : last      ? 'var(--text-muted)'
            : 'var(--text-dim)';
          const borderColor = isBlocked ? 'rgba(255,82,82,0.25)'
            : isBoost   ? 'rgba(0,230,118,0.25)'
            : undefined;
          const icon = !me.configured ? '?' : isBlocked ? '\u2297' : isBoost ? '\u2191' : '\u2013';
          return (
            <span className="status-pill" style={{
              padding: '2px 8px', fontSize: '0.62rem',
              color, fontWeight: isBlocked || isBoost ? 700 : 400,
              borderColor, opacity: stale ? 0.6 : 1,
            }} title={last?.reason ?? (me.configured ? 'MetEngine — no data yet' : 'MetEngine — key not set')}>
              ME:{icon}
              {last?.direction && ` ${last.direction}`}
              {last?.consensusStrength > 0 && ` ${(last.consensusStrength * 100).toFixed(0)}%`}
              {last?.insiderScore > 0 && ` ins:${last.insiderScore}`}
              {ageSec != null && stale && ` ${ageSec}s`}
            </span>
          );
        })()}
        <span className="status-pill" style={{ padding: '2px 8px', fontSize: '0.62rem', marginLeft: 'auto' }}>
          {data.sources?.binanceWs ? 'BinWS' : 'BinREST'}+{data.sources?.clobWs ? 'ClobWS' : 'ClobREST'}
        </span>
      </div>
    </div>
  );
}

export default memo(BotPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    prev.connected === next.connected &&
    a.paused === b.paused &&
    a.dryRun === b.dryRun &&
    a.rec?.action === b.rec?.action &&
    a.rec?.side === b.rec?.side &&
    a.rec?.confidence === b.rec?.confidence &&
    a.rec?.phase === b.rec?.phase &&
    a.ml?.confidence === b.ml?.confidence &&
    a.ml?.side === b.ml?.side &&
    a.edge?.bestEdge === b.edge?.bestEdge &&
    a.bankroll === b.bankroll &&
    a.regime === b.regime &&
    a.ensembleUp === b.ensembleUp &&
    a.stats?.wins === b.stats?.wins &&
    a.stats?.losses === b.stats?.losses &&
    a.stats?.dailyPnL === b.stats?.dailyPnL &&
    a.stats?.consecutiveLosses === b.stats?.consecutiveLosses &&
    a.marketUp === b.marketUp &&
    a.marketDown === b.marketDown &&
    a.positions?.botPosition?.side === b.positions?.botPosition?.side &&
    a.positions?.botPosition?.size === b.positions?.botPosition?.size &&
    a.arbitrage?.found === b.arbitrage?.found &&
    a.limitOrder?.phase === b.limitOrder?.phase &&
    a.limitOrder?.lastEvent?.type === b.limitOrder?.lastEvent?.type &&
    a.metEngine?.last?.ts === b.metEngine?.last?.ts &&
    a.signalStability?.confirmCount === b.signalStability?.confirmCount &&
    a.btcPrice === b.btcPrice &&
    a.fillTracker?.fillRate === b.fillTracker?.fillRate &&
    a.profitTarget?.profit === b.profitTarget?.profit &&
    a.profitTarget?.targetReached === b.profitTarget?.targetReached &&
    a.rlAgent?.narrative === b.rlAgent?.narrative
  );
});
