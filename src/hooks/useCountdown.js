import { useState, useEffect, useRef } from 'react';

/**
 * Client-side countdown that ticks every second.
 * Syncs with the absolute target timestamp from poll data,
 * but updates locally every 1s for smooth display.
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
    if (targetMs != null) {
      setMinutesLeft(Math.max(0, (targetMs - Date.now()) / 60_000));
    } else {
      setMinutesLeft(null);
    }
  }, [targetMs]);

  // Tick every second
  useEffect(() => {
    if (targetMs == null) return;

    const id = setInterval(() => {
      const t = targetRef.current;
      if (t == null) return;
      const remaining = Math.max(0, (t - Date.now()) / 60_000);
      setMinutesLeft(remaining);
    }, 1000);

    return () => clearInterval(id);
  }, [targetMs != null]); // only start/stop when targetMs becomes null or non-null

  return minutesLeft;
}
