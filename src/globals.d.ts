/**
 * Ambient global declarations for browser debug helpers + custom window props.
 * These are intentional runtime globals (dev tooling / cross-module flags),
 * not bugs. Declaring them here clears ~15 spurious TS errors.
 *
 * Created 2026-05-15 (Tier-1 TS cleanup).
 */

interface Window {
  // Polymarket logger debug helpers (src/data/polymarketLogger.js)
  __getLogCount?: () => any;
  __exportTrainingCSV?: () => any;
  __clearTrainingLog?: () => any;
  // Feedback unload-listener guard (src/engines/feedback.js)
  __feedbackUnloadRegistered?: boolean;
}

// IndexedDB request result accessed via event.target.result
interface EventTarget {
  result?: any;
  error?: any;
}
