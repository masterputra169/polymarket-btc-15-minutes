import React, { memo, useState, useRef, useCallback } from 'react';
import { BET_SIZING } from '../config.js';

const RISK_COLORS = {
  AGGRESSIVE:   { bg: 'var(--green-bg)', color: 'var(--green-bright)', border: 'rgba(0,230,118,0.2)' },
  MODERATE:     { bg: 'var(--yellow-bg, rgba(255,193,7,0.1))', color: '#ffc107', border: 'rgba(255,193,7,0.2)' },
  CONSERVATIVE: { bg: 'rgba(100,181,246,0.08)', color: '#64b5f6', border: 'rgba(100,181,246,0.2)' },
  NO_BET:       { bg: 'var(--bg-elevated)', color: 'var(--text-dim)', border: 'var(--border-dim)' },
};

function BetSizingPanel({ data, setBankroll }) {
  const [editingBankroll, setEditingBankroll] = useState(false);
  const inputRef = useRef(null);

  const bet = data?.betSizing;
  const rec = data?.rec;

  const handleBankrollClick = useCallback(() => {
    setEditingBankroll(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const handleBankrollBlur = useCallback((e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val) && val > 0) {
      setBankroll(val);
    }
    setEditingBankroll(false);
  }, [setBankroll]);

  const handleBankrollKey = useCallback((e) => {
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') setEditingBankroll(false);
  }, []);

  if (!bet) return null;

  const risk = bet.riskLevel ?? 'NO_BET';
  const riskStyle = RISK_COLORS[risk] ?? RISK_COLORS.NO_BET;
  const barPct = bet.shouldBet ? Math.min((bet.betPercent / BET_SIZING.MAX_BET_PCT) * 100, 100) : 0;
  const impliedOdds = bet.shouldBet && bet.betPercent > 0
    ? (1 / (bet.side === 'UP' ? (data?.rec?.marketUp ?? 0.5) : (data?.rec?.marketDown ?? 0.5))).toFixed(2)
    : null;

  // Compute implied odds from market price stored in betSizing
  const mktPrice = bet.bankroll > 0 && bet.betAmount > 0 && bet.shouldBet
    ? bet.betAmount / bet.bankroll : 0;

  return (
    <div className="card" style={{ animationDelay: '0.35s', gridColumn: '1 / -1' }}>
      <div className="card__header">
        <span className="card__title">Asymmetric Bet</span>
        <span
          className="card__badge"
          style={{
            background: riskStyle.bg,
            color: riskStyle.color,
            border: `1px solid ${riskStyle.border}`,
          }}
        >
          {risk === 'NO_BET' ? 'NO BET' : risk}
        </span>
      </div>

      {bet.shouldBet ? (
        <>
          {/* Main bet size */}
          <div style={{ textAlign: 'center', margin: '8px 0 6px' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: riskStyle.color, letterSpacing: '-0.02em' }}>
              {(bet.betPercent * 100).toFixed(1)}%
              <span style={{ fontSize: '0.9rem', fontWeight: 500, marginLeft: 6, color: 'var(--text-muted)' }}>
                (${bet.betAmount.toFixed(2)})
              </span>
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-dim)', marginTop: 2 }}>
              {bet.side} &middot; Bankroll ${bet.bankroll.toLocaleString()}
            </div>
          </div>

          {/* Progress bar */}
          <div style={{
            height: 6, borderRadius: 3, background: 'var(--bg-elevated)',
            margin: '0 0 12px', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', borderRadius: 3, width: `${barPct}%`,
              background: riskStyle.color, transition: 'width 0.3s ease',
            }} />
          </div>

          {/* Kelly + EV row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
                <span className="data-row__label">Kelly (raw)</span>
                <span className="data-row__value">{bet.rawKelly != null ? (bet.rawKelly * 100).toFixed(1) : '-'}%</span>
              </div>
              <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
                <span className="data-row__label">Kelly (frac)</span>
                <span className="data-row__value">{bet.rawKelly != null ? (bet.rawKelly * (bet.kellyFraction ?? 0.25) * 100).toFixed(1) : '-'}%</span>
              </div>
            </div>
            <div>
              <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
                <span className="data-row__label">EV/Dollar</span>
                <span className={`data-row__value ${bet.expectedValue > 0 ? 'c-green' : 'c-red'}`}>
                  {bet.expectedValue != null ? `${bet.expectedValue > 0 ? '+' : ''}${bet.expectedValue.toFixed(2)}` : '-'}
                </span>
              </div>
              <div className="data-row" style={{ borderBottom: 'none', padding: '2px 0' }}>
                <span className="data-row__label">Adjusted</span>
                <span className="data-row__value">{bet.adjustedFraction != null ? (bet.adjustedFraction * 100).toFixed(2) : '-'}%</span>
              </div>
            </div>
          </div>

          {/* Multiplier cards */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6,
            marginBottom: 10,
          }}>
            {[
              { label: 'Regime', adj: bet.regimeAdj ?? { multiplier: 1.0, label: 'N/A' } },
              { label: 'Accuracy', adj: bet.accuracyAdj ?? { multiplier: 1.0, label: 'N/A' } },
              { label: 'ML', adj: bet.mlAdj ?? { multiplier: 1.0, label: 'N/A' } },
              { label: 'Confidence', adj: bet.confidenceAdj ?? { multiplier: 1.0, label: 'N/A' } },
              { label: 'Execution', adj: bet.executionAdj ?? { multiplier: 1.0, label: 'N/A' } },
            ].map(({ label, adj }) => (
              <div key={label} style={{
                background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-dim)', padding: '6px 8px',
                textAlign: 'center',
              }}>
                <div style={{ fontSize: '0.6rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                  {label}
                </div>
                <div style={{
                  fontSize: '0.85rem', fontWeight: 600,
                  color: adj.multiplier >= 1.0 ? 'var(--green-bright)' : adj.multiplier >= 0.80 ? '#ffc107' : 'var(--red-bright)',
                }}>
                  {adj.multiplier.toFixed(2)}x
                </div>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: 1 }}>
                  {adj.label}
                </div>
              </div>
            ))}
          </div>

          {/* Formula rationale */}
          <div style={{
            fontSize: '0.6rem', color: 'var(--text-dim)', padding: '6px 8px',
            background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-dim)', lineHeight: 1.5, wordBreak: 'break-word',
          }}>
            {bet.rationale}
          </div>
        </>
      ) : (
        /* NO BET state */
        <div style={{ textAlign: 'center', padding: '16px 0 12px' }}>
          <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6 }}>
            NO BET
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            {bet.rationale || 'No trade opportunity'}
          </div>
          <div style={{
            height: 6, borderRadius: 3, background: 'var(--bg-elevated)',
            margin: '10px 0 0', overflow: 'hidden',
          }}>
            <div style={{ height: '100%', width: 0 }} />
          </div>
        </div>
      )}

      {/* Bankroll editor */}
      <div style={{
        marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 6, fontSize: '0.7rem', color: 'var(--text-dim)',
      }}>
        <span>Bankroll:</span>
        {editingBankroll ? (
          <input
            ref={inputRef}
            type="number"
            defaultValue={bet.bankroll}
            onBlur={handleBankrollBlur}
            onKeyDown={handleBankrollKey}
            style={{
              width: 80, background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
              padding: '2px 6px', fontSize: '0.7rem', textAlign: 'center',
            }}
          />
        ) : (
          <span
            onClick={handleBankrollClick}
            style={{
              cursor: 'pointer', padding: '2px 8px', borderRadius: 'var(--radius-sm)',
              border: '1px dashed var(--border-dim)', color: 'var(--text-primary)',
              fontWeight: 500,
            }}
            title="Click to edit bankroll"
          >
            ${bet.bankroll.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

export default memo(BetSizingPanel, (prev, next) => {
  const a = prev.data?.betSizing;
  const b = next.data?.betSizing;
  if (!a || !b) return a === b;
  return (
    a.betPercent === b.betPercent &&
    a.shouldBet === b.shouldBet &&
    a.riskLevel === b.riskLevel &&
    a.bankroll === b.bankroll &&
    a.side === b.side
  );
});
