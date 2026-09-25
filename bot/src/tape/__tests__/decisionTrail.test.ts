import { describe, test, expect } from 'vitest';
import { DecisionTrail, type DecisionInput } from '../decisionTrail.ts';

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    t: 1_000, slug: 'btc-updown-15m-1', action: 'ENTER', side: 'UP', phase: 'MID',
    reason: 'UP edge 9.1%≥7%, prob 66%≥58%, 3 indicators agree',
    mlUp: 0.812345, mlConf: 0.62469, ensembleUp: 0.70123, edgeUp: 0.0912, edgeDown: -0.2,
    marketUp: 0.6123, marketDown: 0.3877, timeLeftMin: 7.4567, regime: 'moderate', session: 'US',
    ...over,
  };
}

describe('DecisionTrail', () => {
  test('a record is sampled only once it is finished (the next poll began)', () => {
    const tr = new DecisionTrail();
    tr.begin(input({ t: 1 }));
    expect(tr.takeSample()).toBeNull(); // still in progress
    tr.begin(input({ t: 2 }));
    const d = tr.takeSample();
    expect(d).toMatchObject({ k: 'd', t: 1, a: 'E', sd: 'U', ph: 'MID', st: 'wait' });
    expect(tr.takeSample()).toBeNull(); // never twice
  });

  test('numbers are rounded and non-finite values become null', () => {
    const tr = new DecisionTrail();
    tr.begin(input({ mlUp: NaN, edgeDown: Infinity, marketDown: undefined }));
    tr.begin(input());
    expect(tr.takeSample()).toMatchObject({ ml: null, mc: 0.625, en: 0.7012, eu: 0.0912, ed: null, pu: 0.612, pd: null, tl: 7.46 });
  });

  test('WAIT keeps decide()’s reason and no side', () => {
    const tr = new DecisionTrail();
    tr.begin(input({ action: 'WAIT', side: null, reason: 'DOWN: agree 2 < 3, Choppy' }));
    tr.begin(input());
    expect(tr.takeSample()).toMatchObject({ a: 'W', sd: null, why: 'DOWN: agree 2 < 3, Choppy', st: 'wait' });
  });

  test('filters keep every reason; the furthest stage wins', () => {
    const tr = new DecisionTrail();
    tr.begin(input());
    tr.stage('pre', ['has_position']);
    tr.filters(false, ['ML conf 44% < 45% [edge 17%≥15%→relaxed]', 'Entry price 81c > 75c hard cap']);
    tr.stage('pre', ['ignored-later']); // a lesser stage never downgrades
    tr.begin(input());
    const d = tr.takeSample()!;
    expect(d.st).toBe('filtered');
    expect(d.pre).toEqual(['has_position']); // the later, lesser note left it alone
    expect(d.fp).toBe(0);
    expect(d.fr).toEqual(['ML conf 44% < 45% [edge 17%≥15%→relaxed]', 'Entry price 81c > 75c hard cap']);
  });

  test('unstable carries its hold reasons', () => {
    const tr = new DecisionTrail();
    tr.begin(input());
    tr.stage('unstable', ['confirm 1/3']);
    tr.begin(input());
    expect(tr.takeSample()).toMatchObject({ st: 'unstable', hold: ['confirm 1/3'] });
  });

  test('an entry is handed back at once and is not sampled again later', () => {
    const tr = new DecisionTrail();
    tr.begin(input({ t: 5 }));
    tr.filters(true, []);
    const e = tr.entered();
    expect(e).toMatchObject({ t: 5, st: 'entered', fp: 1, fr: [] });
    tr.begin(input({ t: 6 }));
    expect(tr.takeSample()).toBeNull(); // the entered record was already written
    tr.begin(input({ t: 7 }));
    expect(tr.takeSample()).toMatchObject({ t: 6 });
  });

  test('long text and long reason lists are bounded', () => {
    const tr = new DecisionTrail();
    tr.begin(input({ reason: 'x'.repeat(500) }));
    tr.filters(false, Array.from({ length: 50 }, (_, i) => `reason ${i} ${'y'.repeat(300)}`));
    tr.begin(input());
    const d = tr.takeSample()!;
    expect(d.why!.length).toBe(160);
    expect(d.fr).toHaveLength(20);
    expect(d.fr!.every(r => r.length <= 120)).toBe(true);
  });

  test('calls before any begin() are harmless', () => {
    const tr = new DecisionTrail();
    expect(() => { tr.stage('unstable', 'not-an-array'); tr.filters(true, null); }).not.toThrow();
    expect(tr.entered()).toBeNull();
    expect(tr.takeSample()).toBeNull();
  });
});
