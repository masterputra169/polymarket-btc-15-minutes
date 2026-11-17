/**
 * Live & Boundary Cross-Timeframe 5m vs 15m Overlap Study (bear102 reference).
 *
 * Scans active + upcoming Polymarket 5m and 15m Up/Down windows that expire
 * at the exact same timestamp for BTC, ETH, and SOL, checks each market's
 * priceToBeat / CLOB best asks & sizes, and verifies whether any complete-set
 * butterfly (`ask_5m + ask_15m + V2 taker fees < 1.00`) exists >= 5 shares.
 *
 * Run:
 *   node backtest/ml_training/cross5m15mStudy.mts
 */

interface BookLevel {
  price: string;
  size: string;
}

interface OrderBook {
  bids?: BookLevel[];
  asks?: BookLevel[];
}

function takerFeePerShare(p: number): number {
  return 0.07 * p * (1 - p);
}

function bestAsk(levels: BookLevel[] | undefined): { price: number; size: number } | null {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  let best: { price: number; size: number } | null = null;
  for (const lvl of levels) {
    const p = Number(lvl.price);
    const s = Number(lvl.size);
    if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
    if (best === null || p < best.price) best = { price: p, size: s };
  }
  return best;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function fetchWindowPtb(asset: string, startSec: number, durationSec: number, ev: any): Promise<number | null> {
  const metaPtb = Number(ev?.[0]?.eventMetadata?.priceToBeat);
  if (Number.isFinite(metaPtb) && metaPtb > 0) return metaPtb;
  const variant = durationSec === 300 ? 'five' : 'fifteen';
  const sIso = new Date(startSec * 1000).toISOString().replace('.000Z', 'Z');
  const eIso = new Date((startSec + durationSec) * 1000).toISOString().replace('.000Z', 'Z');
  const j = await fetchJson<any>(
    `https://polymarket.com/api/crypto/crypto-price?symbol=${asset.toUpperCase()}&eventStartTime=${sIso}&variant=${variant}&endDate=${eIso}&twapEnabled=true&twapLookbackSeconds=60`,
  );
  const op = Number(j?.openPrice);
  return Number.isFinite(op) && op > 0 ? op : null;
}

async function inspectPair(asset: string, start15Sec: number) {
  const start5Sec = start15Sec + 600; // final 5m window ends on the exact same boundary as the 15m window
  const slug15 = `${asset}-updown-15m-${start15Sec}`;
  const slug5 = `${asset}-updown-5m-${start5Sec}`;

  const [ev15, ev5] = await Promise.all([
    fetchJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${slug15}`),
    fetchJson<any[]>(`https://gamma-api.polymarket.com/events?slug=${slug5}`),
  ]);
  const m15 = ev15?.[0]?.markets?.[0];
  const m5 = ev5?.[0]?.markets?.[0];
  if (!m15 || !m5) {
    return { asset, slug15, slug5, status: 'missing_market' as const };
  }

  const [ptb15, ptb5] = await Promise.all([
    fetchWindowPtb(asset, start15Sec, 900, ev15),
    fetchWindowPtb(asset, start5Sec, 300, ev5),
  ]);

  const tokens15: string[] = JSON.parse(m15.clobTokenIds || '[]');
  const tokens5: string[] = JSON.parse(m5.clobTokenIds || '[]');
  const outcomes15: string[] = JSON.parse(m15.outcomes || '["Up","Down"]');
  const outcomes5: string[] = JSON.parse(m5.outcomes || '["Up","Down"]');
  if (tokens15.length < 2 || tokens5.length < 2) {
    return { asset, slug15, slug5, status: 'missing_tokens' as const };
  }

  const idxUp15 = outcomes15.findIndex(o => o.toLowerCase() === 'up');
  const idxUp5 = outcomes5.findIndex(o => o.toLowerCase() === 'up');
  const up15Tok = tokens15[idxUp15 >= 0 ? idxUp15 : 0];
  const dn15Tok = tokens15[idxUp15 >= 0 ? 1 - idxUp15 : 1];
  const up5Tok = tokens5[idxUp5 >= 0 ? idxUp5 : 0];
  const dn5Tok = tokens5[idxUp5 >= 0 ? 1 - idxUp5 : 1];

  const [bUp15, bDn15, bUp5, bDn5] = await Promise.all([
    fetchJson<OrderBook>(`https://clob.polymarket.com/book?token_id=${up15Tok}`),
    fetchJson<OrderBook>(`https://clob.polymarket.com/book?token_id=${dn15Tok}`),
    fetchJson<OrderBook>(`https://clob.polymarket.com/book?token_id=${up5Tok}`),
    fetchJson<OrderBook>(`https://clob.polymarket.com/book?token_id=${dn5Tok}`),
  ]);

  const askUp15 = bestAsk(bUp15?.asks);
  const askDn15 = bestAsk(bDn15?.asks);
  const askUp5 = bestAsk(bUp5?.asks);
  const askDn5 = bestAsk(bDn5?.asks);

  const combos = [
    {
      pair: '5m_UP + 15m_DOWN',
      a: askUp5,
      b: askDn15,
      ptbGuaranteed: ptb5 != null && ptb15 != null ? ptb5 <= ptb15 : null,
    },
    {
      pair: '5m_DOWN + 15m_UP',
      a: askDn5,
      b: askUp15,
      ptbGuaranteed: ptb5 != null && ptb15 != null ? ptb5 >= ptb15 : null,
    },
  ].map(c => {
    if (!c.a || !c.b) return { pair: c.pair, status: 'no_ask' as const };
    const grossSum = c.a.price + c.b.price;
    const feeSum = takerFeePerShare(c.a.price) + takerFeePerShare(c.b.price);
    const netCost = grossSum + feeSum;
    const edgeNet = 1 - netCost;
    const maxShares = Math.min(c.a.size, c.b.size);
    return {
      pair: c.pair,
      ask5: c.a.price,
      size5: c.a.size,
      ask15: c.b.price,
      size15: c.b.size,
      grossSum: Number(grossSum.toFixed(4)),
      feeSum: Number(feeSum.toFixed(4)),
      netCost: Number(netCost.toFixed(4)),
      edgeNet: Number(edgeNet.toFixed(4)),
      maxShares: Number(maxShares.toFixed(2)),
      ptbGuaranteed: c.ptbGuaranteed,
      actionableArb: c.ptbGuaranteed === true && edgeNet > 0 && maxShares >= 5,
    };
  });

  return {
    asset,
    slug15,
    slug5,
    ptb15,
    ptb5,
    endDate: m15.endDate,
    status: 'ok' as const,
    combos,
  };
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  const cur15 = Math.floor(nowSec / 900) * 900;
  const windows = [cur15, cur15 + 900];
  const assets = ['btc', 'eth', 'sol'];

  console.log(`=== Cross 5m/15m Polymarket Overlap Probe @ ${new Date().toISOString()} ===`);
  let totalCombos = 0;
  let positiveNet = 0;
  let actionable = 0;

  for (const w of windows) {
    for (const a of assets) {
      const res = await inspectPair(a, w);
      if (res.status !== 'ok') {
        console.log(`  [${a.toUpperCase()}] ${res.slug15} vs ${res.slug5}: ${res.status}`);
        continue;
      }
      for (const c of res.combos) {
        if ('status' in c) continue;
        totalCombos += 1;
        if (c.ptbGuaranteed === true && c.edgeNet > 0) positiveNet += 1;
        if (c.actionableArb) actionable += 1;
        const ptbTag = c.ptbGuaranteed === null
          ? 'PTB=pending'
          : `${c.ptbGuaranteed ? 'PTB=COVERED' : 'PTB=GAP_RISK'} (5m=${res.ptb5} vs 15m=${res.ptb15})`;
        console.log(
          `  [${a.toUpperCase()}] ${res.slug5.split('-').pop()} (${ptbTag}) | ${c.pair.padEnd(16)} | ` +
          `5m=${(c.ask5 * 100).toFixed(1)}c(${c.size5.toFixed(0)}) + 15m=${(c.ask15 * 100).toFixed(1)}c(${c.size15.toFixed(0)}) | ` +
          `gross=${c.grossSum.toFixed(3)} fee=${c.feeSum.toFixed(3)} net=${c.netCost.toFixed(3)} edge=${(c.edgeNet * 100).toFixed(2)}%`,
        );
      }
    }
  }
  console.log(`Summary: ${totalCombos} combos checked | positive net edge=${positiveNet} | actionable (>=5 shares & net>0)=${actionable}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
