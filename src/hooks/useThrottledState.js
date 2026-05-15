import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * ═══ useThrottledState — High perf state for real-time streams ═══
 *
 * Problem:  WS fires 1-60x/sec → setState each time → re-render cascade
 * Solution: Store latest value in ref (free), flush to state at fixed interval
 *
 * Result:   Same visual smoothness, 90%+ fewer re-renders
 *
 * @param {*} initialValue  - initial state
 * @param {number} intervalMs - flush interval (default 500ms = 2 updates/sec)
 * @returns {Array} [value, setValue, refValue]
 *   - value:    React state (triggers re-render, updated every intervalMs)
 *   - setValue: call this on every WS tick (writes to ref, NOT state)
 *   - refValue: ref with latest value (always current, no re-render)
 */
export function useThrottledState(initialValue, intervalMs = 500) {
  const [state, setState] = useState(initialValue);
  const latestRef = useRef(initialValue);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);

  const setValue = useCallback((valOrFn) => {
    const next = typeof valOrFn === 'function' ? valOrFn(latestRef.current) : valOrFn;
    if (next === latestRef.current) return; // skip identical
    latestRef.current = next;
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setState(latestRef.current);
      }
    }, intervalMs);
    return () => clearInterval(timerRef.current);
  }, [intervalMs]);

  return [state, setValue, latestRef];
}

/**
 * ═══ useThrottledPair — For price + prevPrice pattern ═══
 *
 * Tracks current + previous value with throttled flushing.
 * Perfect for price streams where you need prev for flash animation.
 */
export function useThrottledPricePair(intervalMs = 500) {
  const [price, setPrice] = useState(null);
  const [prevPrice, setPrevPrice] = useState(null);
  const latestRef = useRef(null);
  const prevRef = useRef(null);
  const dirtyRef = useRef(false);
  const timerRef = useRef(null);

  const pushPrice = useCallback((p) => {
    if (p === latestRef.current) return; // skip identical
    prevRef.current = latestRef.current;
    latestRef.current = p;
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        setPrevPrice(prevRef.current);
        setPrice(latestRef.current);
      }
    }, intervalMs);
    return () => clearInterval(timerRef.current);
  }, [intervalMs]);

  return { price, prevPrice, pushPrice, priceRef: latestRef };
}