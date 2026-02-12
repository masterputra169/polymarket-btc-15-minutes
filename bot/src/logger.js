/**
 * Structured logger with configurable levels.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel = LEVELS.info;

export function setLogLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, tag, msg, extra) {
  if (LEVELS[level] < currentLevel) return;
  const prefix = `${ts()} [${level.toUpperCase().padEnd(5)}] [${tag}]`;
  if (extra !== undefined) {
    console.log(`${prefix} ${msg}`, extra);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

export function createLogger(tag) {
  return {
    debug: (msg, extra) => emit('debug', tag, msg, extra),
    info: (msg, extra) => emit('info', tag, msg, extra),
    warn: (msg, extra) => emit('warn', tag, msg, extra),
    error: (msg, extra) => emit('error', tag, msg, extra),
  };
}

export const log = createLogger('Bot');
