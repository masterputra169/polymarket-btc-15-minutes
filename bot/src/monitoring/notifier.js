/**
 * External notifications — Telegram + Discord webhook.
 *
 * Sends alerts on critical events (circuit breaker, large losses, win rate pause).
 * Gracefully no-ops if env vars are not configured.
 * Rate-limited to 1 message per level per 60s to prevent spam.
 */

import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Notifier');

const RATE_LIMIT_MS = 60_000; // 1 message per level per 60s

/** Timestamp of last sent message per level */
const lastSentMs = {};

/**
 * Send a notification to configured channels.
 * @param {'critical'|'warn'|'info'} level
 * @param {string} message
 * @param {{ key?: string }} [opts] - Optional rate-limit key (defaults to level).
 *   Use distinct keys so e.g. 'info:entry' and 'info:settle' don't block each other.
 */
export async function notify(level, message, opts) {
  const rateKey = opts?.key ?? level;
  const now = Date.now();
  if (lastSentMs[rateKey] && (now - lastSentMs[rateKey]) < RATE_LIMIT_MS) {
    log.debug(`Notification rate-limited (${rateKey}): ${message}`);
    return;
  }
  lastSentMs[rateKey] = now;

  const prefix = level === 'critical' ? '🚨' : level === 'warn' ? '⚠️' : 'ℹ️';
  const fullMessage = `${prefix} [BTC15m Bot] ${message}`;

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
}

/**
 * Extract inline button from <a href="...">Label</a> tag in text.
 * Returns { cleanText, inlineKeyboard } — inlineKeyboard is null if no link found.
 */
function extractInlineButton(text) {
  const linkRe = /\n?<a href="([^"]+)">([^<]+)<\/a>/;
  const match = text.match(linkRe);
  if (!match) return { cleanText: text, inlineKeyboard: null };
  const cleanText = text.replace(linkRe, '').trimEnd();
  const inlineKeyboard = { inline_keyboard: [[{ text: `🔗 ${match[2]}`, url: match[1] }]] };
  return { cleanText, inlineKeyboard };
}

/**
 * Send message via Telegram Bot API.
 * Auto-converts <a href> links to inline keyboard buttons.
 * @returns {boolean} true if sent successfully
 */
async function sendTelegram(text) {
  // Read from process.env directly — BOT_CONFIG captures empty strings because
  // ES module imports are hoisted before dotenvConfig() runs in index.js body.
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) return false;

  try {
    const { cleanText, inlineKeyboard } = extractInlineButton(text);
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = { chat_id: chatId, text: cleanText, parse_mode: 'HTML' };
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
 * @returns {boolean} true if sent successfully
 */
async function sendDiscord(text) {
  const webhookUrl = BOT_CONFIG.discordWebhookUrl;
  if (!webhookUrl) return false;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
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
