/**
 * Shared mutable module state for ML predictor.
 */

// Feature counts
export const BASE_FEATURES = 54;
export const ENGINEERED_FEATURES = 25;
export const MAX_FEATURES = BASE_FEATURES + ENGINEERED_FEATURES; // 79

// Module state
export let processedTrees = null;
export let numUsableTrees = 0;
export let isLoading = false;
export let loadError = null;
export let modelMemoryKB = 0;
export let modelVersion = 1;
export let modelNumFeatures = BASE_FEATURES;
export let optimalThreshold = 0.65;
export let modelMetrics = null;
export let featureNameToIdx = null;
export let plattA = 1.0;
export let plattB = 0.0;

// Setters (needed since `let` exports are read-only from outside)
export function setState(updates) {
  if ('processedTrees' in updates) processedTrees = updates.processedTrees;
  if ('numUsableTrees' in updates) numUsableTrees = updates.numUsableTrees;
  if ('isLoading' in updates) isLoading = updates.isLoading;
  if ('loadError' in updates) loadError = updates.loadError;
  if ('modelMemoryKB' in updates) modelMemoryKB = updates.modelMemoryKB;
  if ('modelVersion' in updates) modelVersion = updates.modelVersion;
  if ('modelNumFeatures' in updates) modelNumFeatures = updates.modelNumFeatures;
  if ('optimalThreshold' in updates) optimalThreshold = updates.optimalThreshold;
  if ('modelMetrics' in updates) modelMetrics = updates.modelMetrics;
  if ('featureNameToIdx' in updates) featureNameToIdx = updates.featureNameToIdx;
  if ('plattA' in updates) plattA = updates.plattA;
  if ('plattB' in updates) plattB = updates.plattB;
}
