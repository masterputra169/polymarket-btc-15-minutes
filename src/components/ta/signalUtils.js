/**
 * Shared signal display helpers for TA indicator sub-components.
 */

export function rowClass(narrative) {
  return narrative === 'LONG'
    ? 'ta-signal-row--long'
    : narrative === 'SHORT'
      ? 'ta-signal-row--short'
      : 'ta-signal-row--neutral';
}

export function colorClass(narrative) {
  return narrative === 'LONG' ? 'c-green' : narrative === 'SHORT' ? 'c-red' : 'c-muted';
}
