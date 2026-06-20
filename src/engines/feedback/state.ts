/**
 * Shared state and persistence for feedback tracker.
 */

const STORAGE_KEY = 'btc_prediction_tracker';
export const MAX_HISTORY = 200;
const PERSIST_DEBOUNCE_MS = 5_000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_SLUGS_KEPT = 5;

// In-memory state
export let cache = null;
export let dirty = false;
export let statsCache = null;
export let statsDirty = true;

let persistTimer = null;

export function ensureLoaded() {
  if (cache !== null) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(cache)) cache = [];

    const cutoff = Date.now() - MAX_AGE_MS;
    const before = cache.length;
    cache = cache.filter(p => p.timestamp > cutoff);
    if (cache.length < before) {
      dirty = true;
      schedulePersist();
      console.log(`[Feedback] Purged ${before - cache.length} expired predictions on load`);
    }
  } catch {
    cache = [];
  }
}

export function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      if (cache.length > MAX_HISTORY) cache = cache.slice(-MAX_HISTORY);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
    } catch { /* localStorage full or disabled */ }
  }, PERSIST_DEBOUNCE_MS);
}

export function markDirty() {
  dirty = true;
  statsDirty = true;
  statsCache = null;
  schedulePersist();
}

export function setDirty(val) {
  dirty = val;
}

export function setCache(newCache) {
  cache = newCache;
}

export function setStatsCache(val) {
  statsCache = val;
  statsDirty = false;
}

export function getPersistTimer() {
  return persistTimer;
}

export function clearPersistTimer() {
  clearTimeout(persistTimer);
  persistTimer = null;
}
