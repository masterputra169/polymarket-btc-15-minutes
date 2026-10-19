/** Send one formatted test alert through the real Telegram/Discord channel.
 *
 *   node --env-file=./.env scripts/alertTest.mts
 *
 * Exits 0 when at least one channel accepted the message.
 */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: resolve(ROOT, 'bot', '.env'), quiet: true });
const { notify, resetNotifierRateLimitsForTests } = await import('../src/monitoring/notifier.ts');

resetNotifierRateLimitsForTests();
const ok = await notify('info', [
  '🔔 <b>Alert system test</b>',
  '',
  'Format baru aktif: template HTML, tombol inline (market/profile/web), rate-limit per kategori, dan feed-health guard.',
  'ℹ️ Ini pesan uji — bot tetap DRY RUN.',
  '',
  '<a href="https://polymarket.com/event/btc-updown-15m-test">View Market</a>',
].join('\n'), { key: 'alert:test' });

console.log(ok ? 'alert sent' : 'no channel accepted the alert (check TELEGRAM_* / DISCORD_WEBHOOK_URL)');
process.exit(ok ? 0 : 2);
