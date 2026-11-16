/**
 * Dashboard Journal Archive RPCs: listJournalArchives and getJournalArchive.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const archiveMock = vi.hoisted(() => ({
  listJournalArchives: vi.fn(() => [{ id: 'archive_20261116_pre_alltime_100', label: 'Legacy', trades: 926 }]),
  getArchivedJournalAnalytics: vi.fn((id: string) =>
    id === 'archive_20261116_pre_alltime_100' ? { patterns: { totalTrades: 926 }, events: [], equityCurve: [] } : null
  ),
}));

vi.mock('../trading/journalAnalytics.ts', () => ({
  ARCHIVE_ID_RE: /^archive_[a-zA-Z0-9_-]+$/,
  listJournalArchives: archiveMock.listJournalArchives,
  getArchivedJournalAnalytics: archiveMock.getArchivedJournalAnalytics,
}));

const PORT = 3196;
process.env.STATUS_PORT = String(PORT);
process.env.STATUS_HOST = '127.0.0.1';
delete process.env.STATUS_AUTH_TOKEN;
delete process.env.STATUS_CONTROL_TOKEN;
delete process.env.BOT_STATUS_TOKEN;

import { startStatusServer, stopStatusServer } from '../statusServer.ts';

function rpc(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('rpc timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify(msg));
    ws.onmessage = (ev) => {
      const data = JSON.parse(String(ev.data));
      if (data.type !== 'response') return;
      clearTimeout(timer);
      ws.close();
      resolve(data.data);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

beforeAll(() => { startStatusServer(); });
afterAll(() => { stopStatusServer(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('statusServer journal archive RPCs', () => {
  test('listJournalArchives returns archive summaries', async () => {
    const res = await rpc({ type: 'listJournalArchives' });
    expect(res).toMatchObject({
      ok: true,
      archives: [{ id: 'archive_20261116_pre_alltime_100', trades: 926 }],
    });
  });

  test('getJournalArchive validates archiveId and rejects traversal/unknown ids', async () => {
    const bad = await rpc({ type: 'getJournalArchive', archiveId: '../etc/passwd' });
    expect(bad).toEqual({ ok: false, error: 'invalid_archive_id' });

    const missing = await rpc({ type: 'getJournalArchive', archiveId: 'archive_missing' });
    expect(missing).toEqual({ ok: false, archiveId: 'archive_missing', error: 'archive_not_found' });

    const ok = await rpc({ type: 'getJournalArchive', archiveId: 'archive_20261116_pre_alltime_100' });
    expect(ok).toMatchObject({
      ok: true,
      archiveId: 'archive_20261116_pre_alltime_100',
      analytics: { patterns: { totalTrades: 926 } },
    });
  });
});
