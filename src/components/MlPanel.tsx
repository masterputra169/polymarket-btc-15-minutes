import React, { memo, useEffect, useState } from 'react';
import { formatProbPct } from '../utils.ts';
import { ML_CONFIDENCE } from '../config.ts';
import ModelProfileDrawer, {
  type ModelConfigProfile,
  type ModelControlState,
  type StoredModelSummary,
} from './ModelProfileDrawer.tsx';

interface MlPanelProps {
  data: any;
  sendBotCommand?: (type: string, payload?: Record<string, any>) => Promise<any>;
}

function fmtModelOption(m: StoredModelSummary, activeId: string | null): string {
  const win = m.windowDays ? `${m.windowDays}d` : `p${m.featurePipeline}`;
  const acc = m.accuracy != null ? `${(m.accuracy * 100).toFixed(1)}%` : '-';
  const tag = m.id === activeId ? ' [ACTIVE]' : '';
  const prof = m.profileLabel ? ` (${m.profileLabel})` : m.hasProfile ? ' (custom)' : '';
  return `${m.id} • ${win} • acc ${acc}${prof}${tag}`;
}

const EMPTY_MODELS: StoredModelSummary[] = [];

function MLPanel({ data, sendBotCommand }: MlPanelProps) {
  const ml = data?.ml;
  const mlControl = data?.mlControl as ModelControlState | undefined;
  const models = mlControl?.models ?? EMPTY_MODELS;
  const activeModelId = mlControl?.activeModelId ?? ml?.modelId ?? null;
  const [selectedId, setSelectedId] = useState<string>(() => activeModelId || models[0]?.id || '');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchStatus, setSwitchStatus] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!selectedId && (activeModelId || models[0]?.id)) {
      setSelectedId(activeModelId || models[0].id);
      return;
    }
    if (selectedId && models.length > 0 && !models.some(m => m.id === selectedId)) {
      setSelectedId(activeModelId || models[0].id);
    }
  }, [activeModelId, models, selectedId]);

  if (!data) return null;

  const { pLong, pShort, rawUp, ruleUp } = data as {
    pLong: number;
    pShort: number;
    rawUp: number;
    ruleUp: number;
  };
  const mlReady = ml?.status === 'ready';

  const activeSummary = models.find(m => m.id === activeModelId) ?? null;
  const selectedSummary = models.find(m => m.id === selectedId) ?? activeSummary ?? null;
  const isSelectedActive = Boolean(selectedId && activeModelId && selectedId === activeModelId);

  const handleSwitchModel = async (targetId: string) => {
    if (!sendBotCommand || !targetId || switching) return;
    setSwitching(true);
    setSwitchStatus(null);
    try {
      const res = await sendBotCommand('switchMlModel', { modelId: targetId });
      if (!res?.ok) {
        setSwitchStatus({ kind: 'err', text: `Switch failed: ${res?.error || 'unknown error'}` });
      } else {
        setSelectedId(res.modelId || targetId);
        setSwitchStatus({
          kind: res.warning ? 'warn' : 'ok',
          text: res.warning
            ? `Switched to ${res.modelId || targetId} (${res.warning})`
            : `Switched active model to ${res.modelId || targetId}`,
        });
      }
    } catch (err: any) {
      setSwitchStatus({ kind: 'err', text: err?.message || 'Switch command failed' });
    } finally {
      setSwitching(false);
    }
  };

  const handleSaveProfile = async (
    modelId: string,
    profile: ModelConfigProfile,
    switchAfter: boolean,
  ) => {
    if (!sendBotCommand) return { ok: false, error: 'offline' };
    const saveRes = await sendBotCommand('saveModelProfile', { modelId, profile });
    if (!saveRes?.ok) return saveRes;
    if (switchAfter && modelId !== activeModelId) {
      const swRes = await sendBotCommand('switchMlModel', { modelId });
      if (!swRes?.ok) {
        return { ok: false, error: `Profile saved, switch failed: ${swRes?.error || 'unknown'}` };
      }
      setSelectedId(swRes.modelId || modelId);
      setSwitchStatus({
        kind: swRes.warning ? 'warn' : 'ok',
        text: swRes.warning
          ? `Saved & switched to ${swRes.modelId} (${swRes.warning})`
          : `Saved profile & switched to ${swRes.modelId}`,
      });
    }
    return saveRes;
  };

  const handleResetProfile = async (modelId: string) => {
    if (!sendBotCommand) return { ok: false, error: 'offline' };
    return sendBotCommand('resetModelProfile', { modelId });
  };

  // ML values
  const mlProbUp = ml?.probUp;
  const mlConfidence = ml?.confidence;
  const mlSide = ml?.side;
  const ensembleProbUp = ml?.ensembleProbUp;
  const alpha = ml?.alpha;
  const source = ml?.source;

  // Rule-based values (use ruleUp, NOT pLong which is now ensemble)
  const ruleProbUp = ruleUp ?? pLong;

  // Ensemble direction
  const ensembleSide = ensembleProbUp !== null && ensembleProbUp !== undefined
    ? ensembleProbUp >= 0.5 ? 'UP' : 'DOWN'
    : null;

  // Agreement check
  const ruleAgreesWithMl =
    mlSide && ruleProbUp !== null
      ? (mlSide === 'UP' && ruleProbUp >= 0.5) || (mlSide === 'DOWN' && ruleProbUp < 0.5)
      : null;

  // Confidence tier
  const getConfTier = (conf) => {
    if (conf === null || conf === undefined) return { label: '-', color: 'c-muted' };
    if (conf >= ML_CONFIDENCE.HIGH) return { label: 'HIGH', color: 'c-green' };
    if (conf >= ML_CONFIDENCE.MEDIUM) return { label: 'MEDIUM', color: 'c-yellow' };
    return { label: 'LOW', color: 'c-red' };
  };

  const mlConfTier = getConfTier(mlConfidence);
  const isHighConfidence = mlConfidence !== null && mlConfidence >= ML_CONFIDENCE.HIGH;

  // Alpha bar width (use != null to catch both null and undefined)
  const alphaBarPct = alpha != null ? Math.round(alpha * 100) : 0;

  // Status badge
  const statusBadge = mlReady
    ? { text: 'ACTIVE', cls: 'badge--live' }
    : ml?.status === 'loading'
      ? { text: 'LOADING', cls: 'badge--loading' }
      : ml?.status === 'error'
        ? { text: 'ERROR', cls: 'badge--offline' }
        : { text: 'OFF', cls: 'badge--offline' };

  return (
    <div
      className={`card${mlReady && isHighConfidence ? ' card--glow-cyan' : ''}`}
      style={{ animationDelay: '0.28s' }}
    >
      <div className="card__header">
        <span className="card__title">🧠 ML Engine</span>
        <span className={`card__badge ${statusBadge.cls}`}>
          {statusBadge.text}
        </span>
      </div>

      {/* Model Switcher + Per-Model Profile Bar (placed below .card__header because dashboard.css clips extra header children) */}
      {models.length === 0 && !activeModelId ? (
        <div
          style={{
            marginTop: '6px',
            marginBottom: '6px',
            padding: '6px 8px',
            borderRadius: '6px',
            border: '1px solid rgba(148, 163, 184, 0.2)',
            background: 'rgba(15, 23, 42, 0.45)',
            fontSize: '0.68rem',
            color: '#94a3b8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <span>Model switcher: syncing registry with bot…</span>
          <span style={{ fontSize: '0.62rem', opacity: 0.75 }}>Config &amp; switch ready</span>
        </div>
      ) : (
        <div
          style={{
            marginBottom: 10,
            padding: '7px 8px',
            borderRadius: 8,
            background: 'rgba(15, 23, 42, 0.55)',
            border: '1px solid rgba(148, 163, 184, 0.16)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.64rem', color: 'var(--text-dim)', letterSpacing: '0.04em' }}>
              MODEL:{' '}
              <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>
                {activeModelId ?? 'none'}
              </span>
              {activeSummary?.hasProfile && (
                <span
                  style={{
                    marginLeft: 5,
                    padding: '1px 5px',
                    borderRadius: 4,
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    background: 'rgba(34, 211, 238, 0.16)',
                    color: 'var(--accent-cyan)',
                  }}
                >
                  {activeSummary.profileLabel || 'CUSTOM'}
                </span>
              )}
            </span>
            {selectedSummary && (
              <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                {selectedSummary.windowDays ? `${selectedSummary.windowDays}d` : `p${selectedSummary.featurePipeline}`}
                {' · '}
                AUC {selectedSummary.auc != null ? selectedSummary.auc.toFixed(3) : '-'}
                {' · '}
                Skill {selectedSummary.brierSkill != null ? `${(selectedSummary.brierSkill * 100).toFixed(1)}%` : '-'}
              </span>
            )}
          </div>

          {models.length > 0 && (
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <select
                aria-label="Select ML model"
                value={selectedId}
                onChange={e => {
                  setSelectedId(e.target.value);
                  setSwitchStatus(null);
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: 'rgba(6, 15, 24, 0.9)',
                  border: '1px solid rgba(148, 163, 184, 0.22)',
                  borderRadius: 6,
                  padding: '4px 6px',
                  color: '#e2e8f0',
                  fontSize: '0.67rem',
                  fontFamily: 'inherit',
                }}
              >
                {models.map(m => (
                  <option key={m.id} value={m.id}>
                    {fmtModelOption(m, activeModelId)}
                  </option>
                ))}
              </select>

              <button
                type="button"
                disabled={!sendBotCommand || !selectedId || isSelectedActive || switching}
                onClick={() => handleSwitchModel(selectedId)}
                style={{
                  padding: '4px 9px',
                  borderRadius: 6,
                  border: '1px solid rgba(34, 211, 238, 0.45)',
                  background: isSelectedActive ? 'rgba(255,255,255,0.04)' : 'rgba(34, 211, 238, 0.16)',
                  color: isSelectedActive ? 'var(--text-dim)' : 'var(--accent-cyan)',
                  fontSize: '0.66rem',
                  fontWeight: 700,
                  cursor: (!sendBotCommand || isSelectedActive || switching) ? 'default' : 'pointer',
                  flexShrink: 0,
                }}
              >
                {switching ? '...' : isSelectedActive ? 'Active' : 'Switch'}
              </button>

              <button
                type="button"
                disabled={!sendBotCommand || !selectedId}
                onClick={() => setDrawerOpen(true)}
                title="Edit per-model configuration profile"
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(148, 163, 184, 0.25)',
                  background: 'rgba(255, 255, 255, 0.04)',
                  color: 'var(--text-secondary)',
                  fontSize: '0.66rem',
                  fontWeight: 600,
                  cursor: (!sendBotCommand || !selectedId) ? 'default' : 'pointer',
                  flexShrink: 0,
                }}
              >
                ⚙ Config
              </button>
            </div>
          )}

          {switchStatus && (
            <div
              style={{
                fontSize: '0.63rem',
                color: switchStatus.kind === 'err' ? '#fca5a5' : switchStatus.kind === 'warn' ? '#fde68a' : '#6ee7b7',
              }}
            >
              {switchStatus.text}
            </div>
          )}
        </div>
      )}

      {mlControl && (
        <ModelProfileDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          models={models}
          activeModelId={activeModelId}
          targetModelId={selectedId || activeModelId || models[0]?.id || ''}
          onChangeTarget={id => setSelectedId(id)}
          profiles={mlControl.profiles ?? {}}
          baseline={mlControl.baseline}
          onSave={handleSaveProfile}
          onReset={handleResetProfile}
        />
      )}

      {mlReady && isHighConfidence && (
        <div className="ml-high-conf-banner" style={{ marginBottom: 10 }}>
          HIGH CONFIDENCE — {mlSide === 'UP' ? '\u2191 LONG' : '\u2193 SHORT'}
        </div>
      )}

      {!mlReady && (
        <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-dim)' }}>
          {ml?.status === 'loading' ? (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>⏳</div>
              Loading XGBoost model...
            </>
          ) : ml?.status === 'error' ? (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>⚠️</div>
              Model load failed
              <br />
              <span style={{ fontSize: '0.68rem' }}>Running rule-based only</span>
            </>
          ) : (
            <>
              <div style={{ fontSize: '1.2rem', marginBottom: 6 }}>📦</div>
              ML model not loaded
              <br />
              <span style={{ fontSize: '0.68rem' }}>Place model files in /public/ml/</span>
            </>
          )}
        </div>
      )}

      {mlReady && (
        <>
          {/* ML Prediction vs Ensemble Stat Boxes */}
          <div className="qt-stat-grid" style={{ marginBottom: 12 }}>
            <div className="qt-stat-box" style={{ textAlign: 'center', alignItems: 'center' }}>
              <span className="qt-stat-box__label">ML P(UP)</span>
              <span
                className={`qt-stat-box__val ${mlSide === 'UP' ? 'c-green' : mlSide === 'DOWN' ? 'c-red' : ''}`}
                style={{ fontSize: '1.15rem', marginTop: 2 }}
              >
                {formatProbPct(mlProbUp, 1)}
              </span>
              <span className={`qt-badge ${mlSide === 'UP' ? 'qt-badge--green' : mlSide === 'DOWN' ? 'qt-badge--red' : 'qt-badge--muted'}`} style={{ marginTop: 3 }}>
                {mlSide === 'UP' ? '↑ LONG' : mlSide === 'DOWN' ? '↓ SHORT' : 'NEUTRAL'}
              </span>
            </div>

            <div
              className="qt-stat-box"
              style={{
                textAlign: 'center',
                alignItems: 'center',
                borderColor: ensembleSide === 'UP'
                  ? 'rgba(52, 211, 153, 0.28)'
                  : ensembleSide === 'DOWN'
                    ? 'rgba(251, 113, 133, 0.28)'
                    : undefined,
              }}
            >
              <span className="qt-stat-box__label">Ensemble Blend</span>
              <span
                className={`qt-stat-box__val ${ensembleSide === 'UP' ? 'c-green' : ensembleSide === 'DOWN' ? 'c-red' : ''}`}
                style={{ fontSize: '1.15rem', marginTop: 2 }}
              >
                {formatProbPct(ensembleProbUp, 1)}
              </span>
              <span className={`qt-badge ${ensembleSide === 'UP' ? 'qt-badge--green' : ensembleSide === 'DOWN' ? 'qt-badge--red' : 'qt-badge--muted'}`} style={{ marginTop: 3 }}>
                {ensembleSide === 'UP' ? '↑ LONG' : ensembleSide === 'DOWN' ? '↓ SHORT' : 'NEUTRAL'}
              </span>
            </div>
          </div>

          {/* Rule vs ML Comparison Section */}
          <div className="qt-panel-section qt-panel-section--accent" style={{ marginBottom: 10 }}>
            <div className="qt-kicker" style={{ marginBottom: 7 }}>
              Rule vs ML Distribution
            </div>

            {/* Rule bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: '0.66rem', color: 'var(--text-muted)', width: 34, flexShrink: 0, fontWeight: 600 }}>
                Rule
              </span>
              <div
                style={{
                  flex: 1,
                  height: 15,
                  background: 'rgba(4, 8, 16, 0.72)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                  border: '1px solid var(--border-dim)',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.round((ruleProbUp ?? 0.5) * 100)}%`,
                    background: (ruleProbUp ?? 0.5) >= 0.5
                      ? 'linear-gradient(90deg, rgba(16,185,129,0.45), rgba(52,211,153,0.75))'
                      : 'linear-gradient(90deg, rgba(244,63,94,0.45), rgba(251,113,133,0.75))',
                    transition: 'width 0.5s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    color: '#fff',
                    zIndex: 1,
                  }}
                >
                  {formatProbPct(ruleProbUp, 1)}
                </span>
              </div>
            </div>

            {/* ML bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.66rem', color: 'var(--accent-cyan)', width: 34, flexShrink: 0, fontWeight: 700 }}>
                ML
              </span>
              <div
                style={{
                  flex: 1,
                  height: 15,
                  background: 'rgba(4, 8, 16, 0.72)',
                  borderRadius: 4,
                  overflow: 'hidden',
                  position: 'relative',
                  border: '1px solid var(--border-dim)',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.round((mlProbUp ?? 0.5) * 100)}%`,
                    background: (mlProbUp ?? 0.5) >= 0.5
                      ? 'linear-gradient(90deg, rgba(6,182,212,0.4), rgba(34,211,238,0.8))'
                      : 'linear-gradient(90deg, rgba(139,92,246,0.4), rgba(167,139,250,0.8))',
                    transition: 'width 0.5s ease',
                  }}
                />
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    color: '#fff',
                    zIndex: 1,
                  }}
                >
                  {formatProbPct(mlProbUp, 1)}
                </span>
              </div>
            </div>
          </div>

          {/* Model Telemetry Rows */}
          <div className="qt-panel-section">
            <div className="data-row">
              <span className="data-row__label">ML Confidence</span>
              <span className={`data-row__value ${mlConfTier.color}`} style={{ fontWeight: 600 }}>
                {mlConfidence != null ? `${(mlConfidence * 100).toFixed(1)}%` : '-'}{' '}
                <span className={`qt-badge ${mlConfTier.label === 'HIGH' ? 'qt-badge--green' : mlConfTier.label === 'MEDIUM' ? 'qt-badge--amber' : 'qt-badge--muted'}`}>
                  {mlConfTier.label}
                </span>
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Agreement</span>
              <span
                className={`data-row__value ${
                  ruleAgreesWithMl === true
                    ? 'c-green'
                    : ruleAgreesWithMl === false
                      ? 'c-red'
                      : 'c-muted'
                }`}
                style={{ fontWeight: 600 }}
              >
                {ruleAgreesWithMl === true
                  ? '✓ Rule + ML Agree'
                  : ruleAgreesWithMl === false
                    ? '✗ Conflict'
                    : '-'}
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Blend Weight (α)</span>
              <span className="data-row__value">
                <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>
                  ML {alphaBarPct}%
                </span>
                <span style={{ color: 'var(--text-dim)', margin: '0 4px' }}>|</span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Rule {100 - alphaBarPct}%
                </span>
              </span>
            </div>

            <div className="data-row">
              <span className="data-row__label">Strategy</span>
              <span className="data-row__value" style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {source ?? '-'}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══ React.memo with custom comparator ═══
// Only re-render when ML-specific fields or model switcher state change
export default memo(MLPanel, (prev, next) => {
  if (prev.sendBotCommand !== next.sendBotCommand) return false;
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.ml?.probUp === b.ml?.probUp &&
    a.ml?.confidence === b.ml?.confidence &&
    a.ml?.side === b.ml?.side &&
    a.ml?.ensembleProbUp === b.ml?.ensembleProbUp &&
    a.ml?.alpha === b.ml?.alpha &&
    a.ml?.source === b.ml?.source &&
    a.ml?.status === b.ml?.status &&
    a.ml?.modelId === b.ml?.modelId &&
    a.mlControl?.version === b.mlControl?.version &&
    a.mlControl?.activeModelId === b.mlControl?.activeModelId &&
    a.pLong === b.pLong &&
    a.pShort === b.pShort &&
    a.ruleUp === b.ruleUp
  );
});