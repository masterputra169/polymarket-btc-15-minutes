import { describe, expect, test } from 'vitest';
import { requestTradingMode } from '../tradingMode.ts';

describe('trading mode switch guards', () => {
  test('rejects an unknown mode', async () => {
    await expect(requestTradingMode('production', 'LIVE')).resolves.toMatchObject({ ok: false });
  });

  test('requires the exact confirmation phrase', async () => {
    await expect(requestTradingMode('live', 'live')).resolves.toMatchObject({ ok: false, error: /LIVE/ });
    await expect(requestTradingMode('dry', 'LIVE')).resolves.toMatchObject({ ok: false, error: /DRY/ });
  });

  test('refuses to switch to the mode that is already active', async () => {
    // Test runner has no DRY_RUN=false; this is the safe dry-run default.
    await expect(requestTradingMode('dry', 'DRY')).resolves.toMatchObject({ ok: false, error: /Already/ });
  });
});
