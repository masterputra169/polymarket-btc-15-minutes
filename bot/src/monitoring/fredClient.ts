/**
 * FRED macro adapter — record-only context.
 *
 * Credential lookup (in order):
 *   1. process.env.FRED_API_KEY
 *   2. /etc/poly15/global-risk.env
 *   3. ~/.poly15/global-risk.env
 *
 * Requests are cached for 6 hours. The key is never logged.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createLogger } from '../logger.ts';

const log = createLogger('FRED');
const BASE = 'https://api.stlouisfed.org/fred';
const CACHE_MS = 6 * 60 * 60_000;
const TIMEOUT_MS = 20_000;
const KEY_PATHS = ['/etc/poly15/global-risk.env', resolve(homedir(), '.poly15', 'global-risk.env')];

export type FredSeries = {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  date: string | null;
};
export type FredRelease = {
  date: string;
  name: string;
  label: string;
  daysUntil: number;
};
export type FredSnapshot = {
  status: 'ok' | 'disabled' | 'error';
  fetchedAt: number;
  series: FredSeries[];
  cpiYoY: number | null;
  releases: FredRelease[];
  error?: string;
};

const RELEASES: Array<{ re: RegExp; label: string }> = [
  { re: /^Consumer Price Index/i, label: 'CPI' },
  { re: /^Employment Situation/i, label: 'NFP' },
  { re: /^Gross Domestic Product$/i, label: 'GDP' },
  { re: /^Personal Income and Outlays/i, label: 'PCE' },
  { re: /^Producer Price Index/i, label: 'PPI' },
  { re: /^Retail Sales/i, label: 'RETAIL' },
  { re: /^University of Michigan/i, label: 'UMICH' },
  { re: /^Initial Claims$/i, label: 'CLAIMS' },
];
const SERIES: Array<{ id: string; label: string; unit: string; limit: number; yoy?: boolean }> = [
  { id: 'CPIAUCSL', label: 'CPI', unit: '% y/y', limit: 24, yoy: true },
  { id: 'FEDFUNDS', label: 'FED', unit: '%', limit: 5 },
  { id: 'DGS10', label: '10Y', unit: '%', limit: 5 },
  { id: 'VIXCLS', label: 'VIX', unit: 'idx', limit: 5 },
  { id: 'UNRATE', label: 'UNEMP', unit: '%', limit: 5 },
];

let cache: FredSnapshot | null = null;
let inflight: Promise<FredSnapshot> | null = null;
let missingKeyLogged = false;

function readKeyFromFile(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    const m = text.match(/^\s*FRED_API_KEY\s*=\s*(.+?)\s*$/m);
    if (!m) return null;
    return m[1].replace(/^['"]|['"]$/g, '').trim() || null;
  } catch {
    return null;
  }
}
function loadKey(): string | null {
  if (process.env.FRED_API_KEY?.trim()) return process.env.FRED_API_KEY.trim();
  for (const file of KEY_PATHS) {
    const key = readKeyFromFile(file);
    if (key) return key;
  }
  return null;
}
function empty(status: FredSnapshot['status'], error?: string): FredSnapshot {
  return { status, fetchedAt: Date.now(), series: [], cpiYoY: null, releases: [], error };
}
async function fredGet(key: string, endpoint: string, params: Record<string, string>): Promise<any> {
  const url = new URL(BASE + endpoint);
  url.searchParams.set('api_key', key);
  url.searchParams.set('file_type', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
async function fetchOneSeries(key: string, spec: typeof SERIES[number]): Promise<FredSeries> {
  const data = await fredGet(key, '/series/observations', {
    series_id: spec.id,
    sort_order: 'desc',
    limit: String(spec.limit),
  });
  const obs = Array.isArray(data?.observations) ? data.observations : [];
  const clean = obs
    .map((o: any) => ({ date: String(o.date || ''), value: num(o.value) }))
    .filter((o: any) => o.value != null && o.date);
  const latest = clean[0] || null;
  let value = latest?.value ?? null;
  if (spec.yoy && latest) {
    const latestDate = Date.parse(latest.date + 'T00:00:00Z');
    const target = new Date(latestDate);
    target.setUTCFullYear(target.getUTCFullYear() - 1);
    const targetMonth = target.toISOString().slice(0, 7);
    const yearAgo = clean.find((o: any) => String(o.date).slice(0, 7) === targetMonth);
    if (yearAgo?.value) value = ((latest.value / yearAgo.value) - 1) * 100;
    else value = null;
  }
  return {
    id: spec.id,
    label: spec.label,
    value: value == null ? null : Math.round(value * 100) / 100,
    unit: spec.unit,
    date: latest?.date ?? null,
  };
}
async function fetchReleases(key: string): Promise<FredRelease[]> {
  const start = new Date();
  const end = new Date(start.getTime() + 60 * 86400_000);
  const data = await fredGet(key, '/releases/dates', {
    realtime_start: start.toISOString().slice(0, 10),
    realtime_end: end.toISOString().slice(0, 10),
    include_release_dates_with_no_data: 'true',
    order_by: 'release_date',
    sort_order: 'asc',
    limit: '200',
  });
  const rows = Array.isArray(data?.release_dates) ? data.release_dates : [];
  const today = Date.parse(start.toISOString().slice(0, 10) + 'T00:00:00Z');
  const out: FredRelease[] = [];
  const seen = new Set();
  for (const row of rows) {
    const name = String(row.release_name || '');
    const date = String(row.date || '');
    if (!date) continue;
    const matcher = RELEASES.find((r) => r.re.test(name));
    if (!matcher) continue;
    const key2 = date + ':' + matcher.label;
    if (seen.has(key2)) continue;
    seen.add(key2);
    const days = Math.max(0, Math.round((Date.parse(date + 'T00:00:00Z') - today) / 86400_000));
    out.push({ date, name, label: matcher.label, daysUntil: days });
  }
  // One entry per release type; FRED can return multiple rows for a release.
  const byLabel = new Map<string, FredRelease>();
  for (const r of out) {
    const existing = byLabel.get(r.label);
    if (!existing || r.date < existing.date) byLabel.set(r.label, r);
  }
  return [...byLabel.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
}
async function load(): Promise<FredSnapshot> {
  const key = loadKey();
  if (!key) {
    if (!missingKeyLogged) {
      missingKeyLogged = true;
      log.info('FRED disabled: no FRED_API_KEY (looked in env and protected files)');
    }
    return empty('disabled');
  }
  try {
    const [seriesResults, releases] = await Promise.all([
      Promise.allSettled(SERIES.map((spec) => fetchOneSeries(key, spec))),
      fetchReleases(key).catch(() => []),
    ]);
    const series = seriesResults
      .filter((r): r is PromiseFulfilledResult<FredSeries> => r.status === 'fulfilled')
      .map((r) => r.value);
    const cpi = series.find((s) => s.id === 'CPIAUCSL');
    return {
      status: series.length ? 'ok' : 'error',
      fetchedAt: Date.now(),
      series,
      cpiYoY: cpi?.value ?? null,
      releases,
      error: series.length ? undefined : 'all series failed',
    };
  } catch (err: any) {
    log.warn('FRED fetch failed: ' + (err?.message || 'unknown'));
    return { ...empty('error', String(err?.message || 'unknown')), series: cache?.series || [], cpiYoY: cache?.cpiYoY ?? null, releases: cache?.releases || [] };
  }
}
export async function fetchFredSnapshot(force = false): Promise<FredSnapshot> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = load()
    .then((s) => { if (s.status === 'ok') cache = s; else if (!cache) cache = s; return cache || s; })
    .catch(() => cache || empty('error', 'unknown'))
    .finally(() => { inflight = null; });
  return inflight;
}
