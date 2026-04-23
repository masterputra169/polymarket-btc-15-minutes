/**
 * Macro Event Guard — blocks trading around high-impact macro events.
 *
 * Source: ForexFactory weekly calendar (FaireEconomy mirror, public XML).
 *   https://nfs.faireconomy.media/ff_calendar_thisweek.xml
 *
 * Additional: bot/data/macro_events_manual.json lets user pin extra events
 * (e.g. emergency FOMC, crypto-specific events not in FF calendar).
 *
 * Rationale: CPI/FOMC/NFP windows = chaotic BTC price action, binary 15-min
 * markets become coin flips (~50% WR). Skip these 6-10 events/month → WR lift.
 *
 * Policy:
 *   - Fetch on startup + every BOT_CONFIG.macro.fetchIntervalMs (default 6h)
 *   - Block trading from -preEventMinutes to +postEventMinutes around event
 *   - Filter by impact (default 'High') and currency (default 'USD')
 *   - Ultra-ML (>=95%) bypass enforced in tradeFilters.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { BOT_CONFIG } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('MacroGuard');

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';

let _events = [];               // [{ title, currency, impact, startMs, endMs, source }]
let _lastFetchMs = 0;
let _fetching = false;
let _stats = { fetches: 0, errors: 0, eventsLoaded: 0, blocksTriggered: 0 };

/**
 * Initialize: load cached events from disk, schedule periodic fetch.
 */
export function initMacroCalendar() {
  if (!BOT_CONFIG.macro?.enabled) {
    log.info('Macro Guard disabled (MACRO_GUARD_ENABLED=false)');
    return;
  }
  _ensureDataDir();
  loadEventsFromDisk();
  loadManualEventsFromDisk();
  _logUpcoming();

  // Fire-and-forget initial fetch (don't block startup)
  fetchMacroEvents().catch(err => log.debug(`Initial macro fetch failed: ${err.message}`));
}

/**
 * Fetch macro events from FaireEconomy XML (called on interval from loop).
 * Non-blocking. Errors fall back to cached events.
 */
export async function fetchMacroEvents() {
  if (!BOT_CONFIG.macro?.enabled) return;
  if (_fetching) return;

  const now = Date.now();
  const interval = BOT_CONFIG.macro.fetchIntervalMs ?? 6 * 60 * 60 * 1000;
  if (_lastFetchMs > 0 && (now - _lastFetchMs) < interval) return;

  _fetching = true;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(FF_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': 'polymarket-bot-macro-guard/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    // FF rate-limits to 1 req/hour — returns HTML error page instead of XML.
    if (xml.trim().startsWith('<!DOCTYPE') || xml.includes('Rate Limited')) {
      log.warn('FF rate-limited (1/hr cap) — keeping cached');
      _stats.errors++;
      return;
    }

    const parsed = parseFfXml(xml);

    if (parsed.length === 0) {
      log.warn('FF calendar returned 0 parsed events — keeping cached');
      _stats.errors++;
      return;
    }

    _events = mergeEvents(parsed, _loadManualEventsRaw());
    _lastFetchMs = now;
    _stats.fetches++;
    _stats.eventsLoaded = _events.length;

    persistEventsToDisk();
    log.info(`Macro calendar: ${_events.length} events loaded (${parsed.length} from FF)`);
    _logUpcoming();
  } catch (err) {
    _stats.errors++;
    log.warn(`Macro fetch error: ${err.message} — using cached (${_events.length} events)`);
  } finally {
    _fetching = false;
  }
}

/**
 * Check if we're currently within a macro-event blackout window.
 * Called from tradeFilters.js on every filter invocation.
 * Returns null or { block: true, reason: string, event: {...} }.
 */
export function checkMacroEvent() {
  if (!BOT_CONFIG.macro?.enabled) return null;
  if (_events.length === 0) return null;

  const now = Date.now();
  for (const ev of _events) {
    if (now >= ev.startMs && now <= ev.endMs) {
      _stats.blocksTriggered++;
      const minsBefore = ev.eventMs != null ? Math.round((ev.eventMs - now) / 60_000) : null;
      const minsAfter = ev.eventMs != null ? Math.round((now - ev.eventMs) / 60_000) : null;
      let timing;
      if (minsBefore > 0) timing = `-${minsBefore}m`;
      else if (minsAfter > 0) timing = `+${minsAfter}m`;
      else timing = 'live';
      return {
        block: true,
        reason: `${ev.currency} ${ev.impact} ${ev.title} (${timing})`,
        event: ev,
      };
    }
  }
  return null;
}

