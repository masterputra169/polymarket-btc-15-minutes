/**
 * Shadow Capture — writes featureBuf + v16 ML output per poll to a JSONL
 * file so an offline replay (scripts/v19_shadow_replay.mjs) can run v19
 * inference on the EXACT same inputs the bot saw.
 *
 * Zero-impact on trading decisions. Only writes when SHADOW_CAPTURE=true.
 * Throttles to every Nth poll to keep file size sane.
 *
 * Created 2026-05-14 for v19 validation. See docs/V19_VALIDATION_PLAN.md.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { featureBuf } from '../../../src/engines/ml/featureExtract.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAPTURE_PATH = path.resolve(__dirname, '../../data/feature_capture.jsonl');

const ENABLED = process.env.SHADOW_CAPTURE === 'true';
const THROTTLE = Math.max(1, parseInt(process.env.SHADOW_CAPTURE_EVERY_N ?? '5', 10));

let pollCounter = 0;
let writeErrCount = 0;
const MAX_WRITE_ERR_LOG = 5;

/**
 * Append a capture record for this poll.
 * @param {object} ctx
 * @param {string} ctx.marketSlug
 * @param {number} ctx.slugTs       — market open seconds (resolution key)
 * @param {number} ctx.timeLeftMin
 * @param {string} ctx.phase        — EARLY|MID|LATE|VERY_LATE
 * @param {number} ctx.lastPrice
 * @param {number} ctx.priceToBeat
 * @param {object} ctx.mlResult     — v16 prediction from current bot
 * @param {string} ctx.regime
 * @param {object} ctx.session
 * @param {number} ctx.ruleProbUp
 * @param {object} ctx.decision     — final WAIT/UP/DOWN + sizing
 */
export function captureForShadow(ctx) {
  if (!ENABLED) return;
  pollCounter++;
  if (pollCounter % THROTTLE !== 0) return;

  try {
    // Snapshot the featureBuf (Float64Array → plain array for JSON).
    // Slice to first 79: bot's featureBuf has 84 slots (5 trailing SM features
    // removed in v13). v16/v19 only use the first 79 (54 base + 25 engineered).
    // Capturing all 84 wastes space and breaks the 79-asserting replay script.
    const N_FEATURES_USED = 79;
    const features = Array.from(featureBuf.subarray(0, N_FEATURES_USED));

    // Derive slugTs from slug string if upstream ctx didn't provide it.
    // Slug format: `btc-updown-15m-<unix_seconds>` — last digit group.
    let slugTs = ctx.slugTs;
    if (slugTs == null && typeof ctx.marketSlug === 'string') {
      const m = ctx.marketSlug.match(/(\d{9,10})$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 1700000000 && n < 2000000000) slugTs = n;
      }
    }

    const rec = {
      t: Date.now(),
      slugTs,
      slug: ctx.marketSlug,
      timeLeftMin: ctx.timeLeftMin,
      phase: ctx.phase,
      lastPrice: ctx.lastPrice,
      ptb: ctx.priceToBeat,
      regime: ctx.regime,
      session: ctx.session?.label ?? null,
      ruleProbUp: ctx.ruleProbUp,
      v16: ctx.mlResult ? {
        ensembleUp: ctx.mlResult.ensembleProbUp ?? null,
        mlUp: ctx.mlResult.mlProbUp ?? null,
        mlConf: ctx.mlResult.mlConfidence ?? null,
        mlSide: ctx.mlResult.mlSide ?? null,
        highConf: ctx.mlResult.isHighConfidence ?? null,
        source: ctx.mlResult.source ?? null,
        modelVersion: ctx.mlResult.modelVersion ?? null,
      } : null,
      decision: ctx.decision ? {
        side: ctx.decision.side ?? null,
        size: ctx.decision.size ?? null,
        edge: ctx.decision.edge ?? null,
        executed: ctx.decision.executed ?? false,
      } : null,
      features, // 79-element snapshot, recoverable as Float64Array
    };

    fs.appendFileSync(CAPTURE_PATH, JSON.stringify(rec) + '\n');
  } catch (err) {
    writeErrCount++;
    if (writeErrCount <= MAX_WRITE_ERR_LOG) {
      console.warn(`[shadowCapture] write error (${writeErrCount}): ${err.message}`);
    }
  }
}

/**
 * Returns capture status for status broadcast.
 */
export function getShadowCaptureStatus() {
  let size = 0;
  let mtime = 0;
  try {
    const st = fs.statSync(CAPTURE_PATH);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {}
  return {
    enabled: ENABLED,
    throttle: THROTTLE,
    pollCounter,
    captureFile: CAPTURE_PATH,
    bytes: size,
    mtime,
  };
}
