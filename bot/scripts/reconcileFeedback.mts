/** Reconcile feedback predictions with verified journal outcomes (one-off / operator tool).
 *
 *   node --env-file=./.env scripts/reconcileFeedback.mts
 *
 * autoSettle() books UP/DOWN from spot 3s before expiry; fallbackVerifier later
 * corrects the journal. This script applies those verified outcomes to the
 * feedback cache so Accuracy/streak/calibration stop showing stale results.
 */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });

const dataDir = resolve(ROOT, 'bot', 'data');
const journalPath = resolve(dataDir, 'trade_journal.jsonl');
const rows = existsSync(journalPath)
  ? readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const verified = new Map();
for (const r of rows) {
  const slug = r.entry?.marketSlug;
  const outcome = r.exit?.verifiedOutcome;
  if (slug && (outcome === 'UP' || outcome === 'DOWN')) verified.set(slug, outcome);
}

const fb = await import('../src/adapters/feedbackStore.ts');
fb.loadFeedbackFromDisk();
let corrected = 0;
for (const [slug, outcome] of verified) corrected += fb.reconcilePrediction(slug, outcome);
if (corrected > 0) fb.saveFeedbackToDisk();
const detailed = fb.getDetailedStats();
console.log(JSON.stringify({
  verifiedOutcomes: verified.size,
  corrected,
  totalSettled: detailed.totalSettled,
  streak: detailed.streak,
  rolling: detailed.rolling,
  calibrationBucketsWithData: detailed.calibration.filter((c) => c.total > 0).length,
}));