/**
 * Get macro calendar stats for dashboard.
 */
export function getMacroStats() {
  const now = Date.now();
  const upcoming = _events
    .filter(ev => ev.eventMs > now)
    .slice(0, 5)
    .map(ev => ({
      title: ev.title,
      currency: ev.currency,
      impact: ev.impact,
      eventAt: new Date(ev.eventMs).toISOString(),
      minutesUntil: Math.round((ev.eventMs - now) / 60_000),
    }));
  return {
    enabled: BOT_CONFIG.macro?.enabled !== false,
    ..._stats,
    lastFetch: _lastFetchMs > 0 ? new Date(_lastFetchMs).toISOString() : null,
    upcoming,
  };
}

// ─────────────── Disk Persistence ───────────────

function _ensureDataDir() {
  try {
    const dir = dirname(BOT_CONFIG.macro.eventsFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch { /* best effort */ }
}

function loadEventsFromDisk() {
  try {
    if (!existsSync(BOT_CONFIG.macro.eventsFile)) return;
    const raw = readFileSync(BOT_CONFIG.macro.eventsFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.events)) {
      _events = parsed.events;
      _lastFetchMs = parsed.fetchedAt ?? 0;
      _stats.eventsLoaded = _events.length;
      log.info(`Macro: loaded ${_events.length} cached events from disk`);
    }
  } catch (err) {
    log.debug(`No macro cache: ${err.message}`);
  }
}

function loadManualEventsFromDisk() {
  const manual = _loadManualEventsRaw();
  if (manual.length > 0) {
    _events = mergeEvents(
      _events.filter(e => e.source !== 'manual'),
      manual
    );
    log.info(`Macro: merged ${manual.length} manual events (total ${_events.length})`);
  }
}

function _loadManualEventsRaw() {
  try {
    const path = BOT_CONFIG.macro.manualEventsFile;
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed.events ?? []);
    return list.map(e => normalizeManualEvent(e)).filter(Boolean);
  } catch (err) {
    log.debug(`Manual events: ${err.message}`);
    return [];
  }
}

function normalizeManualEvent(e) {
  if (!e || !e.title || !e.eventAt) return null;
  const eventMs = new Date(e.eventAt).getTime();
  if (!Number.isFinite(eventMs)) return null;
  const preMin = e.preMinutes ?? BOT_CONFIG.macro.preEventMinutes ?? 30;
  const postMin = e.postMinutes ?? BOT_CONFIG.macro.postEventMinutes ?? 15;
  return {
    title: String(e.title),
    currency: String(e.currency ?? 'USD'),
    impact: String(e.impact ?? 'High'),
    eventMs,
    startMs: eventMs - preMin * 60_000,
    endMs: eventMs + postMin * 60_000,
    source: 'manual',
  };
}

function persistEventsToDisk() {
  try {
    _ensureDataDir();
    writeFileSync(BOT_CONFIG.macro.eventsFile, JSON.stringify({
      fetchedAt: _lastFetchMs,
      events: _events,
    }, null, 2));
  } catch (err) {
    log.debug(`Persist macro events failed: ${err.message}`);
  }
}

// ─────────────── FaireEconomy XML Parser ───────────────

/**
 * Parse FaireEconomy XML. Structure (simplified):
 *   <weeklyevents>
 *     <event>
 *       <title>Core CPI m/m</title>
 *       <country>USD</country>
 *       <date>04-22-2026</date>
 *       <time>8:30am</time>
 *       <impact>High</impact>
 *       ...
 *     </event>
 *   </weeklyevents>
 *
 * FF times are US Eastern. Convert to UTC via ET offset detection.
 */
