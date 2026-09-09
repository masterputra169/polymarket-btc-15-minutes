import { useState, useEffect } from 'react';
import { serverNow, subscribeServerClock } from './serverClock.ts';

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
