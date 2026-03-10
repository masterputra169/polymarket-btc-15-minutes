import React, { memo, useState } from 'react';

const TABS = ['overview', 'hourly', 'events', 'equity'];
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

function HourlyBar({ hour, trades, wr, pnl, maxTrades }) {
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

function StatBox({ label, value, color, sub }) {
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

function OverviewTab({ data }) {
  const { patterns, sessions, dayOfWeek } = data;
  if (!patterns || patterns.totalTrades === 0) {
    return <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.78rem' }}>No trade data</div>;
  }

  const p = patterns;
  const streak = p.currentStreak;

  return (
    <>
      {/* Summary Stats */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <StatBox label="Trades" value={p.totalTrades} />
        <StatBox label="Win Rate" value={`${p.overallWr}%`} color={wrColor(p.overallWr)} />
        <StatBox label="Total P&L" value={pnlStr(p.totalPnl)} color={pnlColor(p.totalPnl)} />
        <StatBox
          label="Streak"
          value={streak?.count > 0 ? `${streak.count}${streak.type === 'win' ? 'W' : 'L'}` : '-'}
          color={streak?.type === 'win' ? 'var(--green-mid)' : streak?.type === 'loss' ? 'var(--red-mid)' : undefined}
        />
      </div>

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
        {Object.entries(sessions).map(([key, s]) => (
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

function HourlyTab({ data }) {
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

function EventsTab({ data }) {
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
    a.computedAt === b.computedAt &&
    a.patterns?.totalTrades === b.patterns?.totalTrades
  );
});
