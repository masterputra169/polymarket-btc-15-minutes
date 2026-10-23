/**
 * Global risk context — record-only pilot.
 *
 * Sources (all keyless or already configured):
 * - Google News RSS (crypto and geopolitics queries)
 * - Cointelegraph RSS
 * - existing ForexFactory macro calendar
 * - existing Fear & Greed / BTC dominance sentiment
 *
 * It NEVER changes a trade decision. Snapshots are appended to
 * bot/data/global_risk.jsonl for forward evaluation.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_CONFIG } from '../config.ts';
import { createLogger } from '../logger.ts';
import { fetchSentiment, getSentimentStats } from '../engines/sentimentSignal.ts';
import { getMacroStats, checkMacroEvent } from './macroCalendar.ts';

const log = createLogger('GlobalRisk');
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const FILE = resolve(DATA_DIR, 'global_risk.jsonl');
const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 5 * 60_000;

export type GlobalRiskHeadline = {
  title: string;
  source: string;
  url: string;
  publishedAt: string | null;
  tone: number;
};

export type GlobalRiskSnapshot = {
  ts: number;
  ageMs: number;
  stale: boolean;
  score: number;
  level: 'low' | 'medium' | 'high';
  macro: {
    active: boolean;
    reason: string | null;
    next: string | null;
    nextInMin: number | null;
  };
  sentiment: {
    fng: number | null;
    classification: string | null;
    composite: number | null;
  };
  headlines: GlobalRiskHeadline[];
  counts: { negative: number; positive: number; total: number };
  sources: { rss: string; macro: string; sentiment: string };
};

const NEGATIVE = [
  'war', 'attack', 'missile', 'invasion', 'sanction', 'tariff', 'crisis',
  'default', 'recession', 'hack', 'exploit', 'bankruptcy', 'outflow',
  'rate hike', 'inflation', 'conflict', 'coup', 'strike', 'escalation',
];
const POSITIVE = [
  'ceasefire', 'rate cut', 'approval', 'inflow', 'adoption', 'rally',
  'resolution', 'agreement', 'surge', 'record high',
];

let snapshot: GlobalRiskSnapshot = {
  ts: 0,
  ageMs: Number.MAX_SAFE_INTEGER,
  stale: true,
  score: 0,
  level: 'low',
  macro: { active: false, reason: null, next: null, nextInMin: null },
  sentiment: { fng: null, classification: null, composite: null },
  headlines: [],
  counts: { negative: 0, positive: 0, total: 0 },
  sources: { rss: 'not fetched', macro: 'not fetched', sentiment: 'not fetched' },
};
let timer = null;
let refreshing = false;

function clean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? clean(m[1]) : '';
}
function parseRss(xml, feedName) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    const title = tag(b, 'title');
    if (!title) continue;
    // The geopolitics query is broad; keep only headlines with a market/policy
    // angle so generic conflict stories do not inflate the risk score.
    if (feedName === 'GoogleNews-Geo' && !/market|oil|energy|dollar|currency|fed|inflation|sanction|tariff|trade|economy|shipping|bitcoin|crypto|stock|bank|nato|russia|ukraine|china|taiwan|iran|israel|middle east|opec/i.test(title)) continue;
    const pub = tag(b, 'pubDate');
    let publishedAt = null;
    if (pub) {
      const t = Date.parse(pub);
      if (Number.isFinite(t)) publishedAt = new Date(t).toISOString();
    }
    const url = tag(b, 'link');
    const source = tag(b, 'source') || feedName;
    const text = title.toLowerCase();
    let tone = 0;
    for (const k of NEGATIVE) if (text.includes(k)) tone -= 1;
    for (const k of POSITIVE) if (text.includes(k)) tone += 1;
    out.push({ title, source, url, publishedAt, tone });
  }
  return out;
}
async function fetchText(url, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'poly15-global-risk/1.0' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
async function fetchHeadlines() {
  const feeds = [
    ['GoogleNews-Crypto', 'https://news.google.com/rss/search?q=bitcoin%20OR%20crypto%20when%3A24h&hl=en-US&gl=US&ceid=US:en'],
    ['GoogleNews-Geo', 'https://news.google.com/rss/search?q=geopolitics%20OR%20war%20OR%20sanctions%20OR%20tariff%20when%3A24h&hl=en-US&gl=US&ceid=US:en'],
    ['Cointelegraph', 'https://cointelegraph.com/rss'],
  ];
  const all = [];
  const errors = [];
  await Promise.all(feeds.map(async ([name, url]) => {
    try {
      const xml = await fetchText(url);
      all.push(...parseRss(xml, name));
    } catch (err) {
      errors.push(name + ': ' + err.message);
    }
  }));
  // Deduplicate by title; keep only the last 24h where a publish time exists.
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const fresh = all.filter((h) => h.publishedAt == null || Date.parse(h.publishedAt) >= cutoff);
  const seen = new Set();
  const dedup = [];
  for (const h of fresh.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))) {
    const key = h.title.toLowerCase().slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(h);
    if (dedup.length >= 24) break;
  }
  return { headlines: dedup, error: errors.length ? errors.join('; ') : null };
}
function appendSnapshot(s) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(FILE) && statSync(FILE).size > MAX_BYTES) {
      try { renameSync(FILE, FILE + '.1'); } catch { /* best effort */ }
    }
    appendFileSync(FILE, JSON.stringify(s) + String.fromCharCode(10));
  } catch (err) {
    log.debug('snapshot write failed: ' + err.message);
  }
}
export async function refreshGlobalRisk() {
  if (refreshing) return snapshot;
  refreshing = true;
  const now = Date.now();
  try {
    const [news, macroStats, initialSentiment] = await Promise.all([
      fetchHeadlines(),
      Promise.resolve(getMacroStats()),
      Promise.resolve(getSentimentStats()),
    ]);
    let sentimentStats = initialSentiment;
    if (!sentimentStats.current) {
      await fetchSentiment();
      sentimentStats = getSentimentStats();
    }
    const headlines = news.headlines;
    const negative = headlines.filter((h) => h.tone < 0).length;
    const positive = headlines.filter((h) => h.tone > 0).length;
    const macroActive = checkMacroEvent();
    const nextMacro = macroStats.upcoming?.[0] || null;
    const macroRisk = macroActive ? 80 : (nextMacro && nextMacro.impact === 'High' && nextMacro.minutesUntil <= 60 ? 40 : 8);
    const headlineRisk = Math.min(40, negative * 5 + Math.max(0, negative - positive) * 3);
    const fng = sentimentStats.current?.fng ?? null;
    const sentimentRisk = fng == null ? 0 : (fng <= 10 || fng >= 90 ? 25 : (fng <= 25 || fng >= 75 ? 10 : 0));
    const score = Math.min(100, macroRisk + headlineRisk + sentimentRisk);
    const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
    snapshot = {
      ts: now,
      ageMs: 0,
      stale: false,
      score,
      level,
      macro: {
        active: !!macroActive,
        reason: macroActive?.reason ?? null,
        next: nextMacro ? nextMacro.title + ' (' + nextMacro.currency + ')' : null,
        nextInMin: nextMacro?.minutesUntil ?? null,
      },
      sentiment: {
        fng,
        classification: sentimentStats.current?.classification ?? null,
        composite: sentimentStats.current?.composite ?? null,
      },
      headlines: headlines.slice(0, 8),
      counts: { negative, positive, total: headlines.length },
      sources: {
        rss: news.error ? 'partial: ' + news.error : 'ok (' + headlines.length + ')',
        macro: macroStats.enabled ? 'ok' : 'disabled',
        sentiment: fng == null ? 'stale' : 'ok',
      },
    };
    appendSnapshot(snapshot);
    log.debug('risk ' + level + ' score=' + score + ' headlines=' + headlines.length);
    return snapshot;
  } catch (err) {
    log.debug('refresh failed: ' + err.message);
    snapshot = { ...snapshot, ageMs: Date.now() - snapshot.ts, stale: snapshot.ts === 0 };
    return snapshot;
  } finally {
    refreshing = false;
  }
}
export function getGlobalRisk() {
  return { ...snapshot, ageMs: snapshot.ts ? Date.now() - snapshot.ts : Number.MAX_SAFE_INTEGER, stale: snapshot.ts === 0 || Date.now() - snapshot.ts > 15 * 60_000 };
}
export function startGlobalRiskMonitor() {
  if (timer) return;
  void refreshGlobalRisk();
  timer = setInterval(() => { void refreshGlobalRisk(); }, REFRESH_MS);
  if (timer.unref) timer.unref();
  log.info('global risk monitor started (5 min)');
}
export function stopGlobalRiskMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
}
