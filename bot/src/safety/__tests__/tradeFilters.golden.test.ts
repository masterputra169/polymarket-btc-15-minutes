/**
 * Golden behaviour of applyTradeFilters.
 *
 * 20,000 seeded inputs across two configurations (time gates off / no dry-run
 * cap on a weekday; time gates on / 75c dry-run cap on a weekend), with the
 * module's own state exercised along the way (loss cooldown, per-market trade
 * counts, the spread baseline) and the three external gates (sentiment, macro,
 * LLM regime) driven per input so their bypass thresholds are covered too.
 *
 * The expected hashes were recorded on 2026-09-25 from the filter module as it
 * was BEFORE its thresholds moved into filterThresholds.ts. A refactor that
 * claims "no behaviour change" must leave every chunk hash untouched: any
 * difference in pass/fail, reason text or session quality for any input shows
 * up here. Print fresh hashes with GOLDEN_PRINT=1 only when a behaviour change
 * is intended — and say so in the commit.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

const ext = vi.hoisted(() => ({ sentiment: null as any, macro: null as any, llm: null as any }));
vi.mock('../../engines/sentimentSignal.ts', () => ({ checkExtremeSentiment: () => ext.sentiment }));
vi.mock('../../monitoring/macroCalendar.ts', () => ({ checkMacroEvent: () => ext.macro }));
vi.mock('../../ai/regimeClassifier.ts', () => ({ checkLLMRegimeAdvisory: () => ext.llm }));
vi.mock('../../monitoring/ptbHealth.ts', () => ({ recordPtbSource: () => {} }));

const ORIGINAL_ENV = { ...process.env };
const CHUNK = 1_000;
const PER_SCENARIO = 10_000;

/** mulberry32 — small, fast, deterministic. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeInputs(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  // Mix of uniform values and the exact boundaries the gates compare against.
  const num = (lo: number, hi: number, edges: number[]) => (r() < 0.35 ? pick(edges) : lo + r() * (hi - lo));
  const maybe = <T,>(p: number, v: () => T): T | null => (r() < p ? null : v());
  const slugs = ['btc-updown-15m-1', 'btc-updown-15m-2', 'btc-updown-15m-3', 'btc-updown-15m-4'];
  const out: any[] = [];
  for (let i = 0; i < PER_SCENARIO; i++) {
    const btc = 80_000 + (r() - 0.5) * 2_000;
    out.push({
      input: {
        mlConfidence: maybe(0.05, () => num(0, 1, [0.3, 0.45, 0.55, 0.6, 0.65, 0.75, 0.8, 0.85, 0.9, 0.95])),
        mlAvailable: r() > 0.05,
        marketPrice: maybe(0.03, () => num(0, 1, [0.14, 0.15, 0.5, 0.55, 0.6, 0.62, 0.63, 0.68, 0.72, 0.75, 0.85, 0.86])),
        atrRatio: maybe(0.1, () => num(0, 2, [0.2, 0.3, 0.5])),
        timeLeftMin: r() < 0.02 ? NaN : maybe(0.03, () => num(0, 15, [0.5, 2, 5, 10, 12])),
        marketSlug: pick(slugs),
        consecutiveLosses: Math.floor(r() * 6),
        session: pick(['US', 'EU/US Overlap', 'Europe', 'Asia', 'Off-hours', 'Weird']),
        btcPrice: maybe(0.03, () => btc),
        priceToBeat: maybe(0.03, () => btc * (1 + (r() - 0.5) * 0.002)),
        tiltMlConfMin: r() < 0.15 ? 0.6 : null,
        bestEdge: maybe(0.05, () => num(-0.3, 0.6, [0.08, 0.1, 0.12, 0.15, 0.25, 0.35, 0.5])),
        delta1m: maybe(0.05, () => (r() - 0.5) * 600),
        signalSide: pick(['UP', 'DOWN', null]),
        regime: pick(['trending', 'moderate', 'choppy', 'mean_reverting']),
        etHour: Math.floor(r() * 24),
        spread: maybe(0.1, () => num(0, 0.12, [0.01, 0.04, 0.08])),
        mlAccuracy: maybe(0.3, () => num(0, 1, [0.45])),
        buyRatio: maybe(0.2, () => num(0, 1, [0.15, 0.5, 0.85])),
        ptbSource: pick(['data_streams', 'polymarket_gamma', 'scheduled_ws', 'polymarket_page', 'chainlink_round', 'oracle', null]),
      },
      lateSniper: r() < 0.5,
      sentiment: r() < 0.1 ? { block: true, reason: 'Extreme fear (FnG=4)' } : null,
      macro: r() < 0.1 ? { block: true, reason: 'CPI in 10m' } : null,
      llm: r() < 0.1 ? { block: true, reason: 'regime conflict', mlBypassAbove: r() < 0.5 ? undefined : 0.8 } : null,
      loss: i % 97 === 0,
      traded: i % 13 === 0,
    });
  }
  return out;
}

async function runScenario(env: Record<string, string | undefined>, startMs: number, seed: number): Promise<string[]> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { setLogLevel } = await import('../../logger.ts');
  setLogLevel('error');
  const f = await import('../tradeFilters.ts');
  const hashes: string[] = [];
  let chunk: unknown[] = [];
  const cases = makeInputs(seed);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    vi.setSystemTime(startMs + i * 1_000);
    if (c.loss) f.recordLoss();
    if (c.traded) f.recordTradeForMarket(c.input.marketSlug);
    if (i % 500 === 0) f.resetMarketTradeCount(null);
    if (c.lateSniper) process.env.LATE_SNIPER_ENABLED = 'true';
    else delete process.env.LATE_SNIPER_ENABLED;
    ext.sentiment = c.sentiment;
    ext.macro = c.macro;
    ext.llm = c.llm;
    chunk.push(f.applyTradeFilters(c.input));
    if (chunk.length === CHUNK) {
      hashes.push(createHash('sha256').update(JSON.stringify(chunk)).digest('hex').slice(0, 16));
      chunk = [];
    }
  }
  return hashes;
}

const WEDNESDAY = Date.UTC(2026, 8, 23, 14, 0, 0);
const SATURDAY = Date.UTC(2026, 8, 26, 14, 0, 0);

// Recorded from the pre-refactor module (see header), then re-recorded on
// 2026-09-25 for one intended change: the PTB-source gate now trusts only the
// 60 s TWAP sources (scheduled_ws and data_streams became non-exact, the gate's
// reason text changed, data_streams left the sniper/edge-ceiling lists). Before
// re-recording, all 20k outputs of both scenarios were compared with the
// previous module fed the same inputs (scheduled_ws/data_streams mapped to a
// non-exact source, the PTB reason normalised): identical, 20,000 of 20,000.
const EXPECTED = {
  timeGatesOff_noCap_weekday: [
    '20948600c8c17976', '9d8e9b4dcbfd4ce1', '526ff7dde04fcb54', 'dac5d609b19b5b05', 'ad117ac2e1fb0572',
    'd541a7bd557f2a05', 'a0a57c8da0e69338', '513e197d7736a43b', '26b71b32e232d3f3', 'f6ce9b87fce7894c',
  ],
  timeGatesOn_dryCap75_weekend: [
    '7ac3fb1401dbbf92', '544a31dfbf7f10a2', 'daf631ccf2946375', '325ed9409d038d44', '044b61f5508643b3',
    'b502e6d59d3149ca', '8ac1b51c533f2bfe', 'aaa18f33989dd024', '91d508e476ea2a1f', '196712e9d2941ec4',
  ],
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('applyTradeFilters golden behaviour', () => {
  test('time gates off, no dry-run cap, weekday', async () => {
    const got = await runScenario(
      { TIME_GATES_ENABLED: undefined, BLOCKED_SESSIONS: undefined, DRY_RUN: 'false', DRY_RUN_HARD_ENTRY_CAP: undefined, POLL_INTERVAL_MS: '80' },
      WEDNESDAY, 20260925,
    );
    if (process.env.GOLDEN_PRINT) console.log('timeGatesOff_noCap_weekday', JSON.stringify(got));
    expect(got).toEqual(EXPECTED.timeGatesOff_noCap_weekday);
  }, 120_000);

  test('time gates on, 75c dry-run cap, weekend, Europe blocked', async () => {
    const got = await runScenario(
      { TIME_GATES_ENABLED: 'true', BLOCKED_SESSIONS: 'Europe', DRY_RUN: 'true', DRY_RUN_HARD_ENTRY_CAP: '0.75', POLL_INTERVAL_MS: '80' },
      SATURDAY, 7,
    );
    if (process.env.GOLDEN_PRINT) console.log('timeGatesOn_dryCap75_weekend', JSON.stringify(got));
    expect(got).toEqual(EXPECTED.timeGatesOn_dryCap75_weekend);
  }, 120_000);
});
