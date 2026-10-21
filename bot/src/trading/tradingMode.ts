/**
 * Safe runtime trading-mode switch.
 *
 * The UI sends a token-gated statusServer command; the bot validates the
 * confirmation phrase, checks for an open position, runs a live readiness
 * preflight when enabling live money, persists DRY_RUN in bot/.env and exits
 * cleanly. systemd (Restart=always) starts the bot in the new mode.
 *
 * Live and dry-run use separate state/journal files (see config.ts), so paper
 * history never becomes live accounting.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOT_CONFIG } from '../config.ts';
import { getCurrentPosition } from './positionTracker.ts';
import { initClobClient, verifyClobV2Readiness, getUsdcBalance } from './clobClient.ts';
import { createLogger } from '../logger.ts';
import { notify } from '../monitoring/notifier.ts';

const log = createLogger('TradingMode');

const ENV_FILE = process.env.BOT_ENV_FILE || resolve(process.cwd(), 'bot', '.env');

function envPath(): string {
  return ENV_FILE;
}

/** Atomically persist DRY_RUN=true/false. Service runs as the file owner. */
export function writeDryRunEnv(dryRun: boolean): void {
  const file = envPath();
  const text = readFileSync(file, 'utf8');
  const next = /^DRY_RUN=.*$/m.test(text)
    ? text.replace(/^DRY_RUN=.*$/m, 'DRY_RUN=' + (dryRun ? 'true' : 'false'))
    : text.trimEnd() + '\nDRY_RUN=' + (dryRun ? 'true' : 'false') + '\n';
  const tmp = file + '.tmp-' + process.pid;
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  log.warn('Persisted DRY_RUN=' + (dryRun ? 'true' : 'false') + ' to ' + file);
}

/** Used by live-startup failure handling: return to safe paper mode. */
export function forceDryRunEnv(): void {
  try { writeDryRunEnv(true); } catch (err) {
    log.error('Could not persist DRY_RUN=true: ' + (err?.message ?? String(err)));
  }
}

function openPositionError(): string | null {
  const pos = getCurrentPosition();
  if (pos && !pos.settled) {
    return 'An open position exists. Settle it before changing the trading mode.';
  }
  return null;
}

async function preflightLive(): Promise<string | null> {
  try {
    await initClobClient();
    await verifyClobV2Readiness();
    const balance = await getUsdcBalance();
    const usd = Number(balance?.balance);
    if (!Number.isFinite(usd) || usd <= 0) {
      return 'pUSD balance is zero or unreadable. Fund the funder wallet first.';
    }
    return null;
  } catch (err) {
    const msg = String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 220);
    log.error('LIVE preflight failed: ' + msg);
    return 'LIVE preflight failed: ' + msg;
  }
}

function scheduleRestart(target: 'live' | 'dry'): void {
  log.warn('Trading mode -> ' + target + '; restarting bot via systemd in 1.2s');
  setTimeout(() => process.exit(0), 1200);
}

export async function requestTradingMode(mode: unknown, confirm: unknown): Promise<Record<string, unknown>> {
  const target = mode === 'live' ? 'live' : mode === 'dry' ? 'dry' : null;
  if (!target) return { ok: false, error: 'mode must be live or dry' };
  const phrase = target === 'live' ? 'LIVE' : 'DRY';
  if (confirm !== phrase) return { ok: false, error: 'Type ' + phrase + ' to confirm' };
  if (target === 'live' && !BOT_CONFIG.dryRun) return { ok: false, error: 'Already in live mode' };
  if (target === 'dry' && BOT_CONFIG.dryRun) return { ok: false, error: 'Already in dry-run mode' };

  const posError = openPositionError();
  if (posError) return { ok: false, error: posError };

  if (target === 'live') {
    const preflightError = await preflightLive();
    if (preflightError) return { ok: false, error: preflightError };
  }

  try {
    writeDryRunEnv(target === 'dry');
  } catch (err) {
    return { ok: false, error: 'Could not persist mode: ' + String(err?.message ?? err).slice(0, 180) };
  }

  try {
    await notify('warn', target === 'live'
      ? '🟢 LIVE MONEY mode requested from dashboard. Bot restarting with real orders enabled.'
      : '🟡 DRY RUN mode requested from dashboard. Bot restarting with simulated orders only.');
  } catch { /* notification is best-effort */ }

  scheduleRestart(target);
  return { ok: true, mode: target, restarting: true, message: 'Bot is restarting in ' + target + ' mode' };
}
