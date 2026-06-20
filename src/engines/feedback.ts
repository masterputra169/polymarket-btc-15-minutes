/**
 * ═══ Prediction Feedback Tracker v3.2 (Slug Cleanup) ═══
 *
 * Thin facade re-exporting the same public API from split modules.
 * Internal modules: feedback/state, feedback/store, feedback/stats, feedback/cleanup
 */

export { recordPrediction, settlePrediction, autoSettle, loadHistory, flushHistory, clearAll } from './feedback/store.ts';
export { getAccuracyStats, getDetailedStats, getMLAccuracy } from './feedback/stats.ts';
export { purgeStaleMarkets, purgeSlug, purgeOlderThan, onMarketSwitch, getStorageStats } from './feedback/cleanup.ts';
export { getSignalModifiers, getSignalPerfStats, computeOverallCRPS, flushSignalPerf, clearSignalPerf } from './feedback/signalPerf.ts';

// Register beforeunload handler
import { flushHistory } from './feedback/store.ts';
import { flushSignalPerf } from './feedback/signalPerf.ts';

if (typeof window !== 'undefined' && !window.__feedbackUnloadRegistered) {
  window.addEventListener('beforeunload', () => { flushHistory(); flushSignalPerf(); });
  window.__feedbackUnloadRegistered = true;
}
