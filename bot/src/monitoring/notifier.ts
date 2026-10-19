/**
 * External notifications — Telegram + Discord webhook.
 *
 * Sends alerts on critical events (circuit breaker, large losses, win rate pause).
 * Gracefully no-ops if env vars are not configured.
 * Rate-limited to 1 message per level per 60s to prevent spam.
 */

import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { redactSecrets } from '../utils/redact.ts';

const log = createLogger('Notifier');

const RATE_LIMIT_MS = 60_000; // 1 message per key per 60s
const MAX_TELEGRAM_CHARS = 3900;

/** Timestamp of last sent message per level */
const lastSentMs: Record<string, number> = {};

/** Test helper: clear rate-limit state. */
export function resetNotifierRateLimitsForTests(): void {
  for (const k of Object.keys(lastSentMs)) delete lastSentMs[k];
}

/**
 * Send a notification to configured channels.
 * @param {'critical'|'warn'|'info'} level
 * @param {string} message
 * @param {{ key?: string }} [opts] - Optional rate-limit key (defaults to level).
 *   Use distinct keys so e.g. 'info:entry' and 'info:settle' don't block each other.
 */
export async function notify(level: 'critical' | 'warn' | 'info', message: string, opts: { key?: string } = {}): Promise<boolean> {
  const rateKey = opts?.key ?? level;
  const now = Date.now();
  if (lastSentMs[rateKey] && (now - lastSentMs[rateKey]) < RATE_LIMIT_MS) {
    log.debug(`Notification rate-limited (${rateKey}): ${message}`);
    return false;
  }
  lastSentMs[rateKey] = now;

  const header = level === 'critical'
    ? '🚨 <b>BTC15m · CRITICAL</b>'
    : level === 'warn'
      ? '⚠️ <b>BTC15m · WARN</b>'
      : 'ℹ️ <b>BTC15m</b>';
  const fullMessage = redactSecrets(`${header}\n${message}`);

  const results = await Promise.allSettled([
    sendTelegram(fullMessage),
    sendDiscord(fullMessage),
  ]);

  const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
  if (sent > 0) {
    log.info(`Notification sent (${level}): ${message}`);
  } else {
    log.debug(`Notification not sent (no channels configured): ${message}`);
  }
  return sent > 0;
}

const PROFILE_URL = 'https://polymarketscan.org/address/0x2f8b9af5a465e2bdd5f9b541c3878bc64659b472';
// No hardcoded fallback: the old Railway dashboard is retired.

interface InlineButton { text: string; url: string }
export interface InlineKeyboard { inline_keyboard: InlineButton[][] }

let warnedDashboardValue: string | null = null;

/**
 * Link for the "View Web" button: DASHBOARD_URL, else the Railway dashboard.
 * Null when the value is unusable, so the button is dropped instead of the
 * alert — Telegram rejects the whole sendMessage (400) if any inline button
 * carries an invalid URL. A bare host is taken as https.
 *
 * Never append ?botStatusToken= here. That token also authorises control
 * commands (pause, setBankroll, sellPosition, forceSettle), and a Telegram
 * message can be forwarded. A browser that has logged in once keeps the token
 * in its own localStorage.
 *
 * Read at send time, not at import — same env-hoisting reason as sendTelegram.
 */
function dashboardUrl(): string | null {
  const raw = (process.env.DASHBOARD_URL ?? '').trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const { protocol, hostname } = new URL(candidate);
    // A dotless host is a typo or `localhost` — nothing a phone can open.
    if ((protocol === 'https:' || protocol === 'http:') && hostname.includes('.')) return candidate;
  } catch {
    // fall through to the refusal below
  }
  if (warnedDashboardValue !== raw) {
    warnedDashboardValue = raw;
    log.warn(`DASHBOARD_URL="${raw}" is not a usable http(s) URL — Telegram "View Web" button omitted.`);
  }
  return null;
}

/**
 * Extract the inline button from an <a href="...">Label</a> tag in text, then
 * append the fixed rows: "View Profile", and "View Web" below it.
 */
export function extractInlineButton(text: string): { cleanText: string; inlineKeyboard: InlineKeyboard } {
  // Move every <a href> link to an inline button (max 3), keep the text clean.
  const linkRe = /\n?<a href="([^"]+)">([^<]+)<\/a>/g;
  const matches = [...text.matchAll(linkRe)];
  const buttons: InlineButton[][] = matches.slice(0, 3).map(m => {
    const label = m[2].replace(/^[^\p{L}\p{N}]+/u, '').trim() || 'Open';
    return [{ text: `🔗 ${label}`, url: m[1] }];
  });
  let cleanText = text.replace(linkRe, '').trimEnd();
  if (cleanText.length > MAX_TELEGRAM_CHARS) cleanText = cleanText.slice(0, MAX_TELEGRAM_CHARS) + '…';
  buttons.push([{ text: '📊 View Profile', url: PROFILE_URL }]);
  const webUrl = dashboardUrl();
  if (webUrl) buttons.push([{ text: '🌐 View Web', url: webUrl }]);
  return { cleanText, inlineKeyboard: { inline_keyboard: buttons } };
}

/**
 * Send message via Telegram Bot API.
 * Auto-converts <a href> links to inline keyboard buttons.
 * @returns {Promise<boolean>} true if sent successfully
 */
async function sendTelegram(text) {
  // Read from process.env directly — BOT_CONFIG captures empty strings because
  // ES module imports are hoisted before dotenvConfig() runs in index.ts body.
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return false;

  try {
    const { cleanText, inlineKeyboard } = extractInlineButton(text);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload: Record<string, any> = { chat_id: chatId, text: cleanText, parse_mode: 'HTML' };
    if (inlineKeyboard) payload.reply_markup = inlineKeyboard;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`Telegram send failed (${res.status}): ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`Telegram error: ${err.message}`);
    return false;
  }
}

/**
 * Send message via Discord webhook.
 * @returns {Promise<boolean>} true if sent successfully
 */
/** Convert Telegram HTML to readable Discord plain text. */
function stripTelegramHtml(text: string): string {
  return text
    .replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2 ($1)')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

async function sendDiscord(text) {
  const webhookUrl = BOT_CONFIG.discordWebhookUrl;
  if (!webhookUrl) return false;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: stripTelegramHtml(text) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn(`Discord send failed (${res.status}): ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`Discord error: ${err.message}`);
    return false;
  }
}
