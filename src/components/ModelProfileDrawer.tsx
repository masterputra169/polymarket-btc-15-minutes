import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type PhaseName = 'EARLY' | 'MID' | 'LATE' | 'VERY_LATE';
const PHASES: readonly PhaseName[] = ['EARLY', 'MID', 'LATE', 'VERY_LATE'];

export interface PhaseThresholdOverride {
  minEdge?: number;
  minProb?: number;
}

export interface ModelConfigProfile {
  label?: string;
  notes?: string;
  updatedAt?: string;
  filters?: Record<string, number>;
  sizing?: {
    kellyProbShrink?: number;
    maxBetAmountUsd?: number;
  };
  orderRouter?: {
    fokMlThreshold?: number;
    limitMlThreshold?: number;
    cheapMlThreshold?: number;
    fokMaxPrice?: number;
  };
  limitOrder?: {
    minMlConfidence?: number;
    minRemainingEdge?: number;
    maxEntryPrice?: number;
    maxUnfilledSec?: number;
  };
  phaseThresholds?: Partial<Record<PhaseName, PhaseThresholdOverride>>;
}

export interface StoredModelSummary {
  id: string;
  featurePipeline: number;
  registeredAt: string;
  source: string;
  status: string;
  windowDays: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  rows: number | null;
  accuracy: number | null;
  auc: number | null;
  ece: number | null;
  brierSkill: number | null;
  notes: string[];
  hasProfile: boolean;
  profileLabel: string | null;
}

export interface ModelControlBaseline {
  filters: Record<string, number>;
  sizing: { kellyProbShrink: number; maxBetAmountUsd: number };
  orderRouter: { fokMlThreshold: number; limitMlThreshold: number; cheapMlThreshold: number; fokMaxPrice: number };
  limitOrder: { minMlConfidence: number; minRemainingEdge: number; maxEntryPrice?: number; maxUnfilledSec?: number };
  phaseThresholds: Record<PhaseName, { minEdge: number; minProb: number }>;
}

export interface ModelControlState {
  activeModelId: string | null;
  featurePipeline: number;
  models: StoredModelSummary[];
  profiles: Record<string, ModelConfigProfile>;
  baseline: ModelControlBaseline;
  effective: ModelControlBaseline;
  version: number;
}

interface FieldSpec {
  key: string;
  label: string;
  step: string;
  min: number;
  max: number;
  hint: string;
}

const FILTER_FIELDS: readonly FieldSpec[] = [
  { key: 'mlConfMin', label: 'ML Conf Min', step: '0.01', min: 0.20, max: 0.90, hint: 'Gate 1 standard ML confidence floor' },
  { key: 'mlConfRelaxed', label: 'ML Conf Relaxed', step: '0.01', min: 0.20, max: 0.90, hint: 'Bypass floor when edge is high' },
  { key: 'highEdgeBypass', label: 'High Edge Bypass', step: '0.01', min: 0.01, max: 0.40, hint: 'Edge >= X relaxes mlConfMin -> mlConfRelaxed' },
  { key: 'hardMlFloor', label: 'Hard ML Floor', step: '0.01', min: 0.20, max: 0.85, hint: 'Absolute minimum ML conf across gates' },
  { key: 'lateMlMin', label: 'Late ML Min', step: '0.01', min: 0.20, max: 0.95, hint: 'Gate 2 floor when <5 min left' },
  { key: 'lateMlRelaxed', label: 'Late ML Relaxed', step: '0.01', min: 0.20, max: 0.90, hint: 'Late floor with high edge' },
  { key: 'lateEdgeBypass', label: 'Late Edge Bypass', step: '0.01', min: 0.01, max: 0.40, hint: 'Late high-edge bypass trigger' },
  { key: 'softEntryCap', label: 'Soft Price Cap', step: '0.01', min: 0.50, max: 0.90, hint: 'Soft ask ceiling (cents/100)' },
  { key: 'baseHardCap', label: 'Hard Price Cap', step: '0.01', min: 0.50, max: 0.92, hint: 'Hard ask ceiling (cents/100)' },
  { key: 'midPhaseMaxPrice', label: 'Mid-Phase Max Px', step: '0.01', min: 0.00, max: 0.80, hint: '5-11m left ask ceiling (0 disables)' },
  { key: 'trendingMlWith', label: 'Trending ML With', step: '0.01', min: 0.20, max: 0.90, hint: 'Trending ML floor aligned w/ BTC' },
  { key: 'trendingMlAgainst', label: 'Trending ML Against', step: '0.01', min: 0.20, max: 0.95, hint: 'Trending ML floor vs BTC' },
  { key: 'btcDistMinPct', label: 'BTC Dist Min %', step: '0.01', min: 0.00, max: 1.00, hint: 'Min % distance from PTB' },
  { key: 'btcDistMlBypass', label: 'BTC Dist Bypass', step: '0.01', min: 0.50, max: 0.99, hint: 'ML conf that waives distance gate' },
  { key: 'deadZoneLo', label: 'Dead Zone Lo', step: '0.01', min: 0.30, max: 0.85, hint: 'ML confidence dead-zone lower bound' },
  { key: 'deadZoneHi', label: 'Dead Zone Hi', step: '0.01', min: 0.30, max: 0.90, hint: 'ML confidence dead-zone upper bound' },
];

