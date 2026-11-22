import React, { memo } from 'react';

interface JevLast {
  ts?: number | null;
  slug?: string | null;
  model?: string | null;
  direction?: string | null;
  directionConfidence?: number | null;
  settleUpProbability?: number | null;
  settleUpCalibrated?: number | null;
  bayesianProbUp?: number | null;
  regime?: string | null;
  regimeConfidence?: number | null;
  compositeRisk?: number | null;
  riskConfidence?: number | null;
  chopHazard?: number | null;
  exhaustionRisk?: number | null;
  flowContradiction?: number | null;
  bullStrength?: number | null;
  bearStrength?: number | null;
  netConviction?: number | null;
  debateDisagreement?: number | null;
  effectiveRiskThreshold?: number | null;
  selfConsistent?: boolean;
  route?: string | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  marketUp?: number | null;
  marketDown?: number | null;
}

interface JevBrierSkill {
  status?: 'warmup' | 'pass' | 'demoted';
  samples?: number;
  jevBrier?: number | null;
  marketBrier?: number | null;
  skillScore?: number | null;
}

export interface JevStatusData {
  enabled?: boolean;
  configured?: boolean;
  mode?: string;
  provider?: string;
  model?: string | null;
  calibrationVersion?: string | null;
  effectiveRiskThreshold?: number | null;
  brierSkill?: JevBrierSkill | null;
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
  const settle = last?.bayesianProbUp ?? last?.settleUpCalibrated ?? last?.settleUpProbability ?? null;
  const upEdge = settle != null && last?.marketUp != null ? settle - last.marketUp : null;
  const downEdge = settle != null && last?.marketDown != null ? (1 - settle) - last.marketDown : null;
  const risk = last?.compositeRisk ?? null;
  const riskThresh = last?.effectiveRiskThreshold ?? data.effectiveRiskThreshold ?? 0.78;
  const skill = data.brierSkill ?? null;
  const tone = !data.enabled || !data.configured ? 'var(--text-muted)' : MODE_COLOR[mode] ?? 'var(--text-secondary)';
  const riskColor = risk == null ? 'var(--text-muted)' : risk >= riskThresh ? 'var(--red-bright)' : risk >= 0.55 ? 'var(--yellow-bright)' : 'var(--green-bright)';
  return (
    <div className="card span-2" style={{ animationDelay: '0.25s' }}>
      <div className="card__header">
        <span className="card__title">JEV / TypeSafe</span>
        <span className={`card__badge ${data.enabled && data.configured ? 'badge--live' : ''}`} style={{ color: tone }}>
          {data.enabled ? (data.configured ? mode.toUpperCase() : 'NO KEY') : 'OFF'}
        </span>
        {skill && (
          <span
            className="card__badge"
            title={skill.jevBrier != null && skill.marketBrier != null ? `JEV Brier ${skill.jevBrier.toFixed(4)} vs Mkt ${skill.marketBrier.toFixed(4)} (n=${skill.samples})` : undefined}
            style={{
              marginLeft: 6,
              color: skill.status === 'pass' ? 'var(--green-bright)' : skill.status === 'demoted' ? 'var(--red-bright)' : 'var(--text-muted)',
            }}
          >
            BS {skill.status?.toUpperCase() ?? 'WARM'}{skill.samples ? ` (${skill.samples})` : ''}
          </span>
        )}
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
            <span className="data-row__value" title={last.settleUpProbability != null ? `Raw ${pct(last.settleUpProbability)} -> Cal ${pct(last.settleUpCalibrated)} -> Bayes ${pct(last.bayesianProbUp)}` : undefined}>
              {pct(settle)}
            </span></div>
          <div className="data-row"><span className="data-row__label">Risk Desk</span>
            <span
              className="data-row__value"
              style={{ color: riskColor, fontWeight: 600 }}
              title={risk != null ? `Chop ${pct(last.chopHazard)} | Exhaust ${pct(last.exhaustionRisk)} | Flow ${pct(last.flowContradiction)} | Thresh ${pct(riskThresh)}` : undefined}
            >
              {pct(risk)} <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.62rem' }}>/ {pct(riskThresh)}</span>
            </span></div>
          {last.netConviction != null && (
            <div className="data-row"><span className="data-row__label">Bull/Bear</span>
              <span
                className="data-row__value"
                style={{ color: last.netConviction > 0.1 ? 'var(--green-bright)' : last.netConviction < -0.1 ? 'var(--red-bright)' : 'var(--text-secondary)', fontWeight: 600 }}
                title={`Bull ${pct(last.bullStrength)} vs Bear ${pct(last.bearStrength)} | Disagreement ${pct(last.debateDisagreement)}${last.selfConsistent === false ? ' | Self-consistency conflict' : ''}`}
              >
                {(last.netConviction >= 0 ? '+' : '') + Math.round(last.netConviction * 100)}% <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.62rem' }}>(dis {pct(last.debateDisagreement)})</span>
              </span></div>
          )}
          <div className="data-row"><span className="data-row__label">Regime</span>
            <span className="data-row__value">{last.regime ?? '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Latency</span>
            <span className="data-row__value">{last.latencyMs != null ? Math.round(last.latencyMs) + 'ms' : '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Cost</span>
            <span className="data-row__value">{last.costUsd != null ? '$' + last.costUsd.toFixed(6) : '-'}</span></div>
          <div className="data-row"><span className="data-row__label">Edge vs mkt</span>
            <span className="data-row__value" style={{ fontSize: '0.68rem' }}>
              UP {upEdge != null ? (upEdge >= 0 ? '+' : '') + (upEdge * 100).toFixed(0) + 'pp' : '-'} / DOWN {downEdge != null ? (downEdge >= 0 ? '+' : '') + (downEdge * 100).toFixed(0) + 'pp' : '-'}
            </span></div>
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
        {skill?.skillScore != null ? ' · skill ' + (skill.skillScore >= 0 ? '+' : '') + (skill.skillScore * 100).toFixed(1) + '%' : ''}
        {data.calibrationVersion ? ' · ' + data.calibrationVersion : ''}
        {data.lastError ? ' · ' + data.lastError.slice(0, 80) : ''}
      </div>
    </div>
  );
});

export default JevPanel;
