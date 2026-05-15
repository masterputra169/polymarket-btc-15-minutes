/**
 * Standalone runner for deposit activator.
 *
 *   node bot/scripts/activate_now.mjs --dry-run    (preview only)
 *   node bot/scripts/activate_now.mjs              (execute)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const dryRun = process.argv.includes('--dry-run');

// Stub the notifier so we don't actually send Telegram/Discord during this manual run.
import('../src/monitoring/notifier.js').catch(() => {});

import('../src/trading/depositActivator.js').then(async ({ activateDeposit }) => {
  console.log('Mode:', dryRun ? 'DRY-RUN (no tx)' : 'EXECUTE');
  console.log('');
  try {
    const r = await activateDeposit({ minAmount: 1_000_000n, dryRun });
    console.log('');
    console.log('Result:', JSON.stringify(r, null, 2));
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}).catch(err => {
  console.error('Loader error:', err);
  process.exit(1);
});
