import React from 'react';

type Headline = { title: string; source: string; url: string; publishedAt: string | null; tone: number };
type FredSeries = { id: string; label: string; value: number | null; unit: string; date: string | null };
type FredRelease = { date: string; name: string; label: string; daysUntil: number };
type Data = {
  score?: number;
  level?: 'low' | 'medium' | 'high';
  stale?: boolean;
  ageMs?: number;
  macro?: { active?: boolean; reason?: string | null; next?: string | null; nextInMin?: number | null };
  sentiment?: { fng?: number | null; classification?: string | null; composite?: number | null };
  headlines?: Headline[];
  counts?: { negative?: number; positive?: number; total?: number };
  fred?: { status?: string; series?: FredSeries[]; cpiYoY?: number | null; releases?: FredRelease[] };
};

function ago(ms?: number) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.round(s / 3600) + 'h';
}

export default function GlobalRiskPanel({ data }: { data?: Data | null }) {
  const level = data?.level || 'low';
  const color = level === 'high' ? '#fda4af' : level === 'medium' ? '#fcd34d' : '#86efac';
  const bg = level === 'high' ? 'rgba(251,113,133,.12)' : level === 'medium' ? 'rgba(251,191,36,.1)' : 'rgba(52,211,153,.1)';
  return (
    <div className="card">
      <div className="card__header">
        <span className="card__title">GLOBAL RISK</span>
        <span style={{ color, background: bg, border: '1px solid ' + color, borderRadius: 5, padding: '2px 6px', fontSize: 8, fontWeight: 800, letterSpacing: '.1em' }}>
          {String(level).toUpperCase()} {data?.score != null ? '· ' + data.score : ''}
        </span>
      </div>
      {!data ? (
        <div style={{ color: 'var(--dash-muted)', fontSize: 10, lineHeight: 1.6 }}>Collector warming up. Sources are record-only.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <div>
              <div style={{ color: 'var(--dash-dim)', fontSize: 8, letterSpacing: '.1em' }}>MACRO</div>
              <div style={{ color: 'var(--dash-text)', fontSize: 10, marginTop: 2 }}>
                {data.macro?.active ? 'BLOCK WINDOW' : data.macro?.next || 'clear'}
              </div>
              <div style={{ color: 'var(--dash-muted)', fontSize: 9 }}>
                {data.macro?.active ? data.macro?.reason || 'event active' : data.macro?.nextInMin != null ? 'in ' + data.macro.nextInMin + 'm' : 'no upcoming high-impact'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--dash-dim)', fontSize: 8, letterSpacing: '.1em' }}>SENTIMENT</div>
              <div style={{ color: 'var(--dash-text)', fontSize: 10, marginTop: 2 }}>
                {data.sentiment?.fng != null ? 'F&G ' + data.sentiment.fng : '—'} {data.sentiment?.classification ? '· ' + data.sentiment.classification : ''}
              </div>
              <div style={{ color: 'var(--dash-muted)', fontSize: 9 }}>
                {data.counts?.negative ?? 0} negative / {data.counts?.total ?? 0} headlines
              </div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--dash-line)', paddingTop: 6 }}>
            <div style={{ color: 'var(--dash-dim)', fontSize: 8, letterSpacing: '.1em', marginBottom: 3 }}>FRED</div>
            {data.fred?.status === 'ok' && (data.fred.series?.length ?? 0) > 0 ? (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  {(data.fred.series || []).slice(0, 5).map((s) => (
                    <span key={s.id} style={{ color: 'var(--dash-text)', fontSize: 9 }}>
                      <span style={{ color: 'var(--dash-dim)' }}>{s.label}</span>{' '}
                      {s.value == null ? '—' : s.value.toFixed(2)}<span style={{ color: 'var(--dash-muted)' }}>{s.unit}</span>
                    </span>
                  ))}
                </div>
                {data.fred.releases?.[0] && (
                  <div style={{ color: 'var(--dash-muted)', fontSize: 8, marginTop: 3 }}>
                    next {data.fred.releases[0].label} · {data.fred.releases[0].date}
                    {data.fred.releases[0].daysUntil != null ? ' · in ' + data.fred.releases[0].daysUntil + 'd' : ''}
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: 'var(--dash-muted)', fontSize: 9 }}>
                {data.fred?.status === 'disabled' ? 'key not configured' : 'unavailable'}
              </div>
            )}
          </div>
          {data.headlines && data.headlines.length > 0 && (
            <div style={{ borderTop: '1px solid var(--dash-line)', paddingTop: 6 }}>
              {data.headlines.slice(0, 3).map((h) => (
                <a key={h.title} href={h.url} target="_blank" rel="noreferrer" style={{
                  display: 'block', color: h.tone < 0 ? '#fecdd3' : 'var(--dash-muted)',
                  fontSize: 9, lineHeight: 1.35, marginBottom: 4, textDecoration: 'none',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }} title={h.title}>{h.title}</a>
              ))}
            </div>
          )}
          <div style={{ color: 'var(--dash-dim)', fontSize: 8, display: 'flex', justifyContent: 'space-between' }}>
            <span>{data.stale ? 'STALE' : 'LIVE'} · {ago(data.ageMs)}</span>
            <span>record-only</span>
          </div>
        </div>
      )}
    </div>
  );
}
