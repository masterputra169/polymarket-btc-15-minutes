import React, { memo } from 'react';

function accBarColor(acc) {
  if (acc === null) return 'var(--border-dim)';
  if (acc >= 0.60) return 'var(--green-mid)';
  if (acc >= 0.50) return 'var(--yellow-mid, #ffc107)';
  return 'var(--red-mid)';
}

function RollingBar({ label, acc, count }) {
  const pct = acc !== null ? Math.round(acc * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', width: 52, flexShrink: 0 }}>{label}</span>
      <div style={{
        flex: 1, height: 16, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden',
        position: 'relative', border: '1px solid var(--border-dim)',
      }}>
        {acc !== null && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: accBarColor(acc), transition: 'width 0.6s ease' }} />}
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.62rem', fontWeight: 600, color: '#fff', zIndex: 1 }}>
          {acc !== null ? pct + '%' : '-'}
        </span>
      </div>
      <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', width: 20, textAlign: 'right' }}>{count ?? ''}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontSize: '0.62rem', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
      {children}
    </div>
  );
}

function AccuracyPanel({ data }) {
  if (!data) return null;
  const df = data.detailedFeedback ?? null;
  const journal = data.journal ?? null;
  const sample = df?.totalSettled ?? 0;
  const confMul = data.feedbackStats?.confidenceMultiplier ?? 1.0;
  const streak = df?.streak ?? { type: 'none', count: 0 };
  const regimeNames = ['trending', 'moderate', 'choppy', 'mean_reverting'];
  const regimeLabels = { trending: 'Trend', moderate: 'Moderate', choppy: 'Choppy', mean_reverting: 'M.Rev' };

  return (
    <div className="card span-2" style={{ animationDelay: '0.29s' }}>
      <div className="card__header">
        <span className="card__title">Accuracy</span>
        {journal
          ? <span className="card__badge badge--live">{journal.totalTrades} TRADES</span>
          : <span className="card__badge badge--loading">TRACKING</span>}
        {journal?.brier != null && (
          <span className="card__badge" style={{ background: 'var(--bg-elevated)', color: journal.brier <= 0.20 ? 'var(--green-mid)' : journal.brier <= 0.25 ? 'var(--yellow-mid, #ffc107)' : 'var(--red-mid)' }}>
            Brier/CRPS {journal.brier.toFixed(4)}
          </span>
        )}
      </div>

      {journal && (
        <div style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid var(--border-dim)' }}>
          <SectionTitle>Trade accuracy — full journal</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <div className="data-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <span className="data-row__label">Trades</span>
              <span className="data-row__value" style={{ fontWeight: 700 }}>{journal.totalTrades}</span>
            </div>
            <div className="data-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <span className="data-row__label">Win rate</span>
              <span className="data-row__value" style={{ fontWeight: 700, color: journal.overallWr >= 55 ? 'var(--green-bright)' : journal.overallWr >= 50 ? 'var(--yellow-bright)' : 'var(--red-bright)' }}>
                {(journal.overallWr ?? 0).toFixed(1)}%
              </span>
            </div>
            <div className="data-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <span className="data-row__label">Net P&amp;L</span>
              <span className="data-row__value" style={{ fontWeight: 700, color: (journal.totalPnl ?? 0) >= 0 ? 'var(--green-bright)' : 'var(--red-bright)' }}>
                {(journal.totalPnl ?? 0) >= 0 ? '+' : ''}{(journal.totalPnl ?? 0).toFixed(2)}
              </span>
            </div>
            <div className="data-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <span className="data-row__label">ROI</span>
              <span className="data-row__value" style={{ fontWeight: 700 }}>{(journal.roi ?? 0).toFixed(1)}%</span>
            </div>
          </div>
          <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: 4 }}>
            {journal.totalWins}W / {journal.totalLosses}L · avg win +{(journal.avgPnlWin ?? 0).toFixed(2)} · avg loss {(journal.avgPnlLoss ?? 0).toFixed(2)} · avg hold {Math.round((journal.avgHoldWin ?? 0) / 60)}m
          </div>
          <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: 2 }}>
            Brier/CRPS {journal.brier != null ? journal.brier.toFixed(4) : '-'} (n={journal.brierN ?? 0}) · logloss {journal.logLoss != null ? journal.logLoss.toFixed(4) : '-'} — binary CRPS = Brier
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <SectionTitle>Prediction sample — rolling (last 24h)</SectionTitle>
        <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: 6 }}>
          n={sample} settled prediction{sample === 1 ? '' : 's'} · rolling bars need 20/50/100
        </div>
        <RollingBar label="Last 20" acc={df?.rolling?.last20 ?? null} count={sample >= 20 ? 20 : null} />
        <RollingBar label="Last 50" acc={df?.rolling?.last50 ?? null} count={sample >= 50 ? 50 : null} />
        <RollingBar label="Last 100" acc={df?.rolling?.last100 ?? null} count={sample >= 100 ? 100 : null} />
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="data-row" style={{ flex: 1, minWidth: 120 }}>
          <span className="data-row__label">Streak (sample)</span>
          <span className="data-row__value" style={{ fontWeight: 600, color: streak.type === 'win' ? 'var(--green-bright)' : streak.type === 'loss' ? 'var(--red-bright)' : 'var(--text-muted)' }}>
            {streak.type === 'win' ? streak.count + 'W' : streak.type === 'loss' ? streak.count + 'L' : '-'}
          </span>
        </div>
        <div className="data-row" style={{ flex: 1, minWidth: 120 }}>
          <span className="data-row__label">Conf. Mult.</span>
          <span className="data-row__value" style={{ fontWeight: 600, color: confMul >= 1.05 ? 'var(--green-bright)' : confMul < 0.90 ? 'var(--red-bright)' : 'var(--text-muted)' }}>
            {confMul.toFixed(2)}x
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <SectionTitle>Prediction sample — per regime</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {regimeNames.map(r => {
            const rd = df?.regimes?.[r];
            const acc = rd?.accuracy ?? null;
            const total = rd?.total ?? 0;
            return (
              <div key={r} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginBottom: 3, textTransform: 'uppercase' }}>{regimeLabels[r] ?? r}</div>
                <div style={{ fontWeight: 700, fontSize: '0.88rem', color: acc === null ? 'var(--text-muted)' : acc >= 0.60 ? 'var(--green-bright)' : acc >= 0.50 ? 'var(--yellow-bright)' : 'var(--red-bright)' }}>
                  {acc !== null ? Math.round(acc * 100) + '%' : '-'}
                </div>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-dim)' }}>n={total}</div>
              </div>
            );
          })}
        </div>
      </div>

      {data.signalPerf && data.signalPerf.some(s => s.fired > 0) && (
        <div style={{ marginBottom: 12 }}>
          <SectionTitle>Signal performance</SectionTitle>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', gap: '2px 8px', fontSize: '0.68rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Signal</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Acc (EMA)</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>CRPS</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Mod</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>n</span>
            {data.signalPerf.filter(s => s.fired > 0).map(s => {
              const pct = Math.round(s.emaAccuracy * 100);
              const barColor = s.emaAccuracy >= 0.60 ? 'var(--green-mid)' : s.emaAccuracy >= 0.50 ? 'var(--yellow-mid, #ffc107)' : 'var(--red-mid)';
              return (
                <React.Fragment key={s.key}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.62rem' }}>{s.key}</span>
                  <div style={{ height: 14, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden', position: 'relative', border: '1px solid var(--border-dim)' }}>
                    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: pct + '%', background: barColor, transition: 'width 0.6s ease' }} />
                    <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.58rem', fontWeight: 600, color: '#fff', zIndex: 1 }}>{pct}%</span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem', textAlign: 'right' }}>{s.avgCrps != null ? s.avgCrps.toFixed(3) : '-'}</span>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: '0.62rem', textAlign: 'right' }}>{s.hasEnoughData ? s.modifier.toFixed(2) + 'x' : '-'}</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.62rem', textAlign: 'right' }}>{s.fired}</span>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <SectionTitle>Calibration — prediction sample</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr auto', gap: '2px 10px', fontSize: '0.68rem' }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Bucket</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Expected</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Actual</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>n</span>
          {(df?.calibration ?? []).filter(c => c.total > 0).map((c, i) => (
            <React.Fragment key={i}>
              <span style={{ color: 'var(--text-secondary)' }}>{c.range}</span>
              <span style={{ color: 'var(--text-muted)' }}>{(c.predicted * 100).toFixed(0)}%</span>
              <span style={{ fontWeight: 600, color: c.actual === null ? 'var(--text-muted)' : c.actual >= c.predicted ? 'var(--green-bright)' : 'var(--red-bright)' }}>
                {c.actual !== null ? (c.actual * 100).toFixed(0) + '%' : '-'}
              </span>
              <span style={{ color: 'var(--text-dim)' }}>{c.total}</span>
            </React.Fragment>
          ))}
        </div>
        {(!df || (df.calibration ?? []).every(c => c.total === 0)) && (
          <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)', marginTop: 4 }}>No settled predictions in this sample yet.</div>
        )}
      </div>
    </div>
  );
}

export default memo(AccuracyPanel);
