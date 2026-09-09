import { useState, useEffect } from 'react';
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

/**
 * The operator's actual browser clock, uncorrected.
 *
 * Only for UI that genuinely means "this machine's time". Anything measured
 * against a bot timestamp belongs on `useClock` / `useServerNow` instead.
 */
export function useLocalClock(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
