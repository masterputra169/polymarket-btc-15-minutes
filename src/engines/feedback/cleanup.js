/**
 * Slug-aware cleanup and market switch handling.
 */

import { ensureLoaded, markDirty, MAX_AGE_MS, MAX_SLUGS_KEPT } from './state.js';
import * as S from './state.js';

function getUniqueSlugs() {
  ensureLoaded();
  const seen = new Set();
  const slugs = [];
  for (let i = S.cache.length - 1; i >= 0; i--) {
    const s = S.cache[i].marketSlug;
    if (s && !seen.has(s)) {
      seen.add(s);
      slugs.unshift(s);
    }
  }
  return slugs;
}

export function purgeStaleMarkets(keepSlugs = MAX_SLUGS_KEPT) {
  ensureLoaded();

  const slugs = getUniqueSlugs();
  if (slugs.length <= keepSlugs) return { removed: 0, slugsPurged: [] };

  const staleSlugs = new Set(slugs.slice(0, slugs.length - keepSlugs));
  const before = S.cache.length;

  S.setCache(S.cache.filter(p => !staleSlugs.has(p.marketSlug)));

  const removed = before - S.cache.length;
  if (removed > 0) {
    markDirty();
    console.log(`[Feedback] Purged ${removed} predictions from ${staleSlugs.size} old markets`);
  }

  return { removed, slugsPurged: [...staleSlugs] };
}

export function purgeSlug(slug) {
  ensureLoaded();
  const before = S.cache.length;
  S.setCache(S.cache.filter(p => p.marketSlug !== slug));
  const removed = before - S.cache.length;
  if (removed > 0) markDirty();
  return removed;
}

export function purgeOlderThan(maxAgeMs = MAX_AGE_MS) {
  ensureLoaded();
  const cutoff = Date.now() - maxAgeMs;
  const before = S.cache.length;
  S.setCache(S.cache.filter(p => p.timestamp > cutoff));
  const removed = before - S.cache.length;
  if (removed > 0) markDirty();
  return removed;
}

export function onMarketSwitch(oldSlug, newSlug) {
  ensureLoaded();
  if (!oldSlug || oldSlug === newSlug) return;

  let changed = false;
  const now = Date.now();

  for (let i = 0; i < S.cache.length; i++) {
    const p = S.cache[i];
    if (p.marketSlug === oldSlug && !p.settled) {
      p.settled = true;
      p.correct = null;
      p.settledAt = now;
      p.actualResult = 'expired';
      changed = true;
    }
  }

  purgeStaleMarkets(MAX_SLUGS_KEPT);

  const cutoff = now - MAX_AGE_MS;
  const before = S.cache.length;
  S.setCache(S.cache.filter(p => p.timestamp > cutoff));
  if (S.cache.length < before) changed = true;

  if (changed) markDirty();

  console.log(`[Feedback] Market switch: "${oldSlug.slice(-20)}" \u2192 "${newSlug.slice(-20)}" | ${S.cache.length} predictions kept`);
}

export function getStorageStats() {
  ensureLoaded();
  const slugs = getUniqueSlugs();
  const settled = S.cache.filter(p => p.settled).length;
  const unsettled = S.cache.length - settled;
  const oldestMs = S.cache.length > 0 ? Date.now() - S.cache[0].timestamp : 0;

  return {
    total: S.cache.length,
    settled,
    unsettled,
    slugs: slugs.length,
    slugList: slugs.slice(-5),
    oldestMinutesAgo: Math.floor(oldestMs / 60_000),
    storageBytesEstimate: JSON.stringify(S.cache).length,
  };
}
