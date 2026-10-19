import React, { memo } from 'react';

interface JevLast {
  ts?: number | null;
  slug?: string | null;
  model?: string | null;
  direction?: string | null;
  directionConfidence?: number | null;
  settleUpProbability?: number | null;
  regime?: string | null;
  regimeConfidence?: number | null;
  latencyMs?: number | null;
  costUsd?: number | null;
}

export interface JevStatusData {
  enabled?: boolean;
  configured?: boolean;
  mode?: string;
  provider?: string;
  model?: string | null;
  shadowMode?: boolean;
  calls?: number;
  errors?: number | null;
  lastLatencyMs?: number | null;
  lastCostUsd?: number | null;
  totalCostUsd?: number | null;
  lastError?: string | null;
  last?: JevLast | null;
}

const MODE_COLOR: Record<string, string> = {
  shadow: 'var(--text-secondary)',
  veto: 'var(--yellow-bright)',
  gate: 'var(--yellow-bright)',
  primary: 'var(--green-bright)',
};

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '-' : Math.round(v * 100) + '%';
}

function ageText(ts: number | null | undefined): string {
  if (!ts) return '-';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? s + 's lalu' : Math.floor(s / 60) + 'm lalu';
}

const JevPanel = memo(function JevPanel({ data }: { data: JevStatusData | null }) {
  if (!data) return null;
  const mode = data.mode ?? (data.shadowMode === false ? 'veto' : 'shadow');
  const last = data.last ?? null;
  const tone = !data.enabled || !data.configured ? 'var(--text-muted)' : MODE_COLOR[mode] ?? 'var(--text-secondary)';
  return (
    <div className="card span-2" style={{ animationDelay: '0.25s' }}>
      <div className="card__header">
        <span className="card__title">JEV / TypeSafe</span>
        <span className={`card__badge ${data.enabled && data.configured ? 'badge--live' : ''}`} style={{ color: tone }}>
          {data.enabled ? (data.configured ? mode.toUpperCase() : 'NO KEY') : 'OFF'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: 'var(--text-muted)' }}>
          {data.provider ?? 'openrouter'} · {data.model ?? 'typesafe/jev-1.14'}
        </span>
      </div>
      {last ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
          <div className="data-row"><span className="data-row__label">Direction</span>
            <span className="data-row__value" style={{ color: last.direction === 'NO_EDGE' ? 'var(--text-secondary)' : last.direction === 'UP' ? 'var(--green-bright)' : 'var(--red-bright)', fontWeight: 700 }}>
              {last.direction ?? '-'} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({pct(last.directionConfidence)})</span>
            </span></div>
          <div className="data-row"><span className="data-row__label">Settle UP</span>
            <span className="data-row__value">{pct(last.settleUpProbability)}</span></div>
          <div className="data-row"><span className="data-row__label">Regime</span>
            <span className="data-row__value">{last.regime ?? '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Latency</span>
            <span className="data-row__value">{last.latencyMs != null ? Math.round(last.latencyMs) + 'ms' : '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Cost</span>
            <span className="data-row__value">{last.costUsd != null ? '$' + last.costUsd.toFixed(6) : '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Update</span>
            <span className="data-row__value">{ageText(last.ts)}</span></div>
        </div>
      ) : (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          {data.enabled && data.configured ? 'Menunggu market berikutnya (call sekali per market).' : data.enabled ? 'Isi TYPESAFE_API_KEY / OPENROUTER_API_KEY untuk mengaktifkan.' : 'JEV dimatikan (JEV_ENABLED=false).'}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: '0.64rem', color: 'var(--text-muted)' }}>
        calls {data.calls ?? 0} · errors {data.errors ?? 0} · last latency {data.lastLatencyMs != null ? Math.round(data.lastLatencyMs) + 'ms' : '-'}
        {data.totalCostUsd != null ? ' · total $' + data.totalCostUsd.toFixed(4) : ''}
        {data.lastError ? ' · ' + data.lastError.slice(0, 80) : ''}
      </div>
    </div>
  );
});

export default JevPanel;
