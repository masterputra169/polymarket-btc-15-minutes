/**
 * Alert templates — pure formatters for Telegram/Discord alerts.
 *
 * Rules: dynamic text is HTML-escaped; links are emitted as
 * `<a href="...">Label</a>` so notifier.ts can move them to inline buttons;
 * every formatter is pure and unit-tested.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return (n * 100).toFixed(digits) + '%';
}

function duration(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '-';
  if (min < 1) return Math.round(min * 60) + 's';
  return min.toFixed(1) + 'm';
}

export interface TradeEntryAlert {
  dryRun: boolean;
  side: string;
  price: number;
  shares: number;
  cost: number;
  edge: number | null;
  mlConfidence: number | null;
  mlSide: string | null;
  jevSummary: string | null;
  bankroll: number | null;
  phase?: string | null;
  timeLeftMin?: number | null;
  regime?: string | null;
  smartFlow?: string | null;
  marketSlug?: string | null;
}

/** Entry alert: one block the operator can scan in two seconds. */
export function tradeEntryAlert(p: TradeEntryAlert): string {
  const arrow = p.side === 'UP' ? '↑' : p.side === 'DOWN' ? '↓' : '↔';
  const title = p.dryRun ? '🧪 <b>DRY ENTRY</b>' : '⚡ <b>ENTRY</b>';
  const lines = [
    title + '  ' + arrow + ' <b>' + escapeHtml(p.side) + '</b>  @ <code>' + (p.price * 100).toFixed(1) + 'c</code>',
    '',
    '💵 <b>' + Number(p.shares).toFixed(0) + ' shares</b> · ' + fmtUsd(p.cost),
    p.edge != null ? '📐 Edge <b>' + (p.edge * 100).toFixed(1) + '%</b>' : null,
    p.mlConfidence != null
      ? '🤖 ML <b>' + fmtPct(p.mlConfidence) + '</b>' + (p.mlSide ? ' (' + escapeHtml(p.mlSide) + ')' : '')
      : '🤖 ML off',
    p.jevSummary ? '🧠 ' + escapeHtml(p.jevSummary) : null,
    p.phase || p.timeLeftMin != null
      ? '⏱ ' + (p.phase ? escapeHtml(p.phase) : '-') + (p.timeLeftMin != null ? ' · ' + duration(p.timeLeftMin) + ' left' : '')
      : null,
    p.regime ? '🌊 Regime: ' + escapeHtml(p.regime) : null,
    p.smartFlow && p.smartFlow !== 'NEUTRAL' ? '💸 Flow: ' + escapeHtml(p.smartFlow) : null,
    '🏦 Bankroll ' + fmtUsd(p.bankroll),
    p.marketSlug ? '<a href="https://polymarket.com/event/' + encodeURIComponent(p.marketSlug) + '">View Market</a>' : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export interface StartupAlert {
  dryRun: boolean;
  bankroll: number;
  jevMode: string | null;
  jevProvider: string | null;
  twapMode: string | null;
  clobV2: boolean;
  modelId: string | null;
  version?: string | null;
}

export function startupAlert(p: StartupAlert): string {
  const lines = [
    p.dryRun ? '🧪 <b>BOT STARTED — DRY RUN</b>' : '🚀 <b>BOT STARTED — LIVE</b>',
    '',
    '🏦 Bankroll: <b>' + fmtUsd(p.bankroll) + '</b>',
    '🧠 JEV: ' + escapeHtml(p.jevMode ?? 'off') + (p.jevProvider ? ' · ' + escapeHtml(p.jevProvider) : ''),
    '📡 TWAP feed: ' + escapeHtml(p.twapMode ?? '-'),
    '🔗 CLOB V2: ' + (p.clobV2 ? 'ready' : 'not initialized (dry run)'),
    p.modelId ? '🤖 Model: <code>' + escapeHtml(p.modelId) + '</code>' : null,
    p.version ? '🏷 Version: ' + escapeHtml(p.version) : null,
  ].filter(Boolean);
  return lines.join('\n');
}

export interface FeedAlertView {
  kind: 'ptb' | 'twap' | 'clob';
  level: 'warn' | 'info';
  detail: string;
  slug?: string | null;
}

export function feedAlertMessage(a: FeedAlertView): string {
  const icon = a.kind === 'ptb' ? '🎯' : a.kind === 'twap' ? '📡' : '📉';
  const label = a.kind === 'ptb' ? 'Price-to-beat' : a.kind === 'twap' ? 'Chainlink TWAP feed' : 'CLOB book';
  const head = a.level === 'info' ? '✅ <b>Feed recovered</b>' : '⚠️ <b>Feed alert</b>';
  return [
    head,
    icon + ' ' + label + ': ' + escapeHtml(a.detail),
    a.slug ? '🎫 <code>' + escapeHtml(a.slug) + '</code>' : null,
  ].filter(Boolean).join('\n');
}
