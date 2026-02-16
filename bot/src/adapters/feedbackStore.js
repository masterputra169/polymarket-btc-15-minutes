/**
 * Feedback persistence adapter for Node.js bot.
 * Replaces localStorage with JSON file persistence.
 * Injects data into shared feedback state so all feedback functions work unchanged.
 *
 * Key insight: calling setCache() before any feedback function ensures
 * ensureLoaded() in state.js short-circuits (cache !== null), so localStorage
 * is never read. The schedulePersist() timer will try localStorage.setItem()
 * but our polyfill (installed in index.js) makes it a no-op.
 * We handle actual persistence ourselves via saveFeedbackToDisk().
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'fs';
import { dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

// Import state module to inject cached data and read cache via live binding
import * as FeedbackState from '../../../src/engines/feedback/state.js';

// Re-export all feedback functions — they work unchanged after state is injected
export {
  recordPrediction,
  settlePrediction,
  autoSettle,
  loadHistory,
  flushHistory,
} from '../../../src/engines/feedback/store.js';

export {
  getAccuracyStats,
  getDetailedStats,
} from '../../../src/engines/feedback/stats.js';

export {
  onMarketSwitch,
} from '../../../src/engines/feedback/cleanup.js';

const log = createLogger('Feedback');

/**
 * Load feedback history from JSON file into shared state.
 * Must be called before any feedback functions.
 */
export function loadFeedbackFromDisk() {
  try {
    if (existsSync(BOT_CONFIG.feedbackFile)) {
      const data = JSON.parse(readFileSync(BOT_CONFIG.feedbackFile, 'utf-8'));
      if (Array.isArray(data)) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const filtered = data.filter(p => p.timestamp > cutoff);
        FeedbackState.setCache(filtered);
        log.info(`Loaded ${filtered.length} predictions from disk (${data.length - filtered.length} expired)`);
        return;
      }
    }
  } catch (err) {
    log.warn(`Could not load feedback file: ${err.message}`);
    // Backup corrupted file so data isn't silently lost
    if (existsSync(BOT_CONFIG.feedbackFile)) {
      try {
        copyFileSync(BOT_CONFIG.feedbackFile, BOT_CONFIG.feedbackFile + '.bak');
        log.warn(`Corrupted feedback file backed up to ${BOT_CONFIG.feedbackFile}.bak`);
      } catch (bakErr) {
        log.warn(`Could not backup corrupted feedback file: ${bakErr.message}`);
      }
    }
  }
  FeedbackState.setCache([]);
}

/**
 * Save feedback state to JSON file.
 * Uses live binding to read current cache from state module.
 */
export function saveFeedbackToDisk() {
  try {
    const currentCache = FeedbackState.cache;
    if (!currentCache || !Array.isArray(currentCache)) return;

    const dir = dirname(BOT_CONFIG.feedbackFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Atomic write: write to temp file then rename (prevents corruption on crash)
    const data = JSON.stringify(currentCache, null, 2);
    const tmpPath = BOT_CONFIG.feedbackFile + '.tmp';
    writeFileSync(tmpPath, data);
    try {
      renameSync(tmpPath, BOT_CONFIG.feedbackFile);
    } catch (renameErr) {
      log.debug(`Rename failed (${renameErr.message}) — direct write`);
      writeFileSync(BOT_CONFIG.feedbackFile, data);
    }
    log.debug(`Saved ${currentCache.length} predictions to disk`);
  } catch (err) {
    log.warn(`Could not save feedback file: ${err.message}`);
  }
}
