import { useServerNow } from './useServerNow.ts';

/**
 * Wall clock on the bot's time base.
 *
 * The ET time and BTC session this drives describe the market, not the
 * operator's PC, so a browser clock that is off by hours must not shift them.
 */
export function useClock(intervalMs = 1000): Date {
  const nowMs = useServerNow(intervalMs);
  return new Date(nowMs);
}