function parseFfXml(xml) {
  const events = [];
  const impactFilter = (BOT_CONFIG.macro.impactLevels ?? ['High']).map(s => s.toLowerCase());
  const currencyFilter = (BOT_CONFIG.macro.currencies ?? ['USD']).map(s => s.toUpperCase());
  const preMin = BOT_CONFIG.macro.preEventMinutes ?? 30;
  const postMin = BOT_CONFIG.macro.postEventMinutes ?? 15;

  const blockRe = /<event>([\s\S]*?)<\/event>/gi;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const country = (extractTag(block, 'country') ?? '').toUpperCase();
    const dateStr = extractTag(block, 'date');      // "04-22-2026"
    const timeStr = extractTag(block, 'time');      // "8:30am" or "All Day" / "Tentative"
    const impact = (extractTag(block, 'impact') ?? '').toLowerCase();

    if (!title || !dateStr) continue;
    if (!impactFilter.includes(impact)) continue;
    if (!currencyFilter.includes(country)) continue;

    const eventMs = parseEtDateTime(dateStr, timeStr);
    if (!Number.isFinite(eventMs)) continue;

    events.push({
      title,
      currency: country,
      impact: impact.charAt(0).toUpperCase() + impact.slice(1),
      eventMs,
      startMs: eventMs - preMin * 60_000,
      endMs: eventMs + postMin * 60_000,
      source: 'forexfactory',
    });
  }

  return events;
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() || null;
}

/**
 * Parse "MM-DD-YYYY" + "H:MMam" in US Eastern time → UTC ms.
 * "All Day" / "Tentative" / empty time → returns NaN (event skipped).
 */
function parseEtDateTime(dateStr, timeStr) {
  const dm = dateStr.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!dm) return NaN;
  const month = parseInt(dm[1], 10);
  const day = parseInt(dm[2], 10);
  const year = parseInt(dm[3], 10);

  if (!timeStr) return NaN;
  const tm = timeStr.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!tm) return NaN;
  let hour = parseInt(tm[1], 10);
  const min = parseInt(tm[2], 10);
  const ampm = tm[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;

  // ET offset: EDT=UTC-4 (Mar-Nov), EST=UTC-5 (Nov-Mar). Approximate by month.
  const isEDT = isUsDst(year, month, day);
  const offsetHours = isEDT ? 4 : 5;

  // Build a UTC date by adding the offset to the ET wall clock
  const utcHour = hour + offsetHours;
  return Date.UTC(year, month - 1, day, utcHour, min, 0, 0);
}

/**
 * Rough US DST check: DST is 2nd Sunday of March → 1st Sunday of November.
 */
function isUsDst(year, month, day) {
  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  // March: DST starts on 2nd Sunday
  if (month === 3) {
    const secondSunday = nthWeekdayOfMonth(year, 2, 0, 2); // 0=Sunday, 2nd occurrence
    return day >= secondSunday;
  }
  // November: DST ends on 1st Sunday
  if (month === 11) {
    const firstSunday = nthWeekdayOfMonth(year, 10, 0, 1); // 10=November (0-indexed)
    return day < firstSunday;
  }
  return false;
}

function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
  const d = new Date(Date.UTC(year, monthIdx, 1));
  const firstDow = d.getUTCDay();
  const offset = (weekday - firstDow + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

// ─────────────── Helpers ───────────────

function mergeEvents(primary, manual) {
  const now = Date.now();
  // Keep only future / currently-active events (anything ending > now - 1h)
  const cutoff = now - 60 * 60 * 1000;
  const out = [...primary, ...manual].filter(e => e.endMs > cutoff);
  // Dedupe by (title + eventMs)
  const seen = new Set();
  return out.filter(e => {
    const key = `${e.title}|${e.eventMs}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.eventMs - b.eventMs);
}

function _logUpcoming() {
  const now = Date.now();
  const upcoming = _events
    .filter(ev => ev.eventMs > now)
    .slice(0, 3);
  if (upcoming.length === 0) return;
  const lines = upcoming.map(ev => {
    const mins = Math.round((ev.eventMs - now) / 60_000);
    const hours = Math.floor(mins / 60);
    const mm = mins % 60;
    const when = hours > 0 ? `${hours}h${mm}m` : `${mm}m`;
    return `${ev.currency} ${ev.impact} ${ev.title} in ${when}`;
  });
  log.info(`Macro upcoming: ${lines.join(' | ')}`);
}
