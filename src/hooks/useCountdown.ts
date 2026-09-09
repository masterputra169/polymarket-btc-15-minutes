import { useState, useEffect, useRef } from 'react';
import { remainingMinutes } from './clockOffset.ts';
import { getServerClockOffset, subscribeServerClock } from './serverClock.ts';

/**
 * Client-side countdown that ticks every second.
 * Syncs with the absolute target timestamp from poll data,
 * but updates locally every 1s for smooth display.
 *
 * The remaining time is computed on the server-corrected clock (see
 * `serverClock.ts`), which `useBotData` keeps fed from each snapshot's `ts`.
 * A PC whose clock is wrong therefore still shows the bot's real
 * time-to-settlement instead of a countdown that is off by the same error.
 *
 * @param {number|null} targetMs - Absolute timestamp (ms) to count down to
 * @returns {number|null} - Minutes remaining (float), updated every second
 */
export function useCountdown(targetMs) {
  const [minutesLeft, setMinutesLeft] = useState(null);
  const targetRef = useRef(targetMs);

  // Sync target from poll data
  useEffect(() => {
    targetRef.current = targetMs;
    setMinutesLeft(remainingMinutes(targetMs, Date.now(), getServerClockOffset()));
  }, [targetMs]);

  // Tick every second, and re-read immediately when the offset itself moves
  useEffect(() => {
    if (targetMs == null) return;

    const tick = () => {
      const t = targetRef.current;
      if (t == null) return;
      setMinutesLeft(remainingMinutes(t, Date.now(), getServerClockOffset()));
    };

    const id = setInterval(tick, 1000);
    const unsubscribe = subscribeServerClock(tick);

    return () => { clearInterval(id); unsubscribe(); };
  }, [targetMs != null]); // only start/stop when targetMs becomes null or non-null

  return minutesLeft;
}
