#!/usr/bin/env node
/**
 * Dry-run report for the bot running on Railway.
 *
 * The Railway bot writes its journal to the service volume, not to this
 * machine, and dry-run rows are deliberately kept out of the Postgres mirror
 * (that table is the record of real trades). So the evidence for the go-live
 * decision lives in one file inside the container. This pulls it — plus the
 * PTB health rollups — over `railway ssh`, keeps a copy under
 * bot/data/railway/, and runs dryRunReport on the copy.
 *
 * Usage: node bot/scripts/railwayDryRunReport.mts [--days N | --all] [--service bot] [--json]
 * Needs: railway CLI logged in and this directory linked to the project.
 */

import { spawnSync, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const OUT_DIR = resolve(ROOT, 'bot', 'data', 'railway');

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const SERVICE = opt('service') ?? 'bot';
const REMOTE_FILES = ['trade_journal.jsonl', 'ptb_health.jsonl', 'state.json'];

/** The real CLI binary: on Windows the PATH entry is a shell shim node cannot spawn. */
function railwayBinary(): { cmd: string; shell: boolean } {
  if (process.env.RAILWAY_BIN) return { cmd: process.env.RAILWAY_BIN, shell: /\.cmd$/i.test(process.env.RAILWAY_BIN) };
  if (process.platform === 'win32') {
    try {
      const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const exe = join(root, '@railway', 'cli', 'bin', 'railway.exe');
      if (existsSync(exe)) return { cmd: exe, shell: false };
    } catch { /* fall through */ }
    return { cmd: 'railway.cmd', shell: true };
  }
  return { cmd: 'railway', shell: false };
}

function pull(file: string): boolean {
  const { cmd, shell } = railwayBinary();
  // Relative path on purpose: Git Bash rewrites leading-slash arguments into
  // Windows paths; the container's working directory is /app.
  const r = spawnSync(cmd, ['ssh', '--service', SERVICE, '--', 'cat', `bot/data/${file}`], { encoding: 'utf8', shell, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) { console.error(`railway ssh failed: ${r.error.message}`); process.exit(1); }
  const missing = r.status !== 0 || /No such file|cannot open/.test(r.stderr || '');
  writeFileSync(join(OUT_DIR, file), missing ? '' : r.stdout);
  return !missing;
}

mkdirSync(OUT_DIR, { recursive: true });
const got = REMOTE_FILES.map(f => `${f}${pull(f) ? '' : ' (not on the volume yet)'}`);
console.log(`Pulled from Railway service "${SERVICE}" into ${OUT_DIR}:\n  ${got.join('\n  ')}`);

const passthrough = argv.filter((a, i) => !(a === '--service' || argv[i - 1] === '--service'));
const report = spawnSync(process.execPath, [
  resolve(__dirname, 'dryRunReport.mts'),
  '--journal', join(OUT_DIR, 'trade_journal.jsonl'),
  '--ptb-health', join(OUT_DIR, 'ptb_health.jsonl'),
  ...passthrough,
], { stdio: 'inherit' });
process.exit(report.status ?? 1);
