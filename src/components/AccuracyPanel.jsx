import React, { memo } from 'react';

function AccuracyPanel({ data }) {
  if (!data) return null;

  const { feedbackStats, detailedFeedback, signalPerf, overallCRPS } = data;
  const df = detailedFeedback;

  if (!df || df.totalSettled < 5) {
    return (
      <div className="card span-2" style={{ animationDelay: '0.29s' }}>
        <div className="card__header">
          <span className="card__title">Accuracy</span>
          <span className="card__badge badge--loading">TRACKING</span>
        </div>
        <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>
          Need 5+ settled predictions ({df?.totalSettled ?? 0}/5)
        </div>
      </div>
    );
  }

  const streak = df.streak ?? { type: 'none', count: 0 };
  const confMul = feedbackStats?.confidenceMultiplier ?? 1.0;

  function accColor(acc) {
    if (acc === null) return 'c-muted';
    if (acc >= 0.60) return 'c-green';
    if (acc >= 0.50) return 'c-yellow';
    return 'c-red';
  }

  function accBarColor(acc) {
    if (acc === null) return 'var(--border-dim)';
    if (acc >= 0.60) return 'var(--green-mid)';
    if (acc >= 0.50) return 'var(--yellow-mid, #ffc107)';
    return 'var(--red-mid)';
  }

  function RollingBar({ label, acc, count }) {
    const pct = acc !== null ? Math.round(acc * 100) : 0;
    const show = acc !== null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', width: 52, flexShrink: 0 }}>
          {label}
        </span>
        <div style={{
          flex: 1, height: 16, background: 'var(--bg-elevated)',
          borderRadius: 3, overflow: 'hidden', position: 'relative',
          border: '1px solid var(--border-dim)',
        }}>
          {show && (
            <div style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${pct}%`, background: accBarColor(acc),
              transition: 'width 0.6s ease',
            }} />
          )}
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.62rem', fontWeight: 600, color: '#fff', zIndex: 1,
          }}>
            {show ? `${pct}%` : '-'}
          </span>
        </div>
        <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)', width: 20, textAlign: 'right' }}>
          {count ?? ''}
        </span>
      </div>
    );
  }

  const regimeNames = ['trending', 'moderate', 'choppy', 'mean_reverting'];
  const regimeLabels = { trending: 'Trend', moderate: 'Moderate', choppy: 'Choppy', mean_reverting: 'M.Rev' };

  return (
    <div className="card span-2" style={{ animationDelay: '0.29s' }}>
      <div className="card__header">
        <span className="card__title">Accuracy</span>
        <span className="card__badge badge--live">{df.totalSettled} SETTLED</span>
        {overallCRPS != null && (
          <span className="card__badge" style={{ background: 'var(--bg-elevated)', color: overallCRPS <= 0.20 ? 'var(--green-mid)' : overallCRPS <= 0.25 ? 'var(--yellow-mid, #ffc107)' : 'var(--red-mid)' }}>
            CRPS {overallCRPS.toFixed(3)}
          </span>
        )}
      </div>

      {/* Rolling Accuracy */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontSize: '0.62rem', color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
        }}>
          Rolling Accuracy
        </div>
        <RollingBar label="Last 20" acc={df.rolling?.last20 ?? null} count={df.totalSettled >= 20 ? 20 : null} />
        <RollingBar label="Last 50" acc={df.rolling?.last50 ?? null} count={df.totalSettled >= 50 ? 50 : null} />
        <RollingBar label="Last 100" acc={df.rolling?.last100 ?? null} count={df.totalSettled >= 100 ? 100 : null} />
      </div>

      {/* Streak + Confidence Multiplier */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="data-row" style={{ flex: 1, minWidth: 120 }}>
          <span className="data-row__label">Streak</span>
          <span className={`data-row__value ${streak.type === 'win' ? 'c-green' : streak.type === 'loss' ? 'c-red' : 'c-muted'}`}
                style={{ fontWeight: 600 }}>
            {streak.type === 'win' ? `${streak.count}W` : streak.type === 'loss' ? `${streak.count}L` : '-'}
          </span>
        </div>
        <div className="data-row" style={{ flex: 1, minWidth: 120 }}>
          <span className="data-row__label">Conf. Mult.</span>
          <span className={`data-row__value ${confMul >= 1.05 ? 'c-green' : confMul < 0.90 ? 'c-red' : 'c-muted'}`}
                style={{ fontWeight: 600 }}>
            {confMul.toFixed(2)}x
          </span>
        </div>
      </div>

      {/* Per-Regime Accuracy */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          fontSize: '0.62rem', color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
        }}>
          Per-Regime Accuracy
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {regimeNames.map(r => {
            const rd = df.regimes?.[r];
            const acc = rd?.accuracy ?? null;
            const total = rd?.total ?? 0;
            return (
              <div key={r} style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-dim)',
                borderRadius: 'var(--radius-sm)',
                padding: '6px 8px', textAlign: 'center',
              }}>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-dim)', marginBottom: 3, textTransform: 'uppercase' }}>
                  {regimeLabels[r] ?? r}
                </div>
                <div className={accColor(acc)} style={{ fontWeight: 700, fontSize: '0.88rem' }}>
                  {acc !== null ? `${(acc * 100).toFixed(0)}%` : '-'}
                </div>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-dim)' }}>
                  n={total}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Signal Performance */}
      {signalPerf && signalPerf.some(s => s.fired > 0) && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: '0.62rem', color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
          }}>
            Signal Performance
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', gap: '2px 8px', fontSize: '0.68rem', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Signal</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Acc (EMA)</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>CRPS</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Mod</span>
            <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>n</span>
            {signalPerf.filter(s => s.fired > 0).map(s => {
              const pct = Math.round(s.emaAccuracy * 100);
              const barColor = s.emaAccuracy >= 0.60 ? 'var(--green-mid)' : s.emaAccuracy >= 0.50 ? 'var(--yellow-mid, #ffc107)' : 'var(--red-mid)';
              const modColor = !s.hasEnoughData ? 'var(--text-dim)' : s.modifier > 1.05 ? 'var(--green-mid)' : s.modifier < 0.95 ? 'var(--red-mid)' : 'var(--text-muted)';
              return (
                <React.Fragment key={s.key}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.62rem' }}>{s.key}</span>
                  <div style={{
                    height: 14, background: 'var(--bg-elevated)',
                    borderRadius: 2, overflow: 'hidden', position: 'relative',
                    border: '1px solid var(--border-dim)',
                  }}>
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: `${pct}%`, background: barColor,
                      transition: 'width 0.6s ease',
                    }} />
                    <span style={{
                      position: 'absolute', inset: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.58rem', fontWeight: 600, color: '#fff', zIndex: 1,
                    }}>
                      {pct}%
                    </span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem', textAlign: 'right' }}>
                    {s.avgCrps != null ? s.avgCrps.toFixed(3) : '-'}
                  </span>
                  <span style={{ color: modColor, fontWeight: 600, fontSize: '0.62rem', textAlign: 'right' }}>
                    {s.hasEnoughData ? s.modifier.toFixed(2) + 'x' : '-'}
                  </span>
                  <span style={{ color: 'var(--text-dim)', fontSize: '0.62rem', textAlign: 'right' }}>
                    {s.fired}
                  </span>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {/* Calibration */}
      <div>
        <div style={{
          fontSize: '0.62rem', color: 'var(--text-dim)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
        }}>
          Calibration (Predicted vs Actual)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr auto', gap: '2px 10px', fontSize: '0.68rem' }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Bucket</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Expected</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Actual</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>n</span>
          {(df.calibration ?? []).filter(c => c.total > 0).map((c, i) => {
            const diff = c.actual !== null ? c.actual - c.predicted : null;
            const diffColor = diff === null ? 'c-muted' : diff >= 0 ? 'c-green' : 'c-red';
            return (
              <React.Fragment key={i}>
                <span style={{ color: 'var(--text-secondary)' }}>{c.range}</span>
                <span style={{ color: 'var(--text-muted)' }}>{(c.predicted * 100).toFixed(0)}%</span>
                <span className={diffColor} style={{ fontWeight: 600 }}>
                  {c.actual !== null ? `${(c.actual * 100).toFixed(0)}%` : '-'}
                </span>
                <span style={{ color: 'var(--text-dim)' }}>{c.total}</span>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default memo(AccuracyPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.detailedFeedback?.totalSettled === b.detailedFeedback?.totalSettled &&
    a.feedbackStats?.accuracy === b.feedbackStats?.accuracy &&
    a.feedbackStats?.confidenceMultiplier === b.feedbackStats?.confidenceMultiplier &&
    a.detailedFeedback?.streak?.count === b.detailedFeedback?.streak?.count &&
    a.detailedFeedback?.streak?.type === b.detailedFeedback?.streak?.type &&
    a.overallCRPS === b.overallCRPS
  );
});
