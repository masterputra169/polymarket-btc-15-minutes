import { describe, test, expect } from 'vitest';
import { summarizeTape } from '../tapeStats.ts';
import type { TapeLine } from '../tapeFormat.ts';

const snap = (t: number, ok: 0 | 1, m = 'mkt-a'): TapeLine => ({ k: 's', t, m, ok });

describe('summarizeTape', () => {
  test('counts live seconds, the longest gap, markets, trades and recorder events', () => {
    const lines: TapeLine[] = [
      { k: 'm', t: 0, m: 'mkt-a', cid: null, up: 'U', dn: 'D', start: null, end: null },
      { k: 'i', t: 0, ev: 'subscribed' },
      snap(1000, 1), snap(2000, 1), snap(3000, 0), snap(4000, 0), snap(5000, 0), snap(6000, 1),
      { k: 'x', t: 6500, m: 'mkt-a', o: 'u', p: 0.5, q: 10, sd: 'BUY', st: null },
      { k: 'i', t: 7000, ev: 'resync' },
      snap(8000, 1, 'mkt-b'),
      { k: 'd', t: 8100, m: 'mkt-b', a: 'W', sd: null, ph: 'MID', why: null, ml: null, mc: null, en: null, eu: null, ed: null, pu: null, pd: null, tl: null, rg: null, ss: null, st: 'wait' },
      { k: 'd', t: 8200, m: 'mkt-b', a: 'E', sd: 'U', ph: 'MID', why: null, ml: null, mc: null, en: null, eu: null, ed: null, pu: null, pd: null, tl: null, rg: null, ss: null, st: 'filtered', fp: 0, fr: ['x'] },
      { k: 'd', t: 8300, m: 'mkt-b', a: 'E', sd: 'U', ph: 'MID', why: null, ml: null, mc: null, en: null, eu: null, ed: null, pu: null, pd: null, tl: null, rg: null, ss: null, st: 'filtered', fp: 0, fr: ['x'] },
    ];
    // out of order on purpose: files from two processes are merged by time
    expect(summarizeTape([...lines].reverse())).toEqual({
      snapshots: 7, live: 4, trades: 1, markets: 2, resyncs: 1, subscriptions: 1,
      firstMs: 0, lastMs: 8300, longestGapSec: 3, decisions: 3, stages: { wait: 1, filtered: 2 },
    });
  });

  test('empty tape', () => {
    expect(summarizeTape([])).toMatchObject({ snapshots: 0, firstMs: null, longestGapSec: 0 });
  });
});
