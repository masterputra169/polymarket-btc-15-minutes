import { describe, test, expect } from 'vitest';
import { gzipSync } from 'zlib';
import { decodeTape, hourOf, hourStamp, makeBootId, parseRelPath, relPathFor } from '../tapeFormat.ts';

const T = Date.UTC(2026, 8, 24, 3, 59, 59, 500);

describe('tape file layout', () => {
  test('one file per UTC hour per process', () => {
    expect(hourOf(T)).toEqual({ date: '2026-09-24', hour: '03' });
    expect(hourStamp(T)).toBe('2026-09-24T03');
    expect(relPathFor(T, 'abc123')).toBe('2026-09-24/03-abc123.jsonl.gz');
    expect(relPathFor(T + 1000, 'abc123')).toBe('2026-09-24/04-abc123.jsonl.gz');
  });

  test('parseRelPath accepts only tape paths — it is also the path-traversal guard', () => {
    expect(parseRelPath('2026-09-24/03-abc123.jsonl.gz')).toEqual({
      date: '2026-09-24', hour: '03', bootId: 'abc123', stamp: '2026-09-24T03',
    });
    for (const bad of [
      '../2026-09-24/03-abc.jsonl.gz', '2026-09-24/../../etc/passwd', '2026-09-24/03-ABC.jsonl.gz',
      '2026-09-24/03-abc.jsonl', '/2026-09-24/03-abc.jsonl.gz', '2026-09-24\\03-abc.jsonl.gz',
    ]) expect(parseRelPath(bad)).toBeNull();
  });

  test('boot ids are fixed width, so file names sort by boot time', () => {
    const a = makeBootId(Date.UTC(2026, 0, 1));
    const b = makeBootId(Date.UTC(2026, 11, 31));
    expect(a).toHaveLength(9);
    expect(a < b).toBe(true);
  });
});

describe('decodeTape', () => {
  const member = (lines: object[]) => gzipSync(lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  test('reads a file made of several gzip members (one per flush)', () => {
    const buf = Buffer.concat([member([{ k: 's', t: 1 }, { k: 's', t: 2 }]), member([{ k: 'x', t: 3 }])]);
    const { lines, bad } = decodeTape(buf);
    expect(lines.map(l => l.t)).toEqual([1, 2, 3]);
    expect(bad).toBe(0);
  });

  test('keeps everything before a member cut short by a crash', () => {
    const whole = member([{ k: 's', t: 1 }]);
    const torn = member([{ k: 's', t: 2 }, { k: 's', t: 3 }]).subarray(0, 20);
    const { lines } = decodeTape(Buffer.concat([whole, torn]));
    expect(lines[0]).toEqual({ k: 's', t: 1 });
  });

  test('counts lines that are not tape lines instead of throwing', () => {
    const buf = gzipSync('{"k":"s","t":1}\nnot json\n{"t":2}\n{"k":"s"}\n');
    const { lines, bad } = decodeTape(buf);
    expect(lines).toHaveLength(1);
    expect(bad).toBe(3);
  });
});
