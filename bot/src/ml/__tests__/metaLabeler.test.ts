import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkMetaLabelerAdvisory,
  computeRocAuc,
  fitMetaLabelerModel,
  getMetaLabelerStatus,
  recordMetaLabelerOutcome,
  resetMetaLabelerForTests,
  scoreMetaLabeler,
  type MetaLabelSample,
} from '../metaLabeler.ts';
import { BOT_CONFIG } from '../../config.ts';

function makeSeparableSamples(n = 60): MetaLabelSample[] {
  const out: MetaLabelSample[] = [];
  for (let i = 0; i < n; i++) {
    const good = i % 2 === 0;
    out.push({
      features: {
        entryPrice: good ? 0.56 : 0.66,
        mlConfidence: good ? 0.58 : 0.31,
        rawMlEdge: good ? 0.12 : 0.01,
        timeLeftMin: good ? 8.0 : 12.5,
        regime: good ? 'trending' : 'moderate',
        jevNetConvAligned: good ? 0.45 : -0.25,
      },
      won: good ? 1 : 0,
    });
  }
  return out;
}

describe('Stage-2 Meta-Labeler', () => {
  const savedMode = BOT_CONFIG.metaLabeler.mode;
  const savedMin = BOT_CONFIG.metaLabeler.minSamples;
  const savedAuc = BOT_CONFIG.metaLabeler.minAuc;

  beforeEach(() => {
    resetMetaLabelerForTests();
    BOT_CONFIG.metaLabeler.mode = 'shadow';
    BOT_CONFIG.metaLabeler.minSamples = 35;
    BOT_CONFIG.metaLabeler.minAuc = 0.56;
  });

  afterEach(() => {
    BOT_CONFIG.metaLabeler.mode = savedMode;
    BOT_CONFIG.metaLabeler.minSamples = savedMin;
    BOT_CONFIG.metaLabeler.minAuc = savedAuc;
    resetMetaLabelerForTests();
  });

  it('computes exact ROC AUC and returns null on single-class labels', () => {
    expect(computeRocAuc([1, 1, 0, 0], [0.9, 0.8, 0.2, 0.1])).toBe(1);
    expect(computeRocAuc([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9])).toBe(0);
    expect(computeRocAuc([1, 1, 1], [0.5, 0.6, 0.7])).toBeNull();
  });

  it('fits separable trade features with high chronological holdout AUC and respects shadow vs veto mode', () => {
    const samples = makeSeparableSamples(60);
    const model = fitMetaLabelerModel(samples, { minSamples: 35 });
    expect(model).not.toBeNull();
    expect(model!.holdoutAuc!).toBeGreaterThan(0.90);

    const goodFeatures = samples[0].features;
    const badFeatures = samples[1].features;

    // Shadow mode always returns passthrough
    const sBad = scoreMetaLabeler(badFeatures, { modelOverride: model });
    expect(sBad.winProb!).toBeLessThan(0.45);
    expect(sBad.action).toBe('passthrough');

    // Veto mode blocks low P(WIN) setups when holdout AUC passes minAuc
    BOT_CONFIG.metaLabeler.mode = 'veto';
    for (const s of samples) recordMetaLabelerOutcome(s.features, s.won === 1);
    expect(getMetaLabelerStatus().samples).toBe(60);
    expect(checkMetaLabelerAdvisory(badFeatures, 'btc-updown-15m-bad')).toMatchObject({ action: 'block' });
    expect(checkMetaLabelerAdvisory(goodFeatures, 'btc-updown-15m-good')).toBeNull();
  });

  it('auto mode stays SHADOW below promoteMinSamples and auto-promotes to VETO once threshold & AUC pass', () => {
    const savedPromoteMin = BOT_CONFIG.metaLabeler.promoteMinSamples;
    const savedPromoteAuc = BOT_CONFIG.metaLabeler.promoteMinAuc;
    try {
      BOT_CONFIG.metaLabeler.mode = 'auto';
      BOT_CONFIG.metaLabeler.promoteMinSamples = 60;
      BOT_CONFIG.metaLabeler.promoteMinAuc = 0.58;

      const samples = makeSeparableSamples(60);
      // At 50 samples (< 60), stays SHADOW passthrough
      for (const s of samples.slice(0, 50)) recordMetaLabelerOutcome(s.features, s.won === 1);
      expect(getMetaLabelerStatus().effectiveMode).toBe('shadow');
      expect(getMetaLabelerStatus().autoPromoted).toBe(false);
      expect(checkMetaLabelerAdvisory(samples[1].features, 'pre-promote')).toBeNull();

      // Reaching 60 samples with high holdout AUC auto-promotes to VETO immediately
      for (const s of samples.slice(50)) recordMetaLabelerOutcome(s.features, s.won === 1);
      expect(getMetaLabelerStatus().effectiveMode).toBe('veto');
      expect(getMetaLabelerStatus().autoPromoted).toBe(true);
      expect(checkMetaLabelerAdvisory(samples[1].features, 'post-promote')).toMatchObject({ action: 'block' });
      expect(checkMetaLabelerAdvisory(samples[0].features, 'post-promote-good')).toBeNull();
    } finally {
      BOT_CONFIG.metaLabeler.promoteMinSamples = savedPromoteMin;
      BOT_CONFIG.metaLabeler.promoteMinAuc = savedPromoteAuc;
    }
  });
});
