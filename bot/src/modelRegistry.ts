/**
 * Model registry + journal: every trained model is kept, every event is logged.
 *
 * Why (2026-09-24): the only record of past models was a gitignored
 * public/ml/backups folder, and the training CSV of the deployed model was
 * overwritten by the next generation run — so the model that had just been
 * shown to lose to the market could no longer be re-examined on its own data.
 * Comparing models needs their artifacts, their data and a history of what
 * happened to them, all kept.
 *
 * Layout (ml_registry/, tracked in git):
 *   journal.jsonl            append-only events: registered, gate, evaluated,
 *                            deployed, retired, rolled_back, note
 *   MODELS.md                generated from the journal + manifests — never edit
 *   models/<id>/manifest.json
 *   models/<id>/{xgboost_model,lightgbm_model,norm_browser}.json.gz
 *   models/<id>/training_data.csv.gz, training_data.meta.json, training_report.txt
 *                            (when they exist; a missing CSV is recorded as missing)
 *
 * Artifacts are gzipped (model JSON compresses 6-9x). The registry copy of
 * norm_browser.json carries `model_id`, which the bot logs at load and stamps
 * on every trade it journals — so live results can be split by model.
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, readdirSync,
} from 'fs';
import { resolve, basename } from 'path';
import { createHash } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';

export const MODEL_FILES = ['xgboost_model.json', 'lightgbm_model.json', 'norm_browser.json'] as const;

export type RegistryEvent = {
  ts: string;
  event: 'registered' | 'gate' | 'evaluated' | 'deployed' | 'retired' | 'rolled_back' | 'note';
  id: string | null;
  actor: string;
  [key: string]: unknown;
};

export interface Manifest {
  id: string;
  registeredAt: string;
  source: string;
  featurePipeline: number;
  /** sha256 of the ORIGINAL uncompressed files (before model_id stamping). */
  sourceSha256: Record<string, string>;
  /** sha256 of the stored .gz files (empty when only a reference is kept). */
  storedSha256: Record<string, string>;
  /** Where the artifacts live when they are not stored here, e.g. "git 4e1ea30:public/ml/". */
  artifactRef: string | null;
  metrics: { xgb: Record<string, unknown> | null; ensemble: Record<string, unknown> | null; ensembleWeights: unknown };
  training: {
    csvStored: boolean;
    csvSha256: string | null;
    csvMissingReason: string | null;
    meta: Record<string, unknown> | null;
    reportStored: boolean;
  };
  notes: string[];
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString();

export function registryPaths(root: string) {
  return {
    root,
    journal: resolve(root, 'journal.jsonl'),
    modelsMd: resolve(root, 'MODELS.md'),
    models: resolve(root, 'models'),
  };
}

/**
 * <yyyymmdd>-p<pipeline>-<first 6 of the xgboost sha256>. The date is when the
 * model was trained when known, else when it was registered; the hash keeps
 * two models from the same day apart and ties the id to the exact artifact.
 */
