/**
 * How the dashboard names the CLOB feed's state.
 *
 * Two states hid the thing an operator actually needs to know. "🔄 REST Poll"
 * appeared both when the stream had broken and when the book simply had no
 * trades for a few seconds, so it stopped being a signal worth reacting to.
 *
 * Three states restore that: `live` and `quiet` are both the real WebSocket
 * book (quiet only means no quote has moved — the link is proven alive by
 * PING/PONG), and `down` means the bot has genuinely fallen back to the 30s
 * REST snapshot and something is wrong.
 */

export type ClobTone = 'live' | 'quiet' | 'down';

export interface ClobSourceLabel {
  text: string;
  tone: ClobTone;
  /** Short explanation for a down feed — null when there is nothing to add. */
  detail: string | null;
  /** Compact form for the header pill. */
  short: string;
  /** Status-dot modifier class matching the tone. */
  dotClass: string;
}

const DOWN_REASONS: Record<string, string> = {
  disconnected: 'socket closed',
  no_book: 'waiting for book',
  link_silent: 'stream silent',
  quote_expired: 'quotes expired',
};

export function describeClobSource({
  clobStatus,
  clobQuietMs,
  clobDownReason,
  clobSource,
}: {
  clobStatus?: string | null;
  clobQuietMs?: number | null;
  clobDownReason?: string | null;
  clobSource?: string | null;
} = {}): ClobSourceLabel {
  // A dashboard build can outrun the bot deploy; fall back to the old field.
  const status = clobStatus ?? (clobSource === 'WebSocket' ? 'live' : 'down');

  if (status === 'live') {
    return { text: '⚡ WebSocket', tone: 'live', detail: null, short: 'CLOB WS', dotClass: '' };
  }

  if (status === 'quiet') {
    const secs = typeof clobQuietMs === 'number' && Number.isFinite(clobQuietMs)
      ? Math.round(clobQuietMs / 1000)
      : null;
    return {
      text: secs === null ? '🟡 WebSocket' : `🟡 WebSocket · quiet ${secs}s`,
      tone: 'quiet',
      detail: null,
      short: 'CLOB WS·q',
      dotClass: 'status-dot--warning',
    };
  }

  return {
    text: '🔄 REST Poll',
    tone: 'down',
    detail: clobDownReason ? (DOWN_REASONS[clobDownReason] ?? clobDownReason) : null,
    short: 'CLOB REST',
    dotClass: 'status-dot--error',
  };
}
