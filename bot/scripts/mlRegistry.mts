/**
 * Model registry CLI (logic in bot/src/modelRegistry.ts).
 *
 *   npm run ml:registry -- list
 *   npm run ml:registry -- register --dir <modelDir> [--csv f] [--meta f] [--report f]
 *                          [--status candidate|live|retired] [--date YYYY-MM-DD]
 *                          [--source text] [--note text] [--csv-missing reason]
 *   npm run ml:registry -- deploy <id> [--note text]      # into public/ml (backs up what it replaces)
 *   npm run ml:registry -- evaluate --ids a,b --file summary.json [--note text]
 *   npm run ml:registry -- note <id|-> <text>
 *   npm run ml:registry -- render                           # regenerate MODELS.md
 *
 * Every command that changes the registry appends to ml_registry/journal.jsonl
 * and regenerates ml_registry/MODELS.md. Nothing is ever deleted.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  registerModel, deployModel, appendEvent, renderModelsMd, readManifest, listManifests, modelStatuses,
} from '../src/modelRegistry.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTRY = resolve(ROOT, 'ml_registry');
const PUBLIC_ML = resolve(ROOT, 'public', 'ml');

function flags(argv: string[]) {
  const out: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1] ?? ''; i++; } else pos.push(argv[i]);
  }
  return { out, pos };
}

const [cmd, ...rest] = process.argv.slice(2);
const { out: f, pos } = flags(rest);
const actor = f.actor || 'manual';

switch (cmd) {
  case 'list': {
    renderModelsMd(REGISTRY);
    const statuses = modelStatuses(REGISTRY);
    for (const m of listManifests(REGISTRY)) {
      const ens = (m.metrics.ensemble ?? m.metrics.xgb ?? {}) as Record<string, any>;
      const skill = typeof ens.brier_skill_vs_market === 'number' ? `${(ens.brier_skill_vs_market * 100).toFixed(1)}%` : '—';
      console.log(`${m.id.padEnd(24)} ${String(statuses[m.id] ?? '—').padEnd(9)} v${m.featurePipeline}  ` +
        `acc ${typeof ens.accuracy === 'number' ? (ens.accuracy * 100).toFixed(1) + '%' : '—'}  skill ${skill}  ` +
        `csv ${m.training.csvStored ? 'stored' : 'missing'}`);
    }
    break;
  }
  case 'register': {
    if (!f.dir) throw new Error('register needs --dir');
    const { manifest, created } = registerModel({
      root: REGISTRY, sourceDir: resolve(f.dir), source: f.source || f.dir, actor,
      status: (f.status as any) || 'candidate',
      trainingCsv: f.csv ? resolve(f.csv) : null,
      csvMissingReason: f['csv-missing'] || null,
      trainingMeta: f.meta ? resolve(f.meta) : null,
      trainingReport: f.report ? resolve(f.report) : null,
      date: f.date ? new Date(`${f.date}T00:00:00Z`) : undefined,
      notes: f.note ? [f.note] : [],
    });
    renderModelsMd(REGISTRY);
    console.log(`${created ? 'registered' : 'already registered'}: ${manifest.id}`);
    break;
  }
  case 'deploy': {
    const id = pos[0];
    if (!id || !readManifest(REGISTRY, id)) throw new Error(`deploy: unknown model id ${id}`);
    const r = deployModel({ root: REGISTRY, id, targetDir: PUBLIC_ML, backupDir: resolve(PUBLIC_ML, 'backups'), actor, note: f.note });
    renderModelsMd(REGISTRY);
    console.log(`deployed ${id} into public/ml (replaced ${r.previousId ?? 'nothing'}; backup tag ${r.backupTag})`);
    console.log('Next: commit public/ml + ml_registry, then `railway up --service bot --ci`.');
    break;
  }
  case 'evaluate': {
    const ids = (f.ids || '').split(',').filter(Boolean);
    if (!ids.length || !f.file) throw new Error('evaluate needs --ids and --file');
    const summary = JSON.parse(readFileSync(resolve(f.file), 'utf-8'));
    appendEvent(REGISTRY, { event: 'evaluated', id: ids[0], actor, ids, note: f.note ?? null, summary });
    renderModelsMd(REGISTRY);
    console.log(`evaluation recorded for ${ids.join(', ')}`);
    break;
  }
  case 'note': {
    const [id, ...words] = pos;
    appendEvent(REGISTRY, { event: 'note', id: id === '-' ? null : id, actor, text: words.join(' ') });
    renderModelsMd(REGISTRY);
    console.log('note recorded');
    break;
  }
  case 'render':
    renderModelsMd(REGISTRY);
    console.log('MODELS.md regenerated');
    break;
  default:
    console.log('usage: mlRegistry.mts list | register | deploy <id> | evaluate | note | render (see header)');
    process.exit(cmd ? 2 : 0);
}