const SIZING_FIELDS: readonly FieldSpec[] = [
  { key: 'kellyProbShrink', label: 'Kelly Prob Shrink', step: '0.05', min: 0.00, max: 1.00, hint: '0=full model prob, 1=shrink to market' },
  { key: 'maxBetAmountUsd', label: 'Max Bet (USD)', step: '0.50', min: 1.00, max: 100.00, hint: 'Per-trade USD cap' },
];

const ROUTER_FIELDS: readonly FieldSpec[] = [
  { key: 'fokMlThreshold', label: 'FOK ML Threshold', step: '0.01', min: 0.50, max: 0.95, hint: 'Rule 1/3 direct FOK confidence' },
  { key: 'limitMlThreshold', label: 'Limit ML Threshold', step: '0.01', min: 0.20, max: 0.85, hint: 'Min ML conf for smart LIMIT route' },
  { key: 'cheapMlThreshold', label: 'Cheap FOK Threshold', step: '0.01', min: 0.45, max: 0.90, hint: 'Cheap-token aggressive FOK conf' },
  { key: 'fokMaxPrice', label: 'FOK Max Price', step: '0.01', min: 0.45, max: 0.85, hint: 'Max ask for immediate FOK' },
];

const LIMIT_FIELDS: readonly FieldSpec[] = [
  { key: 'minMlConfidence', label: 'Limit Min ML Conf', step: '0.01', min: 0.20, max: 0.90, hint: 'Limit entry manager ML floor' },
  { key: 'minRemainingEdge', label: 'Limit Min Edge', step: '0.01', min: 0.00, max: 0.20, hint: 'Minimum remaining edge at target price' },
  { key: 'maxEntryPrice', label: 'Limit Max Entry Px', step: '0.01', min: 0.45, max: 0.75, hint: 'Max GTD JOIN bid price (cents/100)' },
  { key: 'maxUnfilledSec', label: 'Limit Timeout (s)', step: '1', min: 10, max: 120, hint: 'Cancel unfilled resting bid after N sec' },
];

interface DraftForm {
  label: string;
  notes: string;
  filters: Record<string, string>;
  sizing: Record<string, string>;
  orderRouter: Record<string, string>;
  limitOrder: Record<string, string>;
  phaseThresholds: Record<PhaseName, { minEdge: string; minProb: string }>;
}

function toInputStr(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
}

