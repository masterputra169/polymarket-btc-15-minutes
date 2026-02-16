/**
 * Signal performance persistence adapter for Node.js bot.
 * Replaces localStorage with JSON file persistence.
 *
 * Similar pattern to feedbackStore.js — inject data into shared signalPerf
 * module so localStorage is never accessed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

import {
  injectStore,
  getStoreSnapshot,
  getSignalModifiers,
  updateSignalPerf,
  extractSignalSnapshot,
  getSignalPerfStats,
  flushSignalPerf,
} from '../../../src/engines/feedback/signalPerf.js';

// Re-export for use by other bot modules
export {
  getSignalModifiers,
  updateSignalPerf,
  extractSignalSnapshot,
  getSignalPerfStats,
  flushSignalPerf,
};

const log = createLogger('SignalPerf');

/**
 * Load signal perf data from disk into shared state.
 * Must be called before any signalPerf functions.
 */
export function loadSignalPerfFromDisk() {
  try {
    if (existsSync(BOT_CONFIG.signalPerfFile)) {
      const data = JSON.parse(readFileSync(BOT_CONFIG.signalPerfFile, 'utf-8'));
      injectStore(data);
      log.info(`Loaded signal perf data from disk (${Object.keys(data?.signals ?? {}).length} signals)`);
      return;
    }
  } catch (err) {
    log.warn(`Could not load signal perf file: ${err.message}`);
  }
  injectStore(null); // Initialize empty store
}

/**
 * Save signal perf state to disk.
 */
export function saveSignalPerfToDisk() {
  try {
    const snapshot = getStoreSnapshot();
    if (!snapshot) return;

    const dir = dirname(BOT_CONFIG.signalPerfFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const data = JSON.stringify(snapshot, null, 2);
    const tmpPath = BOT_CONFIG.signalPerfFile + '.tmp';
    writeFileSync(tmpPath, data);
    try {
      renameSync(tmpPath, BOT_CONFIG.signalPerfFile);
    } catch {
      writeFileSync(BOT_CONFIG.signalPerfFile, data);
      try { unlinkSync(tmpPath); } catch { /* */ }
    }
    log.debug('Saved signal perf data to disk');
  } catch (err) {
    log.warn(`Could not save signal perf file: ${err.message}`);
  }
}
