import React, { memo, useState } from 'react';
import { useServerNow } from '../hooks/useServerNow.ts';

const TABS =['overview', 'hourly', 'events', 'equity'];
const TAB_LABELS = { overview: 'Overview', hourly: 'Hourly', events: 'Events', equity: 'Equity' };

// ─────────────── Helpers ───────────────

function pnlColor(pnl) {
  if (pnl > 0) return 'var(--green-mid)';
  if (pnl < 0) return 'var(--red-mid)';
  return 'var(--text-muted)';
}

function wrColor(wr) {
  if (wr >= 60) return 'var(--green-mid)';
  if (wr >= 50) return 'var(--yellow-mid, #ffc107)';
  return 'var(--red-mid)';
}

function pnlStr(pnl) {
  if (pnl == null) return '-';
  return pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
}

function fmtTime(tsMs) {
  if (!tsMs) return '-';
  const d = new Date(tsMs);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}/${da} ${hh}:${mm}`;
}

function fmtHoldSec(sec) {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60 > 0 ? ` ${sec % 60}s` : ''}`;
}

function eventTypeColor(type) {
  switch (type) {
    case 'WIN': case 'TAKE_PROFIT': return 'var(--green-mid)';
    case 'LOSS': case 'CUT_LOSS': case 'EMERGENCY_CUT': case 'PHANTOM_LOSS': return 'var(--red-mid)';
    case 'CB_COOLDOWN_RESET': return 'var(--yellow-mid, #ffc107)';
    case 'SET_BANKROLL': case 'RECONCILE_ADJUST': return 'var(--cyan-mid, #17a2b8)';
    case 'SMART_SELL_FIRST': return 'var(--orange-mid, #fd7e14)';
    default: return 'var(--text-muted)';
  }
}

function eventTypeLabel(type) {
  const map = {
    WIN: 'WIN', LOSS: 'LOSS', CUT_LOSS: 'CUT', TAKE_PROFIT: 'TP',
    EMERGENCY_CUT: 'EMRG', SMART_SELL_FIRST: 'SELL', PHANTOM_LOSS: 'PHTM',
    UNWIND: 'UNWD', CB_COOLDOWN_RESET: 'CB RST', SET_BANKROLL: 'SET BR',
    RECONCILE_ADJUST: 'RECON', CONSEC_LOSS_RESET: 'LOSS RST',
  };
  return map[type] ?? type;
}

// ─────────────── Sub-Components ───────────────

const sectionTitle = {
  fontSize: '0.62rem', color: 'var(--text-dim)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
};