function buildDraft(profile: ModelConfigProfile | undefined): DraftForm {
  const filters: Record<string, string> = {};
  for (const f of FILTER_FIELDS) filters[f.key] = toInputStr(profile?.filters?.[f.key]);

  const sizing: Record<string, string> = {};
  for (const f of SIZING_FIELDS) sizing[f.key] = toInputStr((profile?.sizing as any)?.[f.key]);

  const orderRouter: Record<string, string> = {};
  for (const f of ROUTER_FIELDS) orderRouter[f.key] = toInputStr((profile?.orderRouter as any)?.[f.key]);

  const limitOrder: Record<string, string> = {};
  for (const f of LIMIT_FIELDS) limitOrder[f.key] = toInputStr((profile?.limitOrder as any)?.[f.key]);

  const phaseThresholds = {} as Record<PhaseName, { minEdge: string; minProb: string }>;
  for (const ph of PHASES) {
    phaseThresholds[ph] = {
      minEdge: toInputStr(profile?.phaseThresholds?.[ph]?.minEdge),
      minProb: toInputStr(profile?.phaseThresholds?.[ph]?.minProb),
    };
  }

  return {
    label: profile?.label ?? '',
    notes: profile?.notes ?? '',
    filters,
    sizing,
    orderRouter,
    limitOrder,
    phaseThresholds,
  };
}

function parseSectionNumbers(rawMap: Record<string, string>): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(rawMap)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildPayloadFromDraft(draft: DraftForm): ModelConfigProfile {
  const payload: ModelConfigProfile = {};
  if (draft.label.trim()) payload.label = draft.label.trim();
  if (draft.notes.trim()) payload.notes = draft.notes.trim();

  const filters = parseSectionNumbers(draft.filters);
  if (filters) payload.filters = filters;

  const sizing = parseSectionNumbers(draft.sizing);
  if (sizing) payload.sizing = sizing as ModelConfigProfile['sizing'];

  const orderRouter = parseSectionNumbers(draft.orderRouter);
  if (orderRouter) payload.orderRouter = orderRouter as ModelConfigProfile['orderRouter'];

  const limitOrder = parseSectionNumbers(draft.limitOrder);
  if (limitOrder) payload.limitOrder = limitOrder as ModelConfigProfile['limitOrder'];

  const phases: Partial<Record<PhaseName, PhaseThresholdOverride>> = {};
  for (const ph of PHASES) {
    const raw = draft.phaseThresholds[ph];
    const edgeStr = raw.minEdge.trim();
    const probStr = raw.minProb.trim();
    const entry: PhaseThresholdOverride = {};
    if (edgeStr && Number.isFinite(Number(edgeStr))) entry.minEdge = Number(edgeStr);
    if (probStr && Number.isFinite(Number(probStr))) entry.minProb = Number(probStr);
    if (entry.minEdge !== undefined || entry.minProb !== undefined) phases[ph] = entry;
  }
  if (Object.keys(phases).length > 0) payload.phaseThresholds = phases;

  return payload;
}

function fmtMetric(v: number | null, digits = 3, pct = false): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(digits);
}

interface ModelProfileDrawerProps {
  open: boolean;
  onClose: () => void;
  models: StoredModelSummary[];
  activeModelId: string | null;
  targetModelId: string;
  onChangeTarget: (modelId: string) => void;
  profiles: Record<string, ModelConfigProfile>;
  baseline: ModelControlBaseline | null | undefined;
  onSave: (modelId: string, profile: ModelConfigProfile, switchAfter: boolean) => Promise<{ ok: boolean; refused?: string[]; error?: string }>;
  onReset: (modelId: string) => Promise<{ ok: boolean; error?: string }>;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(6, 15, 24, 0.9)',
  border: '1px solid rgba(148, 163, 184, 0.2)',
  borderRadius: 6,
  padding: '5px 8px',
  color: '#e2e8f0',
  fontSize: '0.72rem',
  fontFamily: 'inherit',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent-cyan)',
  margin: '14px 0 8px',
  borderBottom: '1px solid rgba(148, 163, 184, 0.14)',
  paddingBottom: 4,
};

