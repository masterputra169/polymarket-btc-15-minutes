/**
 * Model registry + journal (modelRegistry.ts).
 *
 * 2026-09-24: the deployed model's training CSV was overwritten by the next
 * generation run and its artifacts lived only in a gitignored backups folder.
 * These tests pin what the registry promises: artifacts round-trip exactly,
 * nothing registered is lost or duplicated, the journal only grows, and a
 * deploy never drops the model it replaces from the record.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import {
  registerModel, deployModel, readJournal, readManifest, modelStatuses, renderModelsMd,
  makeModelId, materialiseModel, MODEL_FILES,
} from '../modelRegistry.ts';

let tmp: string;
let root: string;

function writeModel(dir: string, tag: string, pipeline?: number) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'xgboost_model.json'), JSON.stringify({ trees: [tag], metrics: { accuracy: 0.77, auc: 0.85, brier_skill_vs_market: 0.07, confidence_buckets: [1] } }));
  writeFileSync(resolve(dir, 'lightgbm_model.json'), JSON.stringify({ trees: [`lgb-${tag}`] }));
  writeFileSync(resolve(dir, 'norm_browser.json'), JSON.stringify({
    means: [0], ...(pipeline ? { feature_pipeline: pipeline } : {}),
    ensemble_metrics: { accuracy: 0.769, auc: 0.854, brier_skill_vs_market: 0.0699 }, ensemble_weights: { xgb: 0.75, lgb: 0.25 },
  }));
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), 'registry-'));
  root = resolve(tmp, 'ml_registry');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('makeModelId', () => {
  test('date, pipeline and the artifact hash', () => {
    expect(makeModelId(new Date('2026-09-24T03:48:00Z'), 2, 'abcdef0123')).toBe('20260924-p2-abcdef');
  });
});

describe('registerModel', () => {
  test('stores every artifact gzipped, byte-identical except the id stamped into norm', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    writeFileSync(resolve(src, 'training_data.csv'), 'f1,label\n0.1,1\n');
    const { manifest, created } = registerModel({ root, sourceDir: src, source: 'test', actor: 'test', trainingCsv: resolve(src, 'training_data.csv') });
    expect(created).toBe(true);
    const dir = resolve(root, 'models', manifest.id);
    for (const f of ['xgboost_model.json', 'lightgbm_model.json'] as const) {
      expect(gunzipSync(readFileSync(resolve(dir, `${f}.gz`))).equals(readFileSync(resolve(src, f)))).toBe(true);
    }
    const norm = JSON.parse(gunzipSync(readFileSync(resolve(dir, 'norm_browser.json.gz'))).toString());
    expect(norm.model_id).toBe(manifest.id);
    expect(norm.feature_pipeline).toBe(2);
    expect(gunzipSync(readFileSync(resolve(dir, 'training_data.csv.gz'))).toString()).toBe('f1,label\n0.1,1\n');
    expect(manifest.sourceSha256['xgboost_model.json']).toBe(sha(readFileSync(resolve(src, 'xgboost_model.json'))));
    expect(manifest.metrics.xgb).not.toHaveProperty('confidence_buckets');
  });

  test('the same artifact twice is one model and one event', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    const a = registerModel({ root, sourceDir: src, source: 't', actor: 't' });
    const b = registerModel({ root, sourceDir: src, source: 't', actor: 't' });
    expect(b.created).toBe(false);
    expect(b.manifest.id).toBe(a.manifest.id);
    expect(readJournal(root).filter(e => e.event === 'registered')).toHaveLength(1);
  });

  test('a missing training CSV is recorded as missing, with the reason', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a');
    const { manifest } = registerModel({ root, sourceDir: src, source: 't', actor: 't', csvMissingReason: 'overwritten 2026-09-24' });
    expect(manifest.training.csvStored).toBe(false);
    expect(manifest.training.csvMissingReason).toBe('overwritten 2026-09-24');
    expect(manifest.featurePipeline).toBe(1); // absent in norm => legacy
  });

  test('stampSource writes the id into the source norm too, so a deploy from there carries it', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    const { manifest } = registerModel({ root, sourceDir: src, source: 't', actor: 't', stampSource: true });
    expect(JSON.parse(readFileSync(resolve(src, 'norm_browser.json'), 'utf-8')).model_id).toBe(manifest.id);
  });
});

describe('deployModel', () => {
  test('backs up what it replaces, registers it if needed, and journals retire + deploy', () => {
    const live = resolve(tmp, 'public_ml');
    const backups = resolve(live, 'backups');
    writeModel(live, 'old');                       // live, never registered
    const src = resolve(tmp, 'out');
    writeModel(src, 'new', 2);
    const { manifest: fresh } = registerModel({ root, sourceDir: src, source: 't', actor: 't' });

    const { previousId, backupTag } = deployModel({ root, id: fresh.id, targetDir: live, backupDir: backups, actor: 't' });

    expect(previousId).not.toBeNull();
    expect(readManifest(root, previousId!)).not.toBeNull();                 // the old model is in the record
    expect(existsSync(resolve(backups, `${backupTag}_xgboost_model.json`))).toBe(true);
    expect(existsSync(resolve(backups, 'rollback_xgboost_model.json'))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(live, 'norm_browser.json'), 'utf-8')).model_id).toBe(fresh.id);
    expect(JSON.parse(readFileSync(resolve(live, 'xgboost_model.json'), 'utf-8')).trees).toEqual(['new']);

    const statuses = modelStatuses(root);
    expect(statuses[fresh.id]).toBe('live');
    expect(statuses[previousId!]).toBe('retired');
    const events = readJournal(root).map(e => e.event);
    expect(events.slice(-2)).toEqual(['retired', 'deployed']);
  });

  test('refuses an unregistered id', () => {
    expect(() => deployModel({ root, id: 'nope', targetDir: resolve(tmp, 'x'), backupDir: resolve(tmp, 'y'), actor: 't' }))
      .toThrow(/not registered/);
  });
});

describe('journal and MODELS.md', () => {
  test('the journal only grows', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    registerModel({ root, sourceDir: src, source: 't', actor: 't' });
    const first = readFileSync(resolve(root, 'journal.jsonl'), 'utf-8');
    writeModel(resolve(tmp, 'out2'), 'b', 2);
    registerModel({ root, sourceDir: resolve(tmp, 'out2'), source: 't', actor: 't' });
    expect(readFileSync(resolve(root, 'journal.jsonl'), 'utf-8').startsWith(first)).toBe(true);
  });

  test('MODELS.md lists every model with its status and skill', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    const { manifest } = registerModel({ root, sourceDir: src, source: 't', actor: 't' });
    const md = renderModelsMd(root);
    expect(md).toContain(manifest.id);
    expect(md).toContain('candidate');
    expect(md).toContain('+7.0%');
  });

  test('materialiseModel restores the stored files', () => {
    const src = resolve(tmp, 'out');
    writeModel(src, 'a', 2);
    const { manifest } = registerModel({ root, sourceDir: src, source: 't', actor: 't' });
    const out = resolve(tmp, 'restore');
    materialiseModel(root, manifest.id, out);
    for (const f of MODEL_FILES) expect(existsSync(resolve(out, f))).toBe(true);
  });
});

describe('reference-only models (artifacts kept in git history)', () => {
  test('record metrics and hashes but store no artifacts, and refuse to materialise', () => {
    const src = resolve(tmp, 'git_extract');
    writeModel(src, 'old');
    const { manifest } = registerModel({
      root, sourceDir: src, source: 'git abc123', actor: 'backfill', status: 'retired',
      artifactRef: 'git abc123:public/ml/', eventTs: '2026-02-26T12:00:00.000Z', date: new Date('2026-02-26T00:00:00Z'),
    });
    expect(manifest.id.startsWith('20260226-p1-')).toBe(true);
    expect(manifest.artifactRef).toBe('git abc123:public/ml/');
    expect(existsSync(resolve(root, 'models', manifest.id, 'xgboost_model.json.gz'))).toBe(false);
    expect(readJournal(root)[0].ts).toBe('2026-02-26T12:00:00.000Z');
    expect(() => materialiseModel(root, manifest.id, resolve(tmp, 'x'))).toThrow(/reference/);
    expect(renderModelsMd(root)).toContain('ref: git abc123:public/ml/');
  });
});

describe('ensureRegistered', () => {
  test('registers an unseen live model once, then returns the same id', async () => {
    const { ensureRegistered } = await import('../modelRegistry.ts');
    const live = resolve(tmp, 'live');
    writeModel(live, 'x');
    const a = ensureRegistered(root, live, 't');
    const b = ensureRegistered(root, live, 't');
    expect(a).toBe(b);
    expect(readJournal(root).filter(e => e.event === 'registered')).toHaveLength(1);
  });
});