function HourlyBar({ hour, trades, wr, pnl, maxTrades }: any) {
  const barW = maxTrades > 0 ? Math.max(4, (trades / maxTrades) * 100) : 0;
  const label = `${String(hour).padStart(2, '0')}:00`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
      <span style={{ fontSize: '0.6rem', color: 'var(--text-dim)', width: 32, flexShrink: 0, textAlign: 'right' }}>
        {label}
      </span>
      <div style={{
        flex: 1, height: 14, background: 'var(--bg-elevated)',
        borderRadius: 2, overflow: 'hidden', position: 'relative',
        border: '1px solid var(--border-dim)',
      }}>
        {trades > 0 && (
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${barW}%`,
            background: wrColor(wr),
            opacity: 0.7,
            transition: 'width 0.4s ease',
          }} />
        )}
        {trades > 0 && (
          <span style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '0.56rem', fontWeight: 600, color: '#fff', zIndex: 1,
          }}>
            {wr.toFixed(0)}% ({trades})
          </span>
        )}
      </div>
      <span style={{ fontSize: '0.58rem', color: pnlColor(pnl), width: 42, textAlign: 'right', fontWeight: 600 }}>
        {trades > 0 ? pnlStr(pnl) : ''}
      </span>
    </div>
  );
}

function StatBox({ label, value, color, sub }: any) {
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
      borderRadius: 'var(--radius-sm)', padding: '6px 8px', textAlign: 'center', flex: 1, minWidth: 70,
    }}>
      <div style={{ fontSize: '0.56rem', color: 'var(--text-dim)', marginBottom: 2, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontWeight: 700, fontSize: '0.88rem', color: color ?? 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: '0.52rem', color: 'var(--text-dim)' }}>{sub}</div>}
    </div>
  );
}

// ─────────────── Tab: Overview ───────────────

/** A margin reads as good or bad on its own sign, not against a 50% midpoint. */
function marginColor(pp: number | null | undefined) {
  if (pp == null) return undefined;
  if (pp >= 3) return 'var(--green-mid)';
  if (pp > 0) return 'var(--text-primary)';
  return 'var(--red-mid)';
}

const ppStr = (pp: number | null | undefined) =>
  pp == null ? '—' : `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;

/**
 * Below this many realistic-fill trades the margin is labelled as too small to
 * read. n = (1.96·0.5 / 0.05)² ≈ 385 — a 95% interval narrow enough to separate
 * a ~5pp margin from zero, which is roughly where the realistic slice sits.
 *
 * It is the loose bar, not the real one: confirming a thin ~2.5pp edge at 80%
 * power needs ~2,280 trades. This threshold only stops a 30-trade reading from
 * being presented as a finding.
 */
const MIN_REALISTIC_SAMPLE = 385;

function OverviewTab({ data }: any) {
  const { patterns, sessions, dayOfWeek, sources, computedAt, actualPnl, margin } = data;

  // Live-ticking "Updated Xs ago" — re-renders every 5s independently.
  // `computedAt` is a bot timestamp, so the age must use the bot's clock.
  const now = useServerNow(5000);

  if (!patterns || patterns.totalTrades === 0) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>No trade data</div>;
  }

  const p = patterns;
  const streak = p.currentStreak;

  const ageSec = computedAt ? Math.round((now - computedAt) / 1000) : null;
  const ageStr = ageSec != null ? (ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`) : '';
  const sourceStr = sources
    ? `${sources.journal} journal${sources.verified > 0 ? ` + ${sources.verified} on-chain` : ''}`
    : '';

  return (
    <>
      {/* Data source info + polymarketscan cross-reference */}
      <div style={{ fontSize: '0.52rem', color: 'var(--text-dim)', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <a
          href="https://polymarketscan.org/address/0x2f8b9af5a465e2bdd5f9b541c3878bc64659b472"
          target="_blank"
          rel="noopener noreferrer"
          title="Verify on-chain via polymarketscan (third-party blockchain explorer)"
          style={{
            color: 'var(--text-dim)',
            textDecoration: 'none',
            padding: '2px 6px',
            border: '1px solid var(--border-dim)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.52rem',
          }}
        >
          🔗 Verify on polymarketscan.org ↗
        </a>
        <span>
          {sourceStr && <span>{sourceStr}</span>}
          {ageStr && <span style={{ marginLeft: 8 }}>Updated {ageStr}</span>}
        </span>
      </div>

      {/* Summary Stats — matched to polymarketscan layout */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <StatBox label="Trades" value={p.totalTrades} />
        <StatBox
          label="Win Rate"
          value={`${p.overallWr}%`}
          color={wrColor(p.overallWr)}
          sub={margin?.lifetime?.breakevenPct != null
            ? `need ${margin.lifetime.breakevenPct.toFixed(1)}%`
            : undefined}
        />
        {/* The win rate alone is not a verdict: at a 63c average entry, 66.6%
            is only +3.0pp. This box is the one to read. */}
        <StatBox
          label="Margin"
          value={ppStr(margin?.lifetime?.marginPp)}
          color={marginColor(margin?.lifetime?.marginPp)}
          sub="vs breakeven"
        />
        <StatBox label="Total P&L" value={pnlStr(p.totalPnl)} color={pnlColor(p.totalPnl)} />
        <StatBox
          label="Streak"
          value={streak?.count > 0 ? `${streak.count}${streak.type === 'win' ? 'W' : 'L'}` : '-'}
          color={streak?.type === 'win' ? 'var(--green-mid)' : streak?.type === 'loss' ? 'var(--red-mid)' : undefined}
        />
      </div>

      {/* Decision-grade slice: only rows whose entry price reflects a fill a
          live order would actually have got. Everything above blends those with
          dry-run rows booked at the quote, which is the optimistic bound. */}
      {margin?.realistic && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
          <StatBox
            label="Realistic fills"
            value={margin.realistic.trades}
            sub="fok_limit only"
          />
          <StatBox
            label="WR (realistic)"
            value={margin.realistic.winRatePct != null ? `${margin.realistic.winRatePct.toFixed(1)}%` : '—'}
            color={margin.realistic.winRatePct != null ? wrColor(margin.realistic.winRatePct) : undefined}
            sub={margin.realistic.breakevenPct != null
              ? `need ${margin.realistic.breakevenPct.toFixed(1)}%`
              : undefined}
          />
          <StatBox
            label="Margin (realistic)"
            value={ppStr(margin.realistic.marginPp)}
            color={marginColor(margin.realistic.marginPp)}
            sub={margin.realistic.trades < MIN_REALISTIC_SAMPLE
              ? `n too small (<${MIN_REALISTIC_SAMPLE})`
              : 'vs breakeven'}
          />
          <StatBox label="P&L (realistic)" value={pnlStr(margin.realistic.pnl)} color={pnlColor(margin.realistic.pnl)} />
        </div>
      )}

      {/* Polymarketscan-style aggregate metrics */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <StatBox
          label="ROI"
          value={p.roi != null ? `${p.roi >= 0 ? '+' : ''}${p.roi}%` : '—'}
          color={p.roi > 0 ? 'var(--green-mid)' : p.roi < 0 ? 'var(--red-mid)' : undefined}
        />
        <StatBox
          label="Volume"
          value={p.totalVolume != null ? `$${Math.round(p.totalVolume).toLocaleString()}` : '—'}
        />
        <StatBox
          label="Events"
          value={p.totalEvents != null ? p.totalEvents.toLocaleString() : '—'}
          sub="all on-chain"
        />
        <StatBox
          label="Total Cost"
          value={p.totalCost != null ? `$${Math.round(p.totalCost).toLocaleString()}` : '—'}
        />
      </div>

      {/* Actual vs Estimated PnL (from audit trail) */}
      {actualPnl && (
        <div style={{
          display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
          borderRadius: 'var(--radius-sm)', padding: '6px 8px',
          fontSize: '0.62rem',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.52rem', textTransform: 'uppercase' }}>Actual P&L (on-chain)</div>
            <div style={{ fontWeight: 700, color: pnlColor(actualPnl.bankrollChange) }}>
              {pnlStr(actualPnl.bankrollChange)}
            </div>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)' }}>
              ${actualPnl.firstBankroll} → ${actualPnl.lastBankroll}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--text-dim)', fontSize: '0.52rem', textTransform: 'uppercase' }}>Journal Est.</div>
            <div style={{ fontWeight: 700, color: pnlColor(p.totalPnl) }}>
              {pnlStr(p.totalPnl)}
            </div>
            <div style={{ fontSize: '0.5rem', color: 'var(--text-dim)' }}>
              {sources?.verifiedOverrides > 0 ? `${sources.verifiedOverrides} verified` : 'local estimates'}
            </div>
          </div>
        </div>
      )}

      {/* Avg P&L + Hold Time */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <StatBox label="Avg Win" value={pnlStr(p.avgPnlWin)} color="var(--green-mid)" sub={fmtHoldSec(p.avgHoldWin)} />
        <StatBox label="Avg Loss" value={pnlStr(p.avgPnlLoss)} color="var(--red-mid)" sub={fmtHoldSec(p.avgHoldLoss)} />
        <StatBox label="Best Streak" value={`${p.longestWinStreak}W`} color="var(--green-mid)" />
        <StatBox label="Worst Streak" value={`${p.longestLossStreak}L`} color="var(--red-mid)" />
      </div>

      {/* Best/Worst Patterns */}
      <div style={sectionTitle}>Best / Worst Patterns</div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: '3px 10px',
        fontSize: '0.66rem', marginBottom: 10,
      }}>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}></span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Best</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Worst</span>

        <span style={{ color: 'var(--text-secondary)' }}>Hour</span>
        <span style={{ color: 'var(--green-mid)', fontWeight: 600 }}>
          {p.bestHour ? `${String(p.bestHour.hour).padStart(2, '0')}:00 ${p.bestHour.wr}% (${pnlStr(p.bestHour.pnl)})` : '-'}
        </span>
        <span style={{ color: 'var(--red-mid)', fontWeight: 600 }}>
          {p.worstHour ? `${String(p.worstHour.hour).padStart(2, '0')}:00 ${p.worstHour.wr}% (${pnlStr(p.worstHour.pnl)})` : '-'}
        </span>

        <span style={{ color: 'var(--text-secondary)' }}>Session</span>
        <span style={{ color: 'var(--green-mid)', fontWeight: 600 }}>
          {p.bestSession ? `${p.bestSession.label} ${p.bestSession.wr}% (${pnlStr(p.bestSession.pnl)})` : '-'}
        </span>
        <span style={{ color: 'var(--red-mid)', fontWeight: 600 }}>
          {p.worstSession ? `${p.worstSession.label} ${p.worstSession.wr}% (${pnlStr(p.worstSession.pnl)})` : '-'}
        </span>

        <span style={{ color: 'var(--text-secondary)' }}>Day</span>
        <span style={{ color: 'var(--green-mid)', fontWeight: 600 }}>
          {p.bestDow ? `${p.bestDow.day} ${p.bestDow.wr}% (${pnlStr(p.bestDow.pnl)})` : '-'}
        </span>
        <span style={{ color: 'var(--red-mid)', fontWeight: 600 }}>
          {p.worstDow ? `${p.worstDow.day} ${p.worstDow.wr}% (${pnlStr(p.worstDow.pnl)})` : '-'}
        </span>
      </div>

      {/* Session Breakdown */}
      <div style={sectionTitle}>Session Breakdown</div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'auto repeat(4, 1fr)', gap: '3px 8px',
        fontSize: '0.64rem', marginBottom: 10,
      }}>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Session</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Trades</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>WR</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>W/L</span>
        <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>P&L</span>
        {Object.entries(sessions as Record<string, any>).map(([key, s]) => (
          <React.Fragment key={key}>
            <span style={{ color: 'var(--text-secondary)' }}>{s.label}</span>
            <span style={{ color: 'var(--text-muted)' }}>{s.trades}</span>
            <span style={{ color: s.trades >= 3 ? wrColor(s.wr) : 'var(--text-dim)', fontWeight: 600 }}>
              {s.trades > 0 ? `${s.wr}%` : '-'}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>{s.wins}/{s.losses}</span>
            <span style={{ color: pnlColor(s.pnl), fontWeight: 600 }}>{s.trades > 0 ? pnlStr(s.pnl) : '-'}</span>
          </React.Fragment>
        ))}
      </div>

      {/* Day-of-Week */}
      <div style={sectionTitle}>Day of Week</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {dayOfWeek.map(d => (
          <div key={d.day} style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
            borderRadius: 'var(--radius-sm)', padding: '4px 6px', textAlign: 'center',
            flex: 1, minWidth: 38,
          }}>
            <div style={{ fontSize: '0.54rem', color: 'var(--text-dim)', fontWeight: 600 }}>{d.day}</div>
            <div style={{ fontSize: '0.76rem', fontWeight: 700, color: d.trades >= 3 ? wrColor(d.wr) : 'var(--text-dim)' }}>
              {d.trades > 0 ? `${d.wr}%` : '-'}
            </div>
            <div style={{ fontSize: '0.5rem', color: pnlColor(d.pnl) }}>{d.trades > 0 ? pnlStr(d.pnl) : ''}</div>
            <div style={{ fontSize: '0.48rem', color: 'var(--text-dim)' }}>n={d.trades}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// ─────────────── Tab: Hourly ───────────────

function HourlyTab({ data }: any) {
  const { hourly } = data;
  if (!hourly) return null;

  const maxTrades = Math.max(...hourly.map(h => h.trades), 1);

  return (
    <>
      <div style={sectionTitle}>Win Rate by Hour (ET)</div>
      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
        {hourly.map(h => (
          <HourlyBar key={h.hour} hour={h.hour} trades={h.trades} wr={h.wr} pnl={h.pnl} maxTrades={maxTrades} />
        ))}
      </div>
    </>
  );
}

// ─────────────── Tab: Events ───────────────

function EventsTab({ data }: any) {
  const { events } = data;
  if (!events || events.length === 0) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>No events</div>;
  }

  const [showCount, setShowCount] = useState(30);
  const visible = events.slice(0, showCount);

  return (
    <>
      <div style={sectionTitle}>Event Timeline ({events.length} total)</div>
      <div style={{ maxHeight: 440, overflowY: 'auto' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '62px 42px 28px 48px auto',
          gap: '2px 6px', fontSize: '0.62rem', alignItems: 'center',
        }}>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Time</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Event</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Side</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>P&L</span>
          <span style={{ color: 'var(--text-dim)', fontWeight: 600 }}>Details</span>
          {visible.map((ev, i) => (
            <React.Fragment key={`${ev.ts}-${i}`}>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.58rem' }}>{fmtTime(ev.ts)}</span>
              <span style={{
                color: eventTypeColor(ev.type), fontWeight: 700, fontSize: '0.58rem',
                background: 'var(--bg-elevated)', padding: '1px 3px', borderRadius: 2, textAlign: 'center',
              }}>
                {eventTypeLabel(ev.type)}
              </span>
              <span style={{
                color: ev.side === 'UP' ? 'var(--green-mid)' : ev.side === 'DOWN' ? 'var(--red-mid)' : 'var(--text-dim)',
                fontWeight: 600, fontSize: '0.58rem',
              }}>
                {ev.side ?? ''}
              </span>
              <span style={{ color: pnlColor(ev.pnl), fontWeight: 600, fontSize: '0.6rem' }}>
                {ev.pnl != null ? pnlStr(ev.pnl) : ''}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: '0.56rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ev.details
                  ? ev.details
                  : ev.tokenPrice != null
                    ? `@${ev.tokenPrice.toFixed(3)} ML:${ev.mlConf ?? '-'}% ${ev.regime ?? ''} ${ev.holdSec != null ? fmtHoldSec(ev.holdSec) : ''}`
                    : ''
                }
              </span>
            </React.Fragment>
          ))}
        </div>
        {showCount < events.length && (
          <div
            style={{
              textAlign: 'center', padding: '6px 0', fontSize: '0.64rem',
              color: 'var(--cyan-mid, #17a2b8)', cursor: 'pointer',
            }}
            onClick={() => setShowCount(c => c + 50)}
          >
            Show more ({events.length - showCount} remaining)
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────── Tab: Equity ───────────────

function EquityTab({ data }) {
  const { equityCurve } = data;
  if (!equityCurve || equityCurve.length === 0) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>No equity data</div>;
  }

  // Filter to only entries with bankroll
  const points = equityCurve.filter(p => p.bankroll != null);
  if (points.length === 0) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>No bankroll snapshots</div>;
  }

  const bankrolls = points.map(p => p.bankroll);
  const minB = Math.min(...bankrolls);
  const maxB = Math.max(...bankrolls);
  const range = maxB - minB || 1;
  const chartH = 120;
  const chartW = 100; // percentage

  // SVG sparkline
  const svgPoints = points.map((p, i) => {
    const x = (i / Math.max(points.length - 1, 1)) * chartW;
    const y = chartH - ((p.bankroll - minB) / range) * (chartH - 8) - 4;
    return `${x},${y}`;
  }).join(' ');

  const firstBr = points[0].bankroll;
  const lastBr = points[points.length - 1].bankroll;
  const change = lastBr - firstBr;
  const changePct = firstBr > 0 ? ((change / firstBr) * 100).toFixed(1) : '0';

  return (
    <>
      <div style={sectionTitle}>
        Equity Curve ({points.length} snapshots)
      </div>

      {/* Summary */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <StatBox label="Start" value={`$${firstBr.toFixed(2)}`} sub={fmtTime(points[0].ts)} />
        <StatBox label="Now" value={`$${lastBr.toFixed(2)}`} color={pnlColor(change)} sub={fmtTime(points[points.length - 1].ts)} />
        <StatBox label="Change" value={`${pnlStr(change)} (${changePct}%)`} color={pnlColor(change)} />
        <StatBox label="Peak" value={`$${maxB.toFixed(2)}`} color="var(--green-mid)" />
        <StatBox label="Trough" value={`$${minB.toFixed(2)}`} color="var(--red-mid)" />
      </div>

      {/* Chart */}
      <div style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border-dim)',
        borderRadius: 'var(--radius-sm)', padding: '8px 4px', position: 'relative',
      }}>
        {/* Y-axis labels */}
        <div style={{
          position: 'absolute', left: 4, top: 6, fontSize: '0.5rem', color: 'var(--text-dim)',
        }}>
          ${maxB.toFixed(0)}
        </div>
        <div style={{
          position: 'absolute', left: 4, bottom: 4, fontSize: '0.5rem', color: 'var(--text-dim)',
        }}>
          ${minB.toFixed(0)}
        </div>
        <svg
          viewBox={`0 0 ${chartW} ${chartH}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: chartH, display: 'block' }}
        >
          <polyline
            points={svgPoints}
            fill="none"
            stroke={change >= 0 ? 'var(--green-mid)' : 'var(--red-mid)'}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      {/* Recent bankroll events */}
      <div style={{ ...sectionTitle, marginTop: 10 }}>Recent Changes</div>
      <div style={{ maxHeight: 160, overflowY: 'auto' }}>
        {points.slice(-20).reverse().map((p, i) => (
          <div key={`${p.ts}-${i}`} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: '0.6rem', padding: '2px 0',
            borderBottom: '1px solid var(--border-dim)',
          }}>
            <span style={{ color: 'var(--text-dim)' }}>{fmtTime(p.ts)}</span>
            <span style={{
              color: eventTypeColor(p.type), fontWeight: 600, fontSize: '0.56rem',
              background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 2,
            }}>
              {eventTypeLabel(p.type)}
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>${p.bankroll.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ─────────────── Main Panel ───────────────

function JournalTimeSeriesPanel({ data }) {
  const [tab, setTab] = useState('overview');

  if (!data) return null;

  return (
    <div className="card span-2" style={{ animationDelay: '0.32s' }}>
      <div className="card__header">
        <span className="card__title">Journal Analytics</span>
        {data.patterns?.totalTrades > 0 && (
          <span className="card__badge badge--live">{data.patterns.totalTrades} TRADES</span>
        )}
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: 2, marginBottom: 10,
        background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)', padding: 2,
      }}>
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '4px 0', fontSize: '0.64rem', fontWeight: 600,
              border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              background: tab === t ? 'var(--bg-card, #1a1a2e)' : 'transparent',
              color: tab === t ? 'var(--text-primary)' : 'var(--text-dim)',
              transition: 'all 0.2s',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'hourly' && <HourlyTab data={data} />}
      {tab === 'events' && <EventsTab data={data} />}
      {tab === 'equity' && <EquityTab data={data} />}
    </div>
  );
}

