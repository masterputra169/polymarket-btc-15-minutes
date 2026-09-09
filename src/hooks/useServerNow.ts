import { useState, useEffect } from 'react';
import { serverNow, subscribeServerClock, getServerClockOffset } from './serverClock.ts';

/**
 * Ticking "now" on the bot's clock rather than the browser's.
 *
 * Panels use this wherever they render an age or an elapsed time against a
 * timestamp the bot produced. It also re-renders the moment the offset itself
 * changes, so a dashboard opened on a badly-wrong clock corrects on the first
 * snapshot instead of showing a nonsense duration until the next tick.
 *
 * @param intervalMs - how often to re-read the clock
 */
export function useServerNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());

  useEffect(() => {
    const tick = () => setNow(serverNow());
    tick(); // an offset may have landed between mount and this effect
    const id = setInterval(tick, intervalMs);
    const unsubscribe = subscribeServerClock(tick);
    return () => { clearInterval(id); unsubscribe(); };
  }, [intervalMs]);

  return now;
}

/**
 * How far this browser's clock is from the bot's, in ms (server minus local).
 *
 * Re-renders only when the offset itself moves, so a panel can surface a wrong
 * PC clock without ticking every second.
 */
export function useServerClockOffset(): number {
  const [offsetMs, setOffsetMs] = useState(() => getServerClockOffset());

  useEffect(() => {
    const sync = () => setOffsetMs(getServerClockOffset());
    sync(); // an offset may have landed between mount and this effect
    return subscribeServerClock(sync);
  }, []);

  return offsetMs;
}
