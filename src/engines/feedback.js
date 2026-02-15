/**
 * ═══ Prediction Feedback Tracker v3.2 (Slug Cleanup) ═══
 *
 * Thin facade re-exporting the same public API from split modules.
 * Internal modules: feedback/state, feedback/store, feedback/stats, feedback/cleanup
 */

export { recordPrediction, settlePrediction, autoSettle, loadHistory, flushHistory, clearAll } from './feedback/store.js';
export { getAccuracyStats, getDetailedStats } from './feedback/stats.js';
export { purgeStaleMarkets, purgeSlug, purgeOlderThan, onMarketSwitch, getStorageStats } from './feedback/cleanup.js';
export { getSignalModifiers, getSignalPerfStats, computeOverallCRPS, flushSignalPerf, clearSignalPerf } from './feedback/signalPerf.js';

// Register beforeunload handler
import { flushHistory } from './feedback/store.js';
import { flushSignalPerf } from './feedback/signalPerf.js';

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { flushHistory(); flushSignalPerf(); });
}