export default memo(JournalTimeSeriesPanel, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  if (!a || !b) return a === b;
  return (
    a.patterns?.totalTrades === b.patterns?.totalTrades &&
    a.patterns?.totalPnl === b.patterns?.totalPnl &&
    a.patterns?.overallWr === b.patterns?.overallWr &&
    a.patterns?.roi === b.patterns?.roi &&
    a.patterns?.totalVolume === b.patterns?.totalVolume &&
    a.patterns?.totalEvents === b.patterns?.totalEvents &&
    a.patterns?.currentStreak?.count === b.patterns?.currentStreak?.count &&
    a.sources?.total === b.sources?.total &&
    a.events?.length === b.events?.length &&
    a.equityCurve?.length === b.equityCurve?.length &&
    // Margin moves independently of the win rate — a book can hold its WR while
    // the average entry price drifts and the margin closes, which is exactly the
    // case this panel exists to make visible. Every rendered margin field is
    // listed: `pnl` especially, because journalAnalytics overwrites analysis.pnl
    // from the verified on-chain journal and only rewrites `outcome` when the
    // sign flips — so P&L can move while every count and rate stays identical.
    a.margin?.lifetime?.marginPp === b.margin?.lifetime?.marginPp &&
    a.margin?.lifetime?.breakevenPct === b.margin?.lifetime?.breakevenPct &&
    a.margin?.realistic?.trades === b.margin?.realistic?.trades &&
    a.margin?.realistic?.marginPp === b.margin?.realistic?.marginPp &&
    a.margin?.realistic?.winRatePct === b.margin?.realistic?.winRatePct &&
    a.margin?.realistic?.breakevenPct === b.margin?.realistic?.breakevenPct &&
    a.margin?.realistic?.pnl === b.margin?.realistic?.pnl
  );
});
