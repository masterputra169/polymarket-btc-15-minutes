/**
 * Structured logger with configurable levels.
 * Every line goes through redactSecrets(): error messages echo URLs and connection strings.
 */

import { redactSecrets } from './utils/redact.ts';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let currentLevel: number = LEVELS.info;

export function setLogLevel(level: LogLevel | string | undefined) {
  const normalized = typeof level === 'string' && level in LEVELS ? level as LogLevel : 'info';
  currentLevel = LEVELS[normalized];
}

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function redactExtra(extra: unknown): string {
  if (typeof extra === 'string') return redactSecrets(extra);
  if (extra instanceof Error) return redactSecrets(extra.stack ?? extra.message);
  try { return redactSecrets(JSON.stringify(extra)); } catch { return redactSecrets(String(extra)); }
}

function emit(level: LogLevel, tag: string, msg: unknown, extra?: unknown): void {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  const text = redactSecrets(typeof msg === 'string' ? msg : String(msg));
  if (extra !== undefined) {
    console.log(`${prefix} ${text}`, redactExtra(extra));
  } else {
    console.log(`${prefix} ${text}`);
  }
}

export function createLogger(tag: string) {
  return {
    debug: (msg: unknown, extra?: unknown) => emit('debug', tag, msg, extra),
    info: (msg: unknown, extra?: unknown) => emit('info', tag, msg, extra),
    warn: (msg: unknown, extra?: unknown) => emit('warn', tag, msg, extra),
    error: (msg: unknown, extra?: unknown) => emit('error', tag, msg, extra),
  };
}

export const log = createLogger('Bot');