export function makeModelId(date: Date, featurePipeline: number, xgbSha: string): string {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-p${featurePipeline}-${xgbSha.slice(0, 6)}`;
}

export function readJournal(root: string): RegistryEvent[] {
  const { journal } = registryPaths(root);
  if (!existsSync(journal)) return [];
  return readFileSync(journal, 'utf-8').split('\n').filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l) as RegistryEvent]; } catch { return []; }
  });
}

/** Append one event. The journal is never rewritten. */
export function appendEvent(root: string, event: Omit<RegistryEvent, 'ts'> & { ts?: string }): RegistryEvent {
  const { journal } = registryPaths(root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const { ts, ...rest } = event;
  const full = { ts: ts ?? nowIso(), ...rest } as RegistryEvent;
  appendFileSync(journal, JSON.stringify(full) + '\n');
  return full;
}

export function readManifest(root: string, id: string): Manifest | null {
  const p = resolve(registryPaths(root).models, id, 'manifest.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}

export function listManifests(root: string): Manifest[] {
  const dir = registryPaths(root).models;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(id => readManifest(root, id)).filter((m): m is Manifest => m != null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The registered model whose xgboost file matches this sha256, if any. */
export function findBySourceSha(root: string, xgbSha: string): Manifest | null {
  return listManifests(root).find(m => m.sourceSha256['xgboost_model.json'] === xgbSha) ?? null;
}

/** Status per model, derived from the journal: live | candidate | retired | rejected | archived. */
export function modelStatuses(root: string): Record<string, string> {
  const status: Record<string, string> = {};
  for (const e of readJournal(root)) {
    if (!e.id) continue;
    if (e.event === 'registered') status[e.id] = String(e.status ?? 'candidate');
    else if (e.event === 'gate' && e.pass === false && status[e.id] === 'candidate') status[e.id] = 'rejected';
    else if (e.event === 'deployed' || e.event === 'rolled_back') {
      for (const k of Object.keys(status)) if (status[k] === 'live') status[k] = 'retired';
      status[e.id] = 'live';
    } else if (e.event === 'retired') status[e.id] = 'retired';
  }
  return status;
}

function pickMetrics(xgbJson: any, norm: any) {
  const m = xgbJson?.metrics ?? null;
  const xgb = m ? Object.fromEntries(Object.entries(m).filter(([k]) =>
    !['confidence_buckets', 'calibration_bins'].includes(k))) : null;
  return { xgb, ensemble: norm?.ensemble_metrics ?? null, ensembleWeights: norm?.ensemble_weights ?? null };
}

export interface RegisterOptions {
  root: string;
  /** Directory holding the three model JSON files. */
  sourceDir: string;
  source: string;
  actor: string;
  /** archived = kept for the record, never (verifiably) deployed. */
  status?: 'candidate' | 'live' | 'retired' | 'archived';
  trainingCsv?: string | null;
  csvMissingReason?: string | null;
  trainingMeta?: string | null;
  trainingReport?: string | null;
  /** Date for the id; defaults to now. */
  date?: Date;
  notes?: string[];
  /** Also write model_id into sourceDir/norm_browser.json (so a later deploy from there carries it). */
  stampSource?: boolean;
  /**
   * Keep only a reference instead of copying artifacts — for models whose files
   * already live permanently elsewhere (git history). Metrics and hashes are still recorded.
   */
  artifactRef?: string | null;
  /** Timestamp for the `registered` event (backfilling history); defaults to now. */
  eventTs?: string;
}

/**
 * Register the model in `sourceDir`. Idempotent: an artifact already registered
 * (same xgboost sha256) returns its existing manifest and adds no event.
 */
export function registerModel(opts: RegisterOptions): { manifest: Manifest; created: boolean } {
  const { root, sourceDir, source, actor } = opts;
  const raw: Record<string, Buffer> = {};
  for (const f of MODEL_FILES) {
    const p = resolve(sourceDir, f);
    if (existsSync(p)) raw[f] = readFileSync(p);
    // Early models predate LightGBM / norm_browser.json. That is fine for a
    // reference-only record (nothing to restore from here), never for a stored one.
    else if (f === 'xgboost_model.json' || !opts.artifactRef) throw new Error(`registerModel: ${f} missing in ${sourceDir}`);
  }
  const sourceSha256 = Object.fromEntries(Object.entries(raw).map(([f, b]) => [f, sha256(b)]));
  const existing = findBySourceSha(root, sourceSha256['xgboost_model.json']);
  if (existing) return { manifest: existing, created: false };

  const norm = raw['norm_browser.json'] ? JSON.parse(raw['norm_browser.json'].toString('utf-8')) : {};
  const xgbJson = JSON.parse(raw['xgboost_model.json'].toString('utf-8'));
  const featurePipeline = Number.isInteger(norm.feature_pipeline) && norm.feature_pipeline >= 1 ? norm.feature_pipeline : 1;
  const id = makeModelId(opts.date ?? new Date(), featurePipeline, sourceSha256['xgboost_model.json']);
  const dir = resolve(registryPaths(root).models, id);
  mkdirSync(dir, { recursive: true });

  // The registry copy of norm carries the id; the bot logs it and stamps trades with it.
  const stampedNorm = Buffer.from(JSON.stringify({ ...norm, model_id: id }, null, 2));
  const stored: Record<string, Buffer> = { ...raw, ...(raw['norm_browser.json'] ? { 'norm_browser.json': stampedNorm } : {}) };
  const storedSha256: Record<string, string> = {};
  if (!opts.artifactRef) {
    for (const f of MODEL_FILES) {
      const gz = gzipSync(stored[f], { level: 9 });
      writeFileSync(resolve(dir, `${f}.gz`), gz);
      storedSha256[`${f}.gz`] = sha256(gz);
    }
  }
  if (opts.stampSource && raw['norm_browser.json']) writeFileSync(resolve(sourceDir, 'norm_browser.json'), stampedNorm);

  let csvStored = false;
  let csvSha256: string | null = null;
  if (opts.trainingCsv && existsSync(opts.trainingCsv)) {
    const csv = readFileSync(opts.trainingCsv);
    csvSha256 = sha256(csv);
    writeFileSync(resolve(dir, 'training_data.csv.gz'), gzipSync(csv, { level: 9 }));
    csvStored = true;
  }
  let meta: Record<string, unknown> | null = null;
  if (opts.trainingMeta && existsSync(opts.trainingMeta)) {
    copyFileSync(opts.trainingMeta, resolve(dir, 'training_data.meta.json'));
    meta = JSON.parse(readFileSync(opts.trainingMeta, 'utf-8'));
    if (meta && 'feature_names' in meta) meta = { ...meta, feature_names: `(${(meta.feature_names as unknown[]).length} names)` };
  }
  let reportStored = false;
  if (opts.trainingReport && existsSync(opts.trainingReport)) {
    copyFileSync(opts.trainingReport, resolve(dir, basename(opts.trainingReport)));
    reportStored = true;
  }

  const manifest: Manifest = {
    id,
    registeredAt: nowIso(),
    source,
    featurePipeline,
    sourceSha256,
    storedSha256,
    artifactRef: opts.artifactRef ?? null,
    metrics: pickMetrics(xgbJson, norm),
    training: {
      csvStored, csvSha256,
      csvMissingReason: csvStored ? null : (opts.csvMissingReason ?? 'no training CSV supplied'),
      meta, reportStored,
    },
    notes: opts.notes ?? [],
  };
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  appendEvent(root, {
    ts: opts.eventTs, event: 'registered', id, actor, status: opts.status ?? 'candidate', source,
    featurePipeline, xgbSha256: sourceSha256['xgboost_model.json'],
    csvStored, notes: manifest.notes,
  });
  return { manifest, created: true };
}

/**
 * Id of the model currently in `dir`, registering it first if the registry has
 * never seen it — anything that was ever live stays in the record.
 */
export function ensureRegistered(root: string, dir: string, actor: string, status: 'live' | 'retired' | 'candidate' = 'live'): string {
  const xgb = resolve(dir, 'xgboost_model.json');
  const known = findBySourceSha(root, sha256(readFileSync(xgb)));
  if (known) return known.id;
  return registerModel({
    root, sourceDir: dir, source: `${dir} (registered when first seen)`, actor, status,
    csvMissingReason: 'registered after the fact; training CSV not available', notes: ['auto-registered'],
  }).manifest.id;
}

/** Journal a deployment whose files were copied by someone else (autoRetrain's deployNew). */
export function journalDeployment(root: string, d: {
  id: string; previousId: string | null; actor: string; target: string; backupTag?: string | null; note?: string | null;
  /** When it happened, if not now (backfilling history). */
  ts?: string;
}): void {
  if (d.previousId && d.previousId !== d.id) appendEvent(root, { ts: d.ts, event: 'retired', id: d.previousId, actor: d.actor, replacedBy: d.id });
  appendEvent(root, { ts: d.ts, event: 'deployed', id: d.id, actor: d.actor, target: d.target, previousId: d.previousId, backupTag: d.backupTag ?? null, note: d.note ?? null });
}

/** Decompress a registered model's three files into `targetDir`. */
export function materialiseModel(root: string, id: string, targetDir: string): void {
  const dir = resolve(registryPaths(root).models, id);
  const manifest = readManifest(root, id);
  if (!manifest) throw new Error(`model ${id} is not registered`);
  if (manifest.artifactRef) throw new Error(`model ${id} keeps only a reference — restore it from ${manifest.artifactRef}`);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  for (const f of MODEL_FILES) {
    writeFileSync(resolve(targetDir, f), gunzipSync(readFileSync(resolve(dir, `${f}.gz`))));
  }
}

export interface DeployOptions {
  root: string;
  id: string;
  /** public/ml */
  targetDir: string;
  /** public/ml/backups — the files being replaced are copied here first (<tag>_* and rollback_*). */
  backupDir: string;
  actor: string;
  note?: string;
}

/**
 * Deploy a registered model into `targetDir`, backing up what it replaces, and
 * journal it. The model being replaced is registered first if it is not yet,
 * so nothing that was ever live can drop out of the record.
 */
export function deployModel(opts: DeployOptions): { previousId: string | null; backupTag: string } {
  const { root, id, targetDir, backupDir, actor } = opts;
  if (!readManifest(root, id)) throw new Error(`model ${id} is not registered`);

  const previousId = existsSync(resolve(targetDir, 'xgboost_model.json'))
    ? ensureRegistered(root, targetDir, actor, 'live')
    : null;

  const backupTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  for (const f of MODEL_FILES) {
    const src = resolve(targetDir, f);
    if (!existsSync(src)) continue;
    copyFileSync(src, resolve(backupDir, `${backupTag}_${f}`));
    copyFileSync(src, resolve(backupDir, `rollback_${f}`));
  }

  materialiseModel(root, id, targetDir);
  journalDeployment(root, { id, previousId, actor, target: targetDir, backupTag, note: opts.note ?? null });
  return { previousId, backupTag };
}

const fmtPct = (v: unknown) => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : '—');
const fmtNum = (v: unknown, d = 4) => (typeof v === 'number' ? v.toFixed(d) : '—');
const fmtSkill = (v: unknown) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '—');

/** Regenerate MODELS.md from manifests + journal. */
export function renderModelsMd(root: string): string {
  const manifests = listManifests(root);
  const statuses = modelStatuses(root);
  const journal = readJournal(root);
  const lines: string[] = [
    '# Model registry',
    '',
    '_Generated by `bot/src/modelRegistry.ts` from `journal.jsonl` and the manifests — do not edit by hand._',
    '',
    '| Model | Status | Pipeline | Data | Accuracy | AUC | ECE | Skill vs market | Artifacts | Training CSV |',
    '|-------|--------|----------|------|----------|-----|-----|-----------------|-----------|--------------|',
  ];
  for (const m of manifests) {
    const ens = (m.metrics.ensemble ?? {}) as Record<string, unknown>;
    const xgb = (m.metrics.xgb ?? {}) as Record<string, unknown>;
    const meta = (m.training.meta ?? {}) as Record<string, any>;
    const data = meta.first_slug_ts && meta.last_slug_ts
      ? `${meta.rows ?? '?'} mkts ${new Date(meta.first_slug_ts * 1000).toISOString().slice(0, 10)} → ${new Date(meta.last_slug_ts * 1000).toISOString().slice(0, 10)}`
      : '—';
    lines.push(`| \`${m.id}\` | ${statuses[m.id] ?? '—'} | v${m.featurePipeline} | ${data} | ${fmtPct(ens.accuracy ?? xgb.accuracy)} | ` +
      `${fmtNum(ens.auc ?? xgb.auc)} | ${fmtNum(ens.calibration_ece ?? xgb.calibration_ece)} | ` +
      `${fmtSkill(ens.brier_skill_vs_market ?? xgb.brier_skill_vs_market)} | ${m.artifactRef ? `ref: ${m.artifactRef}` : 'stored'} | ` +
      `${m.training.csvStored ? 'stored' : `missing — ${m.training.csvMissingReason}`} |`);
  }
  lines.push('', 'Offline metrics are each model\'s own test split — not comparable across feature pipelines. ' +
    'Head-to-head comparisons are `evaluated` events below.', '', '## Journal', '');
  for (const e of journal.slice().sort((a, b) => b.ts.localeCompare(a.ts))) {
    const { ts, event, id, actor, ...rest } = e;
    const detail = Object.entries(rest).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
    lines.push(`- **${ts.slice(0, 19).replace('T', ' ')}Z** \`${event}\` ${id ? `\`${id}\`` : ''} _(by ${actor})_${detail ? ` — ${detail}` : ''}`);
  }
  const md = lines.join('\n') + '\n';
  writeFileSync(registryPaths(root).modelsMd, md);
  return md;
}
