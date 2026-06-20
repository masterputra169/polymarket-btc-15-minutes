import React, { memo, useEffect, useRef } from 'react';
import { formatNumber } from '../utils.ts';

function PriceDisplay({ label, price, prevPrice, decimals = 2, prefix = '$' }) {
  const ref = useRef(null);
  const prevRef = useRef(price);

  useEffect(() => {
    if (price !== null && prevRef.current !== null && price !== prevRef.current) {
      const el = ref.current;
      if (!el) return;
      const cls = price > prevRef.current ? 'flash-green' : 'flash-red';
      el.classList.remove('flash-green', 'flash-red');
      void el.offsetWidth;
      el.classList.add(cls);
    }
    prevRef.current = price;
  }, [price]);

  if (price === null || price === undefined) {
    return (
      <div className="data-row">
        <span className="data-row__label">{label}</span>
        <span className="data-row__value c-muted">-</span>
      </div>
    );
  }

  const p = Number(price);
  const prev = prevPrice !== null && prevPrice !== undefined ? Number(prevPrice) : null;

  let colorClass = '';
  let arrow = '';
  if (prev !== null && Number.isFinite(prev) && p !== prev) {
    if (p > prev) { colorClass = 'c-green'; arrow = ' ↑'; }
    else { colorClass = 'c-red'; arrow = ' ↓'; }
  }

  return (
    <div className="data-row" ref={ref}>
      <span className="data-row__label">{label}</span>
      <span className={`data-row__value ${colorClass}`}>
        {prefix}{formatNumber(p, decimals)}{arrow}
      </span>
    </div>
  );
}

// ═══ React.memo ═══
// Props are all primitives — default shallow compare is sufficient.
export default memo(PriceDisplay);