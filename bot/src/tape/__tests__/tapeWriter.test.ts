import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TapeWriter } from '../tapeWriter.ts';
import { decodeTape } from '../tapeFormat.ts';

const H3 = Date.UTC(2026, 8, 24, 3, 0, 0);
const H4 = Date.UTC(2026, 8, 24, 4, 0, 0);
const MB = 1024 * 1024;

let dir: string;
let clock: number;

function writer(over: Partial<ConstructorParameters<typeof TapeWriter>[0]> = {}) {
  return new TapeWriter({
    dir, bootId: 'boot1', maxLocalBytes: 100 * MB, minFreeBytes: 0,
    now: () => clock, freeBytes: () => 10_000 * MB, ...over,
  });
}

/** A file left by another process, last written `agoMs` before the test clock. */
function foreign(rel: string, content: string | Buffer, agoMs = 3_600_000) {
  mkdirSync(join(dir, rel.split('/')[0]), { recursive: true });
  writeFileSync(join(dir, rel), content);
  const t = new Date(clock - agoMs);
  utimesSync(join(dir, rel), t, t);
}

function read(rel: string) {
  return decodeTape(readFileSync(join(dir, rel))).lines;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tape-writer-'));
  clock = H3 + 10_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('TapeWriter', () => {
  test('appends one gzip member per flush to the hour file', () => {
    const w = writer();
    w.push({ t: H3 + 1, k: 's' } as any);
    w.push({ t: H3 + 2, k: 's' } as any);
    expect(w.flush()).toMatchObject({ lines: 2, dropped: 0, evicted: [] });
    w.push({ t: H3 + 3, k: 'x' } as any);
    w.flush();
    expect(read('2026-09-24/03-boot1.jsonl.gz').map(l => l.t)).toEqual([H3 + 1, H3 + 2, H3 + 3]);
    expect(w.buffered).toBe(0);
  });

  test('a buffer spanning the hour boundary is split between the two files', () => {
    const w = writer();
    w.push({ t: H4 - 1, k: 's' } as any);
    w.push({ t: H4 + 1, k: 's' } as any);
    w.flush();
    expect(read('2026-09-24/03-boot1.jsonl.gz')).toHaveLength(1);
    expect(read('2026-09-24/04-boot1.jsonl.gz')).toHaveLength(1);
  });

  test('a clock step back never reopens an earlier hour (it may already be uploaded)', () => {
    const w = writer();
    w.push({ t: H4 + 5, k: 's' } as any);
    w.push({ t: H4 - 5, k: 's' } as any); // clock stepped back across the boundary
    w.flush();
    expect(existsSync(join(dir, '2026-09-24/03-boot1.jsonl.gz'))).toBe(false);
    expect(read('2026-09-24/04-boot1.jsonl.gz').map(l => l.t)).toEqual([H4 + 5, H4 - 5]);
  });

  test('completedFiles: other processes’ files and own past hours, never the file being written', () => {
    foreign('2026-09-24/03-boot0.jsonl.gz', 'x'); // previous process, same hour, idle for an hour
    writeFileSync(join(dir, '2026-09-24/README.txt'), 'ignored');
    const w = writer();
    w.push({ t: H3 + 1, k: 's' } as any);
    w.flush();
    expect(w.completedFiles().map(f => f.rel)).toEqual(['2026-09-24/03-boot0.jsonl.gz']);

    clock = H4 + 1;
    expect(w.completedFiles().map(f => f.rel)).toEqual([
      '2026-09-24/03-boot0.jsonl.gz', '2026-09-24/03-boot1.jsonl.gz',
    ]);
  });

  test('over the cap it deletes the oldest finished files, not the current one', () => {
    foreign('2026-09-23/01-boot0.jsonl.gz', Buffer.alloc(600));
    foreign('2026-09-23/02-boot0.jsonl.gz', Buffer.alloc(600));
    const w = writer({ maxLocalBytes: 500 }); // 1200 B of old files + a small current one
    for (let i = 0; i < 50; i++) w.push({ t: H3 + i, k: 's', pad: 'y'.repeat(20) } as any);
    const r = w.flush();
    expect(r.evicted).toEqual(['2026-09-23/01-boot0.jsonl.gz', '2026-09-23/02-boot0.jsonl.gz']);
    expect(existsSync(join(dir, '2026-09-23'))).toBe(false); // empty day dir removed
    expect(read('2026-09-24/03-boot1.jsonl.gz')).toHaveLength(50);
  });

  test('another process’s file that is still being appended to is not finished — even over the cap', () => {
    foreign('2026-09-24/03-boot0.jsonl.gz', Buffer.alloc(600), 30_000); // written 30s ago
    const w = writer({ maxLocalBytes: 100 });
    expect(w.completedFiles()).toEqual([]);
    w.push({ t: H3 + 1, k: 's' } as any);
    expect(w.flush().evicted).toEqual([]);
    expect(existsSync(join(dir, '2026-09-24/03-boot0.jsonl.gz'))).toBe(true);
    clock += 180_000; // idle long enough now
    expect(w.completedFiles().map(f => f.rel)).toEqual(['2026-09-24/03-boot0.jsonl.gz']);
  });

  test('the cap is not rescanned on every flush — only when the estimate crosses it or every 10 min', () => {
    const w = writer({ maxLocalBytes: 10_000 });
    w.push({ t: H3 + 1, k: 's' } as any);
    w.flush(); // first flush scans
    foreign('2026-09-23/01-boot0.jsonl.gz', Buffer.alloc(20_000)); // appears behind the writer's back
    w.push({ t: H3 + 2, k: 's' } as any);
    expect(w.flush().evicted).toEqual([]); // estimate still under the cap: no scan
    clock += 10 * 60_000;
    w.push({ t: clock, k: 's' } as any);
    expect(w.flush().evicted).toEqual(['2026-09-23/01-boot0.jsonl.gz']);
  });

  test('stops writing when the volume runs low — state.json shares it', () => {
    const w = writer({ minFreeBytes: 500 * MB, freeBytes: () => 100 * MB });
    w.push({ t: H3 + 1, k: 's' } as any);
    expect(w.flush()).toMatchObject({ lines: 0, dropped: 1 });
    expect(w.totalDropped).toBe(1);
    expect(w.listFiles()).toEqual([]);
  });

  test('remove() of a file that is already gone is not an error', () => {
    const w = writer();
    w.push({ t: H3 + 1, k: 's' } as any);
    w.flush();
    const [f] = w.listFiles();
    w.remove(f);
    expect(() => w.remove(f)).not.toThrow();
  });
});