export default function ModelProfileDrawer({
  open,
  onClose,
  models,
  activeModelId,
  targetModelId,
  onChangeTarget,
  profiles,
  baseline,
  onSave,
  onReset,
}: ModelProfileDrawerProps) {
  const [draft, setDraft] = useState<DraftForm>(() => buildDraft(profiles[targetModelId]));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(buildDraft(profiles[targetModelId]));
    setFeedback(null);
  }, [open, targetModelId, profiles[targetModelId]]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  const modelMeta = models.find(m => m.id === targetModelId) ?? null;
  const isEditingActive = targetModelId === activeModelId;

  const updateSection = (
    section: 'filters' | 'sizing' | 'orderRouter' | 'limitOrder',
    key: string,
    val: string,
  ) => {
    setDraft(prev => ({
      ...prev,
      [section]: { ...prev[section], [key]: val },
    }));
  };

  const handleSave = async (switchAfter: boolean) => {
    if (!targetModelId || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const payload = buildPayloadFromDraft(draft);
      const res = await onSave(targetModelId, payload, switchAfter);
      if (!res.ok) {
        setFeedback({ kind: 'err', text: res.error || 'Failed to save profile' });
      } else if (res.refused && res.refused.length > 0) {
        setFeedback({ kind: 'warn', text: `Saved with warnings: ${res.refused.join('; ')}` });
      } else {
        setFeedback({
          kind: 'ok',
          text: switchAfter
            ? `Saved profile and activated ${targetModelId}`
            : `Saved profile for ${targetModelId}`,
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!targetModelId || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await onReset(targetModelId);
      if (!res.ok) {
        setFeedback({ kind: 'err', text: res.error || 'Reset failed' });
      } else {
        setDraft(buildDraft(undefined));
        setFeedback({ kind: 'ok', text: `Reset ${targetModelId} to baseline env defaults` });
      }
    } finally {
      setSaving(false);
    }
  };

  const renderGridSection = (
    title: string,
    section: 'filters' | 'sizing' | 'orderRouter' | 'limitOrder',
    fields: readonly FieldSpec[],
    baseObj: Record<string, number> | undefined,
  ) => (
    <div>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
        {fields.map(f => {
          const baseVal = baseObj?.[f.key];
          return (
            <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.67rem', color: 'var(--text-secondary)' }}>
                <span>{f.label}</span>
                <span style={{ color: 'var(--text-dim)' }} title={f.hint}>
                  def: {baseVal !== undefined ? baseVal : '-'}
                </span>
              </span>
              <input
                type="number"
                step={f.step}
                min={f.min}
                max={f.max}
                placeholder={baseVal !== undefined ? String(baseVal) : 'default'}
                value={draft[section][f.key] ?? ''}
                onChange={e => updateSection(section, f.key, e.target.value)}
                style={inputStyle}
                title={f.hint}
              />
            </label>
          );
        })}
      </div>
    </div>
  );

  return createPortal(
    <div
      className="drawer-scrim"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="widget-drawer"
        role="dialog"
        aria-label="Model Configuration Profile"
        style={{ width: 'min(500px, 95vw)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="drawer-head">
          <div>
            <div className="drawer-kicker">PER-MODEL PROFILE OVERRIDES</div>
            <h2 style={{ fontSize: 18 }}>Model Config</h2>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="drawer-copy">
          Leave any field blank to inherit the bot&apos;s `.env` baseline. Values saved here automatically apply whenever this model is active or switched on from the dashboard.
        </p>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px' }}>
          {/* Target model selector inside drawer */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              value={targetModelId}
              onChange={e => onChangeTarget(e.target.value)}
              style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
            >
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.id} ({m.windowDays ? `${m.windowDays}d` : `p${m.featurePipeline}`}, {m.status}{m.id === activeModelId ? ' • ACTIVE' : ''})
                </option>
              ))}
            </select>
            {isEditingActive && (
              <span className="card__badge badge--live" style={{ flexShrink: 0 }}>ACTIVE</span>
            )}
          </div>

          {modelMeta && (
            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginBottom: 10, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(148,163,184,0.12)' }}>
              <span>Win: <b>{modelMeta.windowDays ? `${modelMeta.windowDays}d` : '-'}</b></span>
              {' | '}<span>Rows: <b>{modelMeta.rows?.toLocaleString() ?? '-'}</b></span>
              {' | '}<span>Acc: <b>{fmtMetric(modelMeta.accuracy, 1, true)}</b></span>
              {' | '}<span>AUC: <b>{fmtMetric(modelMeta.auc, 4)}</b></span>
              {' | '}<span>Skill: <b>{modelMeta.brierSkill != null ? `${(modelMeta.brierSkill * 100).toFixed(2)}%` : '-'}</b></span>
              {modelMeta.dateStart && modelMeta.dateEnd && (
                <div style={{ marginTop: 2, color: 'var(--text-dim)' }}>
                  Span: {modelMeta.dateStart} → {modelMeta.dateEnd} | Pipe v{modelMeta.featurePipeline}
                </div>
              )}
            </div>
          )}

          {/* Profile label & notes */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>Profile Label (optional, max 48 chars)</span>
              <input
                type="text"
                maxLength={48}
                placeholder="e.g. 365d Selective / 180d Balanced"
                value={draft.label}
                onChange={e => setDraft(prev => ({ ...prev, label: e.target.value }))}
                style={inputStyle}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>Notes (optional)</span>
              <textarea
                rows={2}
                maxLength={240}
                placeholder="Why this model uses these thresholds..."
                value={draft.notes}
                onChange={e => setDraft(prev => ({ ...prev, notes: e.target.value }))}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </label>
          </div>

          {renderGridSection('Entry Filters (Gates 0–19)', 'filters', FILTER_FIELDS, baseline?.filters)}
          {renderGridSection('Bet Sizing', 'sizing', SIZING_FIELDS, baseline?.sizing as any)}
          {renderGridSection('Smart Order Router', 'orderRouter', ROUTER_FIELDS, baseline?.orderRouter as any)}
          {renderGridSection('Limit Order Gates', 'limitOrder', LIMIT_FIELDS, baseline?.limitOrder as any)}

          {/* Phase thresholds */}
          <div>
            <div style={sectionTitleStyle}>Phase Thresholds (Decision Engine)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
              {PHASES.map(ph => {
                const def = baseline?.phaseThresholds?.[ph];
                return (
                  <div key={ph} style={{ padding: 6, borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(148,163,184,0.12)' }}>
                    <div style={{ fontSize: '0.66rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 4 }}>{ph}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                          minEdge ({def?.minEdge ?? '-'})
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          min={0.01}
                          max={0.30}
                          placeholder={def ? String(def.minEdge) : ''}
                          value={draft.phaseThresholds[ph].minEdge}
                          onChange={e => setDraft(prev => ({
                            ...prev,
                            phaseThresholds: {
                              ...prev.phaseThresholds,
                              [ph]: { ...prev.phaseThresholds[ph], minEdge: e.target.value },
                            },
                          }))}
                          style={inputStyle}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: '0.62rem', color: 'var(--text-dim)' }}>
                          minProb ({def?.minProb ?? '-'})
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          min={0.50}
                          max={0.85}
                          placeholder={def ? String(def.minProb) : ''}
                          value={draft.phaseThresholds[ph].minProb}
                          onChange={e => setDraft(prev => ({
                            ...prev,
                            phaseThresholds: {
                              ...prev.phaseThresholds,
                              [ph]: { ...prev.phaseThresholds[ph], minProb: e.target.value },
                            },
                          }))}
                          style={inputStyle}
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {feedback && (
            <div
              style={{
                marginTop: 12,
                padding: '7px 10px',
                borderRadius: 6,
                fontSize: '0.68rem',
                border: `1px solid ${feedback.kind === 'err' ? 'rgba(248,113,113,0.45)' : feedback.kind === 'warn' ? 'rgba(251,191,36,0.45)' : 'rgba(52,211,153,0.45)'}`,
                background: feedback.kind === 'err' ? 'rgba(248,113,113,0.12)' : feedback.kind === 'warn' ? 'rgba(251,191,36,0.12)' : 'rgba(52,211,153,0.12)',
                color: feedback.kind === 'err' ? '#fca5a5' : feedback.kind === 'warn' ? '#fde68a' : '#6ee7b7',
              }}
            >
              {feedback.text}
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <button type="button" className="drawer-ghost" onClick={handleReset} disabled={saving}>
            Reset Defaults
          </button>
          <button type="button" className="drawer-primary" onClick={() => handleSave(false)} disabled={saving}>
            {saving ? 'Saving...' : 'Save Config'}
          </button>
          {!isEditingActive && (
            <button type="button" className="drawer-primary" onClick={() => handleSave(true)} disabled={saving}>
              Save &amp; Switch
            </button>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
